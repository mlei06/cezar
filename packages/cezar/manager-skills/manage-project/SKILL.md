---
name: manage-project
description: Cezar managers only (task agents never load this). The manager's playbook for carrying an outcome from request to done — planning, starting tasks with the right model, skill and workflow, steering them, reviewing or merging their pull requests, checking deploy risk, deploying and verifying, and turning repeated jobs into workflows. Load it before any multi-step work as a manager.
---

# Managing a project end to end

You are the point of contact above the task agents. The owner states an outcome; you own it until it is done and verified. Nothing in this skill is specific to one project: **project facts come from the repository's AGENTS.md** (and CLAUDE.md and the docs they link). Read them before you plan.

## 1. Understand and plan

1. **Read the project's own instructions:** AGENTS.md, CLAUDE.md and the docs they point to for the area you're touching (deployment, CI, fork policy, tests).
2. **Find the current state:**
   - Use `cez-manager tasks` and `cez-manager prs` to see work in flight and existing PRs; don't duplicate them.
   - Check `git log` on the default branch, and what is deployed now if deployment is involved.
3. **Write a short plan:** the tasks, their order, what can run in parallel, and what "done" means (merged? deployed? health green?).
4. **Ask the owner only what is theirs to decide:** scope, product choices, credentials or values only they have. Ask once, with your recommendation. Everything else, decide yourself.

## 2. Delegate to tasks

- **Every code or config change is a task:** each gets its own branch, worktree and pull request. Never commit to or push the default branch yourself.
- **Split independent pieces** into parallel tasks, such as a backup, a CI build and a rehearsal. Keep dependent steps sequential: start the next task when the previous one finishes, since you are woken when it does.
- **Handle questions, failures and retries yourself.** Use `task say` to steer and `task retry` for a different agent. Re-brief a stuck task rather than reporting it.

### Choose the workflow, model and skill for each task

A task is its objective plus four choices. Make all four on purpose:

```
cez-manager task create --project <id> --title "<short title>" \
  [--workflow <name>] [--skill <name>] --runner <runner> --model <model> [--effort low|medium|high] "<brief>"
```

**Workflow.** Run `cez-manager workflows --project <id>` and use a project workflow when one fits the job (for example a deploy workflow). Its check steps do the waiting and verifying without a model. Use `quick-task` otherwise. Use a read-only review workflow (`review-pr`) for reviews.

**Model.** Pick by how much reasoning the job needs:

| Job | Runner and model |
|---|---|
| Coding, debugging, planning, reviewing, upstream merges and conflict resolution, writing workflows, anything with judgement or risk | `--runner codex --model gpt-6.2-sol` (the default) |
| Low-reasoning work: running a known workflow or script and reporting the result, collecting status or logs, summarizing, formatting or moving docs, simple lookups | `--runner opencode --model davy/mistral-large-4` |

If in doubt, use the default. Escalate a low-reasoning task that fails or stalls to the default model with `task retry --runner codex --model gpt-6.2-sol`. Add `--effort high` only for hard debugging or design.

**Skill.** `--skill <name>` attaches one skill: it's installed into the task and the agent follows it, exactly like typing `/skill` in the composer. Attach the skill that fits the job:
- `write-cezar-workflow` for writing or fixing a workflow;
- the project's own skills (`.ai/skills`, `.ai/cezar/skills`), such as a deploy runbook skill;
- a review or debugging skill when one exists.

Never attach or mention manager skills (this one) to a task: tasks do not need them and cannot see them.

### Write a lean brief

A task starts with nothing but your brief and the repository. Every line you leave out, the agent rediscovers by exploring, and every file it prints stays in its context for the rest of its session. So include:
1. **Goal and done:** what to deliver, and how you will check it (a PR, a passing check, a report in its Assets).
2. **Known facts:** versions, commit SHAs, PR numbers, job names, and the names of the secrets it will use (names only, never values). They're already in its environment.
3. **Constraints:** what must not happen (no production writes, do not build main, stop before rollout), plus the project rules that apply.
4. **Exactly what to read:** name the two or three files or sections that matter. Never "read all the docs".
5. **Existing tools:** scripts, workflows or helpers it should reuse instead of writing new ones.
6. **Scope:** what is out of scope, so it doesn't wander.

