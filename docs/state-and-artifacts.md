# State & artifacts

A run produces three things on disk:

| Path | What | Source of truth? |
|------|------|------------------|
| `state.db` | SQLite index of the whole run | Queryable index |
| `results/<run-id>/<stage>/*.jsonl` | Every message exchanged with each agent | **Yes** — durable raw record |
| `work/<run-id>/hunt/<task-id>/` | Per-Hunt-task scratch dir (PoC compile/run) | Scratch |

All three are gitignored.

## SQLite schema (`src/state.ts`, `bun:sqlite`)

| Table | Holds |
|-------|-------|
| `runs` | One row per run: repo path, timestamps, status (`running`/`completed`/`aborted`/`failed`) |
| `recon_outputs` | The raw Recon payload, keyed by run |
| `tasks` | Hunt tasks: attack class, scope hint, target files, priority, `source` (recon/gapfill/feedback), status (`pending`/`running`/`done`/`failed`) |
| `findings` | Hunt findings + validation verdict + dedupe group + `is_canonical` |
| `traces` | Reachability verdict per canonical finding |
| `dedupe_groups` | Root-cause clusters with a canonical member |
| `costs` | Per-stage cost / token / turn / duration rows (powers `--max-cost-usd` and `status`) |
| `artifacts` | Pointers to the `results/` JSONL files and scratch dirs |

You rarely touch this directly — `audit status` and `audit report` read it for
you — but it's a plain SQLite file if you want to query it.

## Artifacts (`results/<run-id>/<stage>/<id>.jsonl`)

Each line is one JSON event, appended as it happens. Useful kinds:

| `kind` | Meaning |
|--------|---------|
| `meta` | Stage + model + start time |
| `user` | The input sent to the agent |
| `assistant` | A model message (text / thinking / tool_use blocks) |
| `result` | The SDK result (cost, tokens, turns, errors) |
| `repair_request` | A schema-validation repair turn was issued |
| `schema_errors` | The validation errors that caused a failure |
| `final_payload` | The validated output that was persisted |

When a stage misbehaves, this is where to look — e.g. `schema_errors` +
`final_payload` show exactly what the model emitted and why it was rejected.

## Resume semantics

`--resume <run-id>` continues an existing run:

1. The run's status is reopened to `running`.
2. Tasks left `running` (interrupted mid-flight) or `failed` (transient/quota
   error) are flipped back to `pending` so they're re-attempted.
3. Recon is skipped if its output already exists; already-validated findings and
   already-traced canonicals are skipped too.

This is why a **quota exhaustion** leaves the in-flight task `pending` rather
than `failed` — so resume picks it up cleanly once quota returns.

## Cleaning up

```bash
rm -rf state.db state.db-* results/ work/
```

Outputs in `results/` are **not** scrubbed of anything the agents read from the
target (which can include `.env` / secrets). Treat them as sensitive.
