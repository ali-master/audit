# Stages

Every stage is one prompt (`prompts/`) + one schema (`schemas/`) + one module
(`src/stages/`). Default models and concurrency come from
[`config/stages.yaml`](configuration.md).

| # | Stage | Default model | Concurrency | Tools | Output schema |
|---|-------|---------------|-------------|-------|---------------|
| 1 | Recon | `claude-opus-4-7` | 1 | Read, Grep, Glob, Bash | `recon_output` |
| 2 | Hunt | `claude-sonnet-4-6` | 50 | Read, Grep, Glob, Bash | `finding` |
| 3 | Validate | `claude-opus-4-7` | 10 | Read, Grep, Glob | `validation` |
| 4 | Gapfill | `claude-sonnet-4-6` | 1 | Read, Grep, Glob | `gapfill_output` |
| 5 | Dedupe | `claude-sonnet-4-6` | 1 | Read | `dedupe_output` |
| 6 | Trace | `claude-opus-4-7` | 10 | Read, Grep, Glob, Bash | `trace` |
| 7 | Feedback | `claude-sonnet-4-6` | 1 | Read, Grep, Glob | `feedback_output` |
| 8 | Report | `claude-sonnet-4-6` | 1 | Read | `report` |

> Hunt and Validate run on **different models** on purpose — the "deliberate
> disagreement" rule. A unit test enforces it.

---

## 1. Recon — `prompts/01-recon.md` → `recon_output.schema.json`

Maps the repository and emits the initial Hunt queue.

- **Reads**: the whole target repo (via `--add-dir`), git history.
- **Produces**: `subsystems[]`, an `architecture` block (build commands, entry
  points, trust boundaries, external inputs), and `initial_tasks[]` — narrowly
  scoped Hunt tasks.
- **Notable behavior**: greps git history for past security patches
  (`CVE`, `sec:`, `fix.*auth`, `sanitize`, …) and seeds tasks against unpatched
  sibling files that share a fixed idiom. May emit a `logic_chain` task for a
  high-impact multi-component path (the one exception to one-attack-class-per-task).
- **Failure mode**: if Recon's output can't be made schema-valid after its
  repair attempts, the **run aborts** (there's nothing downstream without it).
- **Cap**: `--max-recon-tasks` limits the initial fan-out.

## 2. Hunt — `prompts/02-hunt.md` → `finding.schema.json`

One agent per pending task, each looking for exactly one attack class.

- **Reads**: the task's `target_files`, the relevant recon subsystem, the repo.
- **Runs** in a per-task scratch dir (`work/<run-id>/hunt/<task-id>/`) where it
  may compile and run PoCs with Bash.
- **Produces**: zero or more `findings[]` (each pinned to file + line range with
  a verbatim `evidence_snippet`, severity, confidence, optional `poc`) plus
  `gaps_observed[]` that feed Gapfill.
- **Concurrency**: high by default (50); cap with `--max-concurrency`.
- **Budget**: the per-task budget check can abort the stage cooperatively.

## 3. Validate — `prompts/03-validate.md` → `validation.schema.json`

Adversarial re-read of each finding on a different model.

- **Goal**: disprove the finding. Checks upstream sanitizers, downstream sink
  semantics, framework auto-escaping, and reachability preconditions.
- **Produces**: a verdict — `confirmed`, `rejected`, or `needs_more_info` — with
  a mandatory `alternative_explanation`.
- **Cannot** emit new findings; this stage only filters.
- **Degradation**: if the validator can't produce schema-valid output, the
  finding is marked `needs_more_info` (never silently confirmed).

## 4. Gapfill — `prompts/04-gapfill.md` → `gapfill_output.schema.json`

Coverage analyst that fights hunter drift.

- **Reads**: completed tasks + their finding counts and observed gaps.
- **Produces**: new Hunt tasks (`source: gapfill`, ids prefixed `t_gf_`) for
  under-covered `subsystem × attack class` cells, plus a `coverage_analysis`.
- **Default cap**: 8 new tasks per iteration.

## 5. Dedupe — `prompts/05-dedupe.md` → `dedupe_output.schema.json`

Clusters confirmed findings by **root cause**.

- Same buggy helper called from five sites = one group with five members.
  Structurally identical bugs in different functions = different groups.
- Picks a `canonical_finding_id` per group (successful PoC > severity >
  confidence). Only canonical members go to Trace and Report.
- **Degradation**: if the agent fails, each finding becomes its own canonical
  group (no findings are lost).

## 6. Trace — `prompts/06-trace.md` → `trace.schema.json`

The gate. For each canonical finding, prove (or disprove) reachability.

- **Backward-traces** from the sink to a concrete external entry point,
  emitting the `call_chain` and `entry_points`, or records `blockers`
  (sanitizers, auth gates, dead code) when there's no path.
- **Auth-gated but reachable** still counts as reachable (with
  `auth_required: true`).
- **Degradation**: a tracer failure marks the finding **unreachable**
  (conservative — it won't ship on a failure).
- Only `reachable: true` findings proceed to Report.

## 7. Feedback — `prompts/07-feedback.md` → `feedback_output.schema.json`

The learning loop.

- Extracts the transferable pattern from each reachable trace (a shared sink, an
  insecure idiom, an entry-point shape) and greps for siblings.
- **Produces**: new Hunt tasks (`source: feedback`, ids prefixed `t_fb_`).
  These re-enter Hunt → Validate → Dedupe → Trace.

## 8. Report — `prompts/08-report.md` → `report.schema.json`

The final, schema-validated document.

- **Includes only** confirmed + canonical + reachable findings, with title,
  severity, CWE, evidence, the trace (entry points + call chain),
  recommendation, and `variants` (other group members).
- **No reachable findings** → a minimal empty report is written without an agent
  call.
- **Agent failure** → a deterministic fallback report is assembled from state.
- Written to `results/<run-id>/report/report.json`; render with
  `audit report --run-id <id> --format md`.
