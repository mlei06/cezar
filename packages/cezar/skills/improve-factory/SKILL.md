---
name: improve-factory
description: Improvement runs only (the improve-factory workflow). Turn a batch of scored failure causes into one pull request of redrafts to the files that own them, with a decisions file Cezar reads. Owner-protected — changes to this file need the owner.
---

# Improve the factory

You are an improvement run. Your brief holds a batch of failure causes from scored runs: each with its scorer, label, reasoning, quoted evidence, suggested fix, run link and age. It also holds the previous improvement PRs and their before/after numbers. Your job is to fix what keeps going wrong, at the place the fix belongs, and to leave the factory's guidance shorter or no longer than you found it.

You change files; you never change how you are graded. Never edit scorers (`.ai/cezar/scorers/`), the judge settings, this skill, the `improve-factory` workflow, secrets or permissions. If a cause can only be fixed there, mark its cluster `escalated` with the reason; the owner decides. Leave publication to the workflow. Never merge, release or deploy from this task.

## 1. Cluster

- Group causes by their evidence and fix, not by their wording. Two causes are one cluster when the same change would have prevented both.
- For each cluster, open two or three of its runs (the run links) and read the transcript around the quoted evidence. Confirm the evidence is real and the cause is what the judge says. A cluster you can't confirm is `dismissed`, with what you found instead.
- Note each cluster's size (runs, projects) and cost (tokens, minutes or owner touchpoints, from the metrics in the brief).

## 2. Choose

- Fix the clusters where size times cost is largest. Three good fixes beat ten weak ones; the rest are `deferred`.
- Prefer a mechanism to prose: a check step, a workflow field, a script in a skill's folder, or a budget beats another sentence agents must remember. Add prose only when no mechanism fits.
- A previous improvement whose numbers got worse is a cluster too: decide whether to revert it, fix it, or keep it with the reason.
- `infra` causes (the machine, network, external services, credentials) are not yours to fix in a repository. Dismiss them as "infra, reported to the owner".

## 3. Fix where the cause lives

Use the cause's target (spec D5) to find the file:

| Target | Where the fix goes |
|---|---|
| `workflow` | the project's workflow in `.ai/cezar/workflows/` |
| `skill` | the project's skill (`SKILL.md` and its scripts) |
| `agents-md`, `docs` | AGENTS.md or the doc it points to |
| `code` | the project's code, with a test that fails without the change |
| `brief` | the workflow or template that produced the brief |
| `harness`, `manager-skill` | only in the harness project; in any other project, `escalated` |

**Redraft, don't append.** Rewrite the section the cause points at so the right behaviour is the obvious one, and delete what's outdated or redundant. A skill or AGENTS.md section must end shorter or the same length; if it must grow, say why in the PR. Keep project facts in AGENTS.md and direction in the charter; don't move either into a skill.

**Generic causes:** if a cluster would hit every project (it comes from how Cezar sets tasks up, not from this repository), mark it `escalated` instead of patching this repository around it.

**Stay in scope:** the project's improvement scope (in the brief) lists what you may touch: `docs`, `agents-md`, `skills`, `workflows`, `code`. Anything outside it is `deferred` with the reason.

## 4. Check

Each fix must answer: would it have prevented the quoted evidence in the runs you read? Name the run and the line. The workflow runs `cez factory check` and the project's validation commands for code changes. Fix the reported failures if the workflow sends the task back.

## 5. Record

Write the decisions file at `$CEZ_ARTIFACTS_DIR/improvement-decisions.json` (the workflow names the path), as JSON, one entry per cluster:

```json
{ "pullRequestDescription": "Concise project PR body",
  "clusters": [
  { "id": "short-slug", "causes": ["<cause id>", "..."], "decision": "fixed | dismissed | escalated | deferred",
    "reason": "one line: why this decision", "files": ["paths changed, for fixed"],
    "prevents": "run link and quoted line this fix would have prevented, for fixed" } ] }
```

Every cause in the batch belongs to exactly one cluster. Don't commit the decisions file.

For a project PR, write `pullRequestDescription` with the sections below. The harness uses a generated public summary. Keep raw evidence and private links in the cockpit:
- **Changes:** each fix, its cluster, the files, and the regressions it addresses (runs, scorers, evidence).
- **Expected effect:** which scorer and failure rate should improve, by roughly how much.
- **Not fixed:** dismissed, escalated and deferred clusters, each with its reason.
- **Previous improvements:** any you kept, fixed or reverted after their before/after numbers.

Keep it short; the decisions file holds the per-cause detail.
