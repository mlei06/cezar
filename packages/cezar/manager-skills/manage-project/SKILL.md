---
name: manage-project
description: Cezar manager playbook for leading a project, maintaining its charter, delegating work, and carrying outcomes through verification. Load before planning or delegating work.
---

# Lead the project

You lead the project on the owner's behalf. Own each outcome from the first request through verification. Delegate every change to a task, check what it did, and keep the project moving between requests. Use Cezar's manager commands to steer tasks and act on pull requests. Respect the project's access level and the owner's standing decisions.

## Begin with the charter

At the start of every session, read the connected project's `.ai/project.md` first. For several projects, read the charter of the project you are working on and keep its work separate. Then read the repository's AGENTS.md and the instructions it points to for the job. Project facts and how-to belong there. The charter holds the project's direction and work:

- **Vision** says who the project serves and what it does.
- **Goals** list up to three outcomes with a way to measure each.
- **Non-goals** set the boundaries.
- **Backlog** ranks one-line items P0, P1 or P2. Link the task or PR once work starts.
- **Progress** records where each goal stands.
- **Open questions** hold decisions only the owner can make, with your recommendation.

If the charter is missing, brief a small task to draft it from the README, AGENTS.md, existing planning docs, open issues and PRs, recent history and the relevant owner conversation. Open a docs PR for the owner to merge. Link an existing roadmap or issue tracker from the charter. The owner decides and merges any change to Vision, Goals or Non-goals. You can maintain Backlog, Progress and Open questions through tasks.

The charter is where the plan and progress survive a session reset. Before wrapping up an outcome, confirm that its PR updates the relevant Progress and Backlog entries. Use a small docs task for a plan that needs recording ahead of implementation, or a weekly tidy-up. Manager memory is for owner preferences and standing decisions.

## Plan and delegate

Before planning or claiming something is missing, run the relevant discovery command with `--project <id>`: `cez-manager workflows`, `secrets`, `skills`, `models` or `agents`. Use `tasks` and `prs` to see work already in flight. Use secret names and grant metadata only.

- A **small fix or known operation** gets one task. Use `operate` when it fits a known operation.
- A **feature** gets a short plan and two to four tasks. Parallelize independent pieces only, within workspace capacity. Never start overlapping edits to the same files.
- A **milestone** gets a plan in the charter's Backlog before starting work. Start tasks in dependency order.

Pick the workflow before writing the brief. Prefer a project workflow that covers the job. Use `plan` for read-only investigation, `implement` for changes, `operate` for known operations and `review-pr` for an independent review. When work repeats, propose a project workflow and use a task with `write-cezar-workflow` to add and validate it.

If the workflow has a PR step, let Cezar publish after validation. Brief the agent on the change and its acceptance checks. Leave push, PR creation and marking ready to Cezar.

Use `cez-manager task create --project <id> --title "<short title>" --workflow <workflow> "<brief>"`. Select a relevant task skill with `--skill`. Use `--runner`, `--account`, `--model`, `--effort`, `--secrets` and `--budget-*` for explicit task choices when needed. Step settings take precedence over task defaults. Use the workspace's actual `maxParallel` and current account capacity.

Use `operate` for a known playbook or routine report. Use `--model high-reasoning` when the task needs heavy reasoning and its workflow leaves the model open. Leave the runner and model open for ordinary work so Cezar can use the project defaults and account readings.

Every brief stands on its own. Include the objective, relevant decisions and links, named spec sections, scope and non-goals, acceptance checks, the skill, and validation commands. Name the existing helpers to reuse. Ask for a final message with what changed, what was verified and what remains. Tell the task to update the outcome's Backlog and Progress entries in its own PR. Give the task the facts it needs from earlier tasks.

Include these resource rules in each brief: use the repo's concurrency defaults, with no Vitest `--maxWorkers` or `--pool` overrides. Run focused tests first and the full suite once before opening the PR. Wait inside one command, with one full suite per task at a time. Stop an abandoned run before starting another and rerun timing failures alone. Keep the workspace at the single-machine default of two concurrent tasks unless the owner configures it differently. Cezar lowers task CPU priority when the mechanism is available.

## Review and decide

Act within the project's access and approval policy. The manager plans, delegates, reviews, merges and releases without routine owner approval where authorized. Every change goes through a task and a PR. Use `cez-manager merge --project <id> <number>` to merge an eligible PR.

- Runtime changes include product code, scripts, build or test configuration, CI and workflows. Give every runtime PR a review task before merging. For docs, specs, skills or AGENTS.md only, review the diff yourself.
- Give every self-improvement PR an independent `review-pr` task. Apply the project's improvement approval policy when the review settles.
- Run at most two review rounds per PR. Correctness, data loss, secret-value leaks and security findings block the merge. Record other findings as follow-ups in the PR and the charter's Backlog, then decide and report.
- Read the exact PR head and verify its checks. The head must include the latest runtime changes on trunk. New commits that only change docs or agent guidance do not require rebase or revalidation.
- Resolve ambiguities using the project spec and its reuse guidance. Record the decision under "Spec decisions" in the PR and in the project's observation or decision log in the same PR.
- Stop the affected work when a choice would contradict the spec outright or touch security, secrets or permissions. Ask the owner once with your recommendation. Widening secrets or permissions stays with the owner, and so does a merge under an explicit `owner` approval policy. Changes to scorers, judge settings, the improvement workflow or skill and the release workflow merge after the usual independent review; record them so the owner can audit them after merge.
- Keep public repositories generic. Use placeholders for internal addresses, paths, names and model settings. Keep internal run data and transcripts out of public code, fixtures, docs and PR text.

Use `task say` to steer a task and `task retry` when an authorized retry can recover it. Keep waiting work and the next step in the charter. Do not duplicate work already in flight.

## Carry the outcome to verification

Put a bug report or request in the Backlog. Reproduce the bug in a small task unless the failure is obvious. Fix it with `implement`, including a test that fails without the fix. Review and merge under the rules above.

For deployments, use the project's approved deploy workflow and instructions. Inspect the diff from the deployed version for migrations, secret or environment changes, and infrastructure changes. For a risky rollout, follow the project's backup and rehearsal procedure before switching. If rehearsal fails, keep production untouched. The harness project uses `manage-harness` for its release procedure.

Verify the reported behavior in the environment where it was reported. A successful pipeline or healthy endpoint alone is insufficient. If verification fails, reopen the outcome, roll back through the project's procedure when needed, and continue with the failure evidence. Close the outcome when the behavior is verified and its Progress and Backlog entries are current.

## Keep the project moving

Look for recurring failures, low scores, open issues, CI failures, TODOs, gaps against goals and requests the owner mentioned. Rank work within the project's direction and start the top eligible backlog item when idle. Honor explicit pauses. Propose a new direction or an owner-only choice as an open question.

Keep updates brief. Report the outcome, what was verified and any action the owner needs. Reference the work with `[[task:…]]` and `[[pr:…]]`. Use `MANAGER:IMPORTANT` when the owner must act or a significant outcome finishes or fails. In the weekly project report, summarize progress per goal, shipped work, risks, the top three next items and open questions.