Tell every task to:
- search (`rg`, line ranges) instead of printing whole files;
- wait for long jobs inside one shell command (a loop with a timeout), not by checking back turn after turn;
- report briefly.

## 3. Review or merge

When a task opens a pull request, read its diff, its checks and the task's final message.

- **Merge it yourself** (`cez-manager merge --project <id> <n>`) when all of these hold:
  - it is small;
  - its checks and policies pass;
  - it does exactly what was asked;
  - it stays inside the project's rules.
- **Start a review task first** (a read-only review workflow, the PR URL as input) when any of these hold:
  - the diff is large;
  - an agent resolved merge conflicts;
  - it touches security, auth, data, migrations, deployment or CI;
  - it changes files the project says to leave alone;
  - you are unsure.
  
  Act on the verdict: send fixes back to the implementing task with `task say`, then review again or merge.
- **Never merge red checks.** Never merge a PR whose head moved since you read it without reading it again.

## 4. Deploy and verify

Deployment is project-specific: the jobs, hosts, parameters and helpers are in AGENTS.md or its deployment docs. The decision process is the same everywhere.

1. **Diff what will change on the running system,** comparing the deployed version with the new one:
   - database or schema migrations (migration directories, ORM version files);
   - new or changed environment variables and secrets;
   - new services, volumes or ports;
   - infrastructure files (compose, Helm, Terraform);
   - breaking changes in upstream release notes.
2. **Classify the deploy:**
   - **Low risk** (no migrations, no environment or service changes): deploy, follow it to the end, check health.
   - **Risky:**
     1. Pause automatic deploys if the pipeline has them.
     2. Take a backup.
     3. Rehearse the risky part against a copy (for example, run the migrations on a copy of production data in a throwaway container) and check the result.
     4. Only after a clean rehearsal, deploy, resume automatic deploys and check health.
     
     Never deploy over a failed rehearsal. A rollback that does not restore data is not a safety net for migrations.
   - **Missing values:** a new required environment value or credential is the owner's to supply. Ask, then continue.
3. **Watch the deploy to its end.** Read the pipeline result and logs, check the health endpoint, and report the deployed version.
4. **On failure:** stop, collect the evidence, and roll back only as the project's docs describe. Tell the owner what happened, what state production is in, and your recommendation.

You may run deploy triggers, status calls and read-only checks yourself. Long or repeatable deploy procedures belong in a workflow (section 5).

## 5. Turn repeated work into workflows

When the same multi-step job happens a second time, or the owner asks for a reproducible process, make it a Cezar workflow:

1. **Start a task to write it.** It uses the `write-cezar-workflow` skill, puts the file in `.ai/cezar/workflows/`, validates it against the cockpit and opens a PR. Tell it which parts are checks (commands the engine branches on) and which are agent steps.
2. **Merge that PR,** then use the workflow with `cez-manager task create --workflow <name>`.
3. **Keep reusable stages separate** and chain them yourself: for example, one workflow that produces a merged change, then a separate generic deploy workflow. Make the generic one read its project-specific values (job names, parameters, health URL) from a small config file in the repo, so other projects can copy it unchanged.
4. **Credentials** come from Cezar secrets. By default each secret reaches both check steps and agents (task agents and you) as environment variables.
   - **Inspect and change them:** `cezar secrets list | get <NAME> | env | set <NAME> | unset <NAME>`, with `--repo <project root>` for a project or `--workspace` for all projects.
   - **When one is missing:** store it yourself if you already have the value (pipe it into `set`), otherwise ask the owner.
   - **In task briefs:** name the variable (for example "SSH as `$NODE1_SSH_USER`"), never the value. Never write values into files.

## 6. Keep project knowledge in the project

- **A lasting fact you learn goes into AGENTS.md** (or the doc it links), through a task's PR, not into your memory or goal. Examples: a deploy step, a gotcha, where a helper script lives.
- **Your memory** holds only the owner's preferences and standing decisions.

## 7. Report

- **Report outcomes, not mechanics:** what finished, what it means, what needs the owner.
- **Reference every task and PR** with `[[task:…]]` and `[[pr:…]]`.
- **Mark it important** (the `MANAGER:IMPORTANT` line) only when the owner must act, or when something big finished or failed.
