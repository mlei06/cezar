# Handoff: finish the self-improving factory (M1 check, M1.5, M2 to M6)

Paste everything below the line into a new Codex session started in `~/dev/cezar`. It assumes no prior context.

---

You are taking over the build of the "self-improving factory" in this Cezar fork (`~/dev/cezar`, GitHub `mlei06/cezar`, trunk branch `factory`). Cezar is a local cockpit that runs coding agents as tasks under per-project managers. The spec adds budgets, metrics, scoring, self-improvement, replay, a self-releasing harness, and managers that lead their projects. **Your job is to finish the roadmap:** verify M1, then build M1.5 and M2 to M6 directly as code on `factory`, release each milestone, and verify it on the live cockpit. Fix errors and make improvements along the way. The owner isn't available to unblock you: decide, record the decision and keep going.

## Read first, in this order

1. `.ai/specs/2026-11-25-self-improving-factory-overseer-state.md`: where the build stands, machine state and open items. It's your resume point. Re-read it after any restart.
2. `.ai/specs/2026-11-25-self-improving-factory-roadmap.md`: the Progress table, "Who does what", the definition of done, and for your current milestone its goal, deliverables, acceptance, watch points and the backlog rows assigned to it.
3. `.ai/specs/2026-11-25-self-improving-factory.md` (the spec): for each milestone, only the decisions it names, their "Reuse map" rows, and the matching rows of "Data model and storage", "Settings, CLI and API reference", "Failure handling", "Security" and "Tests and acceptance". D11 and D12 also describe how the managers you're building should behave.
4. `.ai/specs/2026-11-25-self-improving-factory-observations.md`: what went wrong so far and why the spec says what it says.
5. `.ai/skills/factory-work/SKILL.md`: how to work in this repository: which AGENTS.md sections matter, the validation order, test-resource rules, known host test failures, the public-fork rule, and what never to touch. Follow it as if it were your own instructions. AGENTS.md is about 62k characters, so read only the sections it names (`rg -n` and line ranges).

## Where things stand

- **M0** is done. **M1** (spec D2, D3: built-in task workflows, the capability block, secret descriptions, list commands) is merged and live as release `0.21.0+release-41a8ac9`. The `cezar` project's manager was asked to verify M1's acceptance and then stand by.
- **Your first step:** if the state file doesn't record M1's acceptance as verified, verify it yourself against the roadmap's M1 acceptance, including the check that a task made by hand from a project's New task form (description, workflow, model, skill) runs with the capability block in its prompt. Fix anything that fails. Write the M1 review into the observation log, mark M1 done in the Progress table, then start **M1.5** (spec D11, D12: the manager as project lead), then **M2** onward in order.
- **The manager stands by.** Don't give it roadmap work. You may ask it for a Cezar task run if that's useful (`POST http://127.0.0.1:4321/api/v1/workspace/managers/<id>/messages`; the id is in `cezar-manager-id` under the `dataDir` named in `~/.config/factory-overseer.json`), but you don't need to.

## How to work

