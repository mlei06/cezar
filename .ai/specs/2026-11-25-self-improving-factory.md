# The self-improving factory

Status: draft v5.17, 2026-11-25. Fork: `mlei06/cezar`, trunk `factory`. Spec owner: the overseer (see the roadmap). Implementation plan: `2026-11-25-self-improving-factory-roadmap.md`. Findings during the build: `2026-11-25-self-improving-factory-observations.md`.

## TLDR

Cezar already runs a factory: managers turn outcomes into tasks, tasks run workflows on agents, and pull requests come back for review or merge. What it lacks is the loop that makes the factory better over time. This spec adds that loop, modelled on Warp's software factories and adapted to a local, zero-config cockpit run by one person:

1. **Factory as code, using what Cezar already has.** A project's factory is the set of files it commits: workflows, skills, scorers, benchmarks and AGENTS.md. Workflows double as Warp's agent roles: one file says which model, skill, secrets and budget a kind of task gets. Policy (thresholds, approvals, the judge) stays in Cezar's settings, global with per-project overrides, out of reach of the loop.
2. **Agents know what they have.** List commands for managers; a capability block in every task's prompt (its secrets, workflows and skill); secret descriptions; optional secret narrowing.
3. **Bounded tasks.** A per-task token and time budget that wakes the manager when crossed.
4. **Scoring.** After every run, scorers (each a rubric, labels with scores, a pass threshold) are judged by a cheap, self-hosted model. The judge reads Cezar's existing metrics plus the full transcript. A failing score names one to three root causes, each with a target: the place its fix belongs.
5. **Self-improvement.** Root causes are routed to the queue of whoever can fix them: the project or the harness. A deterministic timer starts an improvement run when a queue fills or ages; the manager or the owner can also start one. The run clusters the causes and opens a pull request of redrafts that lists the regressions it addresses.
6. **Verification and replay.** Every run records its starting commit and harness version, so any task can be replayed from its original input with one thing changed (harness release, workflow, model, skill or brief), as a variant beside the original, and compared by score. Benchmarks are saved collections of replays. Before/after comparison of scores checks a change after it merges.
7. **A self-maintaining harness.** The Cezar fork is a project with its own manager. Cezar runs from pinned releases, so a harness change ships through a benchmarked release with automatic rollback.
8. **Managers that run ungated.** Every manager follows the same operating rules (D11): reviews only for runtime changes, its own decision after two review rounds, ambiguities decided and recorded for the owner to audit, and shared-machine limits on test runs.
9. **A manager that leads the project.** Each project keeps a committed charter (vision, goals, a ranked backlog, progress). Its manager drafts and maintains it, scales effort to the job, writes self-contained briefs, proposes and starts work within the vision on its own, and reports progress against the goals (D12).

## Contents

- Evidence, Principles, Glossary
- Reuse map: what Cezar already has, part by part
- Decisions D1–D12
- Data model and storage
- Settings, CLI and API reference
- Failure handling and edge cases
- Security and privacy
- Zero config and compatibility
- Already shipped, Modules, Tests and acceptance, Open questions, Changelog, Sources

## Evidence (first end-to-end test, 2026-11-25)

The first end-to-end test: an autonomous manager on a frontier model, asked only to deploy a project's new upstream release to production. (Project-specific details live in that project's own repository.)

| What happened | Root causes | Where the fixes live |
|---|---|---|
| A round trip to the user for SSH access the agents already had (`DEPLOY_*` host) | agents weren't told their secrets | harness: capability block (D3) |
| The upgrade task ran 25+ min: 116 model calls averaging 93k tokens of context (10.7M input in all), with 62% of the time spent in the model | a 77k-character first read (docs) carried by every call; a brief that said "read the docs"; builds polled through the model | project: a shorter required reading list; the manager's brief; harness: budget (D4) |
| The task rebuilt backup and staging scripts that already existed | the helpers sat in an ignored folder, invisible to task worktrees | project: helpers inside a committed skill |
| A workflow task invented secret names and grew the scope | no list of secrets; a loose brief | harness: D2/D3; project: a deploy workflow |
| 7 review runs voted "reject" with no findings | reviewers couldn't read Azure PR diffs | harness: fixed in `6a00d2387` |
| The manager playbook leaked into task agents | installed globally | harness: fixed in `6f8519c88` |
| Two stray managers | test sandboxes got automatic managers | harness: fixed in `6f8519c88` |

One task often has several causes in different places. That's why a failure carries up to three (D5).

## Principles

