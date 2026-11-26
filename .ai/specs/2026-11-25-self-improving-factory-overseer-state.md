# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-26 04:44 UTC.

## Where the build stands

- **Milestone:** M0 done. M1 is done: live New task acceptance passed, and the low-reasoning check passed on 2026-11-26 02:15 UTC (`operate` ran on OpenCode with the machine's low-reasoning model, capability block present in its prompt; `factory.models.lowReasoning` is now set in the workspace config, written through the config merge-writer). M1.5 is released and waiting on the two-project live acceptance.
- **Live harness:** `0.21.0+release-6466703`. PR #15 is installed and healthy. An isolated check workflow dispatched a child whose run recorded its USD ceiling in the shared run budget. Run identity (#13) and model routing (#14) were verified on earlier releases. The harness manager remains inactive.
- **M1 PRs:** #2 (known host test failures), #3 (secret descriptions), #4 (workflow budgets and agent-step secrets), #5 (typecheck repair), #6 (built-in `implement`, `plan`, `operate`), #7 (the capability block), #8 (manager discovery and task flags), #9 (`manage-project` update), #10 (test-resource rules in `factory-work`).
- **M1 follow-ups** (from reviews, not blocking): generated validation checks get an explicit secrets allowlist; forge-adapter-level draft-PR assertions; check-artifact exclusions survive a cockpit restart (tracked before M1).
- **Live delegated routing:** applied `highReasoning`, `switchAbove: 0.8` and the ordered hosted fallback list through the config merge-writer. With the VPN available, an isolated `operate` task completed on the configured OpenCode primary. With a temporary unreachable probe target, a second `operate` completed on the first hosted fallback and recorded the runner, model and fallback note. Restored the real probe URL immediately after admission.
- **In flight:** Metrics are pushed on `impl/m2-task-stats` at `b7c015ba6`. Initial full testing exposed alias elapsed-time and route inventory gaps. Both are fixed and passed targeted tests. Finish the full validation sequence on the corrected head. `impl/m2-budget-enforcement` at `ef4265aa7` is stacked on metrics and has focused coverage of active time, child allocations, manager alerts, authorization and API parity. `impl/m1-pr-publishing` at `94f683b1f` (B16) and `impl/m2-task-priority` at `677719856` (B22) have typecheck and focused tests. M3 scorer loading and the first `cez factory check` implementation are prepared on `impl/m3-scorers` at `520dd1ee9`. It needs full validation after M2.
- **Next:** finish metrics validation and release. Offline replay of the historical upgrade window matched the expected metrics using the existing local runner samples and event log. Verify live request collection, then merge and release the remaining M2 work and run the live budget threshold check. The concurrent two-project live acceptance remains open.

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

- **Paused (2026-11-25 23:37 UTC, owner):** the `cezar` project's manager is deactivated while a separate implementer builds from the handoff. Reactivate the manager with `PATCH /api/v1/workspace/managers/<id> {"active": true}` only if the owner asks.

- **Handoff (roadmap v3.1):** the manager finishes M1 and stops. M1.5 (spec D11, D12) and M2–M6 go to an implementer agent started from `2026-11-25-self-improving-factory-handoff.md`.


- **M1 acceptance:** completed. New task and the configured low-reasoning alias were verified on the live cockpit.
- Calibration so far: 4 runs, 16 scorer comparisons. Pass/fail agreement is 14/16. The two disagreements: the overseer under-called efficiency once, and the judge can't see spec drift (backlog B19).
- **Public repository hygiene:** the fork holds nothing internal. No provider ids, hosts, paths, usernames, project names, job names or run data. Project-specific notes belong in that project's own repository; machine settings stay in `~/.config/factory-overseer.json`.
- **Git metadata:** later local commits use the fork account’s public GitHub noreply identity. Include earlier local Git identities in the owner’s existing history-cleanup review.
- **History purge, pending (owner decision, not for the implementer):** commits pushed before 2026-11-25 21:45 UTC on `factory`, `feat/manager-autonomy` and the PR branches still contain internal names in older spec text. Rewrite them once M1's PRs are merged and nothing is open: run `git filter-repo --replace-text` over all fork branches, force-push, then delete the stale branches.
