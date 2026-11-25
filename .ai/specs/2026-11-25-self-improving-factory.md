# The self-improving factory

Status: draft v3, 2026-11-25. Fork: `mlei06/cezar`. Supersedes the "software factory feedback" draft of the same day. Implementation plan: `2026-11-25-self-improving-factory-roadmap.md`.

## TLDR

Cezar already runs a factory: managers turn outcomes into tasks, tasks run workflows on agents, and pull requests come back for review or merge. What it lacks is the loop that makes the factory better over time. This spec adds that loop, modelled on Warp's software factories and adapted to a local, zero-config cockpit run by one person:

1. **Factory as code, using what Cezar already has.** A project's factory is the set of files it commits: workflows, skills, scorers, benchmarks and AGENTS.md. Workflows double as Warp's agent roles: one file says which model, skill, secrets and budget a kind of task gets. Policy (thresholds, approvals, the judge) stays in Cezar's settings, global with per-project overrides, out of reach of the loop.
2. **Agents know what they have.** List commands for managers; a capability block in every task's prompt (its secrets, workflows and skill); secret descriptions; optional secret narrowing.
3. **Bounded tasks.** A per-task token and time budget that wakes the manager when crossed.
4. **Scoring.** After every run, scorers (each a rubric, labels with scores, a pass threshold) are judged by a cheap model. The judge reads Cezar's existing metrics plus the full transcript. A failing score names one to three root causes, each with a target: the place its fix belongs.
5. **Self-improvement.** Failures are routed to the queue of whoever can fix them, the project or the harness. A deterministic timer starts an improvement run when a queue fills or ages; the manager or the owner can also start one. The run clusters failures and opens a pull request of redrafts that lists the regressions it addresses.
6. **Verification.** Before/after comparison of scores, and benchmarks (reference tasks across configurations) for changes that need a real comparison.
7. **A self-maintaining harness.** The Cezar fork is a project with its own manager. Cezar runs from pinned releases, so a harness change ships through a benchmarked release with automatic rollback.

## Evidence (open-webui, 2026-11-25)

The first end-to-end test: an autonomous manager on Codex gpt-6.2-sol, asked only "update production".

| What happened | Root causes | Where the fixes live |
|---|---|---|
| A round trip to the user for SSH access the agents already had (`PROD_VM_*`) | agents weren't told their secrets | harness: capability block (D3) |
| The upgrade task ran 25+ min: 116 model calls averaging 93k tokens of context (10.7M input in all), with 62% of the time spent in the model | a 77k-character first read (docs) carried by every call; a brief that said "read the docs"; builds polled through the model | project: a shorter required reading list; the manager's brief; harness: budget (D4) |
| The task rebuilt backup and staging scripts that already existed | the helpers sat in an ignored folder, invisible to task worktrees | project: helpers inside a committed skill |
| A workflow task invented secret names and grew the scope | no list of secrets; a loose brief | harness: D2/D3; project: a deploy workflow |
| 7 review runs voted "reject" with no findings | reviewers couldn't read Azure PR diffs | harness: fixed in `6a00d2387` |
| The manager playbook leaked into task agents | installed globally | harness: fixed in `6f8519c88` |
| Two stray managers | test sandboxes got automatic managers | harness: fixed in `6f8519c88` |

One task often has several causes in different places. That's why a failure carries up to three (D5).

## Principles

