# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-26 23:55 UTC.

## Where the build stands

- **Milestones.** M0, M1, M1.5, M2, M4 and M6 are complete. M3 and M5 have real-use acceptance open. Two managers on distinct registered projects worked concurrently and each delegated one read-only charter task with 120,000 tokens and three active minutes. The first exercise confirmed overlapping manager turns. One delegated task could not use Git under the read-only grants. The repeat used the Read tool and overlapped both manager turns and both task runs. Each task returned all six headings from its charter and finished without publication. The harness manager is inactive.
- **Live harness.** `0.21.0+release-f1c8724` is installed and healthy. The previous `a0766b2` rollout shipped guarded self-improvement. The prior `64a902a` release verified the protected workflow. The prior weekly report release `0.21.0+release-b1a95c4` (#35) also passed its live checks. A due weekly job in an isolated cockpit booted from that installed entry posted one HTML report with artifact security headers and a measured metrics sidecar. #34 shipped policy settings in `0.21.0+release-51419e6`. The live health and configuration reads passed. An isolated cockpit started from that installed entry saved and cleared both workspace and project improvement settings, preserved the judge and unrelated keys, and saved distinct overrides through the browser forms. Installed release #28 verified alternate replay. An authenticated installed-entry fixture replayed a pinned Codex task against the previous installed release. It kept the original project commit and model, read the original marker, and returned its usage measurements. An isolated cockpit booted from installed #27 ran `cez replay --model … --times 3`. Compare showed all four scores on each variant, repeat averages and no adoption action. Replay scores stayed out of both cause queues.
- **Delegated routing.** The merge-writer applied `highReasoning`, `switchAbove: 0.8` and the ordered fallback list. Two installed `operate` fixtures verified the configured primary over the VPN and the first hosted fallback with an unreachable probe. The second recorded its effective runner, model and fallback note. The real probe was restored. M2 also verified run identity, historical metrics, budget alerts, the workflow PR gate, niceness 5 and the workspace cap of 2.
- **Scoring.** #20–24 released the catalog, stateless judge, storage, `cez score`, cause routing and UI. Installed fixtures verified pending and recorded events, score summaries and reconstruction of both cause queues. The outage fixture recovered all four scores after 304 seconds. The configured judge needed 65 seconds and 82.2 seconds to record all four scores on two installed fixtures. The overseer subsequently cleared the M5 gate on adjudicated labels. A fresh blind result and the one-minute acceptance are open. The installed M6 release prioritizes first-minute Outcome and Efficiency jobs with one serial worker. In the installed paired fixtures, both verdicts matched expectations. Outcome took 29.66 and 67.02 seconds. Efficiency took 21.70 and 13.77 seconds.
- **Release controls.** #25–26 are live. Isolated fixtures from the installed entries verified draining before admission, expiry, resuming queued work, exact rollback selection, and all five benchmark cases. A failed restart or post-switch check rolled back in fixtures. A benchmark drop stopped before activation. Reporting and the exact-release revert PR passed with test sinks.
- **Protected release workflow.** #29 merged after independent review as `64a902a`. The committed workflow ran on the live harness. Five staging cases passed at 100%, the real authenticated replay passed, the hold reached idle before the switch, post-switch smoke and health passed, and the release report was delivered. The live catalog lists `harness-release` from the registered clean factory checkout.
- **M5 released.** Protected #33 merged with #36 as `2b6c817` after independent review. #37 merged the hourly source, commands, outcome comparisons and manager approval controls. The combined rebase passed 1,415 focused and 18,675 full-suite tests, unit, build and package checks. The live cockpit released `a0766b2` through the named workflow after all five smoke cases and authenticated replay passed. Three registered projects expose enabled hourly automations. An isolated cockpit booted from that installed entry auto-claimed five causes, checked the patch, recorded one simulated PR and refused another start. At 23:22 UTC the genuine hourly harness check admitted one improvement run and claimed 17 causes. The first patch passed factory validation and the repair corrected a typecheck failure. Independent review then found private run references in an unpublished commit. The overseer cancelled the run before publication. No remote branch or PR existed, and all 17 causes returned to the queue. The harness improvement automation is temporarily paused while `impl/m5-private-publication-check` adds the guard. Commit `684576e` is pushed, typecheck and 1,206 focused tests passed, and the full validation is in progress. Real merged improvements and before/after windows remain pending genuine use.
- **M6 released.** #38 shipped saved benchmark suites, the Factory view, candidate model gates and proactive automation in `f1c8724`. The final full suite passed 18,684 tests, with unit, build and package checks. The installed cockpit recorded three passing Outcome scores on each configured route and an artifact. The browser rendered both comparison rows and loaded the artifact. Installed fixtures verified credential access failure and main CI deduplication. Tool-using OpenCode replays and other CI providers remain backlog items.
- **Score-status follow-up.** #39 merged after independent review as `8180201`. The regression failed before the fix, and the exact head passed typecheck, 545 focused tests, 18,685 full-suite tests, unit, build and package checks. The compiled candidate displayed both counts through the real Factory API in a browser. Release it together with the guard for public improvement commits.
- **Remaining acceptance.** Validate and release the public improvement guard with the merged score-status follow-up. Verify the installed guard and browser, and verify B29 on a new harness worktree before restoring the hourly harness source. Retain the open judge timing and blind calibration cases under B25. The other projects’ production deploy and bug-to-production trial are outside the delegated scope. B26 covers more replay boundaries and B27 covers other CI providers.

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

- **Overseer audit of the first improvement run (A-1 to A-3):** the run's typecheck failure was in a file the draft didn't touch. The likely cause is the task worktree resolving the main checkout's dependencies, not the draft. B29 reuses the existing local After worktree creation hook to run `npm ci` from the worktree lock and typecheck the untouched factory base before task startup. The disposable installed fixture verified fresh dependencies in the worktree and blocked a failing baseline before any task step. Apply the hook to the harness project when releasing the public guard, then verify the real checkout before restoring its automation.

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

- **Protected M5 review:** #36 merged into #33. #33 merged the protected skill and guarded workflow after the owner-delegated review. PR #37 followed with the trigger and commands. Their review decisions are in their PRs.
- **M5 acceptance in use:** the source, CLI, comparison, digest and approval branches shipped together in #37. Follow the genuine project and harness improvements through review, merge and matched post-release samples.
- **M6 review:** #38 is merged and installed. The tested automatic gate yields its parent slot, runs the exact candidate model and cancels leftover variants if it cannot finish. Installed scoring timing: Outcome took 29.66 and 67.02 seconds in the paired fixtures. Efficiency took 21.70 and 13.77 seconds. Both Outcome verdicts matched the expected pass/fail. The failing fixture exceeded the one-minute limit.

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
