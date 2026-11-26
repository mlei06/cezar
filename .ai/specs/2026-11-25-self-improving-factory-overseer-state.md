# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-26 21:19 UTC.

## Where the build stands

- **Milestones.** M0, M1 and M2 are complete. M1.5 is released in #12. Isolated managers ran concurrently, and one manager completed a live project rollout. Live M1.5 passed. Two managers on distinct registered projects worked concurrently and each delegated one read-only charter task with 120,000 tokens and three active minutes. Both reported charter headings in their own chats. The two tasks settled through the review gate with no publication. The harness manager is inactive.
- **Live harness.** `0.21.0+release-b1a95c4` (#35) switched successfully and the live health check passed. A due weekly job in an isolated cockpit booted from that installed entry posted one HTML report with artifact security headers and a measured metrics sidecar. #34 shipped policy settings in `0.21.0+release-51419e6`. The live health and configuration reads passed. An isolated cockpit started from that installed entry saved and cleared both workspace and project improvement settings, preserved the judge and unrelated keys, and saved distinct overrides through the browser forms. Installed release #28 verified alternate replay. An authenticated installed-entry fixture replayed a pinned Codex task against the previous installed release. It kept the original project commit and model, read the original marker, and returned its usage measurements. An isolated cockpit booted from installed #27 ran `cez replay --model … --times 3`. Compare showed all four scores on each variant, repeat averages and no adoption action. Replay scores stayed out of both cause queues.
- **Delegated routing.** The merge-writer applied `highReasoning`, `switchAbove: 0.8` and the ordered fallback list. Two installed `operate` fixtures verified the configured primary over the VPN and the first hosted fallback with an unreachable probe. The second recorded its effective runner, model and fallback note. The real probe was restored. M2 also verified run identity, historical metrics, budget alerts, the workflow PR gate, niceness 5 and the workspace cap of 2.
- **Scoring.** #20–24 released the catalog, stateless judge, storage, `cez score`, cause routing and UI. Installed fixtures verified pending and recorded events, score summaries and reconstruction of both cause queues. The outage fixture recovered all four scores after 304 seconds. The configured judge needed 65 seconds and 82.2 seconds to record all four scores on two installed fixtures. The overseer subsequently cleared the M5 gate on adjudicated labels. A fresh blind result and the one-minute acceptance are open.
- **Release controls.** #25–26 are live. Isolated fixtures from the installed entries verified draining before admission, expiry, resuming queued work, exact rollback selection, and all five benchmark cases. A failed restart or post-switch check rolled back in fixtures. A benchmark drop stopped before activation. Reporting and the exact-release revert PR passed with test sinks.
- **Protected release workflow.** Draft PR #29 (`8a933af1d`) is open for the owner. Typecheck, 148 focused tests, 18,646 full-suite tests, 54 unit checks, build and 35 package checks passed. The dry-run cockpit loaded and completed the YAML. The staged authenticated replay and tool-free fixture judge passed separately. The failed-required-replay fixture kept the active version in place.
- **M5 partial rollout.** Core (#31), owner path protection (#32), policy Settings (#34) and weekly reports (#35) are live. The installed Settings round trip preserved protected and unrelated keys. The installed report rendered its HTML artifact and stored sample counts. Rebased hardening #36 merged into protected #33 as `385789c63` after independent review. The resulting tree matches the validated hardening head. #33 remains on its implementation branch until the M4 release. Typecheck, 468 focused tests, 18,665 full-suite tests, unit, build and package checks passed on the hardening head. Four regressions failed without the relevant publication and recovery fixes. The staged hourly automation claimed five synthetic causes and published one simulated PR. Concurrent manual starts admitted one run. Both CLI commands respected the open-PR guard and the manager command respected read-only access. Outcome comparison, digest and policy controls are staged.
- **M6 implementation in progress.** The suite definitions (`980df31d3`), replay matrix (`impl/m6-benchmark-runner`), Factory view (`impl/m6-factory-view`), automatic comparison for model changes (`impl/m6-improvement-benchmarks`), credential health (`7f81066fa`) and GitHub CI trigger (`dc98f1012`) are on pushed branches. In an isolated dry-run cockpit, two benchmark configurations settled and produced a matrix artifact. The browser rendered both configurations and opened the artifact. Score aggregation and retention passed in fixtures. A failed credential probe persisted one access finding and delivered one fixture-manager notice. The isolated GitHub response launched one completed CI repair task across repeated polls and a restart. The replay sandbox still requires Codex for agent replay, so the configured low-reasoning runner comparison remains pending under B26. Credential checks and CI use the existing automation scheduler. A declared project workflow surfaces a disabled automation for the operator to enable. No real project tasks were launched.
- **Next.** Complete the independent reviews and merge #29, then verify a live release through the committed workflow. #33 and #36 were rebased onto current factory. The protected skill now describes the decisions field the workflow actually reads and leaves publication to the workflow. The rebased M5 rollout is in validation on `impl/m5-live-rollout`. The safeguards are merged into the #33 branch. Merge #33 to factory after the protected release, then ship the trigger. M6 follows M5. Production acceptance on other projects remains outside the delegated scope.

## Standing instructions for when the harness manager resumes

These instructions apply when the owner restarts the harness manager. It remains inactive.

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

- **Owner decision (2026-11-26 20:50 UTC): the implementer finishes the roadmap on its own.** It may merge and release everything itself, including the owner-protected parts:
  - #29 and the first live `harness-release` run;
  - #33 and #36, the `improve-factory` skill and workflow;
  - the M5 trigger rollout and M6.

  Before each protected merge it still does its independent review and records the decision in the PR. It rebases #33 and #36 onto current `factory` first (#33 conflicts after #34 and #35), keeping the skill text unless the review finds a defect.

  For the two-manager test (M1.5) it uses the projects already registered, giving managers only bounded, non-deploying work.

  Still not delegated:
  - production deploys of other projects;
  - force-pushing `factory` or `main`, or rewriting history (the history purge stays the owner's);
  - changing system settings;
  - printing secret values.

- **Protected M5 review:** #36 is merged into the #33 branch after independent review and a rebased 471-test focused pass. #33 will release the protected skill and hardened workflow together.
- **Staged M5 dependencies:** `impl/m5-factory-source` provides hourly admission, run-now and both commands. `impl/m5-improvement-insights` provides outcome comparisons and the cross-project digest. `impl/m5-improvement-approval` requires review and uses the existing approval card for guarded merges. Roll these out with the hardened workflow after owner approval.
- **Staged M6 dependencies:** suite definitions, replay matrices, the Factory view, the automatic model-change comparison, credential health and the GitHub CI trigger passed combined focused validation. Merge and release after M5. B26 covers the enforced replay boundary needed for the configured low-reasoning runner. B27 covers additional CI providers.

- **Calibration gate (overseer decision, 2026-11-26 10:40 UTC):** pass/fail agreement is 37 of 39 (95%, target 80%). The six main-target disagreements were adjudicated against D5/D6 target definitions (observation M3-10): the judge was clearly right on four, two were ambiguous, and the blind label was clearly right on none. So the gap was the blind labels' convention, not the judge. The main-target gate counts as met on adjudicated labels (spec v5.29 now defines the targets). This was post-hoc, not blind. **M5 may start.** Run a fresh blind batch with the clarified definitions after M5's first improvement runs to confirm it. The one-minute latency check (B25) stays open as M3 acceptance and does not gate M5. The adjudication file is in the local calibration folder.

- **Owner decision on commit identity (resolves the M3-6 merge blocker):** the owner chose `Michael Lei <michael.qi.lei05@gmail.com>` as this fork's commit identity on 2026-11-25 (set in this repository's `.git/config`). That address is the owner's own and is approved for authorship on this public fork, including GitHub's default squash-merge author. It is not an internal detail under the public-fork rule. Resume runtime merges and releases: merge #21 with GitHub's default author (or `--author-email michael.qi.lei05@gmail.com`), and use that identity for commits. The noreply address isn't required. Keep the history purge of older internal author lines as the owner's call.

- **Judge selected (2026-11-26 05:45 UTC, overseer applying spec D5):** `factory.judge` is set on this machine to the self-hosted model through OpenCode, the same route as `lowReasoning`, per D5's "a self-hosted model is the intended choice" and the M0 judge prototype the calibration so far used. Written through the config merge-writer; the other `factory` settings are unchanged. Live scoring and calibration can proceed.

- **Paused (2026-11-25 23:37 UTC, owner):** the `cezar` project's manager is deactivated while a separate implementer builds from the handoff. Reactivate the manager with `PATCH /api/v1/workspace/managers/<id> {"active": true}` only if the owner asks.

- **Handoff (roadmap v3.1):** the manager finishes M1 and stops. M1.5 (spec D11, D12) and M2–M6 go to an implementer agent started from `2026-11-25-self-improving-factory-handoff.md`.


- **M1 acceptance:** completed. New task and the configured low-reasoning alias were verified on the live cockpit.
- Calibration before this batch: 4 runs, 16 scorer comparisons. Pass/fail agreement is 14/16. The two disagreements: the overseer under-called efficiency once, and the judge can't see spec drift (backlog B19).
- **Public repository hygiene:** the fork holds nothing internal. No provider ids, hosts, paths, usernames, project names, job names or run data. Project-specific notes belong in that project's own repository; machine settings stay in `~/.config/factory-overseer.json`.
- **Git metadata:** the owner-approved identity matched the earlier squash author and the new #21 squash. Verified branch heads use public noreply or the approved author. Earlier internal author or committer lines remain part of the owner's pending history cleanup, including pushed intermediate heads that may still be reachable by commit id.
- **History purge, pending (owner decision, not for the implementer):** commits pushed before 2026-11-25 21:45 UTC on `factory`, `feat/manager-autonomy` and the PR branches still contain internal names in older spec text. Rewrite them once M1's PRs are merged and nothing is open: run `git filter-repo --replace-text` over all fork branches, force-push, then delete the stale branches.
