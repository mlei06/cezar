# The self-improving factory

Status: draft v4, 2026-11-25. Fork: `mlei06/cezar`, trunk `factory`. Owner: Michael. Spec owner: the overseer (see the roadmap). Implementation plan: `2026-11-25-self-improving-factory-roadmap.md`. Findings during the build: `2026-11-25-self-improving-factory-observations.md`.

## TLDR

Cezar already runs a factory: managers turn outcomes into tasks, tasks run workflows on agents, and pull requests come back for review or merge. What it lacks is the loop that makes the factory better over time. This spec adds that loop, modelled on Warp's software factories and adapted to a local, zero-config cockpit run by one person:

1. **Factory as code, using what Cezar already has.** A project's factory is the set of files it commits: workflows, skills, scorers, benchmarks and AGENTS.md. Workflows double as Warp's agent roles: one file says which model, skill, secrets and budget a kind of task gets. Policy (thresholds, approvals, the judge) stays in Cezar's settings, global with per-project overrides, out of reach of the loop.
2. **Agents know what they have.** List commands for managers; a capability block in every task's prompt (its secrets, workflows and skill); secret descriptions; optional secret narrowing.
3. **Bounded tasks.** A per-task token and time budget that wakes the manager when crossed.
4. **Scoring.** After every run, scorers (each a rubric, labels with scores, a pass threshold) are judged by a cheap, self-hosted model. The judge reads Cezar's existing metrics plus the full transcript. A failing score names one to three root causes, each with a target: the place its fix belongs.
5. **Self-improvement.** Root causes are routed to the queue of whoever can fix them: the project or the harness. A deterministic timer starts an improvement run when a queue fills or ages; the manager or the owner can also start one. The run clusters the causes and opens a pull request of redrafts that lists the regressions it addresses.
6. **Verification.** Before/after comparison of scores, and benchmarks (reference tasks across configurations) where a change needs a real comparison.
7. **A self-maintaining harness.** The Cezar fork is a project with its own manager. Cezar runs from pinned releases, so a harness change ships through a benchmarked release with automatic rollback.

## Contents

- Evidence, Principles, Glossary
- Decisions D1–D10
- Data model and storage
- Settings, CLI and API reference
- Failure handling and edge cases
- Security and privacy
- Zero config and compatibility
- Already shipped, Modules, Tests and acceptance, Open questions, Changelog, Sources

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
- **Policy is not factory.** What the loop may edit (workflows, skills, docs, code; scorer rubrics only with the owner) lives in repos. What governs the loop (thresholds, approvals, judge, scope) lives in settings, which the loop can't change.
- **Nobody grades their own grader.** Changes to scorers, the judge, or the self-improvement workflow and skill always need the owner.
- **Deterministic where possible.** Metrics, routing, triggers, guards and bookkeeping are code. Models do only the judging, clustering and writing.

## Glossary

| Term | Meaning |
|---|---|
| Owner | the person the factory works for (Michael) |
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

| Workflow | Runner and model | Budget | Use |
|---|---|---|---|
| `implement` | codex, gpt-6.2-sol | 3M, 30 min | coding and fixes; ends at a PR |
| `plan` | codex, gpt-6.2-sol, read-only | 1.5M, 20 min | specs, investigation, design |
| `review-pr` (exists) | codex, gpt-6.2-sol, read-only | 1.5M, 20 min | PR review |
| `operate` | opencode, davy/mistral-large-4 | 800k, 20 min | running known workflows or scripts, status, summaries, moving docs |
| `improve-factory` | codex, gpt-6.2-sol | 4M, 45 min | improvement runs (D6); owner-protected |

The built-in model choices are defaults for this fork's machine. A project overrides a built-in by committing a workflow with the same name. A machine without OpenCode or Mistral falls back to the project's default runner for `operate`, with a note on the task.

A project adds its own task workflows. Open-webui's `deploy`, for example:

```yaml
name: deploy
description: Deploy main to production through Jenkins and verify it.
budget: { tokens: 600000, minutes: 60 }
nodes:
  - { id: start, type: start }
  - { id: preflight, type: check, command: python3 .ai/skills/jenkins-deploy/scripts/deploy.py preflight }
  - { id: rollout, type: check, command: python3 .ai/skills/jenkins-deploy/scripts/deploy.py apply }
  - id: report
    type: agent
    runner: opencode
    model: davy/mistral-large-4
    skill: jenkins-deploy
    secrets: [JENKINS_URL, JENKINS_USER, JENKINS_PASSWORD, PROD_VM_HOST]
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
Workflow: deploy (opencode, davy/mistral-large-4); budget 600k tokens, 60 min active
Secrets in your environment (values hidden; never print them):
  JENKINS_URL / JENKINS_USER / JENKINS_PASSWORD: Jenkins API (CA: Michael/certs/ca-bundle.pem)
  PROD_VM_HOST: production Node1 address
Other workflows in this project: implement, plan, review-pr, operate
Attached skill: jenkins-deploy (scripts in its folder)
```

