# Software factory: agents that know what they have, lean tasks, and a feedback loop

Status: draft, 2026-11-25. Fork: `mlei06/cezar`, branch `feat/manager-autonomy`.

## TLDR

A first end-to-end test (an autonomous manager on Codex gpt-6.2-sol, asked only "update production") showed good judgement but slow, expensive execution. Agents did not know which secrets, workflows and helpers they had. Tasks read whole docs and polled through the model. Nothing measured how a task went.

This spec adds three things:
1. **Agents know what they have.** An inventory command for managers. A `--secrets` flag on task create, with the granted secret names written into the task's prompt. A rule that the manager checks its configuration first.
2. **Lean tasks.** Default working rules for every task, a brief template, and a per-task budget that wakes the manager when crossed.
3. **A feedback loop.** Every finished task gets an automatic evaluation, written by a cheap model from a deterministic digest. It gives a pass/fail verdict, a diagnosis and a root-cause category, and it shows as columns on the task row. The weekly audit reads those columns instead of transcripts.

## Evidence (open-webui, 2026-11-25)

| Run | What happened |
|---|---|
| Upgrade task `43299e6b` | 25+ min. 116 model calls averaging 93k tokens of context, 10.7M input tokens in all. 62% of wall time was model time. The first command printed 77k characters (four docs plus the manager's own skill), carried by every later call. It rebuilt backup and staging scripts that already existed in the ignored `Michael/.state/`, polled builds through the model about 10 times, and built one image three ways. |
| First request | A whole round trip to the user, because neither the manager nor the task noticed `PROD_VM_USER`/`PROD_VM_PASSWORD` in their environment. |
| Workflow task `295bd9f4` | 9 min, 3.8M input tokens. It still opened with an 83k-character read. It invented secret names (`JENKINS_API_TOKEN`, `DEPLOY_SSH_*`) instead of checking the stored ones, then grew the scope (a sandboxed OpenCode launcher, a new rollout contract). |
| Review tasks | 7 runs: Azure PR diffs were unreadable, so the verdict was "reject" with no findings. Fixed in `da10dcb22`. |
| Stray managers | Test sandboxes registered as projects got automatic managers. Fixed in `6f8519c88`. |

## Scope

In scope:
- the manager's inventory command;
- task secrets and the capability block in task prompts;
- task working rules and budgets;
- per-task evaluation (digest, evaluator, storage, columns, API);
- the weekly audit job;
- manager guidance.

Out of scope: evaluating manager turns (phase 4), cross-machine aggregation, and changing how secrets are stored.

## Decisions

### D1. Managers check what is configured first: `cez-manager inventory`

A new read command prints, per connected project:
- **Secrets:** names only, with each one's audiences and its description (D3). Never values.
- **Workflows:** with what each can do.
- **Skills:** the project's, the global ones, and the manager-only ones.
- **Agents:** the runners, accounts and models the manager may start tasks with, and each account's usage-limit state.
- **Helpers:** the repo's committed helper scripts, read from an optional `helpers:` list in `.ai/cezar/config.json`, each with its path and one line on what it does.
- **Deployment facts:** the AGENTS.md lines that name job names, hosts or URLs. These are pointers only; the manager reads AGENTS.md itself.

`manage-project` gains a first step: run `inventory` before planning, and before telling the owner that access or a tool is missing. The autonomous system prompt states the same rule in one line.

### D2. `--secrets` on task create, and every task told what it has

`cez-manager task create --secrets NAME[,NAME…]` (repeatable) records `grantedSecrets` on the run.
- **With `--secrets`:** the task's environment gets exactly those secrets (D3 audiences still apply), in addition to cezar's own variables.
- **Without it:** today's behaviour stays: every `agents`-audience secret of the project and workspace.
- **Validation:** a name that isn't stored, or whose audiences exclude `agents`, is refused with the list of valid names.

Either way, the task's system prompt gets a **capability block**, built by cezar and never by the model:

```
You have these secrets as environment variables (values hidden; never print them):
  PROD_VM_HOST: production Node1 address
  PROD_VM_USER / PROD_VM_PASSWORD: SSH login for Node1
  JENKINS_URL / JENKINS_USER / JENKINS_PASSWORD: Jenkins API (CA: Michael/certs/ca-bundle.pem)
Workflows in this project: openwebui-deploy (deploys main through Jenkins)
Helper scripts: Michael/automation/deploy.py (Jenkins CI/CD follow and verify)
```

The secret descriptions come from D3. Workflows and helpers come from the same source as `inventory`. The block is capped at 2k characters.

### D3. Secret descriptions

A secret gains an optional `description` field (at most 200 characters, never secret). It's set with `cezar secrets set NAME --description "…"`, in Settings, or by a manager. Both `inventory` and the capability block print it.

Without descriptions, names alone already beat the status quo. With them, an agent knows what `JENKINS_VM_PASSWORD` is for without guessing.

### D4. Working rules for every task

A short fixed section goes into every task's system prompt (all runners):
- Search (`rg`, line ranges) before reading; never print a whole long file.
- Wait for long jobs (builds, deploys, copies) inside one shell command, with a loop and a timeout. Never check back turn after turn.
- Reuse the helper scripts and workflows listed in the capability block before writing new ones.
- Stay inside the brief, and report scope you think is missing instead of doing it.
- Manager skills are not for tasks.

`manage-project` already carries the matching brief template: goal and done, known facts, constraints, exact files to read, existing tools, and scope.

### D5. A budget per task that wakes the manager

A run may carry `budget: { tokens?: number, minutes?: number }`.
- **Where it comes from:** `--budget-tokens` and `--budget-minutes` on `task create`, else the project's `taskBudget` in `.ai/cezar/config.json`, else defaults of 3M input tokens and 30 minutes of active time. Time spent queued or parked doesn't count.
- **When it's crossed:** the run records `budgetExceeded` with the metric. The task keeps running; this is not a kill. A run with a manager wakes it with a follow-up event carrying the D6 digest's metrics so far (tokens, calls, largest outputs, suspected polling).
- **The manager's choices:**
  - let it continue, raising the budget with `task budget <run> …`;
  - steer it with `task say`;
  - switch its model with `task switch`;
  - cancel and retry.
- **Without a manager:** the task row shows an amber budget marker.
- **Repeats:** after the first crossing, the next alert comes at 2× the budget, so a task that legitimately runs long doesn't nag.

### D6. A deterministic task digest

When a run reaches a terminal state, cezar builds `runs/<id>.digest.json` from the event log. No model is involved. It holds:

- **Identity:** the workflow, runner, model, effort and account; who started the run (a manager, a user or an automation); any attached skill and granted secrets.
- **The brief:** the task text, clipped to 4k characters, with secrets redacted.
- **Timing:** wall time; active time; total model time against tool time; queued and parked time.
- **Tokens:** total input and output, cache reads, model calls, average and peak context per call.
- **Tool calls:** the count; the 10 longest, with duration and command head; the 10 largest outputs, with their size.
- **Detected patterns:**
  - a first read over 30k characters;
  - polling (the same command prefix run three or more times, with gaps between runs);
  - the same failing command run three or more times;
  - files written then patched three or more times;
  - reads of manager skills;
  - attempts to reach anything denied;
  - scope words in the final message ("also", "additionally", new subsystems).
- **Outcome:** final status, the last message (clipped), PR URL and state, review verdicts on that PR, check results, and budget crossings.
- **Interventions:** every `task say`, retry or switch, with who did it.

The digest is the only evaluation input, which keeps evaluation cheap: about 3–6k tokens, not a 10M-token transcript.

### D7. Per-task evaluation: a separate automatic job, not the manager

**Decision:** a separate evaluator runs automatically after every terminal task. The manager doesn't do it. Reasons:
- **Consistency:** every task is judged by the same rubric and model, including tasks a user or automation started. The manager only knows its own tasks.
- **Cost:** a cheap model on a 5k-token digest, against a frontier manager turn re-reading its own session.
- **Independence:** the manager doesn't grade its own briefs.
- **Wake-ups:** evaluation shouldn't burn a manager turn on every task.

The manager still reads the result. The verdict and root cause ride on the task's status card, and a `fail` with a fixable cause wakes it as part of the normal follow-up.

**How it runs:**
- **Model:** an internal, tool-less model call, not a cezar task, so evaluations never create runs, worktrees or more evaluations. The runner and model come from workspace settings `evaluation.runner` and `evaluation.model`. The default here is `opencode` + `davy/mistral-large-4`, which is self-hosted, so digests stay on the machine and the company network.
- **Prompt:** the rubric below plus the digest. The answer is JSON validated by a zod schema, retried once on invalid output, else stored as `evaluation.error`.
- **Skips:** runs under 60 seconds of active time with fewer than 5 tool calls (they're recorded as `skipped`), cancelled-before-start runs, and dry runs.
- **Re-running:** `cez evaluate <run>` re-runs one evaluation, for example after changing the rubric.

**Output** (`runs/<id>.evaluation.json`, mirrored onto the RunRecord):

```json
{
  "verdict": "pass | partial | fail",
  "outcome": "one sentence: what the task delivered against its brief",
  "efficiency": "good | fair | poor",
  "rootCauses": [
    {
      "category": "harness | task-setup | repository | access | model | requirements | external",
      "subcategory": "e.g. task-setup/model-choice, repository/docs-size, access/unknown-secret",
      "evidence": "the digest fact it rests on",
      "fix": "the concrete change that would have prevented it",
      "target": "cezar | manager-skill | brief | agents-md | repo-tooling | workflow | infra"
    }
  ],
  "summary": "two or three sentences for the audit",
  "evaluator": { "runner": "opencode", "model": "davy/mistral-large-4", "digestVersion": 1 }
}
```

**Root-cause categories:**

| Category | Meaning | Example from the evidence |
|---|---|---|
| `harness` | Cezar itself: tools, grants, prompts, provisioning | reviewers couldn't read Azure diffs; the manager skill leaked into tasks |
| `task-setup` | the manager's brief, model, skill, workflow or budget choice | over-scoped brief; asked to read the manager skill; frontier model for status-only work |
| `repository` | the repo's docs, AGENTS.md, helpers, structure | a 50k `setup.md` in the required reading; helpers left in an ignored folder |
| `access` | secrets, credentials, permissions, network | unknown `PROD_VM_*`; expired Jenkins credential |
| `model` | the model couldn't do the work despite good setup | (none observed) |
| `requirements` | the ask was ambiguous or changed | |
| `external` | an outside system failed | ONNX CUDA download 404 |

`pass` means the brief's done criteria were met; `partial` that some were; `fail` that none were, or the outcome was wrong. Efficiency is judged against the task's size, using the digest's patterns.

### D8. Task row columns and API

- **Columns** on the Tasks table (hidden by default, toggled in the column menu): Verdict, Efficiency, Root cause (the first category, plus a count), Tokens, Active time and Model.
- **Detail:** the task detail gets an Evaluation panel showing the summary, root causes with evidence and fixes, and the digest metrics.
- **API:**
  - `GET /p/:id/runs?evaluated=1` filters to evaluated runs;
  - `GET /p/:id/runs/:run/evaluation` returns one evaluation;
  - `GET /workspace/evaluations?since=7d&groupBy=category` returns aggregates for the audit.

### D9. The weekly audit reads the columns

A manager job (`job add --every 10080`) installed by default on automatic managers, run on the low-reasoning model per `manage-project`'s routing table:
1. **Read the aggregates:** `GET /workspace/evaluations?since=7d`. That gives verdict rates, tokens and time per verdict, and the top root causes by count and cost.
2. **Pick the top three fixable causes,** grouped by `target`.
3. **Act on each:**
   - **Project targets** (`agents-md`, `repo-tooling`, `workflow`): start a task with the right skill to fix it and open a PR.
   - **`manager-skill`:** propose an edit to `~/.cezar/manager-skills/`.
   - **`cezar`:** write a short issue note to the owner.
4. **Report:** one message with the week's numbers and what it changed.

The audit never reads transcripts. When a cause needs more evidence, it opens that run's digest.

## Modules

| Module | Change |
|---|---|
| `managers/manager-cli.ts`, `cli-vocabulary.ts` | `inventory`; `task create --secrets`, `--budget-tokens`, `--budget-minutes`; `task budget <run>` |
| `managers/engine.ts` | inventory route; grantedSecrets and budget on createTask; budget follow-up events; evaluation summary on status cards |
| `contract/src/managers.ts`, `runs.ts`, `secrets.ts` | `grantedSecrets`, `budget`, `budgetExceeded`, `evaluation` on RunRecord; secret `description` |
| `workspace/secrets.ts`, `secrets-cli.ts`, Settings | `description` |
| `workflows/run.ts` | the capability block and working rules in the system prompt; grantedSecrets narrowing; budget accounting from token-usage events; a digest-and-evaluate hook on terminal status |
| `evaluation/digest.ts` (new) | build the digest from the event log, with pattern detectors |
| `evaluation/evaluate.ts` (new) | the tool-less model call, rubric, zod schema, storage and re-run |
| `server/server.ts` | evaluation routes and aggregates |
| web Tasks table and detail | columns and the Evaluation panel |
| `manager-skills/manage-project` | inventory-first; `--secrets` in briefs; budgets; audit steps |

## Phases

1. **Know what you have:**
   - D1 inventory command, D2 `--secrets` and capability block, D3 descriptions;
   - D4 working rules.
   
   Smallest change, biggest effect on the observed failures.
2. **Budgets:** D5, with digest metrics computed live.
3. **Evaluation:** D6 digest, D7 evaluator, D8 columns and API.
4. **Audit:** D9, plus evaluating manager turns with the same digest/evaluator shape.

## Tests and acceptance

- **Inventory:** it lists secret names and descriptions and never a value (asserted against stored values). It also lists workflows, skills, agents and helpers.
- **`--secrets`:**
  - with it, only those names are in the task's environment;
  - without it, today's behaviour;
  - unknown or non-agent names are refused with the valid list;
  - the capability block names exactly the granted secrets;
  - redaction covers every granted value.
- **Working rules:** present in every runner's system prompt.
- **Budget:** crossing tokens or active minutes once emits one follow-up and records `budgetExceeded`; the next alert comes at 2×; queued and parked time don't count.
- **Digest, from a replayed event log of the open-webui upgrade task:**
  - it detects the 77k first read;
  - it detects polling (≥3 `isolated-status` checks);
  - it detects repeated patching of `stage-candidate.py`;
  - it detects the manager-skill read.
- **Evaluator:** a recorded model reply validates against the schema; an invalid reply is retried once, then stored as an error; skips apply; evaluator calls never create runs.
- **Columns:** shown from stored evaluations; the aggregates endpoint groups by category and target.

**Acceptance:**
- A rerun of "update production" on open-webui needs no round trip to the user for access.
- No task's first read exceeds 30k characters.
- Every finished task shows a verdict and root cause on its row within a minute.

## Open questions

1. **Should `--secrets` narrow by default?** Make the manager always pass an explicit list, refusing `task create` without `--secrets` when the project has secrets? That's least privilege, at the cost of a little more manager work.
2. **Hard budgets:** should a run past 3× its budget pause and wait for the manager, rather than only alerting?
3. **Evaluating user tasks:** evaluate tasks the owner starts by hand too, or only manager and automation tasks? The default here is all of them.
4. **Default evaluator:** if `davy/mistral-large-4` judges poorly on a sample, use a mid-size model just for `fail` and `partial` verdicts?
