---
name: factory-work
description: How to work on the self-improving factory in this cezar fork — which parts of AGENTS.md matter, how to read the factory spec, how to validate, and what never to touch in the live harness. Attach to every task that implements part of `.ai/specs/2026-11-25-self-improving-factory.md`.
---

# Working on the factory

You are changing the harness that runs you. The live cockpit is an installed version (self-update's `~/.cezar/versions`, behind the `~/.cezar/bin` launchers), never this working tree. The overseer or the `harness-release` workflow ships your merged work. So:

- **Never** restart the cezar service, run `systemctl`, run `cezar use`, `cezar link` or `cezar install`, or touch `~/.cezar/versions`, `~/.cezar/bin` or `~/.cezar/factory`.
- **Never** register projects, start runs or create managers on the live cockpit (port 4321) to test your work. To test against a cockpit, start your own: `CEZ_HOME=$(mktemp -d) CEZ_DRY_RUN=1 node packages/cezar/dist/index.js --no-open --port 4399 --bind-host 127.0.0.1`, after `npm run build`, and stop it when done.

## Read only what your task needs

AGENTS.md is long (about 62k characters). Don't print it whole. Read these sections with `rg -n` and line ranges, and only the ones your change touches:
- **"Zero config"**: new state may be written, never required; new `CEZ_*` variables go in `.env.example` in the same commit.
- **"Changing a mechanism that already works"**: before changing or replacing behaviour, name what it was load-bearing for.
- **"The HTTP API"**: every request and response shape is a zod schema in `packages/contract` first; routes are chained into a family builder; validate with the middleware trio in `src/server/validators.ts`.
- **"Task routing"**: the row for the area you're changing names the files to read first.
- **"Validation"**: the order to run before a PR.

## Read the spec as your requirements

- **Each task implements named decisions** of `.ai/specs/2026-11-25-self-improving-factory.md` (D1–D10). Read those decisions, the "Reuse map" row for each, and the related rows of "Data model and storage" and "Settings, CLI and API reference". Not the whole spec.
- **Reuse first.** The reuse map names the existing module to extend for each part. Extend it; don't build a parallel one. Say in your PR what you reused.
- **If the spec is wrong, unclear or infeasible,** stop that piece and say so in your final message, with the reason. Don't decide it yourself: the overseer owns the spec.

## Validate before the PR

Run these in order, through npm, never `npx vitest`:

```bash
npm run typecheck
npm test -- <the directories you touched>   # then the full `npm test` before the PR
npm run test:unit
npm run build
```

Add a test that fails without your change. Keep old run files, workflows and config parsing exactly as before.

## Work efficiently

- **Search, don't dump:** `rg -n` and `sed -n 'a,bp'`, not `cat` of large files.
- **Long jobs:** wait for a long command (tests, builds) inside one shell command, not by checking back turn after turn.
- **One PR per task,** targeting `factory`. Small and reviewable beats complete and sprawling.
