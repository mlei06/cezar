# Software factory: agents that know what they have, lean tasks, and a feedback loop

Status: draft, 2026-11-25. Fork: `mlei06/cezar`, branch `feat/manager-autonomy`.

## TLDR

A first end-to-end test (an autonomous manager on Codex gpt-6.2-sol, asked only "update production") showed good judgement but slow, expensive execution. Agents did not know which secrets, workflows and helpers they had. Tasks read whole docs and polled through the model. Nothing measured how a task went.

This spec adds three things:
1. **Agents know what they have.** Separate list commands for managers (secrets, workflows, skills, models, agents). An optional `--secrets` flag on task create, and the task's secret names written into its prompt. A rule that the manager checks its configuration first.
2. **Lean tasks.** A brief template in the manager skill, and a per-task budget that wakes the manager when crossed.
3. **A feedback loop.** Every finished task gets an automatic evaluation by a cheap model that reads its whole transcript plus measured metrics. It gives a pass/fail verdict, a diagnosis and a root-cause category, and it shows as columns on the task row. Weekly audits read those columns instead of transcripts, and each fix lands where its cause lives:
   - in the project's own repository (docs, AGENTS.md, skills, workflows, structure), fixed by that project's manager;
   - in the harness, fixed by a manager for the Cezar fork itself, which ships through a release it can roll back.

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
- the manager's list commands;
- task secrets and the capability block in task prompts;
- task budgets;
- per-task evaluation (metrics, transcript, evaluator, storage, columns, API);
- routing fixes to the project or the harness, the two weekly audits, and the harness project with its release process;
- the weekly audit job;
- manager guidance.

Out of scope: evaluating manager turns (phase 4), cross-machine aggregation, and changing how secrets are stored.

## Decisions

### D1. Managers check what is configured first: separate list commands

There are many models across Codex, OpenAI, Anthropic and OpenCode providers, so one combined dump would be long and mostly irrelevant. Each kind of configuration gets its own read command, every one with `--project <id>` and `--json`:

| Command | Lists |
|---|---|
| `cez-manager secrets` | names with audiences and description (D3), project and workspace. Never values. |
| `cez-manager workflows` | (exists) each workflow and what it can do |
| `cez-manager skills` | skills a task can be given with `--skill`: the project's (`.ai/skills`, `.ai/cezar/skills`), global (`~/.agents/skills`, `~/.claude/skills`) and team skills, each with its description. Manager-only skills are not listed: tasks can't use them. |
| `cez-manager models [--runner r]` | per runner, the models it accepts and their effort levels, from cezar's model catalogs. Filtered by runner, because the full list is long. |
| `cez-manager agents` | the runner accounts the manager may start tasks on, and each one's usage-limit state (today a section of `status`) |

`manage-project` gains a first step: before planning, and before telling the owner that access, a model or a tool is missing, run the relevant list command. The autonomous system prompt states the same rule in one line.

### Where project knowledge lives (no new storage)

Cezar already has a place for each kind. This spec adds none:

| Kind | Where | How agents find it |
|---|---|---|
| Skills | project: `.ai/skills/<name>/SKILL.md` or `.ai/cezar/skills/<name>/` (committed); global: `~/.agents/skills`; team: the shared skills repo; manager-only: `manager-skills/`, `~/.cezar/manager-skills/` | cezar's skill catalog; `--skill` installs one into a task |
| Helper scripts | **inside the skill that uses them**: `.ai/skills/<name>/scripts/…`, referenced from its SKILL.md (the Agent Skills layout) | through the skill; a deploy skill carries its deploy script |
| Workflows | `.ai/cezar/workflows/*.yaml` | `cez-manager workflows`; `--workflow` |
| Agents (runner accounts) | workspace level, `~/.cezar` agent accounts | `cez-manager agents`; `--runner` and `--account` |
| Facts (hosts, jobs, rules) | the repo's AGENTS.md and the docs it links | read by the manager; passed into briefs |
| Secrets | cezar's secret store, per project or workspace | `cez-manager secrets`; the task's capability block (D2) |

So "helpers" isn't a new concept. A repeatable procedure becomes a project skill with its scripts beside it. The open-webui deploy runbook and `deploy.py` from PR #5 belong together as `.ai/skills/jenkins-deploy/`.

### D2. `--secrets` on task create, and every task told what it has

`cez-manager task create --secrets NAME[,NAME…]` (repeatable) records `grantedSecrets` on the run.
- **With `--secrets`:** the task's environment gets exactly those secrets (D3 audiences still apply), in addition to cezar's own variables.
- **Without it (the normal case):** today's behaviour stays: every `agents`-audience secret of the project and workspace. `--secrets` is optional, for narrowing when a task should see less.
- **Validation:** a name that isn't stored, or whose audiences exclude `agents`, is refused with the list of valid names.

