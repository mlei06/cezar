# Observation log: building the self-improving factory

The overseer's record of what the factory did while being built, following the roadmap's protocol. One entry per notable observation, with:
- **Evidence:** a task or run id, a metric, a quote.
- **Class:** harness, task-setup, repository, access, model, requirements or external.
- **Decision:** spec amendment, roadmap change, manager change, repository change, or nothing.

After M3, this log is also the calibration set for the automated judge.

## Baseline: open-webui, 2026-11-25 (before the roadmap)

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| 1 | The manager and the task didn't know the stored `PROD_VM_*` SSH secrets, costing a round trip to the owner | task 43299e6b brief: "Default local SSH user mlei4 was denied" | harness | spec D3 capability block |
| 2 | A 77k-character first read was carried by all 116 model calls, averaging 93k tokens of context and 10.7M input tokens in all | task 43299e6b metrics | repository, task-setup | spec D5 efficiency scorer; open-webui docs cleanup (PR #5) |
| 3 | Builds were polled through the model about 10 times, at 25–50 s per check | task 43299e6b transcript, isolated-status calls | task-setup | budget (D4); deploy workflow with check steps (PR #5) |
| 4 | Backup, staging and transfer scripts were rebuilt, although helpers from the v0.13.3 upgrade existed | task 43299e6b; `Michael/.state/upgrade-v0133/` is ignored | repository | helpers belong inside committed skills (spec D1) |
| 5 | Secret names were invented (`JENKINS_API_TOKEN`, `DEPLOY_SSH_*`) instead of listing the stored ones | task 295bd9f4 PR #5 first revision | harness | spec D3 list commands |
| 6 | Scope grew: a sandboxed OpenCode launcher and a new rollout contract, then the deploy was declared blocked | task 295bd9f4 final message | task-setup | `scope` scorer (D5); briefs with explicit out-of-scope |
| 7 | 7 review runs voted reject or changes with no findings: they couldn't read Azure PR diffs | review tasks ea05fbda, 8a12ef83 and others | harness | fixed `6a00d2387` |
| 8 | The manager playbook was read by task agents | task 43299e6b first command | harness | fixed `6f8519c88` |
| 9 | Throwaway test projects got automatic managers | managers deploy-model-cezar, webui-deploy-cockpit | harness | fixed `6f8519c88` |
| 10 | The manager told a task to read the manager skill and `ponytail` | task 295bd9f4 brief | task-setup | `manage-project` brief template forbids it |
| 11 | Judgement was good: risk identified, production protected, clean stop with evidence | the whole run | none | keep |
| 12 | New `CEZ_*` variables shipped without `.env.example` entries, against AGENTS.md's env rule: the overseer's own harness changes | `CEZ_MANAGER_AUTONOMOUS_DEFAULT`, `CEZ_AUTO_PROJECT_MANAGERS` missing from `.env.example` | harness (procedure) | roadmap M0.2 |
| 13 | The fork's AGENTS.md is 62k characters, about the size of open-webui's oversized reading list, and every harness task will be pointed at it | `wc -c AGENTS.md` | repository (harness project) | `factory-work` skill (M0.6); backlog B7 |

## Milestone entries

(added from M0 on)

## Judge calibration

Blind comparisons: the overseer's verdict is written before Mistral's is read, on every third task and every failing one (roadmap runbook). The spec's targets are 80% agreement on pass/fail and 70% on the main cause's target.

| Run | Scorer | Overseer | Judge | Agree on pass/fail | Agree on main target | Note |
|---|---|---|---|---|---|---|

Rubric revisions made from disagreements are listed under the run that prompted them.