- **The manager stands in for the owner, through the same doors.** Creating a task by hand (a project's New task: description, workflow, model, skill) stays the first-class path, and every addition here (workflows, the capability block, budgets, scores) applies to hand-made tasks exactly as to the manager's. The manager creates and oversees tasks through those same task paths; it never gets a mechanism the owner can't use by hand.
- **Zero config.** Every file is optional. Cezar ships default workflows, scorers and settings, and an empty repo still gets scoring and self-improvement.
- **Reuse before adding.** Extend Cezar's workflows, settings, metrics and automations; add a concept only when nothing existing can carry it.
- **Fixes as pull requests.** Every improvement is a reviewed diff. Nothing rewrites factory files in place.
- **Redrafts, not additions.** A self-improvement change rewrites the guidance it touches and removes what's outdated. Skills and AGENTS.md get shorter or stay the same length unless the PR says why.
- **Policy is not factory.** What the loop may edit (workflows, skills, docs, code; scorer rubrics only with the owner) lives in repos. What governs the loop (thresholds, approvals, judge, scope) lives in settings, which the loop can't change.
- **Nobody grades their own grader.** Changes to scorers, the judge, or the self-improvement workflow and skill always need the owner.
- **Deterministic where possible.** Metrics, routing, triggers, guards and bookkeeping are code. Models do only the judging, clustering and writing.

## Glossary

| Term | Meaning |
|---|---|
| Owner | the person the factory works for |
| Overseer | the agent outside Cezar that, during the build, prompts and watches the harness manager and owns this spec (roadmap) |
| Factory | a project's committed definition of how agents work on it: workflows, skills, scorers, benchmarks, AGENTS.md |
| Harness | Cezar itself: engine, runners, grants, hooks, system prompts, manager skills, built-in workflows and scorers |
| Harness project | the registered project whose repository is the harness (the Cezar fork) |
| Manager | the long-lived agent that owns outcomes for its projects (Warp's foreman) |
| Task | one run of a workflow, with its own branch and worktree |
| Task workflow | a workflow used as a role: usually one agent step that fixes the model, skill, secrets and budget for a kind of task |
| Scorer | a rubric, labels with scores, a pass threshold, a sample rate |
| Score | one scorer's verdict on one run |
| Failure | a failing score; it carries 1–3 root causes |
| Cause | one root cause: category, target, evidence, fix |
| Queue | the unprocessed causes owned by one project, or by the harness |
| Improvement run | a task that turns a queue's batch into a pull request |
| Cluster | causes an improvement run judged to share one underlying problem |
| Benchmark | reference tasks with success criteria, run across configurations and scored |

## Reuse map: what Cezar already has, part by part

Every part of this spec builds on something Cezar already has. Where a part needs something new, the reason is given. The decisions below follow this map.

| Spec part | What Cezar already has | Use | What's new, and why |
|---|---|---|---|
| Factory files (D1) | workflows in `.ai/cezar/workflows/`; skills with local-first discovery; AGENTS.md; workflow validation (`stepsIssue`, `graphIssues`, `POST /workflows/parse`); the `.ai/cezar/.gitignore` allowlist | reuse | scorer and benchmark files, which have no home today; `cez factory check` wraps the existing validators and adds theirs |
| Settings (D1) | workspace `~/.cezar/config.json` and project `.ai/cezar/config.json`, with the schema rules (every field optional with `.catch`, `mergeWriteWorkspaceConfig`), and the Settings frame | extend | a `factory` section in both |
| Task workflows (D2) | per-step runner, model, effort, skill, allowed tools; step choice wins over task and project defaults; built-ins via `builtIn()` in `workflows/templates.ts`; `secrets:` on check steps; `budgetUsd` on dispatched subtasks; `.ai/agentic.config.json` `validation.commands` | extend | workflow `budget:`, agent-step `secrets:`, three built-in task workflows |
| List commands (D3) | `cez-manager workflows`; the `/models`, `/skills`, `/secrets` and `/workflows` routes; agent accounts in `cez-manager status`; manager tools forward in process to existing routes | reuse | thin `cez-manager` commands over the existing routes |
| Capability block (D3) | the run's system prompt is composed from global, project, workflow and skill instructions and saved on the run (`systemPrompt`) so Continue reuses it; secrets are already injected | extend | one more composed section, saved with the rest |
| Secret descriptions (D3) | the secret store keeps metadata (audiences, `updatedAt`) beside the encrypted value | extend | a `description` field |
| Budgets (D4) | dispatch's `budgetUsd`: a child's budget is carved from its parent's, and a run that reaches it parks at turn end and stops auto-continuing; usage-limit parking; manager follow-up events | rework | one run budget with `usd`, `tokens` and `minutes`, for every run; the existing park behaviour stays for dispatch children, and top-level runs notify instead |
| Metrics (D5) | run record tokens, cost, times, diff stats, models, peak memory, live context; per-step usage counters; the plan-usage ledger; event timestamps; `TurnStatsCollector` (manager turns only) | reuse | `TurnStatsCollector` extended to task sessions; a derived summary file |
| Judge (D5) | one-shot model calls for commit messages, titles and branch names: `createRunner` + `runner.run({ allowedTools: [] })`, two attempts with the rejection reason, a timeout, and `trackOneShot` with `INTERNAL_CONSUMERS` in the usage ledger | reuse | an `INTERNAL_CONSUMERS.scoring` entry; the judge prompt and validation |
| Score columns and panels (D5) | the Tasks table's column system (tokens, cost, CPU, memory, plan limit…) and column menu; task detail panels; the plan-usage chip | extend | three columns and a Scores panel |
| Improvement trigger (D6) | automations: a coordinator, event sources (`github`, `schedule`, `tracker`), dedupe and receipts, the execution log, skipped-with-reason entries, and reporting each run to a manager | extend | a `factory` event source that fires when a queue passes its threshold or age; the guards live in the source; a built-in automation per project launches `improve-factory` |
| Improvement runs (D6) | ordinary tasks; manager follow-ups; `review-pr`; manager merge; draft PR and mark-ready nodes (GitHub and Azure) | reuse | the `improve-factory` workflow and skill; queues and bookkeeping, which have no home today |
| Replay (D8) | parallel variants (spec 010): runs sharing a `groupId`, each with a `variant` label, grouped in the task list, compared side by side in `/groups/:groupId`; `task retry` with another runner or model; the run's saved `workflowDef` and `systemPrompt` snapshots | extend | run identity (`startCommit`, `harnessVersion`); variants with per-variant overrides and a replay source; score columns in the Compare view |
| Benchmarks (D8) | variants and the Compare view (above) | extend | suites: saved replays with success criteria, run as a matrix |
| Harness releases (D9) | self-update: installs in `~/.cezar/versions/<id>` with a `current` link and `~/.cezar/bin` launchers; `cezar install` packs and installs the running build; `cezar use <id>` switches (rollback); `cezar link`; supervisor restart (`CEZ_SUPERVISED=1`); version pruning with in-use leases | reuse | the `harness-release` workflow around them: wait for idle, the health check with automatic `use <previous>`, the staging cockpit, the release log |
| Project lead (D12) | manager short sessions that restart from cezar-owned memory (spec 2026-11-21); `manage-project`; manager jobs | extend | the `.ai/project.md` charter, read at every session start and written back after each outcome; the skill rewrite |
| Reports (D10) | manager jobs; HTML artifacts in a task's Assets (sandboxed, CDN allowlist) | reuse | the report content |
| Proactive triggers (D10) | schedule automations; the built-in `fix-ci` workflow; GitHub check events | reuse | a `credential-health` workflow per project; on Azure Repos, CI failures need an Azure event source (backlog) |
| Events (all) | the workspace SSE bus, and the WebSocket topic bus | reuse | new event kinds only |

## Decisions

### D1. Factory as code, and where settings live

**What a project commits** (all optional, all existing Cezar locations except scorers and benchmarks):

```text
AGENTS.md                                project facts and rules
.ai/cezar/workflows/*.yaml               workflows, including task workflows (D2)
.ai/skills/<name>/SKILL.md (+ scripts/)  skills, with their helper scripts
.ai/cezar/scorers/<name>/scorer.md       scorers (D5)
.ai/cezar/benchmarks/<suite>/            benchmarks (D8)
```

A project file overrides a built-in with the same name. `cez factory check` validates them all and is a check step any workflow can run. It checks:
- the schemas;
- cross-references (a workflow's skill exists; a scorer's workflows exist; a suite's tasks exist);
- that every scorer has a passing and a failing label.

An invalid file is reported, and the last valid version stays in effect.

**Policy lives in Cezar's settings**, global first with per-project overrides, like every other Cezar setting:
- **Global** (`~/.cezar/config.json` → `factory`, Settings → Global → Factory): the judge, sample rates, the default task budget, the default self-improvement policy, the harness project.
- **Per project** (`.ai/cezar/config.json` → `factory`, Settings → project → Factory): overrides of the budget and the self-improvement policy (thresholds, approval, scope, on/off).
- **Built-in defaults** apply when neither sets a value (D7). The keys are in "Settings, CLI and API reference".

There is no `factory.yaml`. Its contents were policy, and policy must stay outside what an improvement run can edit.

### D2. Task workflows: model, skill, secrets and budget as one file

Cezar's workflow step already sets the runner, model, effort, skill, allowed tools and prompt, and it already wins over the task and project defaults. So a reusable kind of task (Warp's role) is a workflow, usually with one agent step. Two additions make it complete:

- **`budget:`** on the workflow: `{ tokens, minutes }` for the whole run (D4).
- **`secrets:` on agent steps**: an optional list that narrows which `agents`-audience secrets the step receives. Without it the step gets all of them, as today. The current load error for `secrets:` on an agent step is lifted. On a check step `secrets:` keeps its existing meaning.
  - **On Continue, retry or a runner/account switch:** the continued session uses the allowlist of the agent step whose session it resumes, as recorded when that step actually launched. When that can't be determined (no launched step recorded, or the step is ambiguous), it uses the **narrowest** policy: the intersection of every agent step's allowlist in the workflow, where an omitted list counts as "all" and `[]` as none. Never widen on doubt. (v5.4, settled after two review rounds found corner cases.)

```yaml
name: operate
description: Run a known workflow or script and report the result; low reasoning.
budget: { tokens: 800000, minutes: 20 }
steps:
  - id: work
    runner: opencode
    model: low-reasoning   # resolved from the machine's `factory.models.lowReasoning` setting
    prompt: "{{task}}"
```

**Built-in task workflows** ship in the harness, next to `quick-task` and `review-pr`:

| Workflow | Runner and model | Budget | Use |
|---|---|---|---|
| `implement` | ordinary task route | 3M, 30 min | coding and fixes; ends at a PR |
| `plan` | ordinary task route, read-only | 1.5M, 20 min | specs, investigation, design |
| `review-pr` (exists) | ordinary task route, read-only | 1.5M, 20 min | PR review |
| `operate` | the machine's low-reasoning model (`factory.models.lowReasoning`) | 800k, 20 min | running known workflows or scripts, status, summaries, moving docs |
| `improve-factory` | project default | 4M, 45 min | improvement runs (D6); owner-protected |

**`implement` validates with check steps, not with the model.** Its graph is an agent step, then one check step per validation command, with a failing check looping back to the agent (at most twice). Waiting for the tests is then the engine's job. The commands come from the project's existing `.ai/agentic.config.json` (`validation.commands`, which the om-* skills already read). When the file is missing, or has no `validation.commands`, they come from the project's `test` script. With neither, `implement` runs no checks and opens the PR with a note that no validation is configured (v5.9). Guidance in a skill wasn't enough: the M0 warm-up task polled its test run across eight model turns although `factory-work` told it not to (observation M0-6).

The `low-reasoning` and `high-reasoning` aliases resolve to `factory.models.lowReasoning` and `factory.models.highReasoning`, each a runner and model pair in local workspace settings. An unset alias uses the project's default runner and model, with low or high effort where supported and a note on the task. A project overrides a built-in by committing a workflow with the same name.

**Delegated task routing (M2).** The manager chooses a workflow and decides whether the work needs high reasoning. Cezar resolves the task's route at admission using the workspace's configured accounts and models:

| Work | Owner's preferred route |
|---|---|
| Following a known playbook, routine checks and summaries | Mistral through OpenCode via `low-reasoning`. Keep side effects in deterministic check steps when the workflow supports it. The OpenAI cutoff does not apply to this route. |
| Ordinary implementation, investigation and review | The project default runner and model, for example GPT‑6.2 Sol through Codex. For new work, use the configured `high-reasoning` route when current applicable usage for the selected OpenAI account exceeds the threshold. |
| Work explicitly requiring high reasoning | Opus 5.5 through Claude Code from the start. |

Extend the existing manager account selection in `managers/task-agent-choice.ts`. It already skips accounts held at their usage limits. Apply `factory.models.switchAbove` to the same account's applicable usage readings at admission. It is a share with a default of `0.8`. Stale or unknown readings leave the ordinary route in place. The existing eligible-account and queue rules still govern capacity. An admitted run keeps its selected route when usage changes. Explicit workflow pins take precedence.

When the primary low-reasoning model is unreachable, use the first eligible pair with capacity from the ordered `factory.models.lowReasoningFallback` list. The owner's local order is a cheap hosted Codex model followed by a cheap hosted Claude Code model. Resolve reachability at admission with a short cached probe of the primary's model endpoint through its configured relay. Target a five-second timeout and a one-minute cache. When every reachable allowed route is at its usage limit, use the existing account queue. When the low tier has no configured primary or fallbacks, preserve its zero-config behavior. Low-to-low hosted fallback is the only tier substitution for an explicitly low or high task. The run stores the selected runner and model and adds a note when the low-tier fallback is used.

Keep model identifiers and endpoint details in local settings. Use generic placeholders in repo code, tests and fixtures.

The manager's **own chat model stays user-selected**. The owner's preferred selection is GPT‑6.2 Sol. The 80% policy only routes delegated tasks and never changes the manager's chat model.

A project adds its own task workflows. A deployment project's `deploy`, for example:

```yaml
name: deploy
description: Deploy main to production through the project's CI and verify it.
budget: { tokens: 600000, minutes: 60 }
nodes:
  - { id: start, type: start }
  - { id: preflight, type: check, command: python3 .ai/skills/deploy/scripts/deploy.py preflight }
  - { id: rollout, type: check, command: python3 .ai/skills/deploy/scripts/deploy.py apply }
  - id: report
    type: agent
    model: low-reasoning
    skill: deploy
    secrets: [CI_URL, CI_USER, CI_TOKEN, DEPLOY_HOST]
    prompt: "Summarize the rollout from {{nodes.rollout.output}} in three sentences."
  - { id: done, type: end, status: success }
edges:
  - { from: start, to: preflight }
  - { from: preflight.pass, to: rollout }
  - { from: rollout.pass, to: report }
  - { from: report.done, to: done }
```

The manager picks the workflow with `--workflow`. `--model`, `--skill`, `--secrets` and the `--budget-*` flags override single settings for one task. Model routing lives in workflow files, where an improvement run can change it in a one-line, reviewed diff. `manage-project` says only: pick the workflow that fits, and propose a project workflow when a kind of task recurs.

### D3. Agents know what they have

**Manager list commands.** Each takes `--project` and `--json`:

| Command | Lists |
|---|---|
| `cez-manager workflows` | (exists) each workflow, what it can do, and its model and budget |
| `cez-manager secrets` | names, audiences and descriptions; never values |
| `cez-manager skills` | skills a task can be given; manager-only skills excluded |
| `cez-manager models [--runner r]` | models and effort levels per runner |
| `cez-manager agents` | runner accounts available to tasks, with usage-limit state |
| `cez-manager scores [--since 7d]` | pass rates per scorer, open causes and queue state |

`manage-project` starts with this rule: before planning, and before telling the owner something is missing, run the relevant list command.

**The capability block.** Cezar writes it into every task's system prompt, capped at 2k characters, after the project and workflow instructions. The model never writes it:

```
Workflow: deploy (low-reasoning model); budget 600k tokens, 60 min active
Secrets in your environment (values hidden; never print them):
  CI_URL / CI_USER / CI_TOKEN: the CI server's API
  DEPLOY_HOST: production host address
Other workflows in this project: implement, plan, review-pr, operate
Attached skill: deploy (scripts in its folder)
```

Over the cap, Cezar trims in this order: other workflows' names, then secret descriptions. Secret names are never dropped, and the cap doesn't apply to them. If the names alone would exceed 2k, they're listed compactly, comma-separated on one line, and the block may run over the cap by that much. It also reports how many entries it omitted, on one short line. That omission line, like the secret names, is mandatory and exempt from the cap: the cap governs only the optional content (descriptions and other workflows). (v5.3, v5.5, both after the manager flagged boundary conflicts.)

**Secret descriptions.** A secret gains an optional `description` (at most 200 characters, never secret, never redacted). A description is user-written metadata: printable text, one line. At write time, a description containing control characters (NUL included) or its own secret's value is refused. There is no scanning of descriptions against other secrets or host credentials. Prompts render descriptions as stored, except that a description failing either write-time check (its own secret's value, or control characters) is omitted. That covers descriptions written before the checks existed, and no runner ever needs to escape a description (v5.7, v5.10). (v5.6, settled after review rounds kept extending description scrubbing.) It's set with `cezar secrets set NAME --description "…"`, `cezar secrets describe NAME "…"`, in Settings, or by a manager.

### D4. One run budget, for every run

Cezar already has a budget: dispatch's `budgetUsd`. A dispatched child's budget is carved from its parent's, and a run that reaches it parks at turn end and stops auto-continuing. This decision generalizes it rather than adding a second one.

- **The budget** is `{ usd?, tokens?, minutes? }` on any run. It replaces `budgetUsd` on dispatch records, which keep parsing; `budgetUsd: n` reads as `{ usd: n }`. Cost alone isn't enough: Codex and OpenCode on subscriptions report little or no cost, so tokens and time are the reliable limits.
- **Precedence:** the task flag, else the workflow's `budget:`, else (for a dispatched child) the share carved from its parent, else the project setting, else the global setting (default 3M input tokens and 30 active minutes).
- **Accounting:**
  - **Tokens** are input tokens summed over every step and model call, which the run record already tracks.
  - **Active time** is time with a step running. Queued time, parking (usage-limit holds, waiting on the owner) and time at a human gate don't count.
- **What happens when it's crossed** depends on the run's `onBudget` action:
  - `park` (the existing dispatch behaviour, still the default for dispatched children): the run parks at turn end and stops auto-continuing.
  - `notify` (the default for every other run): the run keeps going and records `budgetExceeded: { metric, at, value }`. A managed run wakes its manager through the existing follow-up channel, with the metrics so far, the five largest tool outputs and the current step.
- **The manager's options when woken:**
  - raise the budget: `cez-manager task budget <run> --tokens N --minutes M`;
  - steer the task with `task say`;
  - switch its model with `task switch`;
  - cancel and retry.
- **Repeats:** the next `notify` alert comes at 2× the budget, then 4×.
- **Unmanaged runs** get an amber marker on their row and in the task header.

### D5. Scoring

**Metrics: reuse what Cezar records.** Cezar already records for every run:
- on the run record: tokens in and out, cost, start and finish times, diff stats, models used, peak memory and processes, live context against the window, PR and completion reason;
- per step: tokens, cost, retries, iterations, invocations and turns;
- in the plan-usage ledger: cost and token weights and activity spans per consumer;
- in the event log: a timestamp on every event.

Two additions:
- `TurnStatsCollector`, which records model requests, first and peak context, tool-result characters and cache reads for each manager turn, is extended to task sessions (per step).
- Tool-call durations and output sizes are computed from the event log.

At the end of a run, a `metrics` summary is derived from these (see "Data model") for the judge and the cockpit. No new tracking.

**Scorers.** A scorer lives in `.ai/cezar/scorers/<name>/scorer.md`, or is built in:

```markdown
---
description: Did the task deliver what its brief asked, within scope?
workflows: [implement, operate]   # which runs it scores; default all except benchmarks
labels:
  - { value: delivered, score: 1.0, description: met every done criterion in the brief }
  - { value: partial, score: 0.5, description: met some criteria or needed a human to finish }
  - { value: missed, score: 0, description: did not deliver, or delivered the wrong thing }
passingScore: 1.0
samplingRate: 100
---
Judge the run against its brief only. Quote the transcript lines your label rests on.
```

**Built-in scorers:**

| Scorer | Grades | Labels (score) | Pass at |
|---|---|---|---|
| `outcome` | did it meet the brief's done criteria | delivered (1), partial (0.5), missed (0) | 1 |
| `efficiency` | time and tokens against the task's size: needless reads, polling through the model, rebuilt tooling, repeated failures, wrong model for the work | lean (1), some-waste (0.6), wasteful (0) | 0.6 |
| `procedure` | did it follow AGENTS.md, its workflow, its skill and the brief's constraints (tests run, branch rules, no forbidden actions) | followed (1), minor-lapse (0.6), broke-rules (0) | 0.6 |
| `scope` | did it stay inside the brief | in-scope (1), drifted (0.5), out-of-scope (0) | 1 |

The built-in rubrics start as the overseer's tuned drafts from the build (roadmap M0.6 and M3).

**The judge.**
- **Who:** the machine's `factory.judge` setting (a runner and model). Cezar names no provider. Unset, the judge is the project's default runner at low effort. A self-hosted model is the intended choice, so transcripts stay inside the owner's network and scoring costs only time.
- **How:** the same one-shot call Cezar already makes for commit messages and titles. That's `createRunner` and `runner.run` with no tools, a timeout, and two attempts where the second carries the rejection reason. It's tracked in the usage ledger as a new internal consumer, `scoring`. One call per scorer, never a task, so scoring creates no runs. Calls run one at a time per machine (a small queue).
- **What it reads:** the rubric, the labels, the metrics, then the full transcript as plain text ("Data model" describes the format).
- **Too long:** a transcript longer than the judge's window is shortened only in its largest tool outputs, keeping each one's head and tail. A call or message is never dropped.
- **Its reply:** JSON, validated against the scorer's labels; retried once if invalid, then recorded as an error.
- **Reaching the model:** the configured runner must reach its endpoint. A runner that can't verify an endpoint's certificate is a machine setup problem: a judge that fails shows a clear error on the Factory view, never silent gaps.

**A score** holds the label, its score, pass or fail, and reasoning with quoted evidence. **A failing score names 1–3 causes**, the first being the main one:

```json
{ "category": "harness | task-setup | repository | access | model | requirements | external",
  "target": "harness | manager-skill | workflow | skill | agents-md | docs | code | brief | infra",
  "evidence": "a quoted transcript line or a metric",
  "fix": "the concrete change that would have prevented it" }
```

A cause without quoted evidence is dropped, and so is a cause whose evidence isn't found in the transcript or the metrics (Cezar checks it with a substring match). Three is the cap: it covers the multi-cause failures seen so far without letting the judge pad the list.

**Re-scoring.** `cez score <run> [--scorer s]` re-scores a run on demand, replacing that scorer's result. A rubric change does not re-score old runs automatically.

**In the cockpit:**
- **Task row columns** (hidden by default): Outcome, Efficiency and main cause, next to the existing tokens and cost columns.
- **Task detail:** a Scores panel with each score's reasoning, evidence and causes, and the metrics.
- **Factory view, per project:** pass rate per scorer over time, cost per merged PR, human touchpoints per PR (owner messages, approvals and interventions), PRs merged per week, open improvement PRs, and queue sizes.

### D6. Self-improvement

**Routing.** Each cause is routed when it's scored, on its own, by its target:

| Target | Queue |
|---|---|
| `workflow`, `skill`, `agents-md`, `docs`, `code` | the project's queue |
| `brief` | the project's queue if a workflow's prompt caused it; the harness queue if the manager skill or a built-in workflow did |
| `harness`, `manager-skill` | the harness queue |
| `infra` | no queue: a note to the owner through the project's manager |

So one failure can feed both queues.

- **The harness project's own runs:** a task that ran inside the harness project routes everything to the harness queue.
- **Runs that don't feed queues:**
  - improvement runs feed only the harness queue, since `improve-factory` is part of the harness;
  - benchmark runs feed no queue;
  - dry runs aren't scored.

**The harness queue** is workspace-wide, because harness causes come from every project. It's consumed by the harness project (setting `factory.harnessProject`). It's detected automatically when exactly one registered project is a Cezar repository, judged by its package name or the `.ai/cezar/HARNESS` marker the fork carries. With no harness project, the queue still fills and shows in the Factory view, and nothing consumes it.

**Triggers: an automation, not a new timer.** Cezar's automations already have what a trigger needs: a coordinator, event sources (GitHub, schedule, tracker), dedupe, an execution log with skipped-with-reason entries, and reporting each run to a manager. Self-improvement adds one event source, `factory`. Every hour it checks a queue, with no model call, and fires when either:
- the queue holds the threshold number of unprocessed causes, or
- its oldest unprocessed cause is old enough and there are at least the minimum number.

Each project, and the harness project, gets a **built-in automation** of kind `factory` that launches the `improve-factory` workflow when its source fires. It's enabled by default and can be paused like any automation. Its runs report to the project's manager, which is how the manager is told.

The source applies two guards and logs a skip with the reason when one holds:
- **one at a time:** never while the same queue has an improvement run in flight or an improvement PR open;
- **cooldown:** after an improvement PR merges, nothing until the cooldown has passed (D7).

The project's **manager** (`cez-manager improve --project <id>`), or the **owner** (the Factory view's "Improve now", or `cez improve`), can start a run at any time. That skips the threshold but still respects both guards, and a blocked start shows the reason. It's the automation's "run now", scoped to this source: the manager may run this built-in automation, though it can't run automations in general.

