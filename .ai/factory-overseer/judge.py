#!/usr/bin/env python3
"""Overseer judge prototype (roadmap M0.7). Renders a cezar run into the spec's transcript format
plus a metrics summary, and asks the configured judge model to score it against the fork's rubric
drafts (.ai/cezar/scorers/<name>/scorer.md). Calls the judge model's OpenAI-compatible API through the
local relay (model-relay.py), because the OpenCode binary ignores custom CA settings.

  judge.py <project-root> <run-id> [scorer ...] [--render-only] [--max-chars N]
"""
import json, re, ssl, sys, time, urllib.error, urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import overseer_config as oc
HERE = Path(__file__).resolve().parent
CFG = oc.load()
SCORERS = HERE.parent / 'cezar' / 'scorers'
OUT = oc.data_dir() / 'scores'
DEFAULT_SCORERS = ['outcome', 'efficiency', 'procedure', 'scope']
TARGETS = 'harness | manager-skill | workflow | skill | agents-md | docs | code | brief | infra'
CATEGORIES = 'harness | task-setup | repository | access | model | requirements | external'


def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def load_run(root, run_id):
    runs = Path(root) / '.ai/cezar/runs'
    log = next(runs.glob(f'{run_id}*.ndjson'))
    events = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    rid = log.name.split('.')[0]
    try:
        project = Path(root).name
        rec = json.load(urllib.request.urlopen(f"{CFG['cockpit']}/api/v1/p/{project}/runs/{rid}", timeout=10))
        rec = rec.get('run', rec)
    except Exception:
        rec = {'id': rid}
    return rid, rec, events


def result_text(e):
    r = e.get('result')
    if isinstance(r, str):
        try:
            j = json.loads(r)
            if isinstance(j, dict):
                return str(j.get('aggregatedOutput') or j.get('output') or j.get('contentItems') or j.get('result') or r), j.get('durationMs')
        except Exception:
            pass
        return r, None
    return json.dumps(r), None


def call_text(e):
    inp = e.get('input') or {}
    if isinstance(inp, dict):
        cmd = inp.get('command') or inp.get('cmd')
        if cmd:
            cmd = re.sub(r"^/bin/bash -lc ", '', str(cmd))
            return f"{e.get('tool')}: {cmd}"
        return f"{e.get('tool')}: {json.dumps(inp)[:2000]}"
    return f"{e.get('tool')}: {str(inp)[:2000]}"


