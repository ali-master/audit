# audit documentation

Complete reference for the `audit` pipeline. Start with the
[main README](../README.md) for the quickstart; this directory is the deep
reference.

## Contents

| Doc | What's inside |
|-----|---------------|
| [Architecture](architecture.md) | The pipeline graph, data flow, and the loop logic |
| [Stages](stages.md) | All 8 stages — inputs, outputs, schemas, models, prompts |
| [CLI reference](cli.md) | Every command and flag: `auth-check`, `run`, `status`, `report` |
| [Configuration](configuration.md) | `config/stages.yaml`, environment variables, loop counts |
| [Authentication](authentication.md) | Subscription OAuth, gateways (OpenRouter), API key, scrubbing |
| [Live-target reproduction](live-target.md) | Pointing agents at a running deployment |
| [Scope notes](scope-notes.md) | Excluding intentional-by-design surfaces |
| [State & artifacts](state-and-artifacts.md) | The SQLite schema, `results/` JSONL, `work/` scratch dirs |
| [Programmatic API](programmatic-api.md) | Using the library from your own TypeScript |
| [Troubleshooting](troubleshooting.md) | Quota, schema failures, resume, cost control |

## The one-paragraph mental model

`audit` runs **many narrow agents** instead of one big one. Recon maps the repo
and emits tightly-scoped Hunt tasks (one attack class each). Hunters look for
exactly their assigned bug and try to prove it. A **different model** then tries
to *disprove* each finding (Validate). Survivors are clustered by root cause
(Dedupe) and put through the gate that matters most — **can an attacker actually
reach this sink?** (Trace). Reachable bugs seed new hunts for the same pattern
elsewhere (Feedback), and only confirmed-and-reachable findings make the final
Report. Every agent output is validated against a JSON Schema, every run is
checkpointed in SQLite, and the whole thing is billed to your Claude
subscription.