**The harness queue's other inputs:**
- **Escalations:** a project improvement run may judge a cluster generic ("every project's tasks will hit this") and escalate it. Cezar moves those causes to the harness queue instead of the project patching the repo.
- **Repeats:** when a harness run starts, it receives a digest of every project's open and recently processed causes (category, target, evidence, fix; no transcripts). It decides by judgement, not string matching, which repeat across two or more projects and deserve a better default.
- **Release checks:** after each harness release, a check of whether the release helped (D9).

**The improvement run** is an ordinary task in the project it improves, using the `improve-factory` workflow and skill. Cezar writes its batch into the task's brief: each cause with its scorer, label, reasoning, evidence, fix, run link and age, plus the previous improvement PRs and their before/after numbers. The workflow then runs:
1. **Agent step:**
   - cluster the causes by evidence;
   - for each cluster, read the transcripts of two or three of its runs to confirm it;
   - pick the clusters worth fixing, by how often they occur times what they cost;
   - write redrafts to the files that own each cause;
   - mark each cluster `fixed`, `dismissed` (with a reason), `escalated` or `deferred`, in a decisions file Cezar reads.
2. **Check step:** `cez factory check`, plus the project's validation command if it touched code. On failure it loops back to the agent, at most twice.
3. **PR step:** one draft PR, marked ready once the checks pass, using the description the agent wrote. That description lists each change, the regressions it addresses (runs, scorers, evidence), its expected effect, and the dismissed and escalated clusters with reasons.

