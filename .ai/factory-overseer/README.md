# Factory overseer tooling

Tooling for the overseer of the self-improving factory build (`.ai/specs/2026-11-25-self-improving-factory-roadmap.md`). It's not part of the harness: tasks must not edit it, and it runs outside cezar.

Machine-specific settings (internal hosts, CA bundle, provider) live in `~/.config/factory-overseer.json`, which is never committed. Start from `config.example.json`. Run data (events log, scores, transcripts) lives in the config's `dataDir`, outside the repository, because it quotes private task transcripts.

| File | What it does |
|---|---|
| `judge.py <project-root> <run-id> [scorer…]` | renders a run (transcript plus metrics) and scores it with the rubric drafts in `.ai/cezar/scorers/`; `--render-only` prints the rendering |
| `poller.py` | logs every manager message and task state change to `events.log`; runs as `factory-poller.service` |
| `next-event.sh [timeout-s]` | blocks until the poller logs a manager reply or a task end, then prints what's new |
| `model-relay.py` | localhost-only, fixed-destination TLS relay to the self-hosted model endpoint (OpenCode can't use a custom CA); runs as `model-relay.service`; OpenCode's provider points at `http://127.0.0.1:<relayPort>/v1` |
| `overseer_config.py` | reads the local config |
| `systemd/` | unit templates: `cezar.service` (the cockpit, run from the released harness), `factory-poller.service`, `model-relay.service` |

## Restore on a fresh machine or after a crash

1. **Config:** recreate `~/.config/factory-overseer.json` from `config.example.json`.
2. **Units:** copy `systemd/*.service` to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now cezar factory-poller model-relay`.
3. **Release:** if `~/.cezar/versions/current` is missing, release `factory` with `node scripts/harness-release.mjs`. The first time, add `--no-restart --force`, then start the unit.
4. **Resume:** read `.ai/specs/2026-11-25-self-improving-factory-overseer-state.md` for where the build stands and what's pending.
