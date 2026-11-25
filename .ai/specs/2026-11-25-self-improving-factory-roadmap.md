# Roadmap: building the self-improving factory

Companion to `2026-11-25-self-improving-factory.md` (the spec, v4). Status: v2, 2026-11-25. Findings: `2026-11-25-self-improving-factory-observations.md`.

The factory is built by the factory. After a one-time bootstrap (M0), which the overseer builds by hand, the Cezar fork's own manager implements every later milestone through tasks and pull requests. The overseer prompts it, watches it, intervenes when needed, and turns what goes wrong into changes to the spec and this roadmap. Building the factory is the first real workload the factory learns from, and the overseer acts as its self-improvement engine until the factory has its own.

## Contents

- Goal and definition of done
- Who does what
- Branches and the running harness
- M0 to M6, each with: goal, deliverables, the prompt, acceptance, what the overseer watches
- The overseer's runbook
- Spec revisions and the backlog
- Risks, timeline, changelog

## Progress

| Milestone | Status | Notes |
|---|---|---|
| M0 | done 2026-11-25 | release `0.21.0+release-735fc84` live; warm-up PR #1 merged and released; judge prototype calibrated on 2 runs; observations M0-1 to M0-10 |
| M1 | in progress | |

## Goal and definition of done

The program is done when all of these hold:
1. Every milestone's acceptance holds on the live cockpit.
2. Open-webui's "update production" runs end to end with no round trip to the owner for access, within budget, and shows scores on every task.
3. The factory has merged at least one project improvement PR and one harness improvement PR on its own, and their clusters' failure rates fell.
4. The harness ships its own releases through `harness-release`, with at least one automatic rollback demonstrated.
5. The overseer's calibration shows the judge agreeing on pass/fail for at least 80% of sampled runs, and on the main cause's target for at least 70%.

## Who does what

