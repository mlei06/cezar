# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-26 00:15 UTC.

## Where the build stands

- **Milestone:** M1 (agents know what they have) is merged and live; its live acceptance check is pending. M0 done.
- **Live harness:** `0.21.0+release-f1747bd`. PR #11 installed and healthy.
- **M1 PRs:** #2 (known host test failures), #3 (secret descriptions), #4 (workflow budgets and agent-step secrets), #5 (typecheck repair), #6 (built-in `implement`, `plan`, `operate`), #7 (the capability block), #8 (manager discovery and task flags), #9 (`manage-project` update), #10 (test-resource rules in `factory-work`).
- **M1 follow-ups** (from reviews, not blocking): generated validation checks get an explicit secrets allowlist; forge-adapter-level draft-PR assertions; check-artifact exclusions survive a cockpit restart (tracked before M1).
- **In flight:** M1.5 charter and manager-playbook changes are in validation on `impl/m1.5-manager-playbook`. The concurrent-manager regression failed on the earlier behavior and passed with the change in isolated fixtures.
- **Next:** finish M1.5 validation, review and release. Stop before giving managers real project work so the owner can onboard a second project. Then verify two live managers on separate projects and continue to M2.

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

- **Paused (2026-11-25 23:37 UTC, owner):** the `cezar` project's manager is deactivated, and a separate implementer agent builds from the handoff prompt. Its M1 acceptance check was interrupted: only the `operate` smoke ran (task e5c86fd3, passed, but on the project's default runner, because `factory.models.lowReasoning` is not set on this machine yet). Nothing else was checked. Reactivate the manager with `PATCH /api/v1/workspace/managers/<id> {"active": true}` only if the owner asks.
- **Machine setting still to do:** set `factory.models.lowReasoning` (runner `opencode` plus the self-hosted model named in `~/.config/factory-overseer.json`) in the workspace config. The workspace config API doesn't take `factory` yet, so either add that or write it through the config merge-writer, never by hand while the cockpit runs.

- **Handoff (roadmap v3.1):** the manager finishes M1 and stops. M1.5 (spec D11, D12) and M2–M6 go to an implementer agent started from `2026-11-25-self-improving-factory-handoff.md`.


- **M1 acceptance:** the released New task form submitted a description, workflow, model and slash skill. The read-only run confirmed its capability block. Isolated checks covered secret listing without values, legacy workflow compatibility and both low-reasoning alias paths. The configured low-reasoning smoke with the paused manager is still pending.
- Calibration so far: 4 runs, 16 scorer comparisons. Pass/fail agreement is 14/16. The two disagreements: the overseer under-called efficiency once, and the judge can't see spec drift (backlog B19).
- **Public repository hygiene:** the fork holds nothing internal. No provider ids, hosts, paths, usernames, project names, job names or run data. Project-specific notes belong in that project's own repository; machine settings stay in `~/.config/factory-overseer.json`.
- **Git metadata:** later commits use the fork account’s public GitHub noreply identity. Include earlier local Git identities in the owner’s existing history-cleanup review.
- **History purge, pending (owner decision, not for the implementer):** commits pushed before 2026-11-25 21:45 UTC on `factory`, `feat/manager-autonomy` and the PR branches still contain internal names in older spec text. Rewrite them once M1's PRs are merged and nothing is open: run `git filter-repo --replace-text` over all fork branches, force-push, then delete the stale branches.
