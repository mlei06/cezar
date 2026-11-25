# The self-improving factory

Status: draft, 2026-11-25. Fork: `mlei06/cezar`, branch `feat/manager-autonomy`. Supersedes the "software factory feedback" draft of the same day.

## TLDR

Cezar already runs a factory: managers turn outcomes into tasks, tasks run workflows on agents, and pull requests come back for review or merge. What it lacks is the loop that makes the factory better over time. This spec adds that loop, modelled on Warp's software factories and adapted to a local, zero-config cockpit:

1. **Factory as code.** Everything that shapes how agents work on a project is committed in that project. A small `factory.yaml` holds the factory settings. Next to it are **roles** (reusable task-agent definitions: model, skills, secrets, budget, instructions), workflows, skills, **scorers** and **benchmarks**. Because these are files, agents can propose changes to them and owners can review those changes.
2. **Agents know what they have.** List commands for managers, a capability block in every task's prompt (its secrets, workflows and skills), secret descriptions, and an optional `--secrets` flag.
3. **Lean, bounded tasks.** Roles carry the model and skill choice, the manager writes a lean brief, and a per-task budget wakes the manager when it's crossed.
4. **Scoring.** After a run, sampled scorers (a rubric, labels with scores, a pass threshold, a judge model) read its full transcript plus measured metrics. Each records a classification and its reasoning. A failure also gets a root-cause category and the place where the fix belongs. All of it shows on the task row.
5. **Self-improvement.** When failures accumulate, a self-improvement run clusters them and proposes redrafts, as pull requests listing the regressions they address. Each fix lands where its cause lives:
   - project causes in the project's own factory files, docs or code;
   - harness causes in the Cezar fork.
6. **Verification.** Benchmarks (reference tasks with success criteria, run across configurations) check a change before it ships. Scoring then checks it after: the next runs are compared with the baseline.
7. **A self-maintaining harness.** The Cezar fork is a project with its own factory and manager. Cezar runs from pinned releases, so a harness change ships through a benchmarked release with automatic rollback.

## Evidence (open-webui, 2026-11-25)

The first end-to-end test: an autonomous manager on Codex gpt-6.2-sol, asked only "update production".

| What happened | Root cause | Where the fix lives |
|---|---|---|
| A round trip to the user for SSH access the agents already had (`PROD_VM_*`) | agents weren't told their secrets | harness: the capability block (D4) |
| The upgrade task ran 25+ min: 116 model calls averaging 93k tokens of context (10.7M input in all), with 62% of the time spent in the model | a 77k-character first read carried by every call; builds polled through the model | project: shorter required reading. Brief: name the files. Harness: budget (D5) |
| The task rebuilt backup and staging scripts that already existed | the helpers sat in an ignored folder, invisible to task worktrees | project: helpers inside a committed skill (D2) |
| Workflow task: invented secret names, then grew the scope (a sandboxed launcher, a new rollout contract) | no list of secrets; a loose brief | harness: D3/D4. Project: a deploy role (D2) |
| 7 review runs voted "reject" with no findings | reviewers couldn't read Azure PR diffs | harness: fixed in `6a00d2387` |
| The manager playbook leaked into task agents | installed globally | harness: fixed in `6f8519c88` |
| Two stray managers | test sandboxes got automatic managers | harness: fixed in `6f8519c88` |

All three places where fixes belong show up in one afternoon: the harness, the project's factory files, and the manager's choices.

## Principles

- **Zero config.** Every file in this spec is optional. Cezar ships default roles, scorers and settings, and a project file overrides a default with the same name. An empty repo still gets scoring and self-improvement on the defaults.
- **Fixes as pull requests.** Every improvement is a diff that someone reviews: a person, a review task, or both. Nothing rewrites factory files in place.
- **Redrafts, not additions.** A self-improvement change rewrites the guidance it touches and removes what is outdated. It never appends an addendum. Skills and AGENTS.md must get shorter or stay the same length unless the PR says why.
- **Pay for judgement only where it's needed.** Deterministic checks and metrics come first. Model judges are sampled, cheap, and self-hosted where possible.
- **Nobody grades their own grader.** Changes to scorers, the judge model or the self-improvement prompt always need the owner.