Over the cap, Cezar trims in this order: other workflows' names, then secret descriptions, and lastly secret names (never). It also reports how many entries it omitted.

**Secret descriptions.** A secret gains an optional `description` (at most 200 characters, never secret, never redacted). It's set with `cezar secrets set NAME --description "…"`, `cezar secrets describe NAME "…"`, in Settings, or by a manager.

### D4. A budget per task that wakes the manager

**Precedence:** the task flag, else the workflow's `budget:`, else the project setting, else the global setting (default 3M input tokens and 30 active minutes).

**Accounting:**
- **Tokens** are input tokens summed over every step and model call, which the run record already tracks.
- **Active time** is time with a step running. Queued time, parking (usage-limit holds, waiting on the owner) and time at a human gate don't count.

**Crossing it doesn't stop the task.** The run records `budgetExceeded: { metric, at, value }`. A managed run wakes its manager with a follow-up event: the metrics so far, the five largest tool outputs, and the current step. The manager can:
- raise the budget: `cez-manager task budget <run> --tokens N --minutes M`;
- steer the task with `task say`;
- switch its model with `task switch`;
- or cancel and retry.

The next alert comes at 2× the budget, then 4×. An unmanaged run gets an amber marker on its row and in the task header.

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
- **Who:** by default OpenCode with `davy/mistral-large-4`, self-hosted, so transcripts stay on the company network and scoring costs only time.
- **How:** one tool-less call per scorer, never a task, so scoring creates no runs. Calls run one at a time per machine (a small queue).
- **What it reads:** the rubric, the labels, the metrics, then the full transcript as plain text ("Data model" describes the format).
- **Too long:** a transcript longer than the judge's window is shortened only in its largest tool outputs, keeping each one's head and tail. A call or message is never dropped.
- **Its reply:** JSON, validated against the scorer's labels; retried once if invalid, then recorded as an error.

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

**Triggers.** A deterministic Cezar timer checks every hour, with no model call. It starts an improvement run for a queue when:
- the queue holds the threshold number of unprocessed causes, or
- its oldest unprocessed cause is old enough and there are at least the minimum number.

Two guards apply:
- **one at a time:** never while the same queue has an improvement run in flight or an improvement PR open;
- **cooldown:** after an improvement PR merges, no run until the cooldown has passed (D7).

The project's **manager** (`cez-manager improve --project <id>`), or the **owner** (the Factory view's "Improve now", or `cez improve`), can start a run at any time. That skips the threshold but still respects both guards. When a guard blocks a start, the reason is shown. The manager is told whenever the timer starts a run, like any task it follows.

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
| Judge | opencode, davy/mistral-large-4 | same |

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

**Running a suite.** `cez benchmark <suite> [--config c]` runs every task under every configuration as safe tasks:
- in worktrees at `startingRef`;
- no merges, pushes or deploys;
- check steps marked `sideEffects: true` are skipped.

It scores them with the suite's scorers and reports a matrix of pass rate, cost and time per configuration. The results are stored under the run data and shown in the Factory view.

**Growing suites.** `cez benchmark add <run> --suite s` turns a completed run into a task: its brief becomes the prompt, its outcome the success criteria, and its starting commit the `startingRef`.

**When suites run:**
- **Model changes:** an improvement run that changes a workflow's model runs the matching suite (the one whose `workflow` is that workflow) on both configurations, and puts the matrix in its PR.
- **Harness releases:** a release always runs the harness suite (D9).

### D9. The self-maintaining harness

The Cezar fork (`~/dev/cezar`, remote `mlei06/cezar`, trunk `factory`) is the harness project, with its own manager, the harness manager. Its workflows and skills are for working on Cezar's code, and its queue receives harness causes from every project.

**1. The running harness is a release, never the working tree.**

```text
~/.cezar/harness/
  releases/<sha>/        an exported commit, with node_modules and its build
  current -> releases/<sha>
  previous -> releases/<sha>
  release-log.ndjson     every release, switch and rollback
```

The systemd unit runs `current`. The fork checkout is an ordinary project, edited only in task worktrees, so a merge can't change the live harness. Releases are kept for the last 5 commits.