**Bookkeeping, by Cezar:**
- marks the batch's causes as processed;
- records the improvement (its clusters, decisions and PR);
- moves escalated causes to the harness queue;
- returns deferred causes to the queue.

If the run fails or is cancelled, its causes return to the queue unprocessed.

**Approval.** The project's manager is informed like any other task, and handles the PR by the project's policy:
- `manager` (default): a review task reviews it, then the manager merges it or sends fixes back;
- `owner`: the owner approves;
- `none`: the manager merges after the review task, with no person.

Whatever the policy, these always need the owner:
- changes to any scorer, the judge settings, `improve-factory` or its skill;
- widening secrets or permissions;
- more than 400 changed lines of product code.

Cezar enforces this. A PR that touches a protected path is marked owner-only, and the manager's merge of it is refused.

**Scope.** A project's policy can limit what its improvement runs may touch: `docs`, `agents-md`, `skills`, `workflows`, `code`. The check step rejects changes outside it.

**After a merge.** Cezar records the merged commit as the improvement's start. Then:
- after the cooldown, it computes the before/after pass rate and cost per scorer for the project's runs, and for the harness also per release;
- these numbers go into the next improvement run's brief and the weekly report;
- an improvement whose numbers got worse is flagged, and the next run decides whether to revert it.

### D7. Defaults for a one-person factory

| Setting | Project | Harness |
|---|---|---|
| Self-improvement | on | on |
| Start a run at | 5 unprocessed causes | 5 |
| Or when the oldest is | 3 days old, with at least 2 | 7 days old, with at least 2 |
| Cooldown after a merge | 5 scored runs or 3 days | 10 scored runs on the new release |
| At most in flight | 1, and none while its PR is open | 1 |
| Approval | `manager`, after a review task | `manager`, after a review task; the release benchmarks and can roll back |
| Always the owner | scorers, judge, `improve-factory`, secrets or permissions, more than 400 changed lines of product code | same |
| Scope | docs, agents-md, skills, workflows, code | same |
| Scorers sampled | all four on every run | same |
| Task budget | 3M input tokens, 30 active minutes | same |
| Judge | the machine's `factory.judge` setting; unset: the project's default runner at low effort | same |

### D8. Replay and benchmarks

**Run identity.** Every run records, when it starts:
- `startCommit`, the exact commit its worktree forked from;
- `harnessVersion`, the self-update version id it ran under, with its commit.

These join the run's existing snapshots of its workflow definition (`workflowDef`) and saved instructions (`systemPrompt`). With its original inputs (brief, attachments, runner, model, effort, skill), that's enough to reproduce a run. The worktree isn't needed: it's the run's output, not its input. Today Cezar records only the base branch's name and works out the fork point later from git's reflog, which expires, so recording these must start early. Runs from before the change can't be replayed exactly.

**Replay.** `cez replay <run>` reruns a task from its `startCommit` with its original inputs, and changes at most one thing:
- `--harness <version>`;
- `--workflow <name>`, or the original's saved `workflowDef` (the default);
- `--model`, `--runner`, `--effort`;
- `--skill <name>`;
- `--brief <text|file>`;
- `--times <n>` (default 1, at most 5).

Replays reuse parallel variants (spec 010):
- **Grouping:** the original joins a variant group as the baseline, and each replay is a variant labelled with its change (`harness 3a12b69`, `model low-reasoning`, `skill deploy`, `brief v2`).
- **The task list** shows the group as one tile that expands, as it does for variants today. Each replay's row has its own Outcome, Efficiency and main cause.
- **The Compare view** (`/groups/:groupId`) gains score columns per variant: pass or fail per scorer, tokens, active time and cost. With several replays per variant it also shows the pass rate and averages. It keeps its file and diff comparison; the "choose a winner" action is hidden for replay groups, since they're experiments.

Two extensions to variants make this work:
- per-variant overrides (today every variant shares one configuration);
- a cap of 5 for replay groups (3 stays the cap for ordinary variants).

**What a replay may do:**
- **Outside systems:** replays never push, merge or deploy, and they skip check steps marked `sideEffects: true`.
- **Harness version:** a replay on another harness version runs on a staging cockpit started from that installed version (D9), with its own `CEZ_HOME`.
- **Mid-task messages:** the original's owner and manager messages are appended to the replay's brief as context, not resent mid-run.
- **Queues:** replays never feed improvement queues. They're experiments, and a deliberately weak variant would otherwise flood the queues.
- **Noise:** models vary between runs, so a comparison means 3–5 replays per variant.