| Who | What | How |
|---|---|---|
| **Owner** (Michael) | sets direction, approves owner-only changes, supplies credentials | talks to the overseer, or to any manager |
| **Overseer** (Claude Code, outside Cezar) | builds M0, then writes no code. Prompts the harness manager, monitors it and its tasks, reviews milestones, releases the harness until M4, acts as the judge and improvement engine until the factory has its own, owns the spec, roadmap and observation log | the cockpit API, the manager's chat (as the owner), git and `gh` for reading, the release script, its judge prototype |
| **Harness manager** (the `cezar` project's manager; Codex gpt-6.2-sol, autonomous) | turns each milestone into tasks, briefs them, reviews and merges their PRs, reports, and after M4 releases the harness | `cez-manager`, with the `manage-project` skill |
| **Tasks** | implement, test and open PRs on the fork | Cezar workflows on Codex or OpenCode models |

## Branches and the running harness

- **`factory`** is the fork's working trunk, branched from `feat/manager-autonomy` (which includes the Azure driver and everything shipped so far). Every factory PR targets `factory`, and the `cezar` project's base branch is `factory`.
- **`main`** stays a clean mirror of upstream open-mercato/cezar. **`feat/azure-repos-forge`** stays as the upstream PR branch for #1617.
- **The running cockpit** is an installed version of a `factory` commit (spec D9), in self-update's existing layout (`~/.cezar/versions/<id>`, `current`, the launchers in `~/.cezar/bin`). The global `cezar` and `cez` are those launchers, not the working tree.
- **Open-webui** stays registered with its manager. Its work is paused until M2 and resumes as the factory's second workload.

## M0. Bootstrap (overseer builds; the last code the overseer writes)

**Goal:** a safe place for the factory to change its own harness, plus the overseer's tools.

| # | Deliverable | Done when |
|---|---|---|
| 0.1 | **Trunk.** `factory` branched from `feat/manager-autonomy` and pushed. The `cezar` project's base branch is `factory` (in its local `.ai/cezar/config.json`). | `git ls-remote origin factory` shows it; a task's worktree branches from it |
| 0.2 | **Hygiene the build depends on.** List `CEZ_MANAGER_AUTONOMOUS_DEFAULT`, `CEZ_AUTO_PROJECT_MANAGERS`, `CEZ_SCORING` and `CEZ_SELF_IMPROVEMENT` in `.env.example`. Record the owner-approved exceptions in AGENTS.md: autonomous managers, a manager per project, `agents` secrets by default, scoring, self-improvement. Add the `.ai/cezar/HARNESS` marker. | the docs check passes; AGENTS.md lists the exceptions |
| 0.3 | **The release script** `scripts/harness-release.mjs`, a thin layer over self-update. Given a commit (default `factory` HEAD), it: (1) checks it out in a build worktree `~/.cezar/factory/builds/<sha>`; (2) runs `npm ci` and `npm run build` there; (3) runs that build's own `cezar install`, which packs it into `~/.cezar/versions/<id>` (as a candidate, not yet current); (4) refuses to switch while a task or manager turn is active, unless `--force`; (5) `cezar use <id>`; (6) restarts through the supervisor; (7) checks `/api/v1/health` within 60 s; (8) on failure, `cezar use <previous>` and restarts; (9) appends to `~/.cezar/factory/release-log.ndjson`. With `--rollback` it switches to the previous version. It sets `versionRetention` to 5. | a release from `factory` serves the cockpit; `--rollback` restores the previous version; a forced failure (a bad health URL behind a test flag) rolls back by itself |
| 0.4 | **The unit and global commands use self-update's launcher.** The systemd unit runs `~/.cezar/bin/cezar serve …` with `CEZ_SUPERVISED=1` and `Restart=always`; `~/.cezar/bin` goes on PATH in place of the nvm global link to the working tree. The old unit file is kept as a backup. | editing `~/dev/cezar` changes nothing live; `cezar versions` lists the release as current; a supervisor restart brings the cockpit back by itself |
| 0.5 | **The `cezar` project and its manager.** Register `~/dev/cezar` and configure its automatic manager: Codex gpt-6.2-sol, autonomous, "Cancel or switch any task" on, 15-minute checks, the generic project goal plus "the spec, roadmap and observation log in `.ai/specs/` define your work; the owner gives you milestones". | the manager answers a setup check, listing its workflows, skills and secrets |
| 0.6 | **The `factory-work` skill** `.ai/skills/factory-work/SKILL.md` (about 60 lines). It names what matters in the fork's 62k-character AGENTS.md for this work: the validation order, the contract-first API rule, chained routes, `.env.example`, `ensureDataGitignore`, tests through npm. It also covers how to read the spec (each task implements named decisions), and that the live cockpit is an installed version, so tasks must never restart the service or touch `~/.cezar/versions`, `~/.cezar/bin` or `~/.cezar/factory`. It also points at the spec's reuse map: extend what Cezar has before adding anything. | tasks attach it with `--skill factory-work` |
| 0.7 | **The judge prototype** (overseer tooling, outside the fork, in `~/dev/notes/factory-overseer/`): `render.py` turns a run's event log and record into the spec's transcript format and metrics summary; `judge.sh <run> [scorer…]` sends the rendering with a rubric to `opencode run -m davy/mistral-large-4 --format json` and saves the result. **Rubric drafts** for `outcome`, `efficiency`, `procedure` and `scope` go in the fork's `.ai/cezar/scorers/`, as Markdown the overseer edits. They become the built-ins in M3. | judging the open-webui upgrade run (43299e6b) returns valid labels and causes; Mistral's usable context window is measured and recorded |
| 0.8 | **The poller** (overseer tooling): it logs every manager message and task state change for the `cezar` and `open-webui` projects to `~/dev/notes/factory-overseer/events.log`, and on each task end writes a line the overseer can feed to `judge.sh`. | it runs in the background through a session and survives the cockpit restarts in 0.3 |
| 0.9 | **Warm-up run.** One small real change through the whole path: add `factory/` to the `ensureDataGitignore` allowlist, with its test (spec "Data model"). The manager briefs a task, the task opens a PR on `factory`, a review task approves, the manager merges, and the overseer releases. | the PR is merged, released and healthy; observations logged; the task judged by the prototype |

**Exit:** the overseer stops writing code. If the factory breaks, the overseer may only roll back a release, or fix the release script if rollback itself fails. Either is logged.

**The M0 warm-up prompt** (0.9), sent to the harness manager:

> Warm-up task, to test the factory path end to end. In packages/cezar, add `factory/` to the `ensureDataGitignore` allowlist as ignored state (spec `.ai/specs/2026-11-25-self-improving-factory.md`, "Data model and storage"), and extend `src/data-gitignore.test.ts` to cover it. One task, `implement` (or `quick-task` until `implement` exists), with `--skill factory-work`; PR against `factory`. Review it with `review-pr`, merge when green, then tell me the PR and the task ids. Don't release: I will.

## M1. Agents know what they have (spec D2, D3)

**Goal:** tasks start with the right workflow, model, skill, secrets and budget, and know what they have.

**Deliverables:**
1. **Workflow fields:** `budget:` on workflows (stored and shown; enforced in M2); `secrets:` on agent steps (lifts the load error and narrows the secrets; check steps unchanged); contract and validation.
2. **Built-in task workflows:** `implement`, `plan`, `operate`, with the `operate` fallback when OpenCode is missing.
3. **The capability block** in every task's system prompt, with the trimming order and cap.
4. **Secret `description`:** CLI (`--description`, `describe`), API, Settings, and in the block.
5. **Manager list commands:** `secrets`, `skills`, `models`, `agents`; `workflows` gains model and budget; `task create --secrets`, `--budget-*`.
6. **`manage-project` update:** check first; choose a workflow; propose project workflows when a kind of task recurs.

**The prompt:**

> Milestone M1 of `.ai/specs/2026-11-25-self-improving-factory-roadmap.md`: implement spec D2 and D3 (`.ai/specs/2026-11-25-self-improving-factory.md`). Split it into tasks the way you judge best; my suggestion is the six deliverables in the roadmap, with 1 first because 2 and 3 depend on it. Brief every task with `--skill factory-work`, the exact spec sections it implements, and its tests. Each PR targets `factory` and passes the AGENTS.md validation order. Use `review-pr` before merging. Follow the spec's reuse map: extend what Cezar already has (it names the module for each part) before adding anything new, and say in each PR what it reused. Don't restart the cockpit or touch `~/.cezar/versions` or `~/.cezar/bin`; I release. If the spec is unclear or wrong somewhere, stop that piece and tell me why instead of deciding yourself. Report when M1's acceptance holds, with the PRs and task ids.

**Acceptance:**
- the spec's D2 and D3 tests pass, and the full validation order is green on `factory`;
- live, after the release: `cez-manager task create --workflow operate "report the cockpit version"` runs on Mistral, and its system prompt contains the capability block;
- `cez-manager secrets` lists names and descriptions and never a value (the overseer checks the output against the stored values);
- an old workflow file behaves exactly as before.

**The overseer watches:**
- the size and split of PRs;
- whether briefs name spec sections and tests;
- the first tasks' efficiency against the fork's 62k AGENTS.md, which tests the `factory-work` skill;
- review churn.

**Release:** the overseer runs `harness-release` after checking the acceptance.

## M2. Bounded and measured (spec D4, D5 metrics)

**Goal:** no task runs away unnoticed, and every run has the numbers scoring needs.

**Deliverables:**
1. **Run identity:** `startCommit` and `harnessVersion` recorded at every run's start (dispatched children and Continue too). Ships first in M2, because runs recorded before it can't be replayed exactly.
2. **One run budget:** generalize dispatch's `budgetUsd` into `budget: { usd, tokens, minutes }` with `onBudget: park | notify` (old records keep parsing and parking). Accounting (input tokens; active time excluding queued, parked and gate time); `budgetExceeded`; the manager follow-up with metrics; `task budget`; the 2× and 4× rule; the amber marker.
2. **`TurnStatsCollector` for task sessions,** per step.
3. **The metrics summary:** tool durations and output sizes from the event log; `GET /runs/:id/metrics`.
4. **Cockpit:** metrics in the task detail; budget state on the row.

**The prompt:**

> Milestone M2: spec D4, the metrics part of D5, and run identity from D8. Same rules as M1. Generalize dispatch's existing `budgetUsd`; don't add a second budget. Add a test that replays `.ai/cezar/runs` fixtures to check the metrics summary; the overseer will give you the open-webui upgrade log (43299e6b) as a fixture. Report when the acceptance holds.

**Acceptance:**
- D4 tests pass;
- the replayed open-webui log gives 116 requests, about 93k average context, and the 77k output among the largest;
- live: a task given `--budget-tokens 50000` wakes the manager exactly once at 1× and again at 2×;
- queued and parked time don't count.

**The overseer watches** whether the manager uses `task budget` sensibly when woken.

**Release:** the overseer. **After M2,** open-webui work resumes: PR #5's corrections and the v0.13.4 rollout, with the new workflows and budgets. That gives the factory a second, different workload to learn from.

## M3. Scoring (spec D5, D7 scoring defaults)

**Goal:** every finished task is judged, its failures diagnosed and routed.

**Deliverables:**
1. **Scorers:** the schema, the loader (built-ins from the overseer's tuned rubrics, plus project overrides), and `cez factory check`.
2. **The judge:** transcript rendering, shortening to fit, the judge queue, the OpenCode call, validation, retry and timeout, the outage handling.
3. **Scores:** 1–3 causes with the evidence check; storage with `harnessVersion` and project commit; `cez score`; the `score.recorded` event.
4. **Routing** into the project and harness queues (storage only; nothing consumes them yet); `factory/` state; harness-project detection.
5. **Cockpit and API:** Outcome, Efficiency and main-cause columns; the Scores panel; the scores routes; the `cez-manager scores` command.
6. **Settings:** `factory.judge`, `scoring.*`, `CEZ_SCORING`.

**The prompt:**

> Milestone M3: spec D5 scoring and its settings. The built-in rubrics are the overseer's drafts in `.ai/cezar/scorers/`; use them as written, and don't edit their rubric text (owner-protected). Same rules as before.

**Acceptance:**
- D5 tests pass;
- live: every task finishing on either project has scores within a minute while the judge is up;
- turning the davy endpoint off leaves scores pending, then they complete when it's back;
- **the calibration gate:** on at least 20 runs, the overseer compares the judge with their own blind verdicts and reaches the spec's targets (80% on pass/fail, 70% on the main target). Below that, the overseer revises the rubrics (owner-approved) and re-measures. M5 doesn't start before this passes.

**The overseer watches** the judge's causes for invented evidence and over-flagging, and the judge's latency.

**Release:** the overseer.

## M4. The harness releases itself (spec D9)

**Goal:** the harness ships through a benchmarked release that rolls back by itself.

**Deliverables:**
1. **The `harness-release` workflow** in the fork's `.ai/cezar/workflows/`, wrapping the M0 script (itself built on `cezar install` and `cezar use`). It adds: the staging cockpit (a candidate version's entry on its own port and `CEZ_HOME`), the dry-run harness suite, the comparison against tolerance, wait-for-idle with the 15-minute hold, switch, health check, rollback and report.
2. **Replay** (spec D8): `cez replay` and `POST /runs/:id/replay`; variants (spec 010) extended with per-variant overrides, a replay source, a cap of 5 for replay groups, and score columns in the Compare view; `--harness` replays on a staging cockpit.
3. **The minimum benchmark runner** the release needs (a suite replayed under one configuration), and a harness suite of about 5 tasks.
4. **`harness-release --rollback`,** including opening a revert PR.

**The prompt:**

> Milestone M4: spec D9, and D8's replay plus the minimum of benchmarks that `harness-release` needs. The release script from M0 is `scripts/harness-release.mjs`; wrap it rather than replace it, and keep installing and switching through self-update (`cezar install`, `cezar use`). Replay extends parallel variants (spec 010); don't build a second grouping. Test the rollback path deliberately. When this milestone's PRs are merged I will run the first release with the new workflow myself, then hand releases over to you.

**Acceptance:**
- a release with a deliberately failing health check rolls back by itself;
- a release with a benchmark drop over tolerance stops before the switch;
- a good release switches only when idle;
- the release log records all three;
- replaying a finished task with `--model` and `--times 3` produces a variant group whose Compare view shows scores per variant.

**Handover:** after the first good release through the workflow, the harness manager releases after each milestone. The overseer watches and no longer releases.

## M5. Self-improvement (spec D6, D7, D10 report)

**Goal:** the factory fixes its own recurring failures, in the project or in the harness.

**Deliverables:**
1. **Settings:** the `factory.improvement.*` settings (global and per project), Settings UI, `CEZ_SELF_IMPROVEMENT`.
2. **Triggers:** the `factory` automation event source (hourly queue check with both guards, skips logged with reasons) and a built-in automation per project that launches `improve-factory` and reports to the manager; `cez improve`, `cez-manager improve`, "Improve now" as that automation's run-now.
3. **The `improve-factory` workflow and skill:** batch brief, clustering, evidence reading, redrafts, decisions file, check loop, PR with regressions addressed. The overseer reviews the skill text personally; it's owner-protected.
4. **Bookkeeping:** processed, dismissed, escalated and deferred causes; failed or closed runs return their causes; the improvement records; cooldown; three-failure pause.
5. **Harness inputs:** escalations, the cross-project digest, post-release checks.
6. **Protection:** owner-only paths enforced on merge.
7. **The weekly report job.**

**The prompt:**

> Milestone M5: spec D6, D7 and the report in D10. The `improve-factory` skill is owner-protected: draft it in its own PR and ask me to review it before anything uses it. Start with the trigger and bookkeeping, then the workflow, then protection, then the report.

**Acceptance:**
- D6/D7 tests pass;
- live: a project queue reaching 5 starts exactly one run;
- its PR lists regressions addressed, passes the check step, and is merged by the manager after review;
- a PR touching a scorer is refused for the manager and asks the owner;
- within two weeks, one project improvement PR and one harness improvement PR have merged, with before/after numbers.

**The overseer's role changes:** from being the improvement engine to auditing it. The overseer compares the improvement runs' clusters with their own log, notes what they miss or get wrong, and feeds that into the `improve-factory` skill through owner-approved revisions.

## M6. Benchmarks and proactive triggers (spec D8, the rest of D10)

**Goal:** changes are compared before they ship, and the factory acts without being asked.

**Deliverables:**
1. **Benchmarks as saved replays:** suite and task files, `benchmark add <run>` from a run's identity, matrices across configurations shown as artifacts and in the Factory view; used automatically when an improvement run changes a workflow's model.
2. **The Factory view:** pass rates over time, cost per merged PR, human touchpoints, queues, improvements and benchmark results.
3. **Proactive triggers:** the daily credential health check (a `credential-health` workflow per project); `fix-ci` on a main CI failure.
4. **Optional:** scoring manager turns (spec open question 4).

**Acceptance:**
- a suite comparing Mistral with gpt-6.2-sol on `operate` tasks produces a matrix;
- an expired credential surfaces as an `access` cause before a run fails on it.

## Order and dependencies

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6
             │      │      └─ the harness must roll back before it edits itself
             │      └─ calibration gate before M5
             └─ open-webui resumes after M2
```

## The overseer's runbook

**At the start of every session:**
1. Read the memory note `cezar-factory-overseer`, this roadmap's current milestone and backlog, and the latest observations.
2. Check the cockpit is healthy, and which release is running: `release-log.ndjson`.
3. Start the poller if it isn't running, and read the event log since the last session.
4. Check managers and tasks: anything waiting on the owner, running long, or failed.

**For each milestone:**
1. Send the milestone prompt (above, adjusted for what changed), as the owner, in the harness manager's chat.
2. Watch continuously: the poller notes each manager message and task state change.
3. At each task's end:
   1. read its brief, workflow and model choice;
   2. judge it blind first on a sample (every third task, and every failing one): write a verdict before reading Mistral's;
   3. run `judge.sh`, compare, and log disagreements;
   4. review the PR diff and review result;
   5. log what's notable.
4. Intervene by the ladder (below).
5. At the end, check the acceptance personally, then release (M0–M3) or watch the release (M4 on).
6. Review the milestone:
   - its metrics (below);
   - the observations, each turned into a spec revision, a backlog item, a manager change, a repository change, or nothing;
   - spec and roadmap changelog entries.

**Intervention ladder** (lowest first; each step logged):

| Level | When | Action |
|---|---|---|
| 1. Note | an inefficiency or small mistake that doesn't threaten the outcome | log it; raise it at the milestone review |
| 2. Correct | wrong direction, scope, model or workflow; a misread spec | a message to the manager, as the owner |
| 3. Cancel | a task far over budget, looping, or doing out-of-scope or risky work | cancel it with a reason, then tell the manager |
| 4. Reset | the manager is confused, stuck, or repeating a mistake after correction | stop it, reset its session, restart with a fresh prompt |
| 5. Roll back | a release breaks the cockpit or a running factory | `harness-release --rollback` |

**What the overseer may change:**
- the spec, this roadmap, the observation log and the rubric drafts (committed to `factory` directly; docs only);
- manager configuration;
- settings and secrets;
- releases until M4;
- its own tooling outside the fork.

Not harness code, after M0's exit.

**Metrics per milestone,** recorded at its review:
- tasks, and total tokens, cost and active time;
- PRs, and review rounds per PR;
- interventions by level;
- regressions found after the release;
- observations, and how many became spec revisions or backlog items;
- judge agreement (from M0.7 on).

These are the baseline the factory should improve on over later milestones.

## Spec revisions and the backlog

The build is itself a source of findings. Whatever goes wrong or turns out missing while the manager implements the spec is diagnosed by the overseer: what failed, its root cause and where the fix belongs. Each finding then becomes one of:
- **a spec revision,** when it conflicts with or changes something the spec decides. The overseer edits the spec and records it in its changelog. If the affected milestone is in progress, the overseer tells the manager.
- **a backlog item,** when it's a new feature or improvement that doesn't change current decisions. It goes into the backlog below, with its evidence, and is scheduled at the next milestone review.
- **a manager change** (goal, memory, settings), or **a repository change** given to the manager as a prompt (AGENTS.md, a skill, a workflow).
- **nothing,** with the reason logged.

**The overseer owns the spec and the backlog.** The manager implements them and doesn't rewrite its own requirements. When the manager or a task finds the spec infeasible, wrong or ambiguous, it says so in its report, with the reason. The overseer decides and revises.

## Backlog

New features and improvements found so far, not yet scheduled into a milestone. Each has its evidence and a proposed milestone.

| # | Item | Evidence | Proposed for |
|---|---|---|---|
| B1 | **Finish open-webui's deploy workflow** (PR #5 corrections: stored secret names, password SSH, a real preflight, Mistral summaries, generic skill) and roll out v0.13.4 without the inline-PDF fix | the paused open-webui work; observations 5–6 | after M2 |
| B2 | **Cap review rounds:** at most 2 review tasks per PR head before asking the owner | 7 review runs on PRs #4 and #5 | M1 (`manage-project`) |
| B3 | **Isolate testing:** tasks must test against a staging cockpit with its own `CEZ_HOME`, never register projects or start runs on the live one; add a guard or skill rule | task 295bd9f4 registered throwaway projects on the live cockpit (observation 9) | M1 (`factory-work`), harness guard M4 |
| B4 | **Raise the manager's session-reset thresholds** (55 min idle, 100k context) for long jobs | the open-webui session restarts mid-work | M2 |
| B5 | **One summary at the end,** not a stream of updates, from managers | the open-webui chat | M1 (`manage-project`) |
| B6 | **Azure parity for PR actions:** `github.pr-comment`, `pr-update` and `issue-comment` still call `gh` | the Azure driver's known gap | M4 or later |
| B7 | **Slim the fork's AGENTS.md** (62k characters) for harness tasks, or split it into routed files | measured in M0 | after M3, using M3's efficiency scores |
| B8 | **Hard budgets:** pause at 4× until the manager answers | spec open question 1 | after M3 |
| B9 | **Score manager turns** | spec open question 4 | M6 |
| B10 | **Monitoring webhooks** that start investigation tasks | spec D10 | after M6 |
| B11 | **Upstream #1617:** wait for the maintainers' reply, then open the Azure PR from `feat/azure-repos-forge` | the upstream thread | when they reply |
| B12 | **Seed the queues by re-scoring earlier runs** with `cez score` when M3 ships (both projects, including the open-webui upgrade task), so improvement starts from real evidence | the queues would otherwise start empty; point 3 of the definition of done needs failures to accumulate | M3 |
| B13 | **Global skills read by every task** (graphify and others) add noise to first reads; consider a per-project skill allowlist, or keeping tool-specific skills out of the global folders | M0-8 | after M3, using efficiency scores |
| B14 | **Tasks linger after their PR merges** (about 6 minutes `running`), delaying releases | M0-10 | M4 (`harness-release` wait-for-idle) |

## Risks

| Risk | Mitigation |
|---|---|
| A task edits the live harness | M0 release layout; worktrees; restarts only through the release script; the `factory-work` skill |
| The manager merges a broken change | full validation in the brief; review tasks; release health check and rollback; the overseer checks acceptance |
| Large, sprawling PRs | milestone splits; correction at level 2; the `scope` scorer later |
| Context bloat from the fork's 62k AGENTS.md | the `factory-work` skill names what to read; the overseer watches the first tasks; B7 |
| The judge is miscalibrated | blind sampling from M0.7; M3's calibration gate before M5 |
| The judge (davy) is slow or down | scoring never blocks runs; scores wait and retry |
| Cost | budgets from M2; Mistral for low-reasoning work; the overseer cancels runaway tasks |
| The overseer anchors on the judge | blind verdicts first, on every third task and every failure |
| Upstream drift | `main` stays a mirror; `fork-only` and `upstreamable` labels |

## Timeline (rough, in working sessions)

| Milestone | Estimate | Note |
|---|---|---|
| M0 | 1 session | overseer-built |
| M1 | 1–2 sessions | six small PRs |
| M2 | 1 session | |
| M3 | 2 sessions | plus calibration over about 20 runs |
| M4 | 1–2 sessions | |
| M5 | 2–3 sessions | plus two weeks for its acceptance |
| M6 | 2 sessions | |

## Changelog

- v1 (2026-11-25): first plan.
- v1.1: spec revisions and the backlog, owned by the overseer.
- v2.2: aligned with spec v5's reuse map:
  - M0's release step built on self-update;
  - run identity first in M2, with budgets generalizing `budgetUsd`;
  - replay as variants in M4;
  - the trigger as an automation event source in M5;
  - benchmarks as saved replays in M6.
- v2.1: B12 (credential rotation) dropped at the owner's decision.
- v2: the full M0 (hygiene, release script and unit, judge prototype, rubric drafts, poller, warm-up prompt); goals, deliverables, prompts, acceptance and watch points per milestone; the overseer's runbook with blind calibration; definition of done; backlog B1–B11; timeline.