**2. Shipping is the `harness-release` workflow** in the harness project. It's check steps, apart from one summary:
1. **Build:** typecheck, test and build the merged commit (the AGENTS.md validation order), then install it as a new release.
2. **Stage:** start a staging cockpit from it on another port with its own `CEZ_HOME`. Run the harness benchmark suite against it: `CEZ_DRY_RUN=1` by default, plus a few real cheap tasks when the release touches runners, prompts or the judge. Compare with the current release's last results; a drop beyond the tolerance (default 10 points of pass rate) stops the release.
3. **Wait for idle:** wait until no task is running and no manager turn is active, holding new task starts (they queue) for at most 15 minutes; then stop and report.
4. **Switch:** move `current`, restart, then check `/api/v1/health` and run one dry-run task.
5. **Roll back** on any failure: switch back to `previous`, restart, and report.
6. **Report:** post the release notes (the merged PRs since the last release), the benchmark comparison and the switch result to the harness manager.

The workflow's own changes are owner-protected, like the grader.

**3. Attribution.** Every score records `harnessVersion`, the release's commit. After a release, the harness manager compares failure rates for the clusters the release's PRs targeted, once 10 runs have been scored on it. A release that made them worse is reverted with `harness-release --rollback`, which switches back and opens a revert PR.

**4. Limits.**
- The grader rule applies to the harness too.
- Each harness PR is labelled `fork-only` or `upstreamable`, so generic fixes can go to open-mercato/cezar.
- Manager-only skills ship in the fork's `manager-skills/`. `~/.cezar/manager-skills/` is for local experiments, and an experiment that works becomes a PR.

### D10. Reports and proactive triggers

These use Cezar's existing automations and manager jobs:
- **Hourly:** the improvement-run check (D6).
- **Weekly, per project:** the manager posts a factory report, read only from stored scores:
  - pass rates and their trend;
  - cost per merged PR;
  - human touchpoints per PR;
  - queue sizes and top open causes;
  - improvement PRs merged or waiting, with their before/after.
- **On a main CI failure:** a `fix-ci` task.
- **Daily:** a credential health check that every secret a workflow names still works (Jenkins login, PAT expiry, SSH reachability), using check commands a project declares in a `credential-health` workflow. A failure becomes an `access` cause and a note to the owner before it blocks a run.
- **Later:** monitoring webhooks (Sentry/Grafana style) that start an investigation task.

## Data model and storage

| What | Where | Notes |
|---|---|---|
| Metrics summary | `.ai/cezar/runs/<id>.metrics.json` | derived when the run ends; rebuilt on demand |
| Scores | `.ai/cezar/runs/<id>.scores.json` | one entry per scorer; holds `harnessVersion` and project commit |
| Project queue | `.ai/cezar/factory/queue.json` | causes with state `open`, `processing`, `processed`, `dismissed`, `escalated`, `deferred` |
| Harness queue | `~/.cezar/factory/harness-queue.json` | workspace-wide |
| Improvements | `.ai/cezar/factory/improvements.json` | run, clusters, decisions, PR, merge commit, before/after |
| Benchmark results | `.ai/cezar/factory/benchmarks/<suite>/<at>.json` | one matrix per run |
| Release log | `~/.cezar/harness/release-log.ndjson` | releases, switches, rollbacks |

`.ai/cezar/factory/` joins the `ensureDataGitignore` allowlist as ignored state. Every file is optional and rebuilt when missing. A missing queue starts empty, and causes that were never processed are re-derived from recent scores.

**Metrics summary:**

```json
{ "runId": "…", "workflow": "implement", "runner": "codex", "model": "gpt-6.2-sol",
  "startedBy": "manager | owner | automation | improvement | benchmark",
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
  "judge": { "runner": "opencode", "model": "davy/mistral-large-4", "transcriptChars": 0, "shortened": false },
  "harnessVersion": "<sha>", "projectCommit": "<sha>", "at": "…" }
```

**Transcript rendering for the judge** (plain text, in order):