def render(rid, rec, events, max_chars=520_000):
    t0 = ts(events[0]['ts'])
    entries, calls = [], {}
    for e in events:
        typ = e['type']
        rel = ts(e['ts']) - t0
        stamp = f"[+{int(rel // 60)}:{int(rel % 60):02d}]"
        if typ == 'text' and e.get('text', '').strip():
            entries.append({'k': 'text', 'line': f"{stamp} assistant: {e['text'].strip()}"})
        elif typ == 'user-message':
            entries.append({'k': 'text', 'line': f"{stamp} message to the agent (owner or manager): {e.get('text', '').strip()}"})
        elif typ == 'tool-call':
            calls[e['id']] = (ts(e['ts']), call_text(e), stamp)
        elif typ == 'tool-result' and e.get('toolCallId') in calls:
            start, head, st = calls.pop(e['toolCallId'])
            out, dur = result_text(e)
            secs = (dur / 1000) if dur else ts(e['ts']) - start
            entries.append({'k': 'tool', 'head': f"{st} tool {head[:1500]} ({secs:.1f} s, {len(out):,} chars{', error' if e.get('isError') else ''})", 'out': out, 'secs': secs})
        elif typ in ('note', 'lifecycle') and e.get('message'):
            entries.append({'k': 'text', 'line': f"{stamp} cezar: {e['message']}"})
        elif typ == 'step-start':
            entries.append({'k': 'text', 'line': f"{stamp} step {e.get('stepId')} started ({e.get('name', '')})"})
    # Metrics.
    tok = [e['tokensUsed'] for e in events if e['type'] == 'token-usage' and isinstance(e.get('tokensUsed'), (int, float))]
    deltas = [b - a for a, b in zip(tok, tok[1:]) if b > a]
    tools = [x for x in entries if x['k'] == 'tool']
    wall = ts(events[-1]['ts']) - t0
    tool_s = sum(x['secs'] for x in tools)
    largest = sorted(tools, key=lambda x: -len(x['out']))[:5]
    metrics = [
        f"wall time {wall/60:.1f} min; tool time {tool_s/60:.1f} min; model and other time {max(wall-tool_s,0)/60:.1f} min",
        f"model requests (token-usage updates) {len(tok)}; context per request avg {int(sum(deltas)/len(deltas)) if deltas else 0:,} tokens, peak {max(deltas) if deltas else 0:,}",
        f"tokens recorded: input {rec.get('inputTokens', '?')}, output {rec.get('outputTokens', '?')}, total {rec.get('tokensUsed', '?')}; cost {rec.get('costUsd', '?')}",
        f"tool calls {len(tools)}; tool output {sum(len(x['out']) for x in tools):,} chars",
        "largest outputs: " + '; '.join(f"{len(x['out']):,} chars from {x['head'][:90]}" for x in largest),
    ]
    head = [f"# Run {rid[:8]}: {rec.get('title', '')}",
            f"workflow {rec.get('workflow')} · {rec.get('runner')} {rec.get('model') or rec.get('actualModel') or ''} · status {rec.get('status')} · PR {rec.get('pullRequestUrl') or '-'}",
            '## Brief', (rec.get('task') or '(not available)')[:8000], '## Metrics', *metrics, '## Transcript']

    def assemble(cut):
        lines = list(head)
        for x in entries:
            if x['k'] == 'text':
                lines.append(x['line'])
            else:
                out = x['out']
                if len(out) > cut:
                    keep_h, keep_t = int(cut * 0.75), int(cut * 0.25)
                    out = f"{out[:keep_h]}\n… [{len(out) - keep_h - keep_t:,} chars cut] …\n{out[-keep_t:]}"
                lines.append(x['head'])
                if out.strip():
                    lines.append(out)
        return '\n'.join(lines)

    cut = 10**9
    text = assemble(cut)
    while len(text) > max_chars and cut > 400:
        cut = max(400, int(cut / 2) if cut < 10**8 else max(len(x['out']) for x in tools) // 2)
        text = assemble(cut)
    return text, '\n'.join(metrics), cut < 10**9


def rubric(name):
    raw = (SCORERS / name / 'scorer.md').read_text()
    m = re.match(r'---\n(.*?)\n---\n(.*)', raw, re.S)
    return m.group(1), m.group(2).strip()


def ask(prompt, attempts=2):
    base = f"http://127.0.0.1:{CFG['relayPort']}/v1"
    key = oc.api_key()
    messages = [{'role': 'user', 'content': prompt}]
    last = ''
    for _ in range(attempts):
        body = json.dumps({'model': CFG['provider']['model'], 'messages': messages, 'max_tokens': 16000, 'temperature': 0}).encode()
        req = urllib.request.Request(base + '/chat/completions', data=body,
                                     headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        try:
            r = json.load(urllib.request.urlopen(req, timeout=900))
        except urllib.error.HTTPError as e:
            raise ValueError(f'HTTP {e.code}: {e.read()[:300]!r}')
        last = (r['choices'][0]['message'].get('content') or '').strip()
        m = re.search(r'\{.*\}', last, re.S)
        if m:
            try:
                return json.loads(m.group(0)), r.get('usage')
            except Exception:
                pass
        if last:
            messages += [{'role': 'assistant', 'content': last}, {'role': 'user', 'content': 'That was not valid JSON. Answer again with only the JSON object.'}]
    raise ValueError(f'no valid JSON: {last[:300]}')


def judge(root, run_id, scorers, max_chars):
    rid, rec, events = load_run(root, run_id)
    text, metrics, shortened = render(rid, rec, events, max_chars)
    OUT.mkdir(exist_ok=True)
    (OUT / f'{rid[:8]}.transcript.txt').write_text(text)
    results = {}
    for name in scorers:
        front, body = rubric(name)
        prompt = f"""You are scoring one run of a coding agent, as the scorer "{name}".

Scorer definition (YAML):
{front}

Rubric:
{body}

Answer with only a JSON object:
{{"label": "<one of the labels above>", "reasoning": "<2-5 sentences>", "evidence": ["<short exact quote from the transcript or metrics>", ...],
  "causes": [{{"category": "{CATEGORIES}", "target": "{TARGETS}", "evidence": "<exact quote>", "fix": "<the concrete change that would have prevented it>"}}]}}
Give "causes" (1 to 3, main cause first) only when the label is below the passing score; otherwise an empty list.
Pick each cause's category and target by where the fix belongs:
- brief (category task-setup): the task text told it to do the wasteful or wrong thing, or left out what it needed (files to read, secrets, constraints).
- docs / agents-md (category repository): the project's docs or AGENTS.md are too long, wrong or missing what the agent needed.
- skill / workflow (category repository): the project's skill or workflow file caused it or lacked guidance.
- code (category repository): the project's code structure made the work hard.
- harness / manager-skill (category harness): cezar itself (its prompts, tools, grants, built-in workflows) or the manager's playbook caused it.
- infra (category access or external): credentials, permissions, networks or outside systems.
- model (category model): the setup was right and the model still failed. Every evidence string must be an exact substring of the transcript or metrics below.

=== RUN ===
{text}
"""
        t = time.time()
        try:
            ans, usage = ask(prompt)
        except Exception as e:
            results[name] = {'error': str(e)}
            continue
        labels = {}
        for v, s in re.findall(r'value: ([\w-]+), score: ([\d.]+)', front):
            labels[v] = float(s)
        passing = float(re.search(r'passingScore: ([\d.]+)', front).group(1))
        score = labels.get(ans.get('label'))
        causes = [c for c in ans.get('causes', []) if c.get('evidence') and c['evidence'][:60] in text][:3]
        results[name] = {'label': ans.get('label'), 'score': score, 'pass': score is not None and score >= passing,
                         'reasoning': ans.get('reasoning'), 'evidence': ans.get('evidence', []), 'causes': causes,
                         'dropped_causes': len(ans.get('causes', [])) - len(causes),
                         'judge': {'model': f"{CFG['provider']['name']}/{CFG['provider']['model']}", 'seconds': round(time.time() - t, 1), 'usage': usage, 'transcriptChars': len(text), 'shortened': shortened}}
    (OUT / f'{rid[:8]}.scores.json').write_text(json.dumps(results, indent=1))
    return rid, results


if __name__ == '__main__':
    a = sys.argv[1:]
    max_chars = 520_000
    if '--max-chars' in a:
        i = a.index('--max-chars'); max_chars = int(a[i + 1]); del a[i:i + 2]
    root, run_id, *names = a
    if '--render-only' in names:
        rid, rec, ev = load_run(root, run_id)
        print(render(rid, rec, ev, max_chars)[0])
        sys.exit(0)
    rid, res = judge(root, run_id, names or DEFAULT_SCORERS, max_chars)
    for k, v in res.items():
        if 'error' in v:
            print(f"{k}: ERROR {v['error']}")
        else:
            print(f"{k}: {v['label']} ({'pass' if v['pass'] else 'FAIL'}) — {v['reasoning']}")
            for c in v['causes']:
                print(f"    cause {c['category']}/{c['target']}: {c['fix']}")
