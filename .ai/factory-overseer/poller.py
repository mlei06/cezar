#!/usr/bin/env python3
"""Overseer poller (roadmap M0.8). Logs every manager message and task state change to events.log,
and appends each finished task to ended.txt for the judge. Survives cockpit restarts."""
import json, time, urllib.request
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import overseer_config as oc
DATA = oc.data_dir()
API = oc.load()['cockpit'] + '/api/v1'
LOG = DATA / 'events.log'
ENDED = DATA / 'ended.txt'
STATE = DATA / 'poller-state.json'
TERMINAL = {'done', 'review', 'failed', 'cancelled'}


def get(path):
    return json.load(urllib.request.urlopen(API + path, timeout=15))


def write(line):
    with LOG.open('a') as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {line}\n")


def main():
    state = json.loads(STATE.read_text()) if STATE.exists() else {'msgs': [], 'runs': {}}
    seen_msgs = set(state['msgs'])
    runs = state['runs']
    down = False
    while True:
        try:
            managers = get('/workspace/managers')
            managers = managers.get('managers', managers)
            for m in managers:
                for msg in get(f"/workspace/managers/{m['id']}/messages?limit=40")['messages']:
                    if msg.get('streaming'):
                        continue
                    key = f"{msg['id']}:{msg.get('status', '')}"
                    if key in seen_msgs:
                        continue
                    seen_msgs.add(key)
                    text = msg.get('text') or msg.get('result') or json.dumps(msg.get('action') or msg.get('taskReport') or '')
                    write(f"[{m['name']}] {msg['kind']}{'/' + msg['status'] if msg.get('status') else ''}: {text[:2000]!r}")
            for p in get('/projects')['projects']:
                rs = get(f"/p/{p['id']}/runs")
                for r in rs if isinstance(rs, list) else rs.get('runs', []):
                    k = f"{p['id']}/{r['id']}"
                    sig = f"{r['status']}|{r.get('pullRequestUrl') or ''}"
                    if runs.get(k) == sig:
                        continue
                    if k not in runs and r['status'] in TERMINAL and state.get('initialized'):
                        pass
                    first = k not in runs
                    runs[k] = sig
                    if first and not state.get('initialized'):
                        continue
                    write(f"[task {p['id']}/{r['id'][:8]}] {r['status']} wf={r.get('workflow')} runner={r.get('runner')} model={r.get('model') or ''} pr={r.get('pullRequestUrl') or '-'} :: {(r.get('title') or r.get('task', ''))[:160]!r}")
                    if r['status'] in TERMINAL:
                        with ENDED.open('a') as f:
                            f.write(f"{p['root']}\t{r['id']}\t{r['status']}\t{time.strftime('%Y-%m-%dT%H:%M:%S')}\n")
            state['initialized'] = True
            if down:
                write('cockpit reachable again')
                down = False
        except Exception as e:
            if not down:
                write(f'cockpit unreachable: {e}')
                down = True
        state['msgs'] = list(seen_msgs)[-5000:]
        STATE.write_text(json.dumps(state))
        time.sleep(20)


if __name__ == '__main__':
    main()