```
# Run <id8>: <title>
workflow implement · codex gpt-6.2-sol · started by manager · status done · PR <url>
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
| `judge.runner`, `judge.model` | `opencode`, `davy/mistral-large-4` | no |
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
| `cez benchmark <suite> [--config c]`, `cez benchmark add <run> --suite s` | run or grow a benchmark |
| `cezar secrets set NAME --description "…"`, `cezar secrets describe NAME "…"` | secret descriptions |
| `cez-manager workflows|secrets|skills|models|agents|scores` | list commands (D3) |
| `cez-manager improve --project p` | the manager starts an improvement run |
| `cez-manager task create … --workflow w --secrets a,b --budget-tokens N --budget-minutes M` | task options |
| `cez-manager task budget <run> --tokens N --minutes M` | raise a budget |
| `harness-release [<sha>] [--rollback] [--force]` | the harness release workflow (harness project) |

**API (all under `/api/v1`; project routes also under `/p/:projectId`):**
- `GET /runs/:id/metrics`, `GET /runs/:id/scores`, `POST /runs/:id/score`;
- `GET /factory` (definition, settings, queue, improvements), `GET /factory/check`, `POST /factory/improve`;
- `GET /scores?since&groupBy=scorer|category|target`;
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
| A release fails mid-switch | `previous` is restored; the release log records it; the harness manager is told |
| The owner edits factory files by hand | normal; `cez factory check` runs on load; scoring and improvement use whatever is committed |
| Two machines share a project | queues and scores are machine-local state; each machine scores its own runs |

## Security and privacy

- **What the judge sees:** transcripts are rendered with every value redacted that Cezar redacts today (host and run secrets, token shapes, `agents` and `checks` secret values), before they reach the judge.
- **Where the judge runs:** the default judge is self-hosted, so transcripts stay on the company network. Choosing a hosted judge model is a settings change with a warning in Settings.
- **Scores:** reasoning and evidence quote transcripts, so the same redaction applies before storing them.
- **Improvement runs** are ordinary tasks, with the project's secrets and grants. They can't widen secrets or permissions without the owner (D6).
- **Benchmarks** never push, merge or deploy, and skip check steps marked with side effects.
- **The harness release** runs with the owner's own permissions, and only on commits merged to `factory`.

## Zero config and compatibility

- **Nothing is required.** With no files, a project gets the built-in task workflows and scorers and the default settings. Without OpenCode or Mistral on the machine, the judge falls back to the project's default runner and model at low effort, with a note in the Factory view.
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
| `contract/` | workflow `budget`; agent-step `secrets`; run fields `grantedSecrets`, `budget`, `budgetExceeded`, `harnessVersion`; metrics, score, cause, queue, improvement, scorer, suite and task schemas; secret `description`; `factory` settings in workspace and project config; new events |
| `workflows/` | lift the agent-step `secrets` rule; built-in task workflows; the capability block; budget accounting |
| `factory/` (new) | load and validate scorers and benchmarks with built-in defaults; `cez factory check`; settings resolution |
| `managers/` | list commands; `--secrets`, `--budget-*`, `task budget`, `improve`; budget and improvement follow-ups; `TurnStatsCollector` reused for tasks |
| `scoring/` (new) | metrics summary; transcript rendering, shortened to fit; the judge queue and call; scores, causes, evidence check; routing; re-scoring |
| `improvement/` (new) | queues, the hourly trigger, guards, batch briefs, decisions file, bookkeeping, before/after |
| `benchmarks/` (new) | the suite runner and matrix; `benchmark add` |
| `workspace/secrets*` | `description` |
| `server/` | the routes and events above |
| web | score columns, Scores panel, Factory view, Factory settings |
| `manager-skills/` | `manage-project` (list commands, workflow choice, budgets, improvement); `manage-harness` (new) |
| `skills/improve-factory` (new) | the improvement playbook |
| release | `scripts/harness-release.mjs`, the `~/.cezar/harness` layout and unit file, the `harness-release` workflow |

## Tests and acceptance

- **Task workflows:**
  - a workflow's `budget` and agent-step `secrets` apply;
  - explicit flags override single settings;
  - existing workflows without these fields behave exactly as before;
  - `operate` falls back on a machine without OpenCode.
- **Capability block:** names exactly the granted secrets and never a value; lists the workflows and the attached skill; trims in order and stays under the cap.
- **Budget:** one follow-up per crossing; the next at 2×, then 4×; queued, parked and gate time don't count.
- **Metrics,** from the replayed open-webui upgrade log: 116 model requests, about 93k average context, the 77k first output among the largest.
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
- **Benchmarks:** a suite runs every task under every configuration without side effects and records a matrix.
- **Harness release:**
  - a failing build, benchmark or health check keeps or restores the previous release;
  - no switch happens while work is active;
  - scores record `harnessVersion`.
- **Compatibility:** old run files parse; contract-parity and route-parity tests pass; every new env var is in `.env.example`.

**Acceptance:**
- Rerunning "update production" on open-webui needs no round trip to the owner for access, and its tasks stay within budget.
- Every finished task shows Outcome and Efficiency within a minute when the judge is up.
- Within two weeks of D6 shipping, at least one project improvement PR and one harness improvement PR have merged, and the failure rates of their clusters have dropped.
- The overseer's calibration (roadmap M3) shows the judge agreeing with the overseer on pass/fail for at least 80% of sampled runs, and on the main cause's target for at least 70%.

## Open questions

1. **Hard budgets:** should a task at 4× its budget pause until the manager answers?
2. **Scoring scope:** score tasks the owner starts by hand too (default yes), or only manager and automation tasks?
3. **Mistral's context window:** confirm `mistral-large-4`'s window on the davy endpoint (measured in roadmap M0.6); it decides how often transcripts need shortening.
4. **Scoring the managers:** apply the same metrics, scorers and improvement to manager turns, after D6.

## Changelog

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
