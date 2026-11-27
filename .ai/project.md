# Cezar factory charter

## Vision

A local, zero-config cockpit where an owner can state an outcome once and a project manager carries it through verified delivery. The factory learns from its runs and uses Cezar's existing budgets, workflows, variants and self-update mechanisms to improve both project work and the harness.

## Goals

- **Deliver outcomes with less owner involvement.** Verify a reported bug from reproduction through release on the harness, with a regression test and no routine follow-up from the owner.
- **Measure and learn from work.** Meet the roadmap's judge calibration targets and measure whether merged improvements reduce their target failure rates.
- **Release safely.** Demonstrate benchmark rejection before a switch, an idle switch and an automatic rollback.

## Non-goals

- Moving task state out of the local cockpit or requiring new setup for ordinary runs.
- Changing credentials, permissions, protected rubrics or the judge without the owner.

## Backlog

- P0 Finish M1 live acceptance for the task composer, capability block and low-reasoning alias.
- P0 Verify M1.5 project leadership and charter updates on the released cockpit.
- P1 Deliver M2 run identity, budgets and metrics.
- P1 Deliver M3 scoring and calibration and M4 replay and benchmarked releases.
- P1 Deliver M5 improvement after calibration and rollback, then M6 benchmark reporting and proactive checks.
- P1 B30: verify the next improvement PR squash-merges onto `factory` under its PR title, not the autosave subject.
- P2 Review the [factory roadmap backlog](specs/2026-11-25-self-improving-factory-roadmap.md#backlog) as milestones ship.

## Progress

- Delivery: M0 shipped. M1 is released and live acceptance is pending.
- Learning: scoring, calibration and improvement remain on the roadmap.
- B30: improvement squash merges send the PR title as the subject (implemented and tested; not yet released or live-verified).
- Releases: the bootstrap script ships merged harness commits. Benchmarking and release acceptance are tracked in M4.
