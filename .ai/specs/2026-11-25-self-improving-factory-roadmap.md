# Roadmap: building the self-improving factory

Companion to `2026-11-25-self-improving-factory.md` (the spec). Status: v1, 2026-11-25.

The factory is built by the factory. After a one-time bootstrap (M0), which the overseer builds by hand, the Cezar fork's own manager implements every later milestone through tasks and pull requests. The overseer prompts it, watches it, intervenes when needed, and turns what goes wrong into changes to the spec and this roadmap. Building the factory is the first real workload the factory learns from.

## Who does what

| Who | What | How |
|---|---|---|
| **Owner** (Michael) | sets direction, approves owner-only changes (D6), supplies credentials | talks to the overseer, or directly to any manager |
| **Overseer** (Claude Code, outside Cezar) | builds M0; after that writes no code. Writes prompts for the harness manager, monitors it and its tasks, reviews milestones, releases the harness until M4, keeps the spec, roadmap and observation log | the cockpit API, the manager's chat (speaking as the owner), git and `gh` for reading, the release script |
| **Harness manager** (the `cezar` project's manager in Cezar; Codex gpt-6.2-sol, autonomous) | turns each milestone into tasks, briefs them, reviews and merges their PRs, reports | `cez-manager`, with the `manage-project` skill |
| **Tasks** | implement, test and open PRs on the fork | Cezar workflows on Codex or OpenCode models |

## Branches and the running harness

- **`factory`** is the fork's working trunk. It starts from `feat/manager-autonomy`, which includes the Azure driver. Every factory PR targets `factory`, and the `cezar` project's base branch is `factory`.
- **`main`** stays a clean mirror of upstream open-mercato/cezar. **`feat/azure-repos-forge`** stays as the upstream PR branch for #1617.
- **The running cockpit** is a release built from a `factory` commit (D9), never `~/dev/cezar` itself. The open-webui project keeps working throughout: it's paused, not removed.

## M0. Bootstrap (overseer builds; the last code the overseer writes)

| # | Deliverable | Done when |
|---|---|---|
| 0.1 | `factory` trunk on the fork; GitHub PR target `factory` | the branch is pushed and `cezar`'s base branch is `factory` |
| 0.2 | **Release layout**, `scripts/harness-release.mjs` in the fork. Given a commit, it: (1) exports it to `~/.cezar/harness/releases/<sha>/`; (2) runs `npm ci` and the build; (3) switches the `current` link; (4) restarts the unit; (5) checks `/api/v1/health`; (6) rolls back on failure. Running it with `--rollback` switches to the previous release. The systemd unit runs `current`. | a release from `factory` HEAD serves the cockpit; a rollback restores the previous one; editing `~/dev/cezar` no longer changes the live cockpit |
| 0.3 | **Wait for idle.** The script refuses to switch while a task or manager turn is active, unless given `--force` | tested with a running dry-run task |
| 0.4 | **The `cezar` project.** `~/dev/cezar` registered, with its automatic manager configured: Codex gpt-6.2-sol, autonomous, "Cancel or switch any task" on, 15-minute checks. Its goal: the generic project-manager goal plus pointers to the spec, this roadmap and the observation log. | the manager answers a setup check and lists its workflows and skills |
| 0.5 | **Fork guidance.** A short `.ai/skills/factory-work/SKILL.md`. It covers how to work on the factory spec: which spec section a change implements, the AGENTS.md validation order, the fact that the live cockpit is a release, and to never restart the service. The fork's AGENTS.md is long (about 30k characters), and this skill names the parts that matter. | tasks attach it with `--skill factory-work` |
| 0.6 | **Observation tooling** for the overseer: a poller that logs manager messages and task state changes, plus the observation log `2026-11-25-self-improving-factory-observations.md` | the poller runs in the background; the log has today's open-webui entries |
| 0.7 | **Warm-up run.** A small real change through the whole path: the manager briefs a task, the task opens a PR on `factory`, a review task approves, the manager merges, the overseer releases | one merged PR released and healthy, with observations logged |

**Exit:** the overseer stops writing code. If the factory breaks, the overseer may only roll back a release, or fix the release script if rollback itself is impossible. Either action is logged as an observation.

## M1. Agents know what they have (spec D2, D3)

The overseer gives the harness manager this milestone as one outcome. The manager splits it, but a sensible split is:

1. **Task workflow fields:** workflow `budget:` (stored and shown; enforcement is M2) and agent-step `secrets:`, which lifts the load error and narrows the secrets. Tests cover old workflows behaving as before.
2. **Built-in task workflows:** `implement`, `plan`, `operate` (`improve-factory` comes in M5).
3. **Capability block** in task system prompts; secret `description` (CLI, API, Settings).
4. **Manager list commands:** `secrets`, `skills`, `models`, `agents` (and `workflows` gains model and budget); the `manage-project` update (check first; choose a workflow; propose project workflows).

**Acceptance:**
- the spec's tests for D2 and D3 pass;
- the full validation order in AGENTS.md is green;
- live: a task started with `--workflow operate` runs on Mistral and its prompt shows the capability block;
- `cez-manager secrets` never prints a value.

**Release:** the overseer runs `harness-release` after checking the acceptance.

## M2. Bounded and measured (D4, metrics part of D5)

1. Budget enforcement: accounting, `budgetExceeded`, manager follow-up, `task budget`, the 2× rule, the amber marker.
2. `TurnStatsCollector` for task sessions; tool-call durations and output sizes from the event log; the per-run `metrics` summary.
3. Cockpit: metric fields in the task detail; budget state on the row.

**Acceptance:**
- D4 tests pass;
- the replayed open-webui log yields the expected metrics;
- live: a task given a tiny budget wakes the manager exactly once at 1×, and again at 2×.

## M3. Scoring (D5)

1. Scorer schema and loader (built-ins plus project overrides); `cez factory check` for scorers.
2. The judge: transcript rendering, shortening to fit, the OpenCode/Mistral call, validation and retry.
3. Scores with 1–3 causes, storage, `harnessVersion` and project commit; `cez score`.
4. Routing causes into project and harness queues (storage only; nothing consumes the queues yet).
5. Cockpit: Outcome, Efficiency and Root cause columns, the Scores panel, the scores API.

**Acceptance:**
- D5 tests pass;
- live: every task finishing on the fork gets scores within a minute;
- the overseer compares the judge's scores and causes with their own observations of the same runs, logged as a calibration table in the observation log, and the agreement is good enough to automate on. If it isn't, the rubrics are revised (owner-approved) before M5.

## M4. The harness releases itself (D9)

1. The `harness-release` workflow in the fork, wrapping the M0 script:
   - build and install;
   - staging cockpit with its own `CEZ_HOME` and port;
   - a dry-run harness benchmark (a few fixed tasks);
   - comparison with the current release;
   - wait for idle, switch, health check, rollback.
2. `harness-release --rollback`.
3. The minimum benchmark runner needed for item 1 (the rest is M6).

**Acceptance:**
- a deliberately broken release (failing health check) rolls back by itself;
- a good release switches only when idle.

**Handover:** from here the harness manager releases the harness itself after each milestone merges. The overseer stops running releases and only watches them.

## M5. Self-improvement (D6, D7, D10 weekly report)

1. Factory settings (global and per project) for thresholds, approval and scope; Settings UI.
2. The hourly trigger with both guards, manual start ("improve now"), and manager notification.
3. The `improve-factory` workflow and skill: clustering, reading evidence, redrafts, dismissals and escalations, the PR format.
4. Bookkeeping: processed, dismissed and escalated causes; cluster-to-PR links; cooldown.
5. Harness queue inputs: escalations, the cross-project digest, post-release checks.
6. The weekly factory report job.

**Acceptance:**
- D6/D7 tests pass;
- live: open-webui work resumes, and within two weeks one project improvement PR and one harness improvement PR have merged, with their cluster failure rates measured before and after.

## M6. Benchmarks and proactive triggers (D8, the rest of D10)

1. Benchmark suites, matrices and `benchmark add`, plus their use when an improvement run changes a workflow's model.
2. The Factory view.
3. Daily credential health; `fix-ci` on main CI failure.
4. Optional: scoring manager turns (open question 4).

## Order and dependencies

```
M0 ─► M1 ─► M2 ─► M3 ─► M4 ─► M5 ─► M6
             └─ metrics feed M3   └─ releases needed before the harness edits itself
```

- **M4 comes before M5** because self-improvement on the harness must ship through a release that can roll back.
- **M3's calibration gates M5:** if the judge disagrees too much with the overseer, automated improvement would amplify noise.

## The overseer's protocol

**Channel.** The overseer speaks to the harness manager only through its chat, as the owner would, and never steers a task directly unless the manager is stopped. The overseer may:
- cancel tasks, stop or deactivate managers, and reset a manager's session;
- edit manager settings, goal and memory;
- manage secrets and settings;
- roll back releases.

**Each milestone:**
1. The overseer writes one outcome prompt: the milestone, the spec sections, acceptance, constraints, and "report when done".
2. The overseer watches continuously: the poller notes every manager message and task state change.
3. At each task's end, the overseer reviews its brief, workflow and model choice, tokens and time against size, scope, tests run, PR diff and review result, and logs what's notable.
4. At the milestone's end, the overseer checks the acceptance personally (tests, live checks), then releases (until M4) or watches the release (after M4).
5. The overseer updates the spec, roadmap and log: what changed, and why.

**Intervention ladder** (lowest first; each step logged):

| Level | When | Action |
|---|---|---|
| 1. Note | an inefficiency or small mistake that doesn't threaten the outcome | log it; raise it at the milestone review |
| 2. Correct | wrong direction, wrong scope, a wrong model or workflow for the work, a misread spec | a message to the manager, as the owner |
| 3. Cancel | a task far over budget, looping, or doing out-of-scope or risky work | cancel it with a reason, then tell the manager |
| 4. Reset | the manager is confused, stuck, or repeating a mistake after correction | stop it, reset its session, restart with a fresh prompt |
| 5. Roll back | a release breaks the cockpit or a running factory | `harness-release --rollback` |

**What the overseer may change:**
- the spec, this roadmap and the observation log (committed to `factory` directly, docs only);
- manager configuration;
- settings and secrets;
- releases.

Not code, after M0's exit.

**Turning observations into improvements.** Each observation is logged with evidence and classified like a root cause (harness, task setup, repository, access, model, requirements, external). Then the overseer decides one of:
- a **spec amendment** (a new decision or feature), recorded in the spec's changelog;
- a **roadmap change** (order, split, acceptance);
- a **manager change** (goal, memory, settings);
- a **repository change** for the harness manager to make (AGENTS.md, a skill), given as a prompt;
- **nothing**, with a reason.

Until M3 and M5 exist, this is the manual version of scoring and self-improvement, and the overseer is the judge. After they exist, the overseer's log becomes the calibration set for the automated judge.

**What the overseer measures per milestone:**
- tasks and their total tokens, cost and active time;
- review rounds per PR;
- interventions by level;
- regressions found after a release;
- how many observations became spec changes.

These numbers are the baseline the factory should improve on over later milestones.

## Risks

| Risk | Mitigation |
|---|---|
| A task edits the live harness | M0 release layout; tasks work in worktrees; restarts only through the release script |
| The manager merges a broken change | full validation in the brief; review tasks; release health check and rollback; the overseer checks acceptance |
| Large, sprawling PRs | the manager splits milestones; the overseer corrects at level 2 |
| Context bloat from the fork's 30k AGENTS.md | the `factory-work` skill names what to read; the overseer watches the first tasks' efficiency |
| The judge is miscalibrated | M3's calibration gate before M5 |
| Cost | budgets from M2; Mistral for low-reasoning work; the overseer cancels runaway tasks |
| Upstream drift | `main` stays a mirror; fork-only and upstreamable labels on PRs |

## Changelog

- v1 (2026-11-25): first plan.
