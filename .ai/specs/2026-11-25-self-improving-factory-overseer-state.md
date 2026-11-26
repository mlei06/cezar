# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-26 05:49 UTC.

## Where the build stands

- **Milestone:** M0 done. M1 is done: live New task acceptance passed, and the low-reasoning check passed on 2026-11-26 02:15 UTC (`operate` ran on OpenCode with the machine's low-reasoning model, capability block present in its prompt; `factory.models.lowReasoning` is now set in the workspace config, written through the config merge-writer). M1.5 is released and waiting on the two-project live acceptance.
- **Live harness:** `0.21.0+release-03e0bc9`. PR #17 is installed and healthy. An isolated managed task with the roadmap’s token ceiling delivered one alert at 1× and another at 2× on separate turns. Separate live checks showed queue and parked time were excluded and a settled task saved its metrics snapshot. Earlier releases verified run identity, both routing cases, USD storage, and runner metrics. The harness manager remains inactive.
- **M1 PRs:** #2 (known host test failures), #3 (secret descriptions), #4 (workflow budgets and agent-step secrets), #5 (typecheck repair), #6 (built-in `implement`, `plan`, `operate`), #7 (the capability block), #8 (manager discovery and task flags), #9 (`manage-project` update), #10 (test-resource rules in `factory-work`).
- **M1 follow-ups** (from reviews, not blocking): generated validation checks get an explicit secrets allowlist; forge-adapter-level draft-PR assertions; check-artifact exclusions survive a cockpit restart (tracked before M1).
- **Live delegated routing:** applied `highReasoning`, `switchAbove: 0.8` and the ordered hosted fallback list through the config merge-writer. With the VPN available, an isolated `operate` task completed on the configured OpenCode primary. With a temporary unreachable probe target, a second `operate` completed on the first hosted fallback and recorded the runner, model and fallback note. Restored the real probe URL immediately after admission.
- **In flight:** PR publication (B16) merged as #18 (`ab14791`); the release script is building it. Task CPU priority (B22) is rebased on #18 on `impl/m2-task-priority` at `c87397c47` and running the full validation order. M3 catalog, judge, scores, routing and score views are on stacked `impl/m3-*` branches. An isolated cockpit reached the configured judge, with one score recorded, two errors, and one pending after 94 seconds. Verdict parsing has since been tightened and a second fixture is running.
- **Next:** verify #18 live and finish B22. M2 core acceptance passed on the live cockpit. Ship M3 in order, verify scoring latency and outage recovery against the configured judge, then complete blind calibration. The concurrent real-project acceptance remains open. A separate M4 rollback fix has focused checks on `impl/m4-release-switch`.

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

- **Judge selected (2026-11-26 05:45 UTC, overseer applying spec D5):** `factory.judge` is set on this machine to the self-hosted model through OpenCode, the same route as `lowReasoning`, per D5's "a self-hosted model is the intended choice" and the M0 judge prototype the calibration so far used. Written through the config merge-writer; the other `factory` settings are unchanged. Live scoring and calibration can proceed.

- **Paused (2026-11-25 23:37 UTC, owner):** the `cezar` project's manager is deactivated while a separate implementer builds from the handoff. Reactivate the manager with `PATCH /api/v1/workspace/managers/<id> {"active": true}` only if the owner asks.

- **Handoff (roadmap v3.1):** the manager finishes M1 and stops. M1.5 (spec D11, D12) and M2–M6 go to an implementer agent started from `2026-11-25-self-improving-factory-handoff.md`.


- **M1 acceptance:** completed. New task and the configured low-reasoning alias were verified on the live cockpit.
- Calibration so far: 4 runs, 16 scorer comparisons. Pass/fail agreement is 14/16. The two disagreements: the overseer under-called efficiency once, and the judge can't see spec drift (backlog B19).
- **Public repository hygiene:** the fork holds nothing internal. No provider ids, hosts, paths, usernames, project names, job names or run data. Project-specific notes belong in that project's own repository; machine settings stay in `~/.config/factory-overseer.json`.
- **Git metadata:** verified public noreply metadata on the current metrics and budget PR heads and corrected the related implementation branch heads. Earlier pushed implementation heads may still be reachable by commit id. Include those with earlier local Git identities in the owner’s existing history-cleanup review.
- **History purge, pending (owner decision, not for the implementer):** commits pushed before 2026-11-25 21:45 UTC on `factory`, `feat/manager-autonomy` and the PR branches still contain internal names in older spec text. Rewrite them once M1's PRs are merged and nothing is open: run `git filter-repo --replace-text` over all fork branches, force-push, then delete the stale branches.
