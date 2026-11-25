# Handoff: finish the self-improving factory (M1 check, M1.5, M2 to M6)

Paste everything below the line into a new Codex session started in `~/dev/cezar`. It assumes no prior context.

---

You are the implementer for the "self-improving factory" in this Cezar fork (`~/dev/cezar`, GitHub `mlei06/cezar`, trunk `factory`). Cezar is a local cockpit that runs coding agents as tasks under per-project managers. **Verify M1, then implement M1.5 and M2–M6 from a coding session outside Cezar.** Work through PRs to `factory`, release the merged changes, and verify each milestone on the live cockpit. Make and record routine implementation decisions. When a check needs the owner or more live evidence, record it as pending and continue work whose prerequisites are satisfied.

## Read first, in this order

1. `.ai/specs/2026-11-25-self-improving-factory-overseer-state.md` is the resume point for progress, machine state and open items. Re-read it after any restart. Reconcile it with git, open PRs and the release log before repeating work.
2. Read the current milestone, assigned backlog rows, dependencies and definition of done in `.ai/specs/2026-11-25-self-improving-factory-roadmap.md`. Use this handoff for current responsibilities. The roadmap's old prompts and overseer runbook describe the earlier manager-led build.
3. Read the milestone's decisions and matching reuse, storage, API, failure, security and test requirements in `.ai/specs/2026-11-25-self-improving-factory.md`. Include decisions referenced by the deliverables, such as D8 run identity in M2 and D8 replay in M4. D11 and D12 govern manager behavior.
4. `.ai/specs/2026-11-25-self-improving-factory-observations.md`: what went wrong so far and why the spec says what it says.
5. Read `.ai/skills/factory-work/SKILL.md` and the relevant AGENTS.md sections it points to. The skill's staging-only and escalation rules apply to delegated tasks. This handoff gives the outside implementer responsibility for the live acceptance checks, releases and routine spec decisions described below. Apply the skill's validation, resource and public-fork rules throughout.

## Where things stand

- At handoff, M0 was done and M1 (D2, D3) was merged and reported live as `0.21.0+release-41a8ac9`. M1 acceptance was pending. Use the state file and startup checks below for the current status.
- **First, verify M1.** Check the manager's evidence against every M1 acceptance item and run any missing checks. Create the hand-made task through the live project's New task form with a description, workflow, model and skill. Verify its actual prompt locally for the expected capability block. Use a harmless task with no deployment or repository writes. Inspect secret-list output without printing values. Fix failures, write the M1 review and mark M1 done when acceptance holds. Then start M1.5 (D11, D12) and continue in roadmap order.
- Keep implementation in the outside session. Use the harness manager for bounded live acceptance tasks and the release handover at M4. For an acceptance task, use the manager chat or `POST /api/v1/workspace/managers/<id>/messages`. The manager ID is in `cezar-manager-id` under the `dataDir` in the local overseer config.

## How to work

- **Branches and PRs.** Start each deliverable from current `origin/factory` on `impl/m<N>-<slug>`. Open the PR against `mlei06/cezar:factory` and verify the head and base before merging. Label it `fork-only` or `upstreamable` (D9). In the PR, name the reused module and list any spec decisions.
- **Reuse first.** Extend the module in the reuse map and preserve compatibility with old run files, workflows and settings. Update `.env.example` for each `CEZ_*` contract change and the env table in `docs/reference.md` for user-facing variables.
- **Validate runtime changes** through npm in this order, following AGENTS.md before commit and PR:
  1. `npm run typecheck`
  2. `npm test -- <dirs you touched>`
  3. the full `npm test`, once
  4. `npm run test:unit`
  5. `npm run build`
  6. `npm run test:package`

  Add a test for the changed behavior and prove it fails without the implementation. Record the exact known host failures from `factory-work` in the PR and continue validation. Investigate any new failure. Keep transcript-based checks local and use synthetic fixtures for committed tests.
- **Test resources.** This is one laptop, and it has crashed under load:
  - never pass `--maxWorkers` or `--pool` to Vitest;
  - run at most one full suite at a time across everything you run;
  - wait for long commands inside one shell command rather than checking back;
  - rerun a timing failure on its own before believing it.
- **Review.** Give each runtime PR a separate review pass after implementation. Review the full diff against the relevant spec sections and acceptance checks. Runtime includes product code, scripts, build, test and CI config, and workflows. After at most two rounds, apply the merge rule:
  - **blocks the merge:** correctness bugs, data loss, secret-value leaks, security issues;
  - **merges anyway:** everything else, with the remaining findings listed as follow-ups in the PR and in the roadmap backlog.

  Docs, specs and skills merge after your own diff check.
- **Merge** with a squash merge through `gh` once validation and review pass. Fetch `factory` again and check for runtime changes since the validated base. If there are any, rebase and revalidate before merging. Docs, specs and skill changes alone can wait until the next rebase.
- **Release through M4.** Batch nearby runtime merges and release a SHA confirmed on `origin/factory`. Until the D9 workflow is ready, run `node scripts/harness-release.mjs <merged-sha> --wait-minutes 30` from the fork. Confirm the cockpit's task and manager status is readable before starting. The bootstrap script can treat failed status reads as idle. Keep starts quiet during the switch and leave a busy timeout pending for a retry.

  If a restart would kill your session, start the release detached with `systemd-run --user --collect --unit=harness-release-<sha7> --working-directory="$HOME/dev/cezar" --setenv=PATH="$PATH" node scripts/harness-release.mjs <merged-sha> --wait-minutes 30`. Check the command result or unit journal, the release log and the running version. The bootstrap script rolls back a failed health check when it has a previous version. A restart-command failure can exit before that rollback. After a failed switch, confirm the active version and recovery status before retrying. If the candidate was rolled back, fix it forward or revert its PR. The bootstrap script's manual rollback immediately after an automatic rollback can select the failed candidate.

  At M4, verify the new D9 workflow, including a benchmark rejection and an automatic rollback, then verify its first good release. After that, hand routine releases to the harness manager through the workflow. Use the release path for version switches.
