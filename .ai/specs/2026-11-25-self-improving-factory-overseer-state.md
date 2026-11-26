# Overseer state

The overseer's resume point for the self-improving factory build. Updated and pushed at every milestone step and every overseer decision, so the work survives a crashed machine or a new session. Read this first, then the roadmap's Progress table and the observation log.

Last updated: 2026-11-26 09:51 UTC.

## Where the build stands

- **Milestones.** M0, M1 and M2 are complete. M1.5 is released in #12. Isolated managers ran concurrently, and one manager completed a live project rollout. The owner still controls when to start the live two-project check. The harness manager is inactive.
- **Live harness.** `0.21.0+release-4bba8b9` (#28) switched successfully with all three services active. An authenticated installed-entry fixture replayed a pinned Codex task against the previous installed release. It kept the original project commit and model, read the original marker, and returned its usage measurements. An isolated cockpit booted from installed #27 ran `cez replay --model … --times 3`. Compare showed all four scores on each variant, repeat averages and no adoption action. Replay scores stayed out of both cause queues.
- **Delegated routing.** The merge-writer applied `highReasoning`, `switchAbove: 0.8` and the ordered fallback list. Two installed `operate` fixtures verified the configured primary over the VPN and the first hosted fallback with an unreachable probe. The second recorded its effective runner, model and fallback note. The real probe was restored. M2 also verified run identity, historical metrics, budget alerts, the workflow PR gate, niceness 5 and the workspace cap of 2.
- **Scoring.** #20–24 released the catalog, stateless judge, storage, `cez score`, cause routing and UI. Installed fixtures verified pending and recorded events, score summaries and reconstruction of both cause queues. The outage fixture recovered all four scores after 304 seconds. The configured judge needed 65 seconds and 82.2 seconds to record all four scores on two installed fixtures. Calibration is in flight, and the one-minute acceptance is open.
- **Release controls.** #25–26 are live. Isolated fixtures from the installed entries verified draining before admission, expiry, resuming queued work, exact rollback selection, and all five benchmark cases. A failed restart or post-switch check rolled back in fixtures. A benchmark drop stopped before activation. Reporting and the exact-release revert PR passed with test sinks.
- **Protected release workflow.** Draft PR #29 (`8a933af1d`) is open for the owner. Typecheck, 148 focused tests, 18,646 full-suite tests, 54 unit checks, build and 35 package checks passed. The dry-run cockpit loaded and completed the YAML. The staged authenticated replay and tool-free fixture judge passed separately. The failed-required-replay fixture kept the active version in place.
- **Next.** Owner review of #29 and its first live invocation are the remaining M4 acceptance. The harness manager is inactive pending the live two-project test. M5 is gated on a successful M3 calibration and M6 follows M5. Relevant carryovers include Azure PR action parity (B6), settled PR cleanup (B14), post-restart runner retry (B21), judge acceptance (B25) and additional replay runner isolation (B26).

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
- **Calibration blocked.** Blind labels for 20 archived runs were recorded before the 78 scorer admissions. The live queue reached 39 usable verdicts, 14 errors and 25 pending, with pass/fail agreement on 37 of 39 usable verdicts. Four comparable main targets disagreed. Only four pending verdicts have a blind main target, so the current batch can reach at most 50% main-target agreement against the 70% gate. The one-minute live latency check also remains open. The frozen labels, sample and admissions are in `calibration-2026-11-26/` under the configured overseer data directory. Pending verdicts can finish in the existing queue. Any rubric or judge changes need owner approval before the next calibration.
- Calibration before this batch: 4 runs, 16 scorer comparisons. Pass/fail agreement is 14/16. The two disagreements: the overseer under-called efficiency once, and the judge can't see spec drift (backlog B19).
- **Public repository hygiene:** the fork holds nothing internal. No provider ids, hosts, paths, usernames, project names, job names or run data. Project-specific notes belong in that project's own repository; machine settings stay in `~/.config/factory-overseer.json`.
- **Git metadata:** the owner-approved identity matched the earlier squash author and the new #21 squash. Verified branch heads use public noreply or the approved author. Earlier internal author or committer lines remain part of the owner's pending history cleanup, including pushed intermediate heads that may still be reachable by commit id.
- **History purge, pending (owner decision, not for the implementer):** commits pushed before 2026-11-25 21:45 UTC on `factory`, `feat/manager-autonomy` and the PR branches still contain internal names in older spec text. Rewrite them once M1's PRs are merged and nothing is open: run `git filter-repo --replace-text` over all fork branches, force-push, then delete the stale branches.