- **Branches and PRs:** one branch and PR per deliverable, from current `origin/factory`, named `impl/m<N>-<slug>`, targeting `factory`. Small and reviewable beats complete and sprawling. In each PR, say which existing module you reused (the spec's reuse map) and list any "Spec decisions" you made.
- **Reuse first.** Extend the module the reuse map names, and don't build a parallel one. Keep old run files, workflows and config parsing working exactly as before. New `CEZ_*` variables go in `.env.example` in the same commit.
- **Validate before each PR**, in order, through npm:
  1. `npm run typecheck`
  2. `npm test -- <dirs you touched>`
  3. the full `npm test`, once
  4. `npm run test:unit`
  5. `npm run build`

  Add a test that fails without your change. The known host failures listed in `factory-work` get noted, then you carry on.
- **Test resources.** This is one laptop, and it has crashed under load:
  - never pass `--maxWorkers` or `--pool` to Vitest;
  - run at most one full suite at a time across everything you run;
  - wait for long commands inside one shell command rather than checking back;
  - rerun a timing failure on its own before believing it.
- **Review.** Runtime PRs get one independent review pass before merging. Runtime means anything that executes: `packages/`, `scripts/`, build, test or CI config, and workflows. Re-read the full diff against the spec sections as a reviewer would, separately from writing it. At most two rounds, then decide by the merge rule:
  - **blocks the merge:** correctness bugs, data loss, secret-value leaks, security issues;
  - **merges anyway:** everything else, with the remaining findings listed as follow-ups in the PR and in the roadmap backlog.

  Docs, specs and skills merge after your own diff check.
- **Merge** with a squash merge through `gh` once validation and review pass and the head includes current `factory`. Trunk commits that only touch docs, specs or skills don't force a rebase.
- **Release** after merging runtime PRs, batching merges that land close together. From `~/dev/cezar`, run `node scripts/harness-release.mjs <merged sha> --wait-minutes 30`. It:
  - builds that commit in its own worktree;
  - waits until no Cezar task or manager is busy;
  - switches versions and restarts the `cezar` user service;
  - checks health and rolls back automatically.

  If the restart would kill your own process, start the script detached (`systemd-run --user --collect --unit=harness-release-<sha7> --working-directory=$HOME/dev/cezar --setenv=PATH="$PATH" node scripts/harness-release.mjs <sha> --wait-minutes 30`), then read `journalctl --user -u harness-release-<sha7>` and the last line of `~/.cezar/factory/release-log.ndjson`. A rollback means the merge is broken: fix it forward or revert it. Never install or switch versions any other way, and never touch `~/.cezar/versions` or `~/.cezar/bin` by hand.
- **Verify each milestone live**, against its acceptance in the roadmap, on the released cockpit, using real tasks where acceptance needs them. Then mark it done in the Progress table and write a short milestone review in the observation log: what worked, what didn't, and the spec changes it caused.
- **Fix and improve as you go.** When you hit a bug, a flaky or slow path, or a gap in the spec, fix it in its own small PR, or add it to the roadmap backlog with the milestone it belongs to. Log notable findings in the observation log, with evidence, class and decision, as the existing entries do.
- **Spec gaps.** When the spec is unclear or infeasible, decide in the direction that best fits its decisions and reuse map, and continue. Record the decision in the PR and as a spec changelog entry, bumping the version (`v5.16`, …). Stop only for something that would contradict the spec outright or weaken security.
- **Owner-protected parts** (spec D6, and D7's "Always the owner" list): the scorer rubrics in `.ai/cezar/scorers/` (use them as written), the judge settings, the `improve-factory` skill, secrets and permissions. Build the mechanisms around them. Draft `improve-factory` in its own PR and leave it unmerged for the owner. Make the rest of M5 work without it where possible, and record that as a spec decision.

## Commits, pushes and progress notes, for clean transitions

The laptop crashes, and another agent or the owner may pick up after you, so:
- **Commit small and often,** at least after every passing step. Use plain conventional messages (`feat(scoring): …`, `fix(release): …`, `docs(factory): …`). **Add no `Co-authored-by` or other trailer.**
- **Push your branch after every commit.** Before pushing `factory`, always `git pull --rebase`.
- **After every merge, release, milestone step or decision,** update the docs and push them to `factory` in the same sitting:
  - the state file: "Last updated", "Where the build stands", "Open items";
  - the roadmap's Progress table and backlog;
  - the observation log, for anything notable.

  The state file must always say what's in flight (branch, PR, step), what's next, and anything half-done that a newcomer would need to know.
- **After a restart or a new session:**
  1. read the state file;
  2. check `systemctl --user is-active cezar factory-poller model-relay`;
  3. check the last release-log line and the open PRs (`gh pr list`);
  4. check your own `impl/*` branches;
  5. resume from what the state file says.

## Hard rules

- **The fork is public.** Never commit or post any of these:
  - internal host names or IP addresses;
  - company paths or user names;
  - provider or model ids;
  - other projects' names;
  - run data or transcripts.

  Use generic placeholders. Machine-specific settings live in `~/.config/factory-overseer.json` (never committed) and in local workspace settings. Run data stays outside the repository.
- **Branches:** never commit to `main`, and never force-push `factory` or `main`. Force-with-lease on your own `impl/*` branches is fine.
- **Secrets:** never print a secret's value.
- **System settings:** don't change them without the owner. That covers `.wslconfig`, systemd units (other than through the release script) and OS config.
- **Other projects:** don't deploy any of them to production (for example the paused deployment project) unless the owner asks. Acceptance that needs a production deploy is recorded as pending on the owner, with everything up to the deploy verified.
- **Overseer tooling:** don't edit `.ai/factory-overseer/` beyond reading it, except to retire the judge prototype once M3's built-in judge replaces it.
- **Git history:** leave the pending history purge in the state file alone; it's the owner's call.

## Machine notes

- **The cockpit:** user service `cezar`, at `http://127.0.0.1:4321`, with its API under `/api/v1` and health at `/api/v1/health`.
- **The judge model endpoint** (from M3) only resolves on the internal network, so it needs the VPN. Its address and the OpenCode relay port are in `~/.config/factory-overseer.json`. If it's unreachable, build and test against a stub, and record live scoring as pending.
- **Workspace `maxParallel`** is 2. Keep it there until backlog B22 (a lower CPU priority for task runs) ships in M2.

## Done

The program is done when the roadmap's definition of done holds. Some items need weeks of real use, such as merged improvement PRs whose clusters' failure rates have fallen; others need the owner, such as production deploys. Report those as pending, saying who they wait on, with the mechanism verified. Finish by writing a summary into the state file: what shipped, what's pending and on whom, and the backlog that remains. Push it.
