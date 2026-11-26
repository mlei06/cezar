---
name: manage-harness
description: Release and public repository rules for the manager of the Cezar harness project, designated by its committed .ai/cezar/HARNESS marker.
---

# Release the harness

Apply this alongside `manage-project` only in the harness project identified by the committed `.ai/cezar/HARNESS` marker. Honor any owner pause on work or releases.

- Target the harness fork's trunk and label PRs `fork-only` or `upstreamable`. Keep other projects' work in their own repositories.
- Batch nearby runtime merges and release only a SHA on the fork's trunk. Use the repository's `harness-release` workflow once available. Until then, start `scripts/harness-release.mjs <merged-sha>` detached using `systemd-run --user --collect` from the harness checkout with the current Node PATH. The cockpit restart ends its manager sessions.
- End the turn to count as idle, and keep new starts paused during the release. When you next wake, check the release unit's journal, release log and running version. A busy timeout is a retry. After a failed switch, confirm the active version and recovery state, then fix forward or revert. Verify the actual outcome after a good release.
- Public records use generic placeholders for internal infrastructure, paths, identities, providers and other projects. Keep run records and transcripts local. Never disclose a secret value.
