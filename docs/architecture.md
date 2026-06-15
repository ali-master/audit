# Architecture

## The pipeline graph

```
Recon
  │  emits initial Hunt tasks (one attack class each)
  ▼
┌─ Hunt ─────────► Validate ─────────► Gapfill ─┐   ← repeats up to
│   find bugs       disprove them       re-queue │     gapfill_iterations+1
└────────────────◄──────────────────────────────┘     (breaks early when dry)
  │
  ▼
Dedupe ──► Trace ──► Feedback ─┐   ← repeats up to feedback_iterations
  │  cluster   reachable?   seed │     (re-runs Hunt→Validate→Dedupe→Trace)
  │            gate            │
  ◄────────────────────────────┘
  ▼
Report   (only confirmed + canonical + reachable findings)
```

Implemented in [`src/orchestrator.ts`](../src/orchestrator.ts).

## Why it's shaped this way

The design follows Cloudflare's
[Project Glasswing](https://blog.cloudflare.com/cyber-frontier-models/): real
vulnerability discovery doesn't come from one exhaustive agent. It comes from

1. **Many narrow agents** — one attack class per Hunt task, with the trust
   boundary spelled out in the task's `scope_hint`.
2. **Deliberate disagreement** — Validate runs on a *different model* than Hunt
   and is told to disprove the finding. This filters noise.
3. **Reachability as the gate** — Trace is the stage that decides what ships. A
   "buggy" sink that no attacker-controlled input can reach is dropped.
4. **A feedback loop** — a proven-reachable bug teaches the pipeline a pattern,
   which seeds new hunts for siblings elsewhere in the repo.

## Data flow

Each stage is an agent call wrapped by [`src/runner.ts`](../src/runner.ts):

```
prompt (prompts/NN-stage.md) + schema (schemas/x.schema.json)
        │
        ▼
   system prompt  ──►  Claude Agent SDK query()  ──►  streamed messages
        ▲                                                   │
        │ repair turn (if schema-invalid)                   ▼
        └──────────────────────────────  validate(JSON, schema)
                                                            │ valid
                                                            ▼
                                              payload → SQLite + results/*.jsonl
```

- **Inputs** to each stage are read from the SQLite state (recon output,
  pending tasks, unvalidated findings, canonical findings, reachable traces).
- **Outputs** are validated against the stage's JSON Schema *before* they're
  trusted. If validation fails, the runner issues a repair turn in the same
  session; if it still fails after `repair_attempts`, the stage handles it
  (most degrade gracefully; Recon aborts the run).
- **Artifacts**: every message exchanged with the model is appended to
  `results/<run-id>/<stage>/<id>.jsonl` as it happens — the durable source of
  truth. SQLite is the queryable index built from those payloads.

## The loops

- **Hunt → Validate → Gapfill** repeats up to `gapfill_iterations + 1` times.
  Gapfill analyzes coverage and re-queues under-explored `subsystem × attack
  class` combinations as new Hunt tasks. The loop breaks early when a Hunt
  iteration finds nothing new or Gapfill produces no tasks.
- **Feedback → Hunt → Validate → Dedupe → Trace** repeats up to
  `feedback_iterations` times. Feedback turns reachable traces into new Hunt
  tasks aimed at structurally similar code.

Both loop counts live in `config/stages.yaml` under `loops:`.

## Cost & safety rails

- A **budget guard** (`--max-cost-usd`) is checked between every stage *and*
  before each Hunt task, so a run aborts cleanly instead of overrunning.
- **Concurrency** is per-stage (`config/stages.yaml`), capped globally by
  `--max-concurrency`.
- **Quota exhaustion** aborts into a resumable state (the in-flight task is left
  `pending`); `--resume` re-attempts incomplete work.
- See [State & artifacts](state-and-artifacts.md) for how resume works.