Either way, the task's system prompt gets a **capability block**, built by cezar and never by the model:

```
You have these secrets as environment variables (values hidden; never print them):
  PROD_VM_HOST: production Node1 address
  PROD_VM_USER / PROD_VM_PASSWORD: SSH login for Node1
  JENKINS_URL / JENKINS_USER / JENKINS_PASSWORD: Jenkins API (CA: Michael/certs/ca-bundle.pem)
Workflows in this project: openwebui-deploy (deploys main through Jenkins)
Attached skill: jenkins-deploy (its scripts are in the skill folder)
```

The secret descriptions come from D3; workflows and skills come from the same catalogs as the list commands. The block is capped at 2k characters.

### D3. Secret descriptions

A secret gains an optional `description` field (at most 200 characters, never secret). It's set with `cezar secrets set NAME --description "…"`, in Settings, or by a manager. Both `cez-manager secrets` and the capability block print it.

Without descriptions, names alone already beat the status quo. With them, an agent knows what `JENKINS_VM_PASSWORD` is for without guessing.

### D4. A budget per task that wakes the manager

A run may carry `budget: { tokens?: number, minutes?: number }`.
- **Where it comes from:** `--budget-tokens` and `--budget-minutes` on `task create`, else the project's `taskBudget` in `.ai/cezar/config.json`, else defaults of 3M input tokens and 30 minutes of active time. Time spent queued or parked doesn't count.
- **When it's crossed:** the run records `budgetExceeded` with the metric. The task keeps running; this is not a kill. A run with a manager wakes it with a follow-up event carrying the D5 metrics so far (tokens, calls, largest outputs).
- **The manager's choices:**
  - let it continue, raising the budget with `task budget <run> …`;
  - steer it with `task say`;
  - switch its model with `task switch`;
  - cancel and retry.
- **Without a manager:** the task row shows an amber budget marker.
- **Repeats:** after the first crossing, the next alert comes at 2× the budget, so a task that legitimately runs long doesn't nag.

### D5. Task metrics, and the transcript the evaluator reads

When a run reaches a terminal state, cezar computes `runs/<id>.metrics.json` from the event log. No model is involved. These are only the hard numbers a transcript doesn't state (durations, tokens, context per call); spotting patterns such as polling or re-patching is left to the evaluator, which reads the transcript. It holds:

- **Identity:** the workflow, runner, model, effort and account; who started the run (a manager, a user or an automation); any attached skill and granted secrets.
- **The brief:** the task text, clipped to 4k characters, with secrets redacted.
- **Timing:** wall time; active time; total model time against tool time; queued and parked time.
- **Tokens:** total input and output, cache reads, model calls, average and peak context per call.
- **Tool calls:** the count; the 10 longest, with duration and command head; the 10 largest outputs, with their size.
- **Outcome:** final status, the last message (clipped), PR URL and state, review verdicts on that PR, check results, and budget crossings.
- **Interventions:** every `task say`, retry or switch, with who did it.

**The evaluator reads the whole transcript.** The metrics go first, then the full transcript rendered as plain text: the brief, every message, every tool call and every tool output, in order, with JSON wrappers stripped and secrets redacted. The 10.7M-token figure for the upgrade task was cumulative re-reading. Its transcript itself is about 340k tokens as raw JSON and smaller once rendered, within a long-context model's window.

When a transcript is longer than the evaluator's context window, cezar shortens only the largest tool outputs, keeping each one's head and tail and noting how much was cut, until it fits. It never drops calls or messages. The metrics header always stays whole, since it carries the efficiency evidence (tool time against model time, context per call) that a transcript doesn't show.

### D6. Per-task evaluation: a separate automatic job, not the manager

**Decision:** a separate evaluator runs automatically after every terminal task. The manager doesn't do it. Reasons:
- **Consistency:** every task is judged by the same rubric and model, including tasks a user or automation started. The manager only knows its own tasks.
- **Cost:** one call to a cheap, self-hosted model per task, against a frontier manager turn re-reading its own session.
- **Independence:** the manager doesn't grade its own briefs.
- **Wake-ups:** evaluation shouldn't burn a manager turn on every task.

The manager still reads the result. The verdict and root cause ride on the task's status card, and a `fail` with a fixable cause wakes it as part of the normal follow-up.

