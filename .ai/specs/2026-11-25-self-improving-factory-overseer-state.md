# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-25 21:30 UTC.

## Where the build stands

- **Milestone:** M1 (agents know what they have), in progress. M0 done.
- **Live harness:** `0.21.0+release-b29db47`, which has PRs #1–#5. PRs #8 and #9 are merged into `factory` but not yet released.
- **Merged in M1:** #2 (known host test failures), #3 (secret descriptions), #4 (workflow budgets and agent-step secrets), #5 (typecheck repair), #8 (manager discovery and task flags), #9 (`manage-project` update).
- **Open in M1:**
  - #6, built-in workflows `implement`, `plan`, `operate`: in review after publication fixes. `implement` has no human gate and uses the shared check-artifact path.
  - #7, the capability block: being revised for spec v5.7 (omit a description containing its own secret's value) and a NUL-character fix.
- **Next:** when #6 and #7 merge, the manager holds new starts and says so. The overseer releases `factory` (`node scripts/harness-release.mjs`), tells the manager the release is done, checks M1's acceptance live, writes the M1 review, and sends the M2 prompt.

## Standing instructions given to the harness manager

- **Every task:** `--skill factory-work`, targets `factory`, follows the spec's reuse map.
- **Reviews:** at most two review rounds per PR head before asking the owner. Under the M1 criterion, secret-narrowing edge cases are defense in depth: fix once, then merge if nothing outside that edge remains, and list further cases as follow-ups. Correctness, data loss, value leaks and other security issues still block.
- **Before merging:** the PR head must include current `factory`. Commits that only touch `.ai/specs/` or `.ai/factory-overseer/` don't force a rebase or revalidation.
- **After a runtime merge:** hold new starts until the overseer confirms the release (until M4's `harness-release` can hold starts itself).
- **Pushes:** a task's force-with-lease push to its own `cez/*` branch is approved by the manager itself. Never `factory` or `main`.

## Machine state the overseer depends on

- **Services** (user systemd): `cezar` (runs `~/.cezar/bin/cezar`, the released harness), `factory-poller`, `model-relay`.
- **Config:** `~/.config/factory-overseer.json` (local, never committed).
- **Tooling and restore steps:** `.ai/factory-overseer/README.md`.
- **The judge prototype needs the company network:** the model endpoint's internal hostname doesn't resolve off the VPN. Until it does, calibration pauses; it doesn't block the milestones.

## Open overseer items

- The M1 milestone review: metrics, observations into spec, backlog or nothing.
- Calibration so far: 4 runs, 16 scorer comparisons. Pass/fail agreement is 14/16. The two disagreements: the overseer under-called efficiency once, and the judge can't see spec drift (backlog B19).
- Public repository hygiene: keep internal hosts, paths, usernames and job names out of everything pushed. Run data stays in the config's `dataDir`.
