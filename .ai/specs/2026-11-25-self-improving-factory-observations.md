# Observation log: building the self-improving factory

The overseer's record of what the factory did while being built, following the roadmap's protocol. One entry per notable observation, with:
- **Evidence:** a task or run id, a metric, a quote.
- **Class:** harness, task-setup, repository, access, model, requirements or external.
- **Decision:** spec amendment, roadmap change, manager change, repository change, or nothing.

After M3, this log is also the calibration set for the automated judge.

## D11 observations

- A review raised an ambiguous secret policy for generated checks. The owner confirmed that they inherit the existing workflow check-step secrets.

## Baseline: the deployment project, 2026-11-25 (before the roadmap)

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| 1 | The manager and the task didn't know the stored `DEPLOY_*` host SSH secrets, costing a round trip to the owner | task the upgrade task brief: "Default local SSH user … was denied" | harness | spec D3 capability block |
| 2 | A 77k-character first read was carried by all 116 model calls, averaging 93k tokens of context and 10.7M input tokens in all | task the upgrade task metrics | repository, task-setup | spec D5 efficiency scorer; the deployment project docs cleanup (the deploy-workflow PR) |
| 3 | Builds were polled through the model about 10 times, at 25–50 s per check | task the upgrade task transcript, isolated-status calls | task-setup | budget (D4); deploy workflow with check steps (the deploy-workflow PR) |
| 4 | Backup, staging and transfer scripts were rebuilt, although helpers from the previous upgrade existed | task the upgrade task; the project's ignored state folder is ignored | repository | helpers belong inside committed skills (spec D1) |
| 5 | Secret names were invented (invented CI and SSH names) instead of listing the stored ones | task the deploy-workflow task the deploy-workflow PR's first revision | harness | spec D3 list commands |
| 6 | Scope grew: a sandboxed OpenCode launcher and a new rollout contract, then the deploy was declared blocked | task the deploy-workflow task final message | task-setup | `scope` scorer (D5); briefs with explicit out-of-scope |
| 7 | 7 review runs voted reject or changes with no findings: they couldn't read Azure PR diffs | the review tasks | harness | fixed `6a00d2387` |
| 8 | The manager playbook was read by task agents | task the upgrade task first command | harness | fixed `6f8519c88` |
| 9 | Throwaway test projects got automatic managers | managers deploy-model-cezar, webui-deploy-cockpit | harness | fixed `6f8519c88` |
| 10 | The manager told a task to read the manager skill and `ponytail` | task the deploy-workflow task brief | task-setup | `manage-project` brief template forbids it |
| 11 | Judgement was good: risk identified, production protected, clean stop with evidence | the whole run | none | keep |
| 12 | New `CEZ_*` variables shipped without `.env.example` entries, against AGENTS.md's env rule: the overseer's own harness changes | `CEZ_MANAGER_AUTONOMOUS_DEFAULT`, `CEZ_AUTO_PROJECT_MANAGERS` missing from `.env.example` | harness (procedure) | roadmap M0.2 |
| 13 | The fork's AGENTS.md is 62k characters, about the size of the deployment project's oversized reading list, and every harness task will be pointed at it | `wc -c AGENTS.md` | repository (harness project) | `factory-work` skill (M0.6); backlog B7 |

## Milestone entries

### M0 (bootstrap, overseer-built)

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| M0-1 | Local self-update installs all get the same id (`<version>+local`), so releasing twice from one version would overwrite the previous release and break rollback | `installId()` in `self-update/layout.ts` | harness | the release script uses `linkCheckout` with a `release/<sha7>` build branch per release; spec D9 updated |
| M0-2 | The fork's root `.gitignore` ignored `.ai/cezar/` wholesale, so the harness project couldn't commit its own workflows, scorers or benchmarks | `.gitignore` line 11 | repository (harness) | allowlisted in `b4d4ac1ef` |
| M0-3 | The OpenCode binary ignores every custom-CA setting (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `BUN_CA_BUNDLE_PATH`), so it can't verify the endpoint's internal certificate. Every OpenCode-the low-reasoning model task, the planned `operate` workflow and an OpenCode judge would fail on this machine. | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on `opencode run`; openssl verifies with the same bundle | access (infra) | a localhost-only, fixed-destination TLS relay (`model-relay` user service on localhost) and OpenCode's provider for that endpoint pointed at it; spec D5 judge note |
| M0-4 | The self-hosted judge model has a 262,144-token window; the largest transcript so far (the upgrade task) renders to about 630k characters, roughly 160k tokens, and fits whole | the endpoint's `/v1/models` `max_model_len` | none | answers spec open question 3 |
| M0-5 | A fork with an `upstream` remote could make task PRs target open-mercato/cezar through cezar's fork-parent lookup | AGENTS.md, fork-parent lookup | harness | `gh repo set-default mlei06/cezar`; upstream push disabled |
| M0-6 | The warm-up task (85efd7a7) polled its backgrounded test run across 8 model turns, although `factory-work` says to wait inside one command: 46 requests and 2.2M tokens for a two-line change | judge efficiency: wasteful; transcript +1:34 to +6:18 | harness | spec v5.2: `implement` validates with check steps; the M1 prompt names it |
| M0-7 | The warm-up task stopped to investigate a known, environment-dependent test failure (`open-in-app`, WSL) | transcript +6:18 | repository (harness) | the manager adds known pre-existing failures to `factory-work` (M1 item 0) |
| M0-8 | Tasks read unrelated global skills up front (graphify, about 19k characters with two others) | warm-up first call | harness | backlog B13 |
| M0-9 | The first warm-up review approved after reading the diff without running tests ("Tests were not run") | review 89c3fffa | task-setup | acceptable for review-pr (read-only); validation belongs in the implement workflow's checks (v5.2) |
| M0-10 | The warm-up task stayed `running` for about 6 minutes after its PR merged, holding up the release's wait for idle | release log 09:37 to 09:43; task 85efd7a7 | harness | backlog B14: a task whose PR merged should settle promptly; the release's wait should ignore tasks only monitoring a merged PR |