**How it runs:**
- **Model:** an internal, tool-less model call, not a cezar task, so evaluations never create runs, worktrees or more evaluations. The runner and model come from workspace settings `evaluation.runner` and `evaluation.model`. The default here is `opencode` + `davy/mistral-large-4`, which is self-hosted, so transcripts stay on the machine and the company network.
- **Prompt:** the rubric below, the metrics and the full transcript (D5). The answer is JSON validated by a zod schema, retried once on invalid output, else stored as `evaluation.error`.
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
      "evidence": "the transcript or metric fact it rests on",
      "fix": "the concrete change that would have prevented it",
      "target": "cezar | manager-skill | brief | agents-md | repo-tooling | workflow | infra"
    }
  ],
  "summary": "two or three sentences for the audit",
  "evaluator": { "runner": "opencode", "model": "davy/mistral-large-4", "transcriptTokens": 212000, "shortened": false }
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

`pass` means the brief's done criteria were met; `partial` that some were; `fail` that none were, or the outcome was wrong. Efficiency is judged against the task's size, using the metrics and the transcript.

### D7. Task row columns and API

- **Columns** on the Tasks table (hidden by default, toggled in the column menu): Verdict, Efficiency, Root cause (the first category, plus a count), Tokens, Active time and Model.
- **Detail:** the task detail gets an Evaluation panel showing the summary, root causes with evidence and fixes, and the metrics.
- **API:**
  - `GET /p/:id/runs?evaluated=1` filters to evaluated runs;
  - `GET /p/:id/runs/:run/evaluation` returns one evaluation;
  - `GET /workspace/evaluations?since=7d&groupBy=category` returns aggregates for the audit.

### D8. Fixes land where the root cause lives: project repo or harness

A root cause lives in one of two places, and each has an owner that can change it through ordinary tasks and pull requests.

**The project's factory, in the project's repository.** This is "factory as code": everything that shapes how agents work on one project is committed in that repo, where its tasks can change it.

| Fix | Where it lands |
|---|---|
| Docs cleanup, a shorter required reading path | the repo's docs |
| Project facts and rules | `AGENTS.md` |
| A repeatable procedure, with its scripts | `.ai/skills/<name>/` (scripts in `scripts/`) |
| A routine job that shouldn't need a model | `.ai/cezar/workflows/` |
| Structure that confuses agents: refactors, file splits, test entry points | the code itself |
| Task defaults (budget, models) | `.ai/cezar/config.json` |

**The harness, in the Cezar fork's repository.** These fixes change how every project's agents work:
- the engine and runners;
- tool grants and hooks;
- system prompts and the capability block;
- manager skills (`manager-skills/`);
- the evaluator.

**Routing.** The evaluator's `target` (D6) decides where a fix goes:

| `target` | Owner | Repository |
|---|---|---|
| `agents-md`, `repo-tooling`, `workflow`, `brief` | that project's manager | the project |
| `cezar`, `manager-skill` | the harness manager (D9) | the Cezar fork |
| `infra` | the owner, via the project manager | outside both: credentials, CI configuration |

**Cross-project promotion.** When the same project-level cause shows up in two or more projects within the audit window, it's a harness problem in disguise. The harness manager fixes it once:
- a better default;
- a global skill;
- a check that warns when a repo lacks something.

That replaces patching each repo. For example, "the required reading is over 30k characters" in several repos suggests a skill or check for lean `AGENTS.md`, not five documentation PRs.

**The audit runs at two levels.** Both are weekly manager jobs that read only evaluation fields (D7), on the low-reasoning model:
1. **Project audit,** run by each project manager over its own project's evaluations. It picks the top project-level causes, then starts a task per fix with the right skill attached (docs cleanup, AGENTS.md, a new skill or workflow, a refactor). Each opens a PR in the project. Larger refactors are proposed to the owner first, since they touch product code.
2. **Harness audit,** run by the harness manager over every project's evaluations. It takes the harness-targeted causes and the cross-project repeats, and turns them into tasks in the Cezar fork.

Each audit posts one message with the week's numbers, its changes, and the change against the previous week for the causes it fixed earlier (D9).

### D9. The harness maintains itself: a project for the Cezar fork

The fork (`~/dev/cezar`, remote `mlei06/cezar`) is registered as a Cezar project like any other, with its own manager: the harness manager. Its tasks diagnose and change the harness's own code, prompts, skills and hooks, through branches, tests and PRs, like any project.

Changing the program that is running needs three guarantees.

1. **The running harness is a release, not the working tree.** The cockpit service runs from a release built from a merged commit, for example `~/.cezar/harness/releases/<sha>/` behind a `current` symlink, never from `~/dev/cezar` directly. Today the service runs straight from `~/dev/cezar/packages/cezar/dist`, so merging or building there changes the live harness mid-task. That has to change before the harness manager is allowed to merge.
2. **Deploying the harness is a workflow,** `harness-release`, and it's mostly check steps:
   1. full typecheck, tests and build on the merged commit;
   2. install it as a new release;
   3. wait until no task is running and no manager turn is active;
   4. switch `current` and restart;
   5. check `/api/v1/health` and run one dry-run task;
   6. on failure, switch back to the previous release and restart.