**Benchmarks are saved replays.** A suite lives in `.ai/cezar/benchmarks/<suite>/`, and each task is a frozen replay input:

```yaml
# suite.yaml
description: Deploy-status tasks for a deployment project
configurations:
  - { name: low-reasoning, model: low-reasoning }
  - { name: comparison, runner: codex, model: example-model, effort: low }
tasks: [ci-status, prod-health]
scorers: [outcome, efficiency]
times: 3
---
# tasks/ci-status.yaml
title: Report the last CI and CD builds
sourceRun: <run id>   # optional
workflow: operate
prompt: Report the last CI and CD builds and their results.
successCriteria: Both build numbers and results are correct.
startCommit: 97d817021174027d647df63c890423771ef9d330
```

- **Growing a suite:** `cez benchmark add <run> --suite s` writes a task file from a run's identity and inputs: its brief as the prompt, its outcome as the success criteria, its start commit.
- **Running a suite:** `cez benchmark <suite> [--config c]` replays every task under every configuration, `times` each, as one variant group per task. It reports the matrix (pass rate, cost and time per configuration), stored as a task artifact and shown in the Factory view.
- **When suites run automatically:**
  - an improvement run that changes a workflow's model runs the matching suite and puts the matrix in its PR;
  - a harness release always runs the harness suite (D9).

### D9. The self-maintaining harness

The Cezar fork (`~/dev/cezar`, remote `mlei06/cezar`, trunk `factory`) is the harness project, with its own manager, the harness manager. Its workflows and skills are for working on Cezar's code, and its queue receives harness causes from every project.

**1. The running harness is an installed version, never the working tree.** Cezar's self-update already provides the layout:
- installs in `~/.cezar/versions/<id>`, with a `current` link and launchers in `~/.cezar/bin`;
- `cezar install`, which packs the running build and installs it;
- `cezar use <id>`, which switches versions;
- a supervisor restart (`CEZ_SUPERVISED=1`: the process exits, and systemd relaunches it through the launcher);
- pruning that keeps the running version plus two and never removes one in use.

The harness uses exactly that:
- **The service:** the systemd unit runs `~/.cezar/bin/cezar` with `CEZ_SUPERVISED=1` and `Restart=always`. The global `cezar` and `cez` are those launchers.
- **A release:**
  1. check out the merged commit in a dedicated build worktree (`~/.cezar/factory/builds/<sha>`), never the fork checkout;
  2. run the AGENTS.md validation order there;
  3. register it as its own version with self-update's `linkCheckout` (`cezar link`). The build worktree is on a `release/<sha7>` branch, so each release gets its own id. A local `cezar install` would reuse one id per package version (`<version>+local`) and overwrite the previous release.
  
  The fork checkout is an ordinary project, edited only in task worktrees, so a merge can't change the live harness.
- **The version id and commit** are `harnessVersion` (D8).
- **Retention:** set to 5 for this fork (`versionRetention`), so a few recent releases stay available for rollback and replay.

**2. Shipping is the `harness-release` workflow** in the harness project. It's check steps around the self-update commands, apart from one summary:
1. **Build and install:** as above. A failing validation stops here.
2. **Stage:** start a staging cockpit from the new version's entry, on another port with its own `CEZ_HOME`. Replay the harness benchmark suite against it (D8): `CEZ_DRY_RUN=1` by default, plus real replays when the release touches runners, prompts or the judge. Compare with the current version's last results; a drop beyond the tolerance (default 10 points of pass rate) stops the release.
3. **Wait for idle:** wait until no task is running and no manager turn is active, holding new task starts (they queue) for at most 15 minutes; then stop and report.
4. **Switch:** `cezar use <id>`, then a supervisor restart. Then check `/api/v1/health` within 60 s and run one dry-run task.
5. **Roll back** on any failure: `cezar use <previous id>`, restart, and report.
6. **Report:** post the release notes (the merged PRs since the last release), the benchmark comparison and the switch result to the harness manager. Append every step to `~/.cezar/factory/release-log.ndjson`.

The new pieces are waiting for idle, the health check with automatic rollback, the staging cockpit and the log. Linking, switching and the launchers are self-update's. The release script also removes old build worktrees (keeping 5) and their links. The workflow's own changes are owner-protected, like the grader.

**3. Attribution.** Every score records `harnessVersion` (the version id and its commit). After a release, the harness manager compares failure rates for the clusters the release's PRs targeted, once 10 runs have been scored on it. A release that made them worse is reverted with `harness-release --rollback`, which switches back and opens a revert PR.

**4. Limits.**
- The grader rule applies to the harness too.
- Each harness PR is labelled `fork-only` or `upstreamable`, so generic fixes can go to open-mercato/cezar.
- Manager-only skills ship in the fork's `manager-skills/`. `~/.cezar/manager-skills/` is for local experiments, and an experiment that works becomes a PR.

### D10. Reports and proactive triggers