## Glossary

| Term | Meaning in Cezar |
|---|---|
| Factory | a project's committed definition of how agents work on it: `.ai/cezar/factory.yaml` plus roles, workflows, skills, scorers and benchmarks, alongside AGENTS.md |
| Harness | Cezar itself: engine, runners, grants, hooks, system prompts, manager skills, default roles and default scorers |
| Manager | the long-lived agent that owns outcomes for its projects (Warp's foreman) |
| Role | a reusable task-agent definition: runner, model, effort, skills, secrets, budget and instructions (Warp's agent or worker) |
| Task | one run of a workflow, with its own branch and worktree |
| Scorer | a rubric, labels with scores, a pass threshold, a judge model and a sample rate |
| Score | one scorer's classification of one run, with reasoning, plus a root cause when it fails |
| Self-improvement run | a task that turns a batch of failing scores into a pull request |
| Benchmark | reference tasks with success criteria, run across configurations and graded by scorers |

## Decisions

### D1. Factory as code: `.ai/cezar/factory.yaml` and the definition layout

A project's factory lives in its repository:

```text
AGENTS.md                         project facts and rules (read by managers and tasks)
.ai/cezar/factory.yaml            factory settings (optional)
.ai/cezar/roles/<name>/role.md    task-agent definitions (D2)
.ai/cezar/workflows/*.yaml        workflows (existing)
.ai/skills/<name>/SKILL.md        project skills; their scripts in scripts/ (existing)
.ai/cezar/scorers/<name>/scorer.md   scorers (D6)
.ai/cezar/benchmarks/<suite>/suite.yaml + tasks/*.yaml   benchmarks (D9)
```

`factory.yaml` holds only settings that belong to the whole factory. Each one has a default:

```yaml
schemaVersion: 1
defaults:
  role: implement                 # used by task create without --role
  budget: { tokens: 3000000, minutes: 30 }
scoring:
  judge: { runner: opencode, model: davy/mistral-large-4 }   # default judge for scorers without a model
  samplingRate: 25                # default sample rate, percent
selfImprovement:
  failedRunThreshold: 10          # unprocessed failures that start a run
  maxAgeDays: 7                   # or the age of the oldest one
  review: manager                 # manager | owner | none: who must approve its PRs (D8)
  scope: [roles, skills, workflows, scorers-proposals-only, agents-md, docs, code]
```

**Why a new file instead of `.ai/cezar/config.json`:** `config.json` carries settings that only the local machine may grant (for example `bypassPermissions` is refused when that file is tracked). The factory must be committed and reviewable, so it gets its own file. `config.json` stays for local machine settings.

**Validation:** Cezar validates the whole definition (zod schemas, references between files) when it loads a project, and as a check step any workflow can run (`cez factory check`). An invalid definition is reported and the last valid one stays in effect, as Warp does. Self-improvement PRs run that check before they open.

The Cezar fork is a project too. Its factory definition describes how agents maintain the harness (D11). The harness's defaults (roles, scorers, manager skills) ship inside the fork, where its own self-improvement can edit them.

### D2. Roles: model, skills, secrets and budget as files

A role is a reusable definition for one kind of task. Each lives in `.ai/cezar/roles/<name>/role.md`: frontmatter for settings, body for standing instructions. The body is added to the task's system prompt, ahead of the brief.

```markdown
---
description: Implement a change on a branch and open a PR
runner: codex
model: gpt-6.2-sol
effort: medium
workflow: quick-task
skills: []
secrets: all            # all agents-audience secrets (default) or a list of names
budget: { tokens: 3000000, minutes: 30 }
---
Read only the files the brief names, then search. Wait for long commands inside one shell
command. Keep scope to the brief; report missing scope instead of doing it.
```

**Default roles** ship in the harness and can be overridden by a project role with the same name:

| Role | Runner and model | Workflow | Use |
|---|---|---|---|
| `implement` | codex, gpt-6.2-sol | quick-task | coding and fixes |
| `plan` | codex, gpt-6.2-sol | quick-task (read-only) | specs, investigation |
| `review` | codex, gpt-6.2-sol | review-pr | PR review |
| `operate` | opencode, davy/mistral-large-4 | quick-task | running a known workflow or script, collecting status, summarizing |
| `improve` | codex, gpt-6.2-sol | quick-task | self-improvement runs (D8) |

**Project roles** encode that project's own task kinds. For open-webui, for example, a `deploy` role would use `operate`'s model, attach the `jenkins-deploy` skill, and grant the `JENKINS_*` and `PROD_VM_*` secrets.

**Starting a task:** `cez-manager task create --role <name> "<brief>"` applies the role. An explicit flag (`--model`, `--skill`, `--secrets`, `--workflow`, `--budget-*`) overrides one setting. The manager's routing guidance (which model for which job) moves out of `manage-project` prose and into roles. The skill then says only "pick the role that fits; make a project role when a task kind recurs".

**Why roles matter for the loop:** model choice, skill attachment and standing instructions become data the self-improvement run can change in a reviewed PR. "Status tasks should use Mistral" is then a one-line diff, not a prompt rewrite.

**Helpers belong in skills.** A repeatable procedure with scripts becomes a project skill, with the scripts in its `scripts/` folder. A role attaches it. There is no separate "helpers" concept.

### D3. Managers check what is configured first: list commands

Each kind of configuration gets its own read command, and every one takes `--project` and `--json`:

| Command | Lists |
|---|---|
| `cez-manager roles` | the project's roles and the defaults, each with its description, model and skills |
| `cez-manager secrets` | names with audiences and descriptions (D4), never values |
| `cez-manager workflows` | (exists) workflows and what each can do |
| `cez-manager skills` | skills a task can be given; manager-only skills are excluded |
| `cez-manager models [--runner r]` | models and effort levels per runner, filtered because the full list is long |
| `cez-manager agents` | runner accounts available for tasks, with usage-limit state |
| `cez-manager scores [--since 7d]` | pass rates per scorer, and recent failures with their root causes |

`manage-project` (manager-only) starts with this step: before planning, and before telling the owner that something is missing, run the relevant list command.

### D4. Every task is told what it has

Cezar builds a **capability block** and adds it to every task's system prompt. It's capped at 2k characters, and the model never writes it:

```
Role: deploy (opencode, davy/mistral-large-4)
Secrets in your environment (values hidden; never print them):
  PROD_VM_HOST: production Node1 address
  PROD_VM_USER / PROD_VM_PASSWORD: SSH login for Node1
  JENKINS_URL / JENKINS_USER / JENKINS_PASSWORD: Jenkins API (CA: Michael/certs/ca-bundle.pem)
Workflows: openwebui-deploy (deploys main through Jenkins)
Attached skill: jenkins-deploy (scripts in its folder)
Budget: 3M tokens, 30 min active
```

- **`--secrets` is optional,** on the CLI or in a role. Without it, a task gets every `agents`-audience secret of the project and workspace, as it does today. With it, the task gets exactly the listed secrets. A name that isn't stored, or isn't shared with agents, is refused with the list of valid names.
- **Secret descriptions:** a secret gains an optional `description` (at most 200 characters, never secret). It's set with `cezar secrets set NAME --description "…"`, in Settings, or by a manager.

### D5. A budget per task that wakes the manager

The budget comes from the task flag, else the role, else `factory.yaml`, else defaults of 3M input tokens and 30 minutes of active time. Time spent queued or parked doesn't count.

- **Crossing it doesn't kill the task.** The run records `budgetExceeded`, and a managed run wakes its manager with the metrics so far (D6). The manager can raise the budget (`task budget <run>`), steer the task, switch its model, or cancel and retry.
- **Repeats:** the next alert comes at 2× the budget.
- **Unmanaged runs** show an amber marker on the task row.

### D6. Scoring runs

**Metrics.** When a run ends, Cezar computes `runs/<id>.metrics.json` from the event log, with no model involved. It holds only measured facts that a transcript doesn't state:
- **Identity:** role, runner, model and effort; who started the run.
- **Timing:** wall time, active time, model time against tool time.
- **Tokens:** input, output, cache reads, model calls, average and peak context per call.
- **Tool calls:** the count, and the duration and output size of each.
- **Outcome:** PR and review results, check results, budget crossings, and interventions (`task say`, retries, switches).

Pattern-finding is left to the judges.

**Scorers.** Each scorer lives in `.ai/cezar/scorers/<name>/scorer.md`:

```markdown
---
description: Did the task do what the brief asked, within its scope?
roles: [implement, operate]      # which runs it scores; default all
labels:
  - { value: delivered, score: 1.0, description: met every done criterion in the brief }
  - { value: partial, score: 0.5, description: met some criteria or needed a human to finish }
  - { value: missed, score: 0, description: did not deliver, or delivered the wrong thing }
passingScore: 1.0
samplingRate: 100
model: davy/mistral-large-4       # default: factory.yaml scoring.judge
---
Judge the run against its brief only. Quote the transcript lines your label rests on.
```

**Default scorers** ship in the harness, and each can be overridden by name or disabled:

| Scorer | Grades | Default sample rate |
|---|---|---|
| `outcome` | did it meet the brief's done criteria | 100% |
| `efficiency` | time and tokens against the task's size: needless reads, polling through the model, rebuilt tooling, repeated failures | 50% |
| `procedure` | did it follow AGENTS.md, its role, its skills and its constraints | 25% |
| `scope` | did it stay inside the brief | 25% |

**The judge reads the whole run.** It gets the metrics first, then the full transcript as plain text: brief, messages, tool calls and outputs, in order, with secrets redacted. If the transcript is longer than the judge's context window, Cezar shortens only the largest tool outputs, keeping each one's head and tail, and never drops a call. The judge is a tool-less model call, not a task, so scoring never creates runs.

**A score holds** the label, its score, pass or fail, and reasoning with quoted evidence. A failing score also holds a **root cause**:

```json
{ "category": "harness | task-setup | repository | access | model | requirements | external",
  "evidence": "…", "fix": "…",
  "target": "harness | manager-skill | role | brief | agents-md | skill | workflow | docs | code | infra" }
```

Scores are stored in `runs/<id>.scores.json`, together with the harness release the run used (`harnessVersion`) and its factory commit. `cez score <run> [--scorer s]` re-scores a run on demand, replacing that scorer's previous result.

### D7. Scores in the cockpit

- **Task row columns** (hidden by default): Outcome, Efficiency, Root cause, Tokens, Active time, Role and Model.
- **Task detail:** a Scores panel shows each score's reasoning, evidence and root cause, plus the metrics.
- **Factory view, per project:**
  - pass rate per scorer over time;
  - cost per PR;
  - human touchpoints per PR (how automated it is);
  - PRs merged per week;
  - open self-improvement PRs, each with the regressions it addresses.
- **API:**
  - `GET /p/:id/runs/:run/scores`;
  - `GET /p/:id/scores?since=…&groupBy=scorer|category|target`;
  - `GET /workspace/scores?…` across projects.

### D8. Self-improvement runs, and where fixes land

**Trigger.** A failure is a failing score that no self-improvement run has processed yet. A check every hour starts a self-improvement run for a project once it has `failedRunThreshold` failures (default 10), or when its oldest failure is `maxAgeDays` (7) old. A manager or the owner can also say "improve the factory now". Each run takes the whole batch.

**The run** is a task with the `improve` role and the `improve-factory` skill (it ships in the harness). Its input is the failing scores with their reasoning and root causes, plus links to the runs. It:
1. **Clusters** the failures by root cause and evidence.
2. **Checks each cluster's evidence,** reading the transcripts for that cluster's failing runs.
3. **Picks the clusters worth fixing,** weighting how often each occurs by its cost.
4. **Writes the fix as a redraft** to the file that owns the cause:

| `target` | Fix lands in | Who runs the improvement |
|---|---|---|
| `role` | `.ai/cezar/roles/` | the project's self-improvement run |
| `skill`, `workflow` | `.ai/skills/`, `.ai/cezar/workflows/` | the project's self-improvement run |
| `agents-md`, `docs` | AGENTS.md, the docs | the project's self-improvement run |
| `code` | the project's code (structure, test entry points, refactors) | the project's self-improvement run |
| `brief` | the manager's skill or the role's instructions, whichever caused it | manager-skill: harness; role: project |
| `harness`, `manager-skill` | the Cezar fork | the harness's self-improvement run (D11) |
| `infra` | outside both repos (credentials, CI configuration) | a note to the owner |

5. **Opens one PR per project.** The PR lists each change with its **Regressions addressed** (failing runs, scorers, evidence) and its expected effect. It runs `cez factory check` before opening.

**Cross-project promotion.** When the same project-level cause clusters in two or more projects, the harness run takes it. It fixes the default (a default role, skill, scorer or manager skill) instead of patching every repo.

**Approval** (`selfImprovement.review`):
- `manager` (the default): a review task reviews the PR, then the project manager merges it.
- `owner`: a person must approve it.
- `none`: the manager merges after the review task, with no person.

Whatever the setting, these always need the owner:
- changes to scorers, judge models or `improve-factory`, since nobody grades their own grader;
- large product-code refactors;
- anything that widens secrets or permissions.

### D9. Benchmarks verify a change before it ships

A benchmark suite lives in `.ai/cezar/benchmarks/<suite>/`:

```yaml
# suite.yaml
description: Deploy-status tasks for open-webui
target: { role: operate }
configurations:
  - { name: mistral, role: { model: davy/mistral-large-4 } }
  - { name: sol-low, role: { runner: codex, model: gpt-6.2-sol, effort: low } }
tasks: [jenkins-status, prod-health]
scorers: [outcome, efficiency]
---
# tasks/jenkins-status.yaml
title: Report the last CI and CD builds
prompt: Report the last chatbot/build-push and chatbot/deploy builds and their results.
successCriteria: Both build numbers and results are correct.
startingRef: 97d817021174027d647df63c890423771ef9d330
```

- **Running a suite:** `cez benchmark <suite>` runs every task under every configuration as dry-run-safe tasks (no merges, no deploys; checks with side effects are skipped). It scores them with the suite's scorers and reports a matrix of pass rate, cost and time per configuration. An agent can then propose a role or routing change from the result.
- **Building suites:** a self-improvement run that changes a role's model, or a harness release (D11), runs the relevant suite first. Suites grow from real runs: `cez benchmark add <run>` turns a completed run into a task, with its brief as the prompt and its outcome as the success criteria.
- **Checking afterwards:** after a fix merges, the next scored runs of the affected scorers are compared with the baseline before it. A fix whose cluster doesn't fall within the next batch is flagged in the next self-improvement run, which may revert it.

### D10. Reports: what the owner reads

The manager posts one factory summary a week per project. It reads only stored scores and metrics:
- pass rates per scorer and their trend;
- cost per PR;
- human touchpoints per PR;
- the top open root causes;
- the self-improvement PRs merged or waiting, and whether the fixes merged earlier helped.

There is no separate audit. Self-improvement runs do the fixing, and the report says how the factory is doing.

### D11. The self-maintaining harness

The Cezar fork (`~/dev/cezar`, remote `mlei06/cezar`) is a registered project. Its manager, the **harness manager**, uses the `manage-harness` manager skill. Its factory is the harness's own: roles for working on Cezar's code, scorers, benchmarks, and the `harness-release` workflow. The harness's self-improvement run receives the `harness` and `manager-skill` failures from every project, plus cross-project promotions.

**1. The running harness is a release, never the working tree.** Today the service runs straight from `~/dev/cezar/packages/cezar/dist`, so a build there changes the live harness. Instead:
- releases are built from merged commits into `~/.cezar/harness/releases/<sha>/`;
- a `current` link points at the live one, and the systemd unit runs `current`;
- the fork checkout is just a project, edited only in task worktrees.

**2. Shipping is the `harness-release` workflow,** made of check steps except for one summary:
1. Typecheck, test and build the merged commit, then install it as a new release.
2. Start a **staging cockpit** from the new release, on another port with its own `CEZ_HOME`, and run the harness benchmark suite against it with `CEZ_DRY_RUN=1` plus a few real cheap tasks (D9). Compare against the current release's last results.
3. Wait until no task is running and no manager turn is active, holding new task starts for up to N minutes.
4. Switch `current`, restart, and check `/api/v1/health` plus one dry-run task.
5. On any failure, switch back to the previous release and restart.
6. Post the release notes, and the benchmark comparison, to the harness manager.

**3. Attribution.** Every score records `harnessVersion`. After a release, the harness manager compares failure rates for the clusters the release targeted. A release that made them worse is reverted with `harness-release --rollback`.

**4. Limits.**
- The grader rule from D8 applies to the harness too.
- A harness PR is labelled fork-only or upstreamable, so generic fixes can go to open-mercato/cezar.
- Manager-only skills ship in the fork's `manager-skills/`. `~/.cezar/manager-skills/` is for local experiments, and an experiment that works becomes a PR.

### D12. Proactive triggers

The loop doesn't wait for the owner. These use Cezar's existing automations (schedule and GitHub) and manager jobs:
- **Hourly:** the self-improvement threshold check (D8).
- **Weekly:** the factory report (D10).
- **On a main CI failure:** a `fix-ci` task.
- **Daily credential health:** check that every secret a role or workflow uses still authenticates (Jenkins login, PAT expiry, SSH reachability), and file a note before it blocks a run.
- **Later:** webhook triggers for monitoring alerts (Sentry/Grafana style) to start an investigation task. Out of scope here.

## What already shipped on this branch

| Commit | What |
|---|---|
| `3a12b6900`, `5aa93a1d3` | autonomous managers; a manager per project; `manage-project` as a skill |
| `f396b75eb` | the `agents` secret audience; `cezar secrets get/env` |
| `6f8519c88` | manager-only skills; `task create --skill`; no managers for scratch projects |
| `6a00d2387` | reviewers read Azure Repos PRs (`az repos pr`, PR merge-ref fetch) |

## Modules

| Area | Change |
|---|---|
| `contract/` | schemas for factory.yaml, role, scorer, score, suite and task; run fields `role`, `grantedSecrets`, `budget`, `budgetExceeded`, `harnessVersion`; secret `description` |
| `factory/` (new) | load and validate the definition (with defaults and overrides); `cez factory check` |
| `managers/` | `--role`, `--secrets`, `--budget-*`; the list commands; `task budget`; budget and score follow-ups; the self-improvement trigger |
| `workflows/run.ts` | apply the role; the capability block; secret narrowing; budget accounting; after a run, metrics then sampled scoring |
| `scoring/` (new) | metrics; transcript rendering, shortened to fit; the judge call; score storage; re-scoring |
| `benchmarks/` (new) | the suite runner, the matrix, `benchmark add` |
| `workspace/secrets*` | `description` |
| `server/` | score, factory and benchmark routes |
| web | score columns, the Scores panel, the Factory view |
| `manager-skills/` | `manage-project` (roles, list commands, budgets); `manage-harness` (new) |
| `skills/improve-factory` (new, harness) | the self-improvement playbook |
| harness defaults | default roles and scorers, shipped in the fork |
| release layout | `~/.cezar/harness/releases`, the `current` link, a unit file change, and the `harness-release` workflow in the fork's factory |

## Phases

1. **Know what you have:**
   - roles (D2) with defaults, and `--role`;
   - the list commands (D3);
   - the capability block, optional `--secrets` and secret descriptions (D4).
   
   These fix most of today's failures.
2. **Bounded and measured:** budgets (D5); metrics (D6, no judges yet); the cockpit columns (D7).
3. **Scoring:** scorers, default scorers and judges (D6), and the Scores panel.
4. **Self-improvement:** the trigger, `improve-factory`, routing to project or harness, PRs with regressions addressed (D8); the weekly report (D10).
5. **Self-maintaining harness:** the release layout and `harness-release` (D11, before anything else in this phase); registering the fork with its harness manager; harness benchmarks (D9).
6. **Benchmarks in general:** project suites and `benchmark add`; configuration matrices for routing changes.

## Tests and acceptance

- **Factory loading:**
  - a repo with no files gets the default roles and scorers;
  - a project role or scorer overrides a default by name;
  - an invalid definition keeps the last valid one, with a reported error;
  - `cez factory check` fails on a broken reference.
- **Roles:**
  - `--role` applies its runner, model, skill, secrets and budget, and its instructions reach the system prompt;
  - explicit flags override single settings.
- **Capability block:** it names exactly the granted secrets, never a value; it lists the workflows and the attached skill; it stays under the cap.
- **Budget:** a crossing emits one follow-up; the next alert comes at 2×; queued and parked time don't count.
- **Metrics,** from the replayed open-webui upgrade log: 116 calls, about 93k average context, the 77k first output among the largest.
- **Scoring:**
  - sampling honours `samplingRate`;
  - an over-long transcript is shortened only in its largest outputs and fits the window;
  - a judge reply validates against the scorer's labels, and an invalid one is retried once, then recorded as an error;
  - a failure carries a root cause;
  - scoring creates no runs.
- **Self-improvement:**
  - the threshold starts exactly one run per project;
  - a cause with a project target lands in that project's PR;
  - a harness target, or a cause repeated across two projects, lands in the fork;
  - a PR touching scorers asks the owner even with `review: none`.
- **Harness release:**
  - a failing benchmark or health check keeps or restores the previous release;
  - no switch happens while a task or manager turn is active;
  - scores record `harnessVersion`.

**Acceptance:**
- Rerunning "update production" on open-webui needs no round trip to the user for access, and its tasks stay within budget.
- Every finished task shows Outcome and Efficiency on its row within a minute.
- Within two weeks, at least one self-improvement PR has merged in a project and one in the fork, and the failure rates for their clusters have fallen.

## Open questions

1. **Defaults:** are the default threshold (10 failures or 7 days) and sample rates right for a single-user factory? Warp's defaults are 25 failures, 7 days and 10–25% sampling, which suit a team.
2. **Hard budgets:** should a task far over its budget (3×) pause until the manager answers, rather than only alerting?
3. **Scope of scoring:** score tasks the owner starts by hand too (the default here), or only manager and automation tasks?
4. **Mistral's context window:** confirm `mistral-large-4`'s window on the davy endpoint. That decides how often transcripts need shortening, and whether `efficiency` should use a larger-window judge.
5. **Live benchmark runs:** a few real, cheap tasks per harness release cost money each time. Should a release benchmark run dry-run only unless the release touches runners or prompts?
6. **Scoring the managers:** apply the same metrics, scorers and self-improvement to manager turns. Proposed for after phase 4.

## Sources

- Warp blog: [engineering self-improving software factories](https://www.warp.dev/blog/engineering-self-improving-software-factories), [closing the loop](https://warp.dev/blog/agent-self-improving-software-factories), [the road to self-improving software](https://www.warp.dev/blog/self-improving-software-proactive-agents).
- Warp docs: [scorers](https://docs.warp.dev/factories/measure-and-improve/scorers/), [self-improvement](https://docs.warp.dev/factories/measure-and-improve/self-improvement/), [automations](https://docs.warp.dev/factories/automations/), [factory as code](https://docs.warp.dev/factories/factory-as-code/).

Cezar differs from Warp on purpose:
- it runs locally and needs no configuration;
- roles live in the project repo, not in a separate factory repo;
- it adds the harness tier (D11), which Warp doesn't describe, because here the platform itself is something the factory maintains;
- every failure carries a root-cause target, so a fix can be routed to the right repository.
