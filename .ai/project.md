# Cezar factory charter

## Vision

A local, zero-config cockpit where an owner can state an outcome once and a project manager carries it through verified delivery. The factory learns from its runs and uses Cezar's existing budgets, workflows, variants and self-update mechanisms to improve both project work and the harness.

## Goals

- **Deliver outcomes with less owner involvement.** Verify a reported bug from reproduction through release on the harness, with a regression test and no routine follow-up from the owner.
- **Measure and learn from work.** Meet the roadmap's judge calibration targets and measure whether merged improvements reduce their target failure rates.
- **Release safely.** Demonstrate benchmark rejection before a switch, an idle switch and an automatic rollback.

## Non-goals

- Moving task state out of the local cockpit or requiring new setup for ordinary runs.
- Changing credentials or widening permissions without the owner. Changes to rubrics, the judge settings, `improve-factory` and `harness-release` get the D11.2 review split (an independent review for every self-improvement PR) and are audited after merge (spec D6, v5.39).

## Backlog

- P0 Finish M1 live acceptance for the task composer, capability block and low-reasoning alias.
- P0 Verify M1.5 project leadership and charter updates on the released cockpit.
- P1 Deliver M2 run identity, budgets and metrics.
- P1 Deliver M3 scoring and calibration and M4 replay and benchmarked releases.
- P1 Deliver M5 improvement after calibration and rollback, then M6 benchmark reporting and proactive checks.
- P1 B30: verify the next improvement PR squash-merges onto `factory` under its PR title, not the autosave subject. Deferred test coverage: a merge in a second registered (non-boot) project.
- P1 B31 post-release acceptance: on the released harness, measure input tokens per call and per task for comparable read-only reviews pinned to a commit, before and after B31, using the cockpit's usage ledger. The repository measurement covers only bytes returned per read.
- P2 Spec follow-up (nonblocking): D12.5 Ideation still names "D7's owner list", which v5.39 removed; point it at D6's approval policy and D11.4 in the next spec revision.
- P2 Review the [factory roadmap backlog](specs/2026-11-25-self-improving-factory-roadmap.md#backlog) as milestones ship.

## Progress

- Delivery: M0 shipped. M1 is released and live acceptance is pending.
- Learning: scoring, calibration and improvement remain on the roadmap.
- B30: improvement squash merges send the PR title as the subject, with one PR identity across merge reads, manager approval, cockpit merge, settlement and recovery (implemented and tested; not yet released or live-verified).
- Merge policy (spec v5.39): the owner-protected merge gate is removed; changes to scorers, judge settings, `improve-factory` and `harness-release` get the D11.2 review split, with an independent review for every self-improvement PR, and are audited by the overseer after merge; manager merges carry the reviewed head SHA (implemented in this PR; release pending).
- B31: the restricted read broker's Read takes an optional `ref` (a hex commit id, resolved as that exact commit object with replacement objects off) and reads the file at that commit, sliced server-side with the 1-based `offset`/`limit`. Every Read cuts lines over 2,000 characters, and a partial Read ends with the lines it showed and the next offset. Every read-tool result is capped at 64,000 characters, truncation notice included. An already-granted `gh` falls back to the service PATH and still runs with the isolated tool env. On a synthetic 1,600-line, 70,890-byte pinned fixture, answering one question about line 800 took 64,000 bytes through `git show <sha>:<path>` (capped, so still cut short) and 971 bytes through a ranged Read at the ref (21,935 bytes for the default 500-line window). Implemented and tested; not yet released or live-verified.
- Releases: the bootstrap script ships merged harness commits. Benchmarking and release acceptance are tracked in M4.