- **Verify each milestone live** against the roadmap on the released cockpit. Record the released SHA, what passed, and any pending check with its prerequisite. Mark it done when its acceptance holds and write the review in the observation log. Use isolated staging for development, fixture replay, outage simulation and failure injection. Record staging results as such when an acceptance item still needs live evidence.
- **Fix and improve as you go.** When you hit a bug, a flaky or slow path, or a gap in the spec, fix it in its own small PR, or add it to the roadmap backlog with the milestone it belongs to. Log notable findings in the observation log, with evidence, class and decision, as the existing entries do.
- **Spec gaps.** Resolve routine ambiguities using the decisions and reuse map. Record the decision in the PR and, when it changes the spec, add a changelog entry and bump the version. Leave decisions that contradict the spec outright or affect protected security boundaries pending for the owner.
- **Owner-protected parts.** Follow D6/D7 for scorers, judge settings, `improve-factory`, widening secrets or permissions, and the owner gate for manager-approved PRs with more than 400 changed lines of product code. D9 also protects changes to the release workflow. Use the scorer rubrics as written. Draft `improve-factory` in its own PR and leave it for the owner to merge. Once M5 can start, verify its mechanisms in staging with controlled fixtures and leave live launches pending until the owner approves the required workflow and skill.

## Milestone gates

- **M1.5:** verify the charter and manager behavior with bounded tasks. The deployment project's charter belongs in that project's repo. Preserve the owner gate on vision, goals and non-goals.
- **M2:** if the historical run used in the metrics acceptance is available locally, compare it against the roadmap's counts there. Use synthetic data for committed tests and record the historical comparison as pending if the run is unavailable.
- **M3 to M5:** record blind verdicts before viewing the judge's results. M5 starts only after calibration passes on at least 20 runs, at 80% or better for pass/fail and 70% or better for the main cause's target. M5 also depends on M4's rollback demonstration. If the judge is unavailable or a gate misses, record the missing evidence and continue only with work whose prerequisites hold.

## Commits, pushes and progress notes, for clean transitions

The laptop crashes, and another agent or the owner may pick up after you, so:
- **Commit small and often,** at least after every passing step. Use plain conventional messages (`feat(scoring): …`, `fix(release): …`, `docs(factory): …`). **Add no `Co-authored-by` or other trailer.**
- **Push your branch after every commit.** Before pushing `factory`, always `git pull --rebase`.
- **After every merge, release, milestone step or decision,** update the state file's "Last updated", "Where the build stands" and "Open items", plus the roadmap's Progress table and backlog. Log notable findings in the observation log. Push the update to `factory` in the same sitting. Use a separate worktree for the docs update when implementation changes are in progress.

  The state file must always say what's in flight (branch, PR, step or release unit), which checks passed, what's pending and what's next. Keep evidence in public-safe summaries.
- **After a restart or a new session**, reconcile the state file against these checks before resuming at the first outstanding step.
  1. Check `systemctl --user is-active cezar factory-poller model-relay`.
  2. Check cockpit health, the latest release attempt, the last successful switch or rollback, and any release unit still running.
  3. Check the fork's open PRs (`gh pr list --repo mlei06/cezar --base factory`), your `impl/*` branches and any worktrees with local changes.

## Hard rules

- **The fork is public.** Never commit or post any of these:
  - internal host names or IP addresses;
  - company paths or user names;
  - provider or model ids;
  - other projects' names;
  - run data or transcripts.

  Use generic placeholders. Machine-specific settings live in `~/.config/factory-overseer.json` (never committed) and in local workspace settings. Run data stays outside the repository.
- **Branches:** never commit to `main`, and never force-push `factory` or `main`. Force-with-lease on your own `impl/*` branches is fine.
- **Secrets:** leave live credentials and grants to the owner. Never print a secret's value.
- **System settings:** leave `.wslconfig`, systemd service definitions and OS config to the owner. Use the release path for changes to `~/.cezar/versions` and `~/.cezar/bin`.
- **Other projects:** production deployment requires the owner's authorization. Verify through staging and record the live deployment and behavior checks as pending on the owner. Apply this to both the resumed rollout after M2 and the D12.7 one-message production acceptance.
- **Overseer tooling:** don't edit `.ai/factory-overseer/` beyond reading it, except to retire the judge prototype once M3's built-in judge replaces it.
- **Git history:** leave the pending history purge in the state file alone; it's the owner's call.

## Machine notes

- **The cockpit:** user service `cezar`, at `http://127.0.0.1:4321`, with its API under `/api/v1` and health at `/api/v1/health`.
- **The judge model endpoint** (from M3) only resolves on the internal network, so it needs the VPN. Its address and the OpenCode relay port are in `~/.config/factory-overseer.json`. If it's unreachable, build and test against a stub, and record live scoring as pending.
- **Workspace `maxParallel`** is 2. Keep it there until backlog B22 (a lower CPU priority for task runs) ships in M2.

## Done

Use the roadmap's full definition of done. A released mechanism, a verified workflow and measured outcomes can land at different times. Keep the program open while production checks, approvals or improvement results still need evidence. Before handing off or finishing, update the state file with what shipped, verified outcomes, pending checks and their owners, and the remaining backlog. Push the update to `factory`.