These use Cezar's existing automations and manager jobs:
- **Hourly:** the improvement-run check (D6).
- **Weekly, per project:** a manager job writes a factory report as an HTML artifact (Cezar's existing artifacts) and posts its summary, read only from stored scores:
  - pass rates and their trend;
  - cost per merged PR;
  - human touchpoints per PR;
  - queue sizes and top open causes;
  - improvement PRs merged or waiting, with their before/after.
- **On a main CI failure:** a `fix-ci` task.
- **Daily:** a credential health check that every secret a workflow names still works (CI login, token expiry, SSH reachability), using check commands a project declares in a `credential-health` workflow. A failure becomes an `access` cause and a note to the owner before it blocks a run.
- **Later:** monitoring webhooks (Sentry/Grafana style) that start an investigation task.

### D11. Manager operating rules

Every manager works by these rules, which ship in the `manage-project` skill (and, for the harness project, `manage-harness`), so a manager dropped into any project behaves the same. They came out of running the harness project during M1. Project-specific rules stay in that project's AGENTS.md or its task skill, never in the manager skill.

1. **Ungated by default.** A manager plans, briefs, reviews, merges and (where a release workflow exists) releases without waiting for the owner. Only D7's "Always the owner" list needs the owner. The owner audits afterwards: what the manager decided is recorded where the owner will read it (below).
2. **Reviews only for runtime changes.** A PR that changes anything that executes (product code, scripts, build, test or CI config, workflows) gets a review task before merging. A PR that only changes documentation, specs, skills or AGENTS.md merges after the manager's own diff check, with no review task.
3. **Review stalemates.** At most two review rounds per PR. After that the manager decides: correctness bugs, data loss, secret-value leaks and security issues block the merge; anything else (edge cases, defense in depth, style) merges, with the remaining findings listed as follow-ups in the PR and the project's backlog. The manager reports the decision rather than asking.
4. **Requirement ambiguities.** When the spec or brief is unclear, the manager decides in the direction that best fits the spec's decisions and reuse map, and keeps going. It records each decision under "Spec decisions" in the PR description and as one line in the project's observation or decision log, in the same PR. It stops for the owner only when a decision would contradict the spec outright or touch security, secrets or permissions.
5. **Fresh enough to merge.** A PR's head must include the current trunk, except that trunk commits touching only documentation or agent guidance (specs, skills, `*.md` outside source directories) never force a rebase or revalidation.
6. **Shared machine resources.** Tasks share one laptop:
   - tasks never override the repository's test-runner concurrency (for Vitest, no `--maxWorkers` or `--pool`);
   - at most one full test suite per task at a time, waited for inside one command, and an abandoned run is stopped before another starts;
   - focused tests first, the full suite once before the PR;
   - a timing failure seen while other suites run is rerun alone before it is reported;
   - the workspace's `maxParallel` defaults to 2 on a single machine.
   Briefs repeat these rules, and the project's task skill holds them (`factory-work` in the harness project). Each run also gets a lower CPU priority than the cockpit (`nice`), so a busy machine slows tasks rather than the cockpit (backlog B22).
7. **Briefs.** Every brief states the goal, what is out of scope, the acceptance checks, the skill to attach and the validation commands, and points at the spec sections it implements instead of restating them.
8. **Releases of the harness.** Until the `harness-release` workflow (D9) exists, the harness manager runs `scripts/harness-release.mjs` itself after merging runtime PRs, batching merges that land close together. A release restarts the cockpit the manager runs in, so it is started detached (`systemd-run --user --collect --unit=harness-release-<sha7> … node scripts/harness-release.mjs <sha>`), the manager ends its turn so it counts as idle, and starts nothing while the unit runs. After waking it reads the unit's journal and the last line of `release-log.ndjson`; a rollback means the merge is broken, and the manager fixes it forward or reverts it.
9. **A public fork stays generic.** When the project's repository is public, nothing internal goes into it: no internal host names, addresses, company paths, user names, provider ids, other projects' names or run data. Internal details belong in the repositories of the projects they concern.

### D12. The manager as project lead

A manager is the project's lead and the owner's stand-in: accountable for where the project is going and how it gets there, not only for running the tasks it is handed. It works like a person in a coding-agent session who knows when to use subagents, without being told. It is built as a rewrite of the `manage-project` skill, plus one committed file per project. Sources: Anthropic's lead-agent research system (delegation briefs, effort scaling, plans in external memory), Roo Code's Orchestrator (coordinate, don't implement; every subtask ends in a summary that becomes the record), CrewAI's manager (self-contained delegation), MetaGPT's product and project managers (goals, user stories, a ranked requirement pool, "anything unclear"), and ChatDev (an explicit role matters most).

1. **The charter: `.ai/project.md`, committed.** Sections, all optional:
   - **Vision:** one paragraph, what the project is for and for whom.
   - **Goals:** at most three, each with how success is measured.
   - **Non-goals.**
   - **Backlog:** a ranked list, each item `P0`/`P1`/`P2` with one line and, when started, its task or PR.
   - **Progress:** per goal, where it stands, updated after each finished outcome.
   - **Open questions:** what only the owner can answer.
   
   A missing charter is fine (zero config): the manager drafts one from the repository (README, AGENTS.md, docs, open issues and PRs, recent history) and its first conversation with the owner, and opens it as a docs PR. **Vision, goals and non-goals are the owner's:** the manager proposes changes to them, in a PR the owner merges, and never merges those itself. The backlog, progress and open questions are the manager's to change freely (D11.2: docs, so no review task). **Every project uses `.ai/project.md`,** whatever else the repository keeps: an existing `ROADMAP.md` or issue tracker is linked from it, not adopted or copied. Project facts stay in AGENTS.md, and AGENTS.md never holds backlog or progress; the charter holds direction, not how-to.
   **Who writes it:** the manager never commits (D11), so the task that delivers an outcome updates the charter's Progress and Backlog lines in its own PR, as part of its brief. The drafting of a missing charter, and a weekly tidy-up, are small low-reasoning tasks.
2. **Plan and progress live in the charter, not the chat.** Cezar's managers already run short sessions that restart from cezar-owned memory (spec 2026-11-21). The charter is the durable plan those sessions start from: every new session reads it first, and the manager writes progress back before its session ends, so nothing important lives only in a conversation. Manager memory keeps what the owner asked it to remember; the charter keeps the project's direction and state.
3. **Effort scales with the job.** Before delegating, the manager sizes the work:
   - **small** (a fix, a docs change, a known script): one task, a low-reasoning model where D2's `operate` fits;
   - **a feature:** a plan, then 2 to 4 tasks, parallel where they touch different files;
   - **a milestone:** a written plan in the charter's backlog first, then tasks in dependency order.
   It never starts more parallel tasks than the workspace's `maxParallel`, and never two tasks on the same files.
4. **Self-contained briefs.** A task knows nothing the brief doesn't say. Every brief has: the objective; the context it needs (decisions made, files, prior task results, linked by path or PR, not restated); what is out of scope; acceptance checks; the skill and validation commands; and what its final message must contain (what changed, what was verified, what's left), since that summary is the record the manager reads. This is D11.7, made concrete.
5. **Ideation.** The manager adds backlog items from what it sees: failed or low-scoring runs (D5), repeated causes (D6), TODOs and FIXMEs, open issues, CI failures, gaps between the charter's goals and the code, and the owner's passing remarks. Within the vision and goals it ranks and starts that work itself. A new direction, a change to goals, or anything on D7's owner list it proposes instead, as an open question with its recommendation.
6. **Cadence.** After each finished outcome: update the charter's progress and backlog. When idle with nothing in flight: take the top backlog item. Weekly: D10's report gains a project section: progress per goal, what shipped, risks, the top three next items, and open questions.
7. **One message, carried to production.** A report of a bug or a request ("X is broken", "add Y") is an outcome the manager carries end to end without further messages from the owner: add it to the backlog; reproduce it (a small task) unless it is obvious; fix it with `implement`, including a regression test that fails without the fix; review and merge under D11; deploy through the project's deploy workflow when the project deploys; then **verify the reported behaviour itself where it was reported** (production, staging, the CLI), not only that the deploy is healthy; roll back if the deploy breaks something; and report what was wrong, what changed and how it was verified. The manager asks the owner only for what it cannot get itself (an account, a sample file, a product choice), once, with its recommendation. An outcome is done when the verification passes, not when a PR opens.
8. **Role first.** The skill opens with the role, stated plainly: the project's lead, owner of the outcome, who delegates every change to tasks, checks their work, and keeps the project moving between the owner's requests.

The manager still never writes code itself (every change is a task, D11), and hand-made tasks stay first-class: the owner can add to the backlog, start tasks by hand or redirect the manager at any time.

## Data model and storage

| What | Where | Notes |
|---|---|---|
| Metrics summary | `.ai/cezar/runs/<id>.metrics.json` | derived when the run ends; rebuilt on demand |
| Scores | `.ai/cezar/runs/<id>.scores.json` | one entry per scorer; holds `harnessVersion` and project commit |
| Project queue | `.ai/cezar/factory/queue.json` | causes with state `open`, `processing`, `processed`, `dismissed`, `escalated`, `deferred` |
| Harness queue | `~/.cezar/factory/harness-queue.json` | workspace-wide |
| Improvements | `.ai/cezar/factory/improvements.json` | run, clusters, decisions, PR, merge commit, before/after |
| Benchmark results | `.ai/cezar/factory/benchmarks/<suite>/<at>.json` | one matrix per run |
| Run identity | the run record: `startCommit`, `harnessVersion` | written at run start, beside the existing `workflowDef` and `systemPrompt` snapshots |
| Replay source | the run record: `replayOf` (run id), `replayChange` (what was changed), and the existing `groupId`/`variant` | replays are variants |
| Installed harness versions | `~/.cezar/versions/<id>` (self-update's layout) | unchanged |
| Harness build worktrees | `~/.cezar/factory/builds/<sha>` | one per release; pruned with its version |
| Release log | `~/.cezar/factory/release-log.ndjson` | releases, stages, switches, rollbacks |

`.ai/cezar/factory/` joins the `ensureDataGitignore` allowlist as ignored state. Every file is optional and rebuilt when missing. A missing queue starts empty, and causes that were never processed are re-derived from recent scores.

**Metrics summary:**

```json
{ "runId": "…", "workflow": "implement", "runner": "codex", "model": "example-model",
  "startedBy": "manager | owner | automation | improvement | benchmark | replay",
  "startCommit": "<sha>", "harnessVersion": { "id": "…", "commit": "<sha>" },
  "wallMs": 0, "activeMs": 0, "modelMs": 0, "toolMs": 0,
  "tokens": { "input": 0, "output": 0, "cacheRead": 0 },
  "requests": 0, "contextAvg": 0, "contextPeak": 0,
  "toolCalls": 0, "toolResultChars": 0,
  "largestOutputs": [{ "call": 1, "tool": "Bash", "chars": 0, "head": "…" }],
  "longestCalls": [{ "call": 1, "tool": "Bash", "ms": 0, "head": "…" }],
  "budget": { "tokens": 0, "minutes": 0, "exceeded": [] },
  "outcome": { "status": "done", "pr": "…", "review": "approve", "checks": { "passed": 0, "failed": 0 } },
  "interventions": [{ "kind": "say | retry | switch | cancel", "by": "manager | owner", "at": "…" }] }
```

**Score:**

```json
{ "scorer": "efficiency", "label": "wasteful", "score": 0, "pass": false,
  "reasoning": "…", "evidence": ["…"],
  "causes": [{ "category": "repository", "target": "docs", "evidence": "…", "fix": "…" }],
  "judge": { "runner": "<runner>", "model": "<model>", "transcriptChars": 0, "shortened": false },
  "harnessVersion": "<sha>", "projectCommit": "<sha>", "at": "…" }
```

**Transcript rendering for the judge** (plain text, in order):

```
# Run <id8>: <title>
workflow implement · codex example-model · started by manager · status done · PR <url>
## Brief
<task text>
## Metrics
<the summary above, as lines>
## Transcript
[+0:00] assistant: <text>
[+0:05] tool Bash (2.4 s, 12,340 chars): <command>
<output; when shortened: first 1,500 chars … [9,840 chars cut] … last 500 chars>
[+0:09] owner said: <text>
...
## Final message
<text>
```

**The judge prompt:** the scorer's description, labels and rubric; the cause schema with the target list; and the instruction to answer only with JSON quoting the transcript, followed by the rendered transcript.

## Settings, CLI and API reference

**Settings (`factory` in `~/.cezar/config.json`; per-project overrides in `.ai/cezar/config.json`):**

| Key | Default | Project override |
|---|---|---|
| `judge.runner`, `judge.model` | unset (the project's default runner at low effort) | no |
| `models.lowReasoning.runner`, `models.lowReasoning.model` | unset (the project's default runner at low effort) | no |
| `models.highReasoning.runner`, `models.highReasoning.model` | unset (the project's default runner at high effort) | no |
| `models.switchAbove` | `0.8` | no |
| `models.lowReasoningFallback` | empty ordered list of runner and model pairs | no |
| `scoring.enabled` | true | yes |
| `scoring.sampling.<scorer>` | 100 | yes |
| `budget.tokens`, `budget.minutes` | 3,000,000, 30 | yes |
| `improvement.enabled` | true | yes |
| `improvement.threshold` | 5 | yes |
| `improvement.ageDays`, `improvement.minForAge` | 3, 2 (harness 7, 2) | yes |
| `improvement.cooldownRuns`, `improvement.cooldownDays` | 5, 3 (harness 10 runs) | yes |
| `improvement.approval` | `manager` | yes |
| `improvement.scope` | all five | yes |
| `harnessProject` | auto-detected | no |
| `release.benchmarkTolerance` | 10 | no |

**Env:** `CEZ_SCORING=0` turns scoring off, and `CEZ_SELF_IMPROVEMENT=0` turns improvement runs off. Both are listed in `.env.example`.

**CLI:**

| Command | Does |
|---|---|
| `cez factory check` | validate the project's factory files |
| `cez score <run> [--scorer s]` | score or re-score a run |
| `cez improve [--project p]` | start an improvement run now (guards apply) |
| `cez replay <run> [--harness v] [--workflow w] [--model m] [--runner r] [--effort e] [--skill s] [--brief t] [--times n]` | replay a run with one change, as a variant beside it |
| `cez benchmark <suite> [--config c]`, `cez benchmark add <run> --suite s` | run or grow a benchmark |
| `cezar secrets set NAME --description "…"`, `cezar secrets describe NAME "…"` | secret descriptions |
| `cez-manager workflows|secrets|skills|models|agents|scores` | list commands (D3) |
| `cez-manager improve --project p` | the manager starts an improvement run |
| `cez-manager task create … --workflow w --secrets a,b --budget-tokens N --budget-minutes M` | task options |
| `cez-manager task budget <run> --tokens N --minutes M` | raise a budget |
| `harness-release [<sha>] [--rollback] [--force]` | the harness release workflow (harness project), built on `cezar link` and `cezar use` |
| `cezar install`, `cezar use <id>`, `cezar versions` | (exist) self-update's install, switch and list |

**API (all under `/api/v1`; project routes also under `/p/:projectId`):**
- `GET /runs/:id/metrics`, `GET /runs/:id/scores`, `POST /runs/:id/score`;
- `GET /factory` (definition, settings, queue, improvements), `GET /factory/check`, `POST /factory/improve`;
- `GET /scores?since&groupBy=scorer|category|target`;
- `POST /runs/:id/replay` (returns the variant group), and the existing `GET /groups/:groupId`, which gains scores per variant;
- `GET|POST /benchmarks`, `GET /benchmarks/:suite/results`;
- `GET /workspace/scores`, `GET /workspace/factory/harness-queue`;
- `PUT /secrets/:name` gains `description`.

Every route has its zod schema in `packages/contract` first, per AGENTS.md.

**Events** (the workspace SSE bus): `score.recorded`, `budget.exceeded`, `improvement.started`, `improvement.finished`, `release.switched`, `release.rolledBack`.

## Failure handling and edge cases

| Case | Behaviour |
|---|---|
| The judge endpoint is down | scores stay `pending`; retry after 5 min, 30 min, then 2 h; then `error`, with a note on the Factory view. Runs are never blocked by scoring. |
| The judge returns invalid JSON | one retry with the validation error appended; then `error` |
| A judge call takes too long | 3-minute timeout per call, counted as an invalid reply |
| A run is cancelled before it starts, or is a dry run | not scored |
| A run is cancelled mid-way | `outcome` isn't scored; `efficiency`, `procedure` and `scope` are |
| A run is very long (transcript over the window) | shortened only in its largest outputs (D5); if the metrics, brief and calls alone don't fit, scored as `error: too large`, and the run is listed for owner attention |
| Scoring falls behind | it's a queue: one judge call at a time per machine, newest runs first; backlog size shows on the Factory view |
| Two causes contradict each other | both stay; the improvement run's clustering decides |
| The same cause keeps recurring after a fix | the next run receives the earlier fix and its before/after, and may revert or redraft it |
| An improvement run fails or is cancelled | its causes return to `open`; the next trigger retries; three failures in a row pause that queue and tell the owner |
| An improvement PR is closed unmerged | its clusters return to `open` with the close reason |
| The harness project isn't registered | the harness queue fills and is visible; nothing consumes it |
| A release fails mid-switch | `cezar use <previous id>` restores it; the release log records it; the harness manager is told |
| A replay's original predates run identity | it's refused, with the reason; it can still be added to a benchmark by hand with a chosen `startCommit` |
| A replay's start commit is gone (history rewritten) | it's refused, with the reason |
| A replay asks for a harness version that's been pruned | it's refused, listing the installed versions |
| The owner edits factory files by hand | normal; `cez factory check` runs on load; scoring and improvement use whatever is committed |
| Two machines share a project | queues and scores are machine-local state; each machine scores its own runs |

## Security and privacy

- **What the judge sees:** transcripts are rendered with every value redacted that Cezar redacts today (host and run secrets, token shapes, `agents` and `checks` secret values), before they reach the judge.
- **Where the judge runs:** the default judge is self-hosted, so transcripts stay on the internal network. Choosing a hosted judge model is a settings change with a warning in Settings.
- **Scores:** reasoning and evidence quote transcripts, so the same redaction applies before storing them.
- **Improvement runs** are ordinary tasks, with the project's secrets and grants. They can't widen secrets or permissions without the owner (D6).
- **Benchmarks** never push, merge or deploy, and skip check steps marked with side effects.
- **The harness release** runs with the owner's own permissions, and only on commits merged to `factory`.

## Zero config and compatibility

- **Nothing is required.** With no files, a project gets the built-in task workflows and scorers and the default settings. Without a configured judge, it falls back to the project's default runner and model at low effort, with a note in the Factory view.
- **Default-on features that cost model time,** following AGENTS.md's zero-config rule. These are owner-approved exceptions on this fork, recorded in its AGENTS.md:
  - scoring (`CEZ_SCORING=0` to turn off);
  - self-improvement (`CEZ_SELF_IMPROVEMENT=0`);
  - autonomous managers by default (`CEZ_MANAGER_AUTONOMOUS_DEFAULT=0`);
  - a manager per project (`CEZ_AUTO_PROJECT_MANAGERS=0`).
  
  Every `CEZ_*` variable is listed in `.env.example`.
- **Old workflows** without `budget:` or agent-step `secrets:` behave exactly as before. Old runs without metrics or scores parse and show empty columns.
- **New API routes** are inventoried in `BACKWARD_COMPATIBILITY.md` §2, and the contract-parity and route-parity tests cover them.

## Already shipped on the fork

| Commit | What |
|---|---|
| `3a12b6900`, `5aa93a1d3` | autonomous managers; a manager per project; `manage-project` as a skill |
| `f396b75eb` | the `agents` secret audience; `cezar secrets get/env` |
| `6f8519c88` | manager-only skills; `task create --skill`; no managers for scratch projects |
| `6a00d2387` | reviewers read Azure Repos PRs (`az repos pr`, PR merge-ref fetch) |

## Modules

| Area | Change |
|---|---|
| `contract/` | workflow `budget`; agent-step `secrets`; run fields `grantedSecrets`, `budget` (generalizing dispatch's `budgetUsd`), `onBudget`, `budgetExceeded`, `startCommit`, `harnessVersion`, `replayOf`, `replayChange`; variant overrides; metrics, score, cause, queue, improvement, scorer, suite and task schemas; secret `description`; `factory` settings in workspace and project config; new events |
| `workflows/` | lift the agent-step `secrets` rule; built-in task workflows; the capability block; budget accounting |
| `factory/` (new) | load and validate scorers and benchmarks with built-in defaults; `cez factory check`; settings resolution |
| `managers/` | list commands; `--secrets`, `--budget-*`, `task budget`, `improve`; budget and improvement follow-ups; `TurnStatsCollector` reused for tasks |
| `scoring/` (new) | metrics summary; transcript rendering, shortened to fit; the judge queue and call; scores, causes, evidence check; routing; re-scoring |
| `improvement/` (new) | queues, the hourly trigger, guards, batch briefs, decisions file, bookkeeping, before/after |
| `benchmarks/` (new) | the suite runner and matrix; `benchmark add` |
| `workspace/secrets*` | `description` |
| `server/` | the routes and events above |
| web | score columns, Scores panel, Factory view, Factory settings |
| `manager-skills/` | `manage-project` (list commands, workflow choice, budgets, improvement, the D11 operating rules, rewritten as the D12 project lead); `manage-harness` (new: D11's release and public-fork rules) |
| `skills/improve-factory` (new) | the improvement playbook |
| `self-update/` | used as is: `linkCheckout` from a build worktree, `activate` (`cezar use`), the launchers, supervisor restart |
| release | `scripts/harness-release.mjs` (wait for idle, health check, automatic `use <previous>`, staging cockpit, log) and the `harness-release` workflow; the unit runs `~/.cezar/bin/cezar` with `CEZ_SUPERVISED=1` |
| variants (spec 010) | per-variant overrides; replay source; cap 5 for replay groups; score columns in the Compare view; no winner pick for replay groups |
| `automations/` | the `factory` event source and a built-in automation per project |
| `usage-ledger/` | `INTERNAL_CONSUMERS.scoring` |

## Tests and acceptance

- **Task workflows:**
  - a workflow's `budget` and agent-step `secrets` apply;
  - explicit flags override single settings;
  - existing workflows without these fields behave exactly as before;
  - `operate` falls back on a machine without OpenCode.
- **Capability block:** names exactly the granted secrets and never a value; lists the workflows and the attached skill; trims in order and stays under the cap.
- **Budget:** one follow-up per crossing; the next at 2×, then 4×; queued, parked and gate time don't count.
- **Metrics,** from a replayed log of the first end-to-end test's upgrade task: 116 model requests, about 93k average context, the 77k first output among the largest.
- **Scoring:**
  - every sampled scorer records a valid label, or an error after one retry;
  - a failing score has 1–3 causes, each with evidence found in the transcript or metrics;
  - an over-long transcript is shortened only in its largest outputs and fits the window;
  - a judge outage leaves scores pending and retries;
  - scoring creates no runs and never blocks one.
- **Routing and triggers:**
  - a cause routes to the project or harness queue by its target, and one failure can feed both;
  - 5 causes, or a 3-day-old cause with at least 2, starts exactly one run;
  - a manual start skips the threshold but not the guards;
  - nothing starts while a run is in flight or its PR is open, or during cooldown;
  - a failed run returns its causes.
- **Approval:** a PR touching a protected path is owner-only, even under `none`, and the manager's merge is refused.
- **Run identity:** every run records `startCommit` and `harnessVersion` at start, including dispatched children and Continue.
- **Replay:**
  - a replay starts from the original's `startCommit` with its saved workflow and inputs, changes exactly the one thing asked, and joins the original's variant group;
  - its row has its own scores, and the Compare view shows them per variant;
  - it never pushes, merges or deploys, and never feeds a queue;
  - a `--harness` replay runs on a staging cockpit of that version.
- **Budgets:** an old dispatch record with `budgetUsd` parses and still parks; a top-level run notifies.
- **Benchmarks:** a suite replays every task under every configuration, `times` each, without side effects, and records a matrix.
- **Harness release:**
  - it links each build as its own version and switches through `cezar use`;
  - a failing build, benchmark or health check keeps or restores the previous version;
  - no switch happens while work is active;
  - scores record `harnessVersion`.
- **Manager rules (D11):** the shipped `manage-project` skill states every D11 rule; a run's process has a lower CPU priority than the cockpit.
- **One message to production (D12.7):** a reported bug in a project with a deploy workflow ends merged, deployed and verified where it was reported, with a regression test, and no further owner messages; a failed verification reopens the outcome instead of reporting it done.
- **Project lead (D12):** a project without a charter gets a drafted one as a docs PR; a new manager session's first read is the charter; a finished outcome's PR updates its Progress and Backlog; the manager never merges a change to vision, goals or non-goals.
- **Compatibility:** old run files parse; contract-parity and route-parity tests pass; every new env var is in `.env.example`.

**Acceptance:**
- Rerunning the first end-to-end test's deploy request needs no round trip to the owner for access, and its tasks stay within budget.
- Every finished task shows Outcome and Efficiency within a minute when the judge is up.
- Within two weeks of D6 shipping, at least one project improvement PR and one harness improvement PR have merged, and the failure rates of their clusters have dropped.
- The overseer's calibration (roadmap M3) shows the judge agreeing with the overseer on pass/fail for at least 80% of sampled runs, and on the main cause's target for at least 70%.

## Open questions

1. **Hard budgets:** should a task at 4× its budget pause until the manager answers?
2. **Scoring scope:** score tasks the owner starts by hand too (default yes), or only manager and automation tasks?
3. ~~**The judge model's context window**~~ answered in M0: 262,144 tokens, so most transcripts fit whole.
4. **Scoring the managers:** apply the same metrics, scorers and improvement to manager turns, after D6.

## Changelog

- **v5.17:** D2 keeps ordinary tasks on project defaults, adds the high-reasoning alias and configurable usage threshold to existing account selection, and adds cached admission-time probing and ordered hosted fallbacks for the low tier. Manager chat stays user-selected.

- **v5.16:** D2 adds a three-tier delegated task ladder and an 80% OpenAI usage threshold for admitting new ordinary tasks. Manager chat stays user-selected. M2 owns adoption and acceptance.

- **v5.15:** D12.7, one message carried to production: reproduce, fix with a regression test, review, merge, deploy, verify the reported behaviour where it was reported, roll back on breakage; done means verified. Rules renumbered so the role stays last.
- **v5.14:** D12: every project keeps `.ai/project.md` (existing roadmaps are linked, not adopted); charter updates ride in the outcome's own PR, since the manager never commits.
- **v5.13:** D12, the manager as project lead: a committed charter (`.ai/project.md`) holding vision, goals, non-goals, a ranked backlog, progress and open questions; plans in the charter, not the chat; effort scaling; self-contained briefs; ideation within the vision; a progress cadence; role first. Drawn from public orchestrator and manager designs.
- **v5.12:** principle: the manager stands in for the owner through the same task paths; hand-made tasks stay first-class and get every addition.
- **v5.11:** D11, manager operating rules, so the rules the harness manager was given during M1 live in the product: ungated by default, reviews only for runtime changes, two review rounds then the manager decides, ambiguities decided and recorded, docs-only trunk commits never force a rebase, shared-machine test limits and a lower CPU priority for runs, brief contents, detached harness releases, a public fork stays generic.
- **v1:** first draft ("software factory feedback").
- **v2:** separate list commands; optional `--secrets`; the judge reads the full transcript; helper scripts live in skills; pattern detectors dropped.
- **v3:**
  - Warp's design merged in;
  - roles became task workflows;
  - policy moved to settings (no `factory.yaml`);
  - deterministic trigger plus manager and owner starts;
  - Cezar's existing metrics reused;
  - 1–3 routed causes per failure;
  - one-person defaults.
- **v5.10:** descriptions are printable one-line text: control characters are refused at write and omitted at render, so runners never escape them.
- **v5.9:** `implement` without `validation.commands`: the `test` script, else no checks and a note on the PR.
- **v5.8:** no provider or project-specific names in the harness: the judge and the low-reasoning model (`operate`) are machine settings (`factory.judge`, `factory.models.lowReasoning`); evidence and examples made generic.
- **v5.7:** render applies the same own-value check (omit), covering older descriptions; still no other scanning.
- **v5.6:** secret descriptions: refuse one containing its own secret's value at write time; no other scanning or scrubbing.
- **v5.5:** the capability block's omission-count line is mandatory and exempt from the cap, like secret names.
- **v5.4:** agent-step secrets on Continue: the resumed step's recorded allowlist, else the intersection of all agent steps' allowlists; never widen on doubt.
- **v5.3:** the capability block's 2k cap never drops secret names; names alone may exceed it, listed compactly (conflict raised by the harness manager in M1).
- **v5.2:** `implement` validates with check steps from `.ai/agentic.config.json` (M0 warm-up finding).
- **v5.1:** findings from M0: release ids via linked build worktrees, a TLS relay for a self-hosted endpoint, a 262k-token judge window.
- **v5:**
  - a reuse map of what Cezar already has, part by part;
  - budgets generalize dispatch's `budgetUsd` with park or notify;
  - the judge reuses the one-shot model-call path;
  - the improvement trigger is an automation event source;
  - run identity (`startCommit`, `harnessVersion`) and replay as variants (spec 010), with benchmarks as saved replays;
  - harness releases built on self-update (`~/.cezar/versions`, `cezar install`, `cezar use`, supervisor restart) instead of a new layout;
  - weekly reports as artifacts.
- **v4:** data model and storage; settings, CLI, API and events reference; failure handling and edge cases; security and privacy; zero-config and compatibility (env vars, owner-approved exceptions); calibration targets in acceptance.

## Sources

- Warp blog: [engineering self-improving software factories](https://www.warp.dev/blog/engineering-self-improving-software-factories), [closing the loop](https://warp.dev/blog/agent-self-improving-software-factories), [the road to self-improving software](https://www.warp.dev/blog/self-improving-software-proactive-agents).
- Warp docs: [scorers](https://docs.warp.dev/factories/measure-and-improve/scorers/), [self-improvement](https://docs.warp.dev/factories/measure-and-improve/self-improvement/), [automations](https://docs.warp.dev/factories/automations/), [factory as code](https://docs.warp.dev/factories/factory-as-code/).

Where Cezar differs on purpose:
- it's local and needs no configuration;
- task workflows replace Warp's agent definitions, because Cezar's workflow steps already carry model, skill and tools;
- policy lives in settings rather than in a factory file the loop could edit;
- failures carry routed root causes, so fixes can land in the right repository;
- it adds the harness tier (D9), which Warp doesn't describe.