### M1

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| M1-1 | `maxParallel` 2 left a docs-only review queued 23 minutes behind two long implementation tasks | review e7d87e48 queued 09:45 to 10:08 | harness (settings) | workspace `maxParallel` raised to 4 |
| M1-2 | The manager stopped and raised a real spec conflict (D3's cap against never dropping secret names) instead of deciding it | manager message 09:44 | none (good) | spec v5.3 |
| M1-3 | All three code tasks so far polled their test runs through the model (8 to 16 turns each), despite the `factory-work` guidance | judge efficiency on 85efd7a7 and 6651d04f | harness | confirms v5.2 (`implement` validates with check steps); M1 item 2 |
| M1-4 | Implementation tokens are high: 7.2M (secret descriptions), 11.9M (workflow fields), largely from long full-suite waits re-reading context | run records | harness | budgets (M2) and v5.2 checks should cut this; re-measure after M1 |
| M1-5 | The manager held new starts for about 3 hours after a merge, waiting for a release confirmation, while the overseer was out of usage | events 07:07 to 10:09 | harness | B14: the hold belongs in `harness-release`, with a time limit (M4) |
| M1-6 | A built-in workflow task added a human gate to `implement` that the spec doesn't have | PR #6 | task-setup | corrected through the manager; spec D2 unchanged |
| M1-7 | Scope drift that matches the brief but not the spec is invisible to the judge, which only sees the brief | calibration on e04a507e | harness | backlog B19: give the `scope` scorer the spec sections a task names |
| M1-8 | Load of 9 to 11 on 12 cores, a likely cause of the host crashes: the PR #7 task ran two full Vitest suites at once in one worktree, one with `--maxWorkers=5` against the repository's cap of 2, while other tasks ran suites too; PR #6 then reported five timing failures in web scheduling tests | process list, 16:51; task 0705b477; PR #6 final message | harness (resources), task-setup | stopped the duplicate run; workspace `maxParallel` back to 2; manager rules (no worker overrides, one full suite per task, rerun timing failures alone) into briefs and `factory-work`; backlog B22 |
| M1-9 | Confirms M1-8: under the new test rules, PR #6's full suite passed with only the three documented host failures; the five web scheduling failures were load-induced | PR #6 final run, 18,554 passes | none | keep the rules |
| M1-10 | The review found that `implement`'s generated validation checks inherit check-only secrets while the agent can edit the test scripts; the manager held the merge as a security decision, as D11.4 asks | review f0349f8b | none (good escalation) | overseer: not a blocker, since agent secrets are ungated by owner decision; keep inheritance, explicit allowlist as a follow-up |
| M1-12 | The New task composer can select a workflow and a slash skill together. The runner received the expanded skill, but the capability block omitted its name. | PR #11 regression checks the actual runner prompt. The live New task form submitted the workflow, model and skill together on release `f1747bd`, and the read-only run confirmed its capability block. | harness | Use the resolved slash skill in the existing capability block. Preserve workflow-step skill precedence and compatibility with native slash commands. |
| M1-13 | The low-reasoning model refuses to quote its own system prompt, so asking a task to report its capability block can't verify it; the runner's stored session can | `operate` runs 910f342b and a8533071 | harness (verification) | verify prompts from the runner's session store or a test hook, not by asking the model; M3's judge reads transcripts the same way |

## M1.5

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| M1.5-1 | Git can discover a parent repository from a separately registered folder. A manager for that folder could receive a different project's charter. | PR #12 regression held two managers open concurrently and verified charter separation, fresh-session reloading and the nested-folder case. | harness | Preview committed charter sections only from the connected repository root. Prefer already-fetched fast-forward progress and keep reads bounded. |

Release `7dd520c` passed health and contained both playbooks and the charter loader. The real two-project exercise is pending owner onboarding.

## M2

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| M2-1 | Worktree setup or a later Continue can start from a different revision than the initial fork. The running harness release also needs to stay attributable across upgrades. | PR #13 verified dispatch, setup-hook commits, persisted Continue identity and the linked CLI. Release `417a93c` passed health and returned the expected project and harness commits for an isolated task. | harness | Record the initial identity once and the Continue identity on its step. Keep commit metadata optional for older or unidentifiable records (D8, v5.18). |
| M2-2 | The routine model depends on network reachability, and default model pins in built-ins preempt project settings. | Owner's D2 routing decision. | policy | Keep project defaults for ordinary work, add a configurable threshold and high alias, and probe the low-tier primary before selecting a hosted fallback (v5.17). |
| M2-3 | The relay forwards a credential-free probe upstream. An authentication challenge confirms the path is reachable. | PR #14 and release `0349ad4`. A live `operate` completed with the VPN available. Another completed on the first hosted fallback after switching just the probe to an unreachable target, then restoring the real URL. The run stored its runner, model and fallback note. | harness | Use the configured relay endpoint as the probe. Treat an authentication challenge as reachable and use account holds to select hosted fallbacks when the probe fails. |
| M2-4 | A saved dispatch USD ceiling can be zero. It still means park immediately. | PR #15 tested both legacy zero and new run budget records, including parking and reservations against mixed children. A live isolated dispatch on `6466703` confirmed canonical storage. | harness | Read both from one accessor. Copy positive legacy allocations into the run budget on load and preserve the effective zero ceiling. |
| M2-5 | The historical cockpit event log can rank tool results, while the archived runner session contains the per-request context samples. | Replayed the upgrade window locally through the new collector and metrics summarizer. The request count, average context and largest output matched the roadmap acceptance. | harness | Use the task collector for new runs and omit unknown request metrics for older logs. Keep the original run and session out of the repository. |
| M2-6 | Giving the first child all remaining token and time capacity can block normal fan-out. | Focused dispatch tests cover two children under a fixed parent budget and a settled child returning its unused share. | harness | Split these resources among free child slots. Keep the previous USD allocation behavior (D4, v5.19). |

| M2-7 | The Codex and OpenCode runner paths received per-request usage but had not passed it into the task collector. | PR #16's runner regressions exercise Codex request context and the OpenCode completion readings, including a repeated event. A live task on `f053f7e` returned request, context, and tool metrics. | harness | Emit readings through the existing usage-status event. Keep the raw request measurements optional for older logs and unsupported runners. |


## Judge calibration

Blind comparisons: the overseer's verdict is written before the judge's is read, on every third task and every failing one (roadmap runbook). The spec's targets are 80% agreement on pass/fail and 70% on the main cause's target.

| Run | Scorer | Overseer | Judge | Agree on pass/fail | Agree on main target | Note |
|---|---|---|---|---|---|---|
| the deployment project the upgrade task | outcome | delivered | delivered | yes | n/a | the transcript includes the authorized follow-up turns |
| the deployment project the upgrade task | efficiency | wasteful | some-waste (rubric v1), then wasteful (v2) | no, then yes | no: judge harness/workflow, overseer docs + brief | v2 anchors the labels; the judge prompt now defines targets |
| the deployment project the upgrade task | procedure | minor-lapse (read the manager skill) | followed | yes (both pass) | n/a | judge didn't treat reading a manager skill as a lapse; harmless now it's manager-only |
| the deployment project the upgrade task | scope | in-scope (follow-ups were authorized) | in-scope | yes | n/a | |

| cezar 85efd7a7 (warm-up) | outcome | delivered | delivered | yes | n/a | blind verdict written first |
| cezar 85efd7a7 | efficiency | wasteful (after seeing metrics) | wasteful | yes | yes: workflow | |
| cezar 85efd7a7 | procedure | followed | followed | yes | n/a | |
| cezar 85efd7a7 | scope | in-scope | in-scope | yes | n/a | |

| cezar 6651d04f (secret descriptions) | outcome | delivered | delivered | yes | n/a | |
| cezar 6651d04f | efficiency | lean (blind, from the PR only) | some-waste | yes (both pass) | n/a | the judge saw 16 polling turns during a 17-min test run that the PR didn't show |
| cezar 6651d04f | procedure | followed | followed | yes | n/a | |
| cezar 6651d04f | scope | in-scope | in-scope | yes | n/a | |

| cezar e04a507e (built-in workflows) | outcome | delivered | delivered | yes | n/a | |
| cezar e04a507e | efficiency | some-waste (blind) | wasteful | no | n/a | the judge is right: 128k average context over 121 requests; my blind call from the PR was too generous |
| cezar e04a507e | procedure | followed | followed | yes | n/a | |
| cezar e04a507e | scope | drifted (added a human gate the spec doesn't have) | in-scope | no | n/a | the judge scores against the brief, not the spec, so spec drift the brief allowed is invisible to it |

Rubric revisions: efficiency v2 (2026-11-25), anchored labels after the the upgrade task disagreement. Judge prompt: target definitions added after the same run.

Rubric revisions made from disagreements are listed under the run that prompted them.
