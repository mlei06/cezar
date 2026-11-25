# Handoff: build the self-improving factory, M1.5 to M6

Paste everything below the line into a fresh coding-agent session started in `~/dev/cezar`. It is written for an agent with no prior context.

---

You are taking over the build of the "self-improving factory" in this Cezar fork (`~/dev/cezar`, GitHub `mlei06/cezar`, trunk branch `factory`). Cezar is a local cockpit that runs coding agents as tasks under per-project managers. The spec adds budgets, metrics, scoring, self-improvement, replay and a self-releasing harness. Your job is to implement milestones M1.5 and M2 to M6 of the roadmap directly, as code on `factory`, and verify each on the live cockpit. The owner is not available to unblock you: decide, record and keep going.

## Read first, in this order

1. `.ai/specs/2026-11-25-self-improving-factory-overseer-state.md`: where the build stands right now, machine state, open items. Re-read it after any restart.
2. `.ai/specs/2026-11-25-self-improving-factory-roadmap.md`: the Progress table, "Who does what", the milestone you're on (goal, deliverables, acceptance, watch points), the backlog rows assigned to it, and the definition of done.
3. `.ai/specs/2026-11-25-self-improving-factory.md` (the spec): only the decisions your milestone names, their "Reuse map" rows, and the matching rows of "Data model and storage", "Settings, CLI and API reference", "Failure handling", "Tests and acceptance". D11 holds the working rules below in full.
4. `.ai/specs/2026-11-25-self-improving-factory-observations.md`: what went wrong so far and why the spec says what it says.
5. `.ai/skills/factory-work/SKILL.md`: how to work in this repository (which AGENTS.md sections matter, validation order, test-resource rules, known host test failures, what never to touch). Follow it as if it were attached to you. AGENTS.md is about 62k characters; read only the sections it names, with `rg -n` and line ranges.

## Where things stand

- M0 is done. M1 (spec D2, D3: built-in task workflows, the capability block, secret descriptions, list commands) is being finished by the `cezar` project's manager inside Cezar: PR #6 merges, then one release of #6–#9, then a live acceptance check. Check the state file and `~/.cezar/factory/release-log.ndjson`. **Don't start M1.5 or M2 code until M1's release is live**, since both build on #6. Start with M1.5 (spec D11, D12: the manager as project lead), then M2. Read and plan while you wait. If M1 stalls for more than about two hours, finish it yourself: take over PR #6's branch, address its open review findings, merge and release.
- After M1 the manager stands by. It doesn't build M1.5 or later. You may message it (`POST /api/v1/workspace/managers/<id>/messages` on `http://127.0.0.1:4321`, id in `cezar-manager-id` under the `dataDir` of `~/.config/factory-overseer.json`) if you want a Cezar task run, but you don't need to.

## How to work

- **One branch and PR per deliverable**, from current `origin/factory`, named `impl/m<N>-<slug>`, targeting `factory`. Small and reviewable beats complete and sprawling. Say in each PR which existing module you reused (the spec's reuse map), and list any "Spec decisions" you made.
- **Reuse first.** Extend the module the reuse map names. Don't build a parallel one. Keep old run files, workflows and config parsing working exactly as before; new `CEZ_*` variables go in `.env.example` in the same commit.
- **Validate before each PR**, in order, through npm: `npm run typecheck`, `npm test -- <dirs you touched>`, full `npm test` once, `npm run test:unit`, `npm run build`. Add a test that fails without your change. Known host failures are listed in `factory-work`; note them and carry on.
- **Test resources.** This is one laptop that has crashed under load. Never pass `--maxWorkers` or `--pool` to Vitest. At most one full suite at a time across everything you run, including parallel subagents. Wait for long commands inside one shell command. Rerun a timing failure alone before believing it.
- **Review.** Runtime PRs (anything that executes: `packages/`, `scripts/`, build, test or CI config, workflows) get one independent review pass before merging, by a fresh subagent or reviewer that reads the diff against the spec sections. At most two rounds; then decide by the merge rule: correctness bugs, data loss, secret-value leaks and security issues block; everything else merges with the remaining findings listed as follow-ups in the PR and the roadmap backlog. Docs, specs and skills merge after your own diff check.
- **Merge** with a squash merge through `gh` once checks and review pass and the head includes current `factory`. Commits on `factory` that only touch docs, specs or skills don't force a rebase.
- **Release** after merging runtime PRs, batching merges that land close together: `node scripts/harness-release.mjs <merged sha> --wait-minutes 30` from `~/dev/cezar`. It builds the commit in its own worktree, waits until no Cezar task or manager is busy, switches versions, restarts the `cezar` user service, checks health and rolls back automatically. You run outside the cockpit, so you can run it in your own shell. A rollback means the merge is broken: fix forward or revert. Never install or switch versions any other way, and never touch `~/.cezar/versions` or `~/.cezar/bin` by hand.
- **Verify each milestone live**, against its acceptance in the roadmap, on the released cockpit. Use real tasks where acceptance needs them. Then update the roadmap's Progress table and write a short milestone review in the observation log (what worked, what didn't, the spec changes it caused).
- **Spec gaps.** When the spec is unclear or infeasible, decide in the direction that best fits its decisions and reuse map, record the decision in the PR and as a spec changelog entry (bump the version, `v5.12`, …), and continue. Stop only for something that contradicts the spec outright or weakens security.
- **Owner-protected parts** (spec D6, D7 "Always the owner"): the scorer rubrics in `.ai/cezar/scorers/` (use them as written), the judge settings, the `improve-factory` skill, secrets and permissions. Build the mechanisms around them; draft `improve-factory` in its own PR and leave it unmerged for the owner, with the rest of M5 working without it where possible (record that as a spec decision).

## Persistence: the laptop crashes

- Commit and push work in progress to your PR branch often, at least after every passing step.
- After every merge, release or decision, update the state file's "Where the build stands" and "Open items", commit and push to `factory` (`git pull --rebase` first).
- After a restart: read the state file, check `systemctl --user is-active cezar factory-poller model-relay`, the last release-log line, open PRs (`gh pr list`), and resume.

## Hard rules

- **The fork is public.** Never commit or post internal host names, IP addresses, company paths, user names, provider or model ids, other projects' names, or run data and transcripts. Use generic placeholders. Machine-specific settings live in `~/.config/factory-overseer.json` (never committed) and in local workspace settings. Run data lives outside the repo.
- Never commit to `main`; never force-push `factory` or `main`. Force-with-lease on your own `impl/*` branches is fine.
- Never print secret values. Don't change system settings (`.wslconfig`, systemd units other than through the release script, OS config) without the owner.
- Don't run production deploys of other projects (for example the paused deployment project) unless the owner asks in chat. Acceptance that needs one is recorded as pending owner.
- Don't edit `.ai/factory-overseer/` beyond reading it, except to retire the judge prototype once M3's built-in judge replaces it.

## Machine notes

- The cockpit: user service `cezar`, `http://127.0.0.1:4321`, API under `/api/v1`. Health: `/api/v1/health`.
- The judge model endpoint (used from M3) only resolves on the internal network, so it needs the VPN; its address and the OpenCode relay port are in `~/.config/factory-overseer.json`. If it's unreachable, build and test against a stub and record live scoring as pending.
- Workspace `maxParallel` is 2; keep it there until backlog B22 (a lower CPU priority for runs) ships in M2.

## Done

The program is done when the roadmap's definition of done holds. Items that need weeks of real use (merged improvement PRs whose clusters' failure rates fell) or the owner (production deploys) are reported as pending with the mechanism verified. Finish with a summary in the state file: what shipped, what's pending and on whom, and the backlog that remains.