3. **Attribution.** Every evaluation records the harness release it ran under (`harnessVersion`). The harness audit compares a cause's rate and cost before and after the release that targeted it, and reverts a change that made things worse.

**Limits:**
- **The grader:** changes to the evaluator, its rubric or its model need the owner's approval, because a factory that grades itself can learn to pass its own test.
- **Upstream:** each harness PR is labelled fork-only or upstreamable, so generic improvements can also go to open-mercato/cezar.
- **Overrides:** `~/.cezar/manager-skills/` stays for local experiments that shadow the fork's skills. A change that works there is moved into the fork by PR.

## Modules

| Module | Change |
|---|---|
| `managers/manager-cli.ts`, `cli-vocabulary.ts` | `secrets`, `skills`, `models`, `agents`; `task create --secrets` (optional), `--budget-tokens`, `--budget-minutes`; `task budget <run>` |
| `managers/engine.ts` | routes for the list commands; grantedSecrets and budget on createTask; budget follow-up events; evaluation summary on status cards |
| `contract/src/managers.ts`, `runs.ts`, `secrets.ts` | `grantedSecrets`, `budget`, `budgetExceeded`, `evaluation` on RunRecord; secret `description` |
| `workspace/secrets.ts`, `secrets-cli.ts`, Settings | `description` |
| `workflows/run.ts` | the capability block in the system prompt; grantedSecrets narrowing; budget accounting from token-usage events; a metrics-and-evaluate hook on terminal status |
| `evaluation/metrics.ts` (new) | metrics from the event log; transcript rendering, shortened to fit a context window |
| `evaluation/evaluate.ts` (new) | the tool-less model call, rubric, zod schema, storage and re-run |
| `server/server.ts` | evaluation routes and aggregates |
| web Tasks table and detail | columns and the Evaluation panel |
| `manager-skills/manage-project` | check-first with the list commands; budgets; project-audit steps |
| `manager-skills/manage-harness` (new) | the harness manager's playbook: harness audit, cross-project promotion, `harness-release`, attribution |
| harness release layout + `harness-release` workflow (new, in the fork's `.ai/cezar/workflows/`) | build, test, install, drain, switch, health-check, roll back |

## Phases

1. **Know what you have:**
   - D1 list commands, D2 the capability block and optional `--secrets`, D3 descriptions.
   
   Smallest change, biggest effect on the observed failures.
2. **Budgets:** D4, with the D5 metrics computed live.
3. **Evaluation:** D5 metrics and transcript, D6 evaluator, D7 columns and API.
4. **Audit:** D8 project and harness audits.
5. **Self-maintenance:** D9. Release-based service install and `harness-release` first, then register the fork as a project with its harness manager. Evaluating manager turns the same way comes last.

## Tests and acceptance

- **List commands:** `secrets` lists names and descriptions and never a value (asserted against stored values); `skills` excludes manager-only skills; `models --runner codex` lists only Codex models.
- **`--secrets`:**
  - with it, only those names are in the task's environment;
  - without it, today's behaviour;
  - unknown or non-agent names are refused with the valid list;
  - the capability block names exactly the granted secrets;
  - redaction covers every granted value.
- **Budget:** crossing tokens or active minutes once emits one follow-up and records `budgetExceeded`; the next alert comes at 2×; queued and parked time don't count.
- **Metrics, from a replayed event log of the open-webui upgrade task:** 116 model calls, about 93k average context, the 77k-character first output among the largest, and model time greater than tool time.
- **Evaluator:** the rendered transcript keeps every call and message; an over-long transcript is shortened only in its largest outputs and fits the window; a recorded model reply validates against the schema; an invalid reply is retried once, then stored as an error; skips apply; evaluator calls never create runs.
- **Columns:** shown from stored evaluations; the aggregates endpoint groups by category and target.
- **Routing:** project targets reach the project manager's audit; `cezar` and `manager-skill` targets, and causes repeated across two projects, reach the harness audit.
- **Harness release:** a failing health check after a switch restores the previous release; a switch never happens while a task or manager turn is active.

**Acceptance:**
- A rerun of "update production" on open-webui needs no round trip to the user for access.
- No task's first read exceeds 30k characters.
- Every finished task shows a verdict and root cause on its row within a minute.

## Open questions

1. **Hard budgets:** should a run past 3× its budget pause and wait for the manager, rather than only alerting?
2. **Evaluating user tasks:** evaluate tasks the owner starts by hand too, or only manager and automation tasks? The default here is all of them.
3. **Default evaluator:** if `davy/mistral-large-4` judges poorly on a sample, use a mid-size model just for `fail` and `partial` verdicts?
4. **Mistral's context window:** confirm `mistral-large-4`'s window on the davy endpoint. That sets how often transcripts need shortening.
