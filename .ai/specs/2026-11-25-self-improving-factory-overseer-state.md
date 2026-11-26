# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-26 07:24 UTC.

## Where the build stands

- **Milestone:** M0 done. M1 is done: live New task acceptance passed, and the low-reasoning check passed on 2026-11-26 02:15 UTC (`operate` ran on OpenCode with the machine's low-reasoning model, capability block present in its prompt; `factory.models.lowReasoning` is now set in the workspace config, written through the config merge-writer). M1.5 is released and waiting on the two-project live acceptance. M2 is complete. M3 is in implementation and validation.
- **Live harness:** `0.21.0+release-7cfb1b7` (#20). The installed CLI accepted the bundled rubrics and rejected a fixture with invalid frontmatter. In `acaa5ab` (#19), an isolated workflow check observed niceness 5 and the workspace cap stayed at 2. In `ab14791` (#18), a scratch custom workflow returned the workflow PR gate and stopped on the expected failed check. Azure draft ownership passed the forge fixture. Prior releases verified both delegated routing cases, dispatch USD storage, the historical metrics replay, separate 1× and 2× alerts, queue and parked time exclusions, and the saved metrics snapshot. The harness manager remains inactive.
- **M1 PRs:** #2 (known host test failures), #3 (secret descriptions), #4 (workflow budgets and agent-step secrets), #5 (typecheck repair), #6 (built-in `implement`, `plan`, `operate`), #7 (the capability block), #8 (manager discovery and task flags), #9 (`manage-project` update), #10 (test-resource rules in `factory-work`).
- **M1 follow-ups** (from reviews, not blocking): generated validation checks get an explicit secrets allowlist; forge-adapter-level draft-PR assertions; check-artifact exclusions survive a cockpit restart (tracked before M1).
- **Live delegated routing:** applied `highReasoning`, `switchAbove: 0.8` and the ordered hosted fallback list through the config merge-writer. With the VPN available, an isolated `operate` task completed on the configured OpenCode primary. With a temporary unreachable probe target, a second `operate` completed on the first hosted fallback and recorded the runner, model and fallback note. Restored the real probe URL immediately after admission.
- **In flight:** #21 merged at `cc93140d2` using the owner-approved squash author. The detached release unit `harness-release-cc93140` is building it. The existing live version stays authoritative until the release log records a successful switch.
- **Judge review:** typecheck, focused checks, unit tests, build and packaging passed for #21 with the documented host exception in the focused suite. The full suite had three documented host failures and a manager restart timing failure that passed in isolation. A synthetic request reached the configured judge through stateless generation and returned the expected reply in six seconds.
- **Score storage review:** `impl/m3-scores` at `6001406f6` passed typecheck and 736 focused tests, and is running full validation. It redacts saved inputs and verdicts and picks up tasks settled during cockpit recovery. The integrated real-judge fixture saved four scores in 83 seconds. The outage fixture saved all four after 304 seconds. In staging, `impl/m3-causes` at `efc6286cf` restored both cause queues from saved verdicts after restart without another judge call. The top `impl/m3-score-ui` at `47ffc87db` passed 113 focused tests and emitted all four pending invalidations and all four recorded-score events in that fixture.
- **Next:** verify `cc93140` after the release, rebase score storage onto the squash once its full suite completes, and ship the remaining M3 slices in order. Verify production scoring latency and outage behavior, then complete blind calibration. The concurrent real-project acceptance remains open. The M4 rollback fix and isolated staging smoke passed focused checks on `impl/m4-release-switch` and `impl/m4-staging-cockpit`. The release admission hold passed focused checks on `impl/m4-release-hold` at `5c7dd39a9`, including admission after expiry, drain, and rollback selection.
- **M4 preparation:** The isolated release benchmark passed five cases. Fixtures stopped on a benchmark drop, rolled back after a failed health or smoke check, and selected the last healthy target. The protected workflow draft `80a6f0249` parsed, loaded and finished with the staging guard. `impl/m4-revert-pr` at `1e25b73f5` adds an exact-release revert PR, the merged-commit guard and the AGENTS validation order before benchmarked activation. `impl/m4-deterministic-release-tests` at `1aea4ade7` isolated the clock and WSL fixtures behind the three known host failures, with all 41 focused tests passing. `impl/m4-compare-scores` at `5df6f375c` includes score comparisons and skips marked checks and external graph operations during replay. Safe exact replay and the first owner-run release remain open.

## Standing instructions given to the harness manager

Since 2026-11-25 17:25 the manager runs the harness project on its own (owner decision); the overseer audits afterwards instead of gating.

- **Every task:** `--skill factory-work`, targets `factory`, follows the spec's reuse map.
- **Reviews:** only runtime PRs (`packages/`, `scripts/`, build and test config) get a Codex review. Docs, skills, specs and `.ai/factory-overseer/` merge after the manager's own diff check.
- **Review rounds:** after two rounds the manager decides by the M1 merge rule (correctness, data loss, value leaks and security block; edge cases become follow-ups) and reports the decision.
- **Spec ambiguities:** the manager decides, records them under "Spec decisions" in the PR and as a line in the observation log; the overseer reviews afterwards.
- **Releases:** the manager releases merged runtime PRs itself, batched, with `harness-release.mjs` detached through `systemd-run --user` (a restart kills the cockpit's own process tree), starts nothing while it runs, and checks the journal and release log after waking. A rollback means fix forward or revert.
- **Before merging:** the PR head must include current `factory`. Commits that only touch documentation or agent guidance (`.ai/specs/`, `.ai/skills/`, `.ai/factory-overseer/`, `*.md` outside `packages/`) don't force a rebase or revalidation.
- **Pushes:** a task's force-with-lease push to its own `cez/*` branch is fine. Never `factory` or `main`.
- **Test resources (M1-8):** never override Vitest's worker cap, at most one full `npm test` per task at a time, rerun timing failures alone before reporting them.

## Machine state the overseer depends on

- **Services** (user systemd): `cezar` (runs `~/.cezar/bin/cezar`, the released harness), `factory-poller`, `model-relay`.
- **Config:** `~/.config/factory-overseer.json` (local, never committed).
- **Workspace `maxParallel` is 2** (back from 4 after the host overloaded). Raise it only once B22 limits a task's CPU.
- **WSL is capped at 8 cores and 24 GB** (`.wslconfig`, applies after `wsl --shutdown`; backup `.wslconfig.bak-before-cap`).
- **Tooling and restore steps:** `.ai/factory-overseer/README.md`.
- **The judge prototype needs the VPN:** the judge endpoint only resolves on the internal network.

## Open overseer items

- **Owner decision on commit identity (resolves the M3-6 merge blocker):** the owner chose `Michael Lei <michael.qi.lei05@gmail.com>` as this fork's commit identity on 2026-11-25 (set in this repository's `.git/config`). That address is the owner's own and is approved for authorship on this public fork, including GitHub's default squash-merge author. It is not an internal detail under the public-fork rule. Resume runtime merges and releases: merge #21 with GitHub's default author (or `--author-email michael.qi.lei05@gmail.com`), and use that identity for commits. The noreply address isn't required. Keep the history purge of older internal author lines as the owner's call.

- **Judge selected (2026-11-26 05:45 UTC, overseer applying spec D5):** `factory.judge` is set on this machine to the self-hosted model through OpenCode, the same route as `lowReasoning`, per D5's "a self-hosted model is the intended choice" and the M0 judge prototype the calibration so far used. Written through the config merge-writer; the other `factory` settings are unchanged. Live scoring and calibration can proceed.

- **Paused (2026-11-25 23:37 UTC, owner):** the `cezar` project's manager is deactivated while a separate implementer builds from the handoff. Reactivate the manager with `PATCH /api/v1/workspace/managers/<id> {"active": true}` only if the owner asks.

- **Handoff (roadmap v3.1):** the manager finishes M1 and stops. M1.5 (spec D11, D12) and M2–M6 go to an implementer agent started from `2026-11-25-self-improving-factory-handoff.md`.


- **M1 acceptance:** completed. New task and the configured low-reasoning alias were verified on the live cockpit.
- Calibration so far: 4 runs, 16 scorer comparisons. Pass/fail agreement is 14/16. The two disagreements: the overseer under-called efficiency once, and the judge can't see spec drift (backlog B19).
- **Public repository hygiene:** the fork holds nothing internal. No provider ids, hosts, paths, usernames, project names, job names or run data. Project-specific notes belong in that project's own repository; machine settings stay in `~/.config/factory-overseer.json`.
- **Git metadata:** the owner-approved identity matched the earlier squash author and the new #21 squash. Verified branch heads use public noreply or the approved author. Earlier internal author or committer lines remain part of the owner's pending history cleanup, including pushed intermediate heads that may still be reachable by commit id.
- **History purge, pending (owner decision, not for the implementer):** commits pushed before 2026-11-25 21:45 UTC on `factory`, `feat/manager-autonomy` and the PR branches still contain internal names in older spec text. Rewrite them once M1's PRs are merged and nothing is open: run `git filter-repo --replace-text` over all fork branches, force-push, then delete the stale branches.
