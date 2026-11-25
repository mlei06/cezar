# Observation log: building the self-improving factory

The overseer's record of what the factory did while being built, following the roadmap's protocol. One entry per notable observation, with:
- **Evidence:** a task or run id, a metric, a quote.
- **Class:** harness, task-setup, repository, access, model, requirements or external.
- **Decision:** spec amendment, roadmap change, manager change, repository change, or nothing.

After M3, this log is also the calibration set for the automated judge.

## Baseline: open-webui, 2026-11-25 (before the roadmap)

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| 1 | The manager and the task didn't know the stored `DEPLOY_*` host SSH secrets, costing a round trip to the owner | task 43299e6b brief: "Default local SSH user … was denied" | harness | spec D3 capability block |
| 2 | A 77k-character first read was carried by all 116 model calls, averaging 93k tokens of context and 10.7M input tokens in all | task 43299e6b metrics | repository, task-setup | spec D5 efficiency scorer; open-webui docs cleanup (PR #5) |
| 3 | Builds were polled through the model about 10 times, at 25–50 s per check | task 43299e6b transcript, isolated-status calls | task-setup | budget (D4); deploy workflow with check steps (PR #5) |
| 4 | Backup, staging and transfer scripts were rebuilt, although helpers from the v0.13.3 upgrade existed | task 43299e6b; the project's ignored state folder is ignored | repository | helpers belong inside committed skills (spec D1) |
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

### M0 (bootstrap, overseer-built)

| # | Observation | Evidence | Class | Decision |
|---|---|---|---|---|
| M0-1 | Local self-update installs all get the same id (`<version>+local`), so releasing twice from one version would overwrite the previous release and break rollback | `installId()` in `self-update/layout.ts` | harness | the release script uses `linkCheckout` with a `release/<sha7>` build branch per release; spec D9 updated |
| M0-2 | The fork's root `.gitignore` ignored `.ai/cezar/` wholesale, so the harness project couldn't commit its own workflows, scorers or benchmarks | `.gitignore` line 11 | repository (harness) | allowlisted in `b4d4ac1ef` |
| M0-3 | The OpenCode binary ignores every custom-CA setting (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `BUN_CA_BUNDLE_PATH`), so it can't verify the endpoint's internal certificate. Every OpenCode-Mistral task, the planned `operate` workflow and an OpenCode judge would fail on this machine. | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on `opencode run`; openssl verifies with the same bundle | access (infra) | a localhost-only, fixed-destination TLS relay (`davy-relay` user service, 127.0.0.1:5001) and OpenCode's davy provider pointed at it; spec D5 judge note |
| M0-4 | `mistral-large-4` on davy has a 262,144-token window; the largest transcript so far (the upgrade task) renders to about 630k characters, roughly 160k tokens, and fits whole | davy `/v1/models` `max_model_len` | none | answers spec open question 3 |
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

## Judge calibration

Blind comparisons: the overseer's verdict is written before Mistral's is read, on every third task and every failing one (roadmap runbook). The spec's targets are 80% agreement on pass/fail and 70% on the main cause's target.

| Run | Scorer | Overseer | Judge | Agree on pass/fail | Agree on main target | Note |
|---|---|---|---|---|---|---|
| open-webui 43299e6b | outcome | delivered | delivered | yes | n/a | the transcript includes the authorized follow-up turns |
| open-webui 43299e6b | efficiency | wasteful | some-waste (rubric v1), then wasteful (v2) | no, then yes | no: judge harness/workflow, overseer docs + brief | v2 anchors the labels; the judge prompt now defines targets |
| open-webui 43299e6b | procedure | minor-lapse (read the manager skill) | followed | yes (both pass) | n/a | judge didn't treat reading a manager skill as a lapse; harmless now it's manager-only |
| open-webui 43299e6b | scope | in-scope (follow-ups were authorized) | in-scope | yes | n/a | |

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

Rubric revisions: efficiency v2 (2026-11-25), anchored labels after the 43299e6b disagreement. Judge prompt: target definitions added after the same run.

Rubric revisions made from disagreements are listed under the run that prompted them.
