# Contributing to audit

Thanks for considering a contribution! `audit` is an 8-stage, agent-driven
vulnerability-discovery pipeline. This guide explains how it's laid out and how
to change it safely.

## Code of Conduct

This project is governed by our [Code of Conduct](.github/CODE_OF_CONDUCT.md).
By participating, you agree to uphold it.

## TL;DR setup

```bash
bun install
bun run src/cli.ts auth-check   # confirm Claude auth works
bun test                        # unit tests (no network)
bun run test:types              # tsc --noEmit
bun run build                   # bundle to dist/
```

Requirements: **[Bun](https://bun.sh) ≥ 1.1** (the project uses `bun:sqlite`
and other Bun-native APIs) and a Claude Pro/Max subscription (or a gateway /
API key) for end-to-end runs.

## How the pipeline is structured

Each of the 8 stages is defined by **three** things, and changing a stage
usually means touching all three together:

| Concern | Location | What it is |
|---------|----------|------------|
| Behavior | `prompts/<NN>-<stage>.md` | The system prompt for that stage's agent |
| Output shape | `schemas/<name>.schema.json` | JSON Schema the agent output must validate against |
| Wiring | `src/stages/<stage>.ts` | Reads inputs from state, runs the agent, writes results |

Cross-cutting code:

- `src/runner.ts` — the single Claude Agent SDK wrapper (streaming session +
  schema-validation + repair turn + retry/backoff). All stages go through it.
- `src/orchestrator.ts` — the stage graph and the budget/quota/resume logic.
- `src/state.ts` — the `bun:sqlite` data layer (runs, tasks, findings, traces,
  dedupe groups, costs, artifacts).
- `src/config.ts` + `config/stages.yaml` — per-stage model, concurrency, tools,
  repair attempts, and the loop counts.

See [`docs/`](docs/) for the full reference.

## Common changes

- **Tune a stage's behavior** → edit its prompt in `prompts/`. No code change
  needed.
- **Add/relax an output field** → edit the schema in `schemas/`. Keep
  `additionalProperties: false` and add the field explicitly; agents only emit
  what the schema allows.
- **Change a stage's model / concurrency / tools** → `config/stages.yaml`.
  Hunt and Validate **must stay on different models** — the "deliberate
  disagreement" rule is enforced by a test.
- **Add a new attack class** → it's just a string in the Recon/Gapfill prompts'
  allow-lists; no schema change required.

## Pull requests

1. Fork and branch from `main` (`git checkout -b feat/your-thing`).
2. Make your change; add or update tests under `tests/` when you touch logic.
3. Run the full local gate:
   ```bash
   bun run test:types && bun test && bun run build
   ```
4. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
   `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
5. Open the PR with a clear description of what changed and why.

## Style

- TypeScript everywhere; prefer explicit types on public functions.
- Match the surrounding code's idiom and comment density.
- Schemas are the contract — when you change one, update the matching prompt so
  the agent knows the new shape, and add a validation test if it's load-bearing.
- Keep secrets out of commits and out of `results/` you attach to issues.

## Testing notes

- `bun test` runs offline and is the gate for PRs.
- End-to-end pipeline runs cost real tokens against your Claude subscription —
  use `--max-concurrency 1 --max-recon-tasks 3 --max-cost-usd <n>` and a tiny
  target when validating changes manually.

Thank you for contributing! 🎉