- **Zero config.** Every file is optional. Cezar ships default workflows, scorers and settings, and an empty repo still gets scoring and self-improvement.
- **Reuse before adding.** Extend Cezar's workflows, settings, metrics and automations; add a concept only when nothing existing can carry it.
- **Fixes as pull requests.** Every improvement is a reviewed diff. Nothing rewrites factory files in place.
- **Redrafts, not additions.** A self-improvement change rewrites the guidance it touches and removes what's outdated. Skills and AGENTS.md get shorter or stay the same length unless the PR says why.
- **Policy is not factory.** What the loop may edit (workflows, skills, scorers' rubrics only with the owner, docs, code) lives in repos. What governs the loop (thresholds, approvals, judge, scope) lives in settings, which the loop can't change.
- **Nobody grades their own grader.** Changes to scorers, the judge, or the self-improvement workflow and skill always need the owner.

## Glossary

| Term | Meaning |
|---|---|
| Factory | a project's committed definition of how agents work on it: workflows, skills, scorers, benchmarks, AGENTS.md |
| Harness | Cezar itself: engine, runners, grants, hooks, system prompts, manager skills, built-in workflows and scorers |
| Manager | the long-lived agent that owns outcomes for its projects (Warp's foreman) |
| Task | one run of a workflow, with its own branch and worktree |
| Task workflow | a workflow used as a role: usually one agent step that fixes the model, skill, secrets and budget for a kind of task |
| Scorer | a rubric, labels with scores, a pass threshold, a sample rate |
| Failure | a failing score; it carries 1–3 root causes |
| Queue | the unprocessed root causes owned by one project, or by the harness |
| Improvement run | a task that turns a queue's batch into a pull request |
| Benchmark | reference tasks with success criteria, run across configurations and scored |

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

A project file overrides a built-in with the same name. `cez factory check` validates them all (schemas and cross-references) and is a check step any workflow can run. An invalid file is reported, and the last valid version stays in effect.

**Policy lives in Cezar's settings**, global first with per-project overrides, like every other Cezar setting:
- **Global** (`~/.cezar/config.json`, Settings → Global → Factory): the judge runner and model, default sample rates, default task budget, default self-improvement policy.
- **Per project** (`.ai/cezar/config.json`, Settings → project → Factory): overrides of the budget and the self-improvement policy (thresholds, approval, scope).
- **Built-in defaults** apply when neither sets a value (D7 lists them).

There is no `factory.yaml`. Its contents were policy, and policy must stay outside what an improvement run can edit.

### D2. Task workflows: model, skill, secrets and budget as one file

Cezar's workflow step already sets the runner, model, effort, skill, allowed tools and prompt, and it already wins over the task and project defaults. So a reusable kind of task (Warp's role) is a workflow, usually with one agent step. Two additions make it complete:

- **`budget:`** on the workflow: `{ tokens, minutes }` for the whole run (D4).
- **`secrets:` on agent steps**: an optional list that narrows which `agents`-audience secrets the step receives. Without it the step gets all of them, as today. (Today `secrets:` on an agent step is a load error; that rule is lifted.)

```yaml
name: operate
description: Run a known workflow or script and report the result; low reasoning.
budget: { tokens: 800000, minutes: 20 }
steps:
  - id: work
    runner: opencode
    model: davy/mistral-large-4
    prompt: "{{task}}"
```

**Built-in task workflows** ship in the harness, next to `quick-task` and `review-pr`:

| Workflow | Runner and model | Use |
|---|---|---|
| `implement` | codex, gpt-6.2-sol | coding and fixes; opens a PR |
| `plan` | codex, gpt-6.2-sol, read-only | specs, investigation, design |
| `review-pr` (exists) | codex, gpt-6.2-sol, read-only | PR review |
| `operate` | opencode, davy/mistral-large-4 | running known workflows or scripts, status, summaries, moving docs |
| `improve-factory` | codex, gpt-6.2-sol | improvement runs (D6); owner-protected |

A project adds its own: open-webui's `deploy` would be `operate`'s model with the `jenkins-deploy` skill, its secrets narrowed to `JENKINS_*` and `PROD_VM_*`, and a deterministic check step that runs the deploy script.

The manager picks the workflow with `--workflow`. `--model`, `--skill`, `--secrets` and the `--budget-*` flags override single settings. Model routing lives in workflow files, where an improvement run can change it in a one-line, reviewed diff. `manage-project` says only: pick the workflow that fits, and propose a project workflow when a kind of task recurs.

### D3. Agents know what they have

**Manager list commands.** Each takes `--project` and `--json`:

| Command | Lists |
|---|---|
| `cez-manager workflows` | (exists) each workflow, what it can do, and its model and budget |
| `cez-manager secrets` | names, audiences and descriptions; never values |
| `cez-manager skills` | skills a task can be given; manager-only skills excluded |
| `cez-manager models [--runner r]` | models and effort levels per runner |
| `cez-manager agents` | runner accounts available to tasks, with usage-limit state |
| `cez-manager scores [--since 7d]` | pass rates per scorer, and open root causes |

`manage-project` starts with this rule: before planning, and before telling the owner something is missing, run the relevant list command.

**The capability block.** Cezar writes it into every task's system prompt, capped at 2k characters. The model never writes it:

```
Workflow: deploy (opencode, davy/mistral-large-4); budget 800k tokens, 20 min active
Secrets in your environment (values hidden; never print them):
  PROD_VM_HOST: production Node1 address
  PROD_VM_USER / PROD_VM_PASSWORD: SSH login for Node1
  JENKINS_URL / JENKINS_USER / JENKINS_PASSWORD: Jenkins API (CA: Michael/certs/ca-bundle.pem)
Other workflows in this project: implement, review-pr, plan
Attached skill: jenkins-deploy (scripts in its folder)
```

**Secret descriptions.** A secret gains an optional `description` (at most 200 characters, never secret). It's set with `cezar secrets set NAME --description "…"`, in Settings, or by a manager.

### D4. A budget per task that wakes the manager

The budget comes from the task flag, else the workflow's `budget:`, else the project setting, else the global setting (default 3M input tokens and 30 active minutes). Queued and parked time doesn't count.

Crossing the budget doesn't stop the task. The run records `budgetExceeded`, and a managed run wakes its manager with the metrics so far. The manager can raise the budget (`task budget <run>`), steer the task, switch its model, or cancel and retry. The next alert comes at 2× the budget. An unmanaged run gets an amber marker on its row.

### D5. Scoring

**Metrics: reuse what Cezar records.** Cezar already records for every run:
- on the run record: tokens in and out, cost, start and finish times, diff stats, models used, peak memory and processes, live context against the window, PR and completion reason;
- per step: tokens, cost, retries, iterations, invocations and turns;
- in the plan-usage ledger: cost and token weights and activity spans per consumer;
- in the event log: a timestamp on every event.

Two things are added:
- `TurnStatsCollector`, which records model requests, first and peak context, tool-result characters and cache reads for each manager turn, is extended to task sessions.
- Tool-call durations and output sizes are computed from the event log.

A small `metrics` summary is derived from these when a run ends, for the judge and the cockpit. No new tracking.

**Scorers.** Each scorer lives in `.ai/cezar/scorers/<name>/scorer.md`, or is built in:

```markdown
---
description: Did the task deliver what its brief asked, within scope?
workflows: [implement, operate]   # which runs it scores; default all
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

| Scorer | Grades |
|---|---|
| `outcome` | did it meet the brief's done criteria |
| `efficiency` | time and tokens against the task's size: needless reads, polling through the model, rebuilt tooling, repeated failures |
| `procedure` | did it follow AGENTS.md, its workflow, its skill and its constraints |
| `scope` | did it stay inside the brief |

**The judge.** By default it's OpenCode with `davy/mistral-large-4`, self-hosted, so transcripts stay on the company network and scoring costs only time. For each sampled scorer it makes one tool-less call, never a task, so scoring creates no runs. It reads the metrics first, then the full transcript as plain text (brief, messages, tool calls and outputs, in order, with secrets redacted). A transcript longer than the judge's window is shortened only in its largest tool outputs, keeping each one's head and tail; no call is ever dropped. The reply is validated against the scorer's labels, retried once if invalid, then recorded as an error.

**A score** holds the label, its score, pass or fail, and reasoning with quoted evidence. **A failing score names 1–3 root causes**, the first being the main one:

```json
{ "category": "harness | task-setup | repository | access | model | requirements | external",
  "target": "harness | manager-skill | workflow | skill | agents-md | docs | code | brief | infra",
  "evidence": "a quoted transcript line or a metric",
  "fix": "the concrete change that would have prevented it" }
```

A cause without quoted evidence is dropped. Three is the cap: it covers the multi-cause failures seen so far without letting the judge pad the list.

Scores are stored with the run (`runs/<id>.scores.json`), together with the harness release (`harnessVersion`) and project commit it ran under. `cez score <run> [--scorer s]` re-scores a run, replacing that scorer's result.

**In the cockpit:**
- task row columns for Outcome, Efficiency and main root cause, next to the existing tokens and cost columns;
- a Scores panel in the task detail;
- a Factory view per project: pass rate per scorer over time, cost per merged PR, human touchpoints per PR, PRs merged per week, open improvement PRs.

**API:** `GET /p/:id/runs/:run/scores`, `GET /p/:id/scores?since=…&groupBy=scorer|category|target`, and `GET /workspace/scores` across projects.

### D6. Self-improvement

**Routing.** Each root cause is routed when it's scored, on its own, by its target:

| Target | Queue |
|---|---|
| `workflow`, `skill`, `agents-md`, `docs`, `code` | the project's queue |
| `brief` | the project's queue if a workflow's prompt caused it; the harness queue if the manager skill did |
| `harness`, `manager-skill` | the harness queue (the Cezar-fork project) |
| `infra` | no queue: a note to the owner through the project's manager |

So one failure can feed both queues. A task that ran inside the Cezar fork routes everything to the harness queue.

**Triggers.** A deterministic Cezar timer checks every hour, with no model call. It starts an improvement run for a queue when:
- the queue holds the threshold number of unprocessed causes (project 5, harness 5), or
- its oldest unprocessed cause is old enough (project 3 days, harness 7 days) and there are at least 2.

Two guards apply:
- **one at a time:** never while the same queue has an improvement run in flight or an improvement PR open;
- **cooldown:** after an improvement PR merges, wait for 5 newly scored runs or 3 days, whichever comes first (harness: until the release has 10 scored runs).

The **project's manager**, or the **owner**, can also start a run at any time ("improve the factory now"). That skips the threshold but still respects both guards. The manager is told whenever the timer starts one.

**The harness queue's other inputs:**
- **escalations:** a project improvement run may judge a cause generic ("every project's tasks will hit this") and move it to the harness queue instead of patching the repo;
- **repeats:** when a harness run starts, it receives a digest of every project's recent causes and decides, by judgement rather than string matching, which repeat across two or more projects and deserve a better default;
- **releases:** after each harness release, a check of whether the release helped (D9).

**The improvement run** is an ordinary task in the project it improves, using the `improve-factory` workflow. Its input is the batch: each cause with its scorer, label, reasoning, evidence and run link. Then:
1. **Agent step:**
   - cluster the causes by evidence;
   - for each cluster, read the transcripts of two or three of its runs to confirm it;
   - pick the clusters worth fixing, by how often they occur times what they cost;
   - write redrafts to the files that own each cause;
   - mark the clusters it skips as dismissed (with a reason) or escalated.
2. **Check step:** `cez factory check`, plus the project's tests if it touched code.
3. **PR step:** one PR whose description lists each change, the regressions it addresses (runs, scorers, evidence) and the effect it expects.

Cezar does the bookkeeping, not the model. It marks the batch processed and records which cluster went to which PR, which were dismissed and which escalated.

**Approval.** The project's manager is informed like any other task, and handles the PR by the project's policy:
- `manager` (default): a review task reviews it, then the manager merges it or sends fixes back;
- `owner`: the owner approves;
- `none`: the manager merges after the review task, with no person.

Whatever the policy, these always need the owner: changes to scorers, the judge, `improve-factory` or its skill; widening secrets or permissions; large refactors of product code.

**Scope.** A project's policy can limit what its improvement runs may touch, for example docs, workflows and skills only, no code.

### D7. Defaults for a one-person factory

| Setting | Project | Harness |
|---|---|---|
| Start a run at | 5 unprocessed causes | 5 |
| Or when the oldest is | 3 days old, with at least 2 | 7 days old, with at least 2 |
| Cooldown after a merge | 5 scored runs or 3 days | 10 scored runs on the new release |
| At most in flight | 1, and none while its PR is open | 1 |
| Approval | manager, after a review task | manager, after a review task; the release benchmarks and can roll back |
| Always the owner | scorers, judge, `improve-factory`, secrets or permissions, big refactors | same |
| Scorers sampled | all four on every run (the judge is self-hosted) | same |
| Task budget | 3M input tokens, 30 active minutes | same |

### D8. Benchmarks

A suite lives in `.ai/cezar/benchmarks/<suite>/`:

```yaml
# suite.yaml
description: Deploy-status tasks for open-webui
workflow: operate
configurations:
  - { name: mistral, model: davy/mistral-large-4 }
  - { name: sol-low, runner: codex, model: gpt-6.2-sol, effort: low }
tasks: [jenkins-status, prod-health]
scorers: [outcome, efficiency]
---
# tasks/jenkins-status.yaml
title: Report the last CI and CD builds
prompt: Report the last chatbot/build-push and chatbot/deploy builds and their results.
successCriteria: Both build numbers and results are correct.
startingRef: 97d817021174027d647df63c890423771ef9d330
```

`cez benchmark <suite>` runs every task under every configuration as safe tasks (no merges, no deploys; check steps with side effects are skipped). It scores them and reports pass rate, cost and time per configuration. `cez benchmark add <run>` turns a completed run into a task, using its brief as the prompt and its outcome as the success criteria.

An improvement run that changes a workflow's model runs the matching suite first. A harness release always runs the harness suite (D9).

### D9. The self-maintaining harness

The Cezar fork (`~/dev/cezar`, remote `mlei06/cezar`) is a registered project with its own manager, the harness manager. Its workflows and skills are for working on Cezar's code. Its queue receives harness causes from every project.

**1. The running harness is a release, never the working tree.**
- releases are built from merged commits into `~/.cezar/harness/releases/<sha>/`;
- a `current` link points at the live one, and the systemd unit runs `current`;
- the fork checkout is an ordinary project, edited only in task worktrees, so a merge can't change the live harness.

**2. Shipping is the `harness-release` workflow,** check steps except one summary:
1. Typecheck, test and build the merged commit, then install it as a new release.
2. Start a **staging cockpit** from it on another port with its own `CEZ_HOME`. Run the harness benchmark suite against it (`CEZ_DRY_RUN=1` by default; a few real cheap tasks when the release touches runners or prompts). Compare with the current release's last results.
3. Wait until no task is running and no manager turn is active, holding new task starts for at most 15 minutes.
4. Switch `current`, restart, then check `/api/v1/health` and one dry-run task.
5. On any failure, switch back to the previous release and restart.
6. Post the release notes and the benchmark comparison to the harness manager.

**3. Attribution.** Every score records `harnessVersion`. After a release, the harness manager compares failure rates for the clusters the release targeted. A release that made them worse is reverted with `harness-release --rollback`.

**4. Limits.**
- The grader rule applies to the harness.
- Each harness PR is labelled fork-only or upstreamable, so generic fixes can go to open-mercato/cezar.
- Manager-only skills ship in the fork's `manager-skills/`. `~/.cezar/manager-skills/` is for local experiments.

### D10. Reports and proactive triggers

These use Cezar's existing automations and manager jobs:
- **Hourly:** the improvement-run check (D6).
- **Weekly, per project:** the manager posts a factory report, read only from stored scores: pass rates and trends, cost per merged PR, human touchpoints per PR, top open causes, and the improvement PRs merged or waiting, with their before/after.
- **On a main CI failure:** a `fix-ci` task.
- **Daily:** a credential health check that every secret a workflow uses still works (Jenkins login, PAT expiry, SSH reachability), with a note filed before it blocks a run.
- **Later:** monitoring webhooks (Sentry/Grafana style) that start an investigation task.

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
| `contract/` | workflow `budget`; agent-step `secrets`; run fields `grantedSecrets`, `budget`, `budgetExceeded`, `harnessVersion`; scorer, score, suite and task schemas; secret `description`; factory settings in workspace and project config |
| `workflows/` | lift the agent-step `secrets` rule; built-in task workflows; the capability block; budget accounting |
| `factory/` (new) | load and validate scorers and benchmarks with built-in defaults; `cez factory check` |
| `managers/` | list commands; `--secrets`, `--budget-*`, `task budget`; budget follow-ups; improvement trigger, queues and bookkeeping; `TurnStatsCollector` reused for tasks |
| `scoring/` (new) | metrics summary; transcript rendering, shortened to fit; the judge call; scores, causes and routing; re-scoring |
| `benchmarks/` (new) | the suite runner and matrix; `benchmark add` |
| `workspace/secrets*` | `description` |
| `server/` | score, factory and benchmark routes |
| web | score columns, Scores panel, Factory view, Factory settings |
| `manager-skills/` | `manage-project` (list commands, workflow choice, budgets); `manage-harness` (new) |
| `skills/improve-factory` (new) | the improvement playbook |
| release | `~/.cezar/harness/releases`, the `current` link and unit file, and `harness-release` in the fork's workflows |

## Tests and acceptance

- **Task workflows:**
  - a workflow's `budget` and agent-step `secrets` apply;
  - explicit flags override single settings;
  - existing workflows without these fields behave exactly as before.
- **Capability block:** names exactly the granted secrets and never a value; lists the workflows and the attached skill; stays under the cap.
- **Budget:** one follow-up per crossing; the next at 2×; queued and parked time don't count.
- **Metrics,** from the replayed open-webui upgrade log: 116 model requests, about 93k average context, the 77k first output among the largest.
- **Scoring:**
  - every sampled scorer records a valid label, or an error after one retry;
  - a failing score has 1–3 causes, each with evidence;
  - an over-long transcript is shortened only in its largest outputs and fits the window;
  - scoring creates no runs.
- **Routing and triggers:**
  - a cause routes to the project or harness queue by its target, and one failure can feed both;
  - 5 causes, or a 3-day-old cause with at least 2, starts exactly one run;
  - a manual start skips the threshold but not the guards;
  - nothing starts while a run is in flight or its PR is open, or during cooldown.
- **Approval:** a PR touching scorers asks the owner even under `none`.
- **Harness release:**
  - a failing benchmark or health check keeps or restores the previous release;
  - no switch happens while work is active;
  - scores record `harnessVersion`.

**Acceptance:**
- Rerunning "update production" on open-webui needs no round trip to the user for access, and its tasks stay within budget.
- Every finished task shows Outcome and Efficiency within a minute.
- Within two weeks of D6 shipping, at least one project improvement PR and one harness improvement PR have merged, and the failure rates of their clusters have dropped.

## Open questions

1. **Hard budgets:** should a task at 3× its budget pause until the manager answers?
2. **Scoring scope:** score tasks the owner starts by hand too (default yes), or only manager and automation tasks?
3. **Mistral's context window:** confirm `mistral-large-4`'s window on the davy endpoint; it decides how often transcripts need shortening.
4. **Scoring the managers:** apply the same metrics, scorers and improvement to manager turns, after D6.

## Sources

- Warp blog: [engineering self-improving software factories](https://www.warp.dev/blog/engineering-self-improving-software-factories), [closing the loop](https://warp.dev/blog/agent-self-improving-software-factories), [the road to self-improving software](https://www.warp.dev/blog/self-improving-software-proactive-agents).
- Warp docs: [scorers](https://docs.warp.dev/factories/measure-and-improve/scorers/), [self-improvement](https://docs.warp.dev/factories/measure-and-improve/self-improvement/), [automations](https://docs.warp.dev/factories/automations/), [factory as code](https://docs.warp.dev/factories/factory-as-code/).

Where Cezar differs on purpose:
- it's local and needs no configuration;
- task workflows replace Warp's agent definitions, because Cezar's workflow steps already carry model, skill and tools;
- policy lives in settings rather than in a factory file the loop could edit;
- failures carry routed root causes, so fixes can land in the right repository;
- it adds the harness tier (D9), which Warp doesn't describe.
