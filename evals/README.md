# Prompt evals (`promptfoo`)

Promptfoo suites for the audit pipeline's stage prompts in [`../prompts/`](../prompts).

## What is and isn't covered here

The 11 stage prompts split into two kinds:

| Kind | Stages | Eval approach |
| --- | --- | --- |
| **Pure-reasoning** (input is structured JSON; no repo access needed) | `04-gapfill`, `05-dedupe`, `07-feedback`, `08-report` | ✅ Covered here — deterministic + schema assertions. |
| **Agentic** (need `Read`/`Grep`/`Glob`/`Bash` against a live repo) | `01-recon`, `02-hunt`, `03-validate`, `06-trace`, `09-fix`, `10-triage-intake`, `11-advise` | ⏳ Not via the plain provider — see [below](#evaluating-the-agentic-stages). |

A plain `anthropic:messages` provider gives the model **no tools**. Grading recon
or hunt that way would only grade *hallucinated* file reads — a green check that
means nothing. The four pure-reasoning stages, by contrast, are near-pure
functions of their JSON input, so they give real signal today:

- **Dedupe** and **Report** consume already-structured findings/traces.
- **Gapfill** consumes Recon's *output* (subsystem paths come from the input, not
  live `grep`), and its coverage logic — fill under-covered cells, never re-issue
  a ran tuple, respect the cap — is fully checkable from the test's own input.
- **Feedback** consumes reachable traces. Its *output contract* (source/prefix
  tags, cap, priorities, per-task rationale) and its **no-retest** rule are
  deterministic; only the correctness of the proposed sibling `target_files`
  needs a live repo, so that part is deferred to the agentic harness.

## Layout

```
evals/
  lib/
    stage-prompt.cjs      # loads prompts/<stage>.md as system + test `input` as user
    extract-json.cjs      # output transform: isolate JSON before asserting
    validate-schema.cjs   # ajv validator that resolves cross-file $refs (see below)
  gapfill/  promptfooconfig.yaml, assert-gapfill.cjs,  tests/cases.yaml
  dedupe/   promptfooconfig.yaml, assert-dedupe.cjs,   tests/cases.yaml
  feedback/ promptfooconfig.yaml, assert-feedback.cjs, tests/cases.yaml
  report/   promptfooconfig.yaml, assert-report.cjs,   tests/cases.yaml
```

### Schema validation: `is-json` vs. `validate-schema.cjs`

Dedupe and Report validate via promptfoo's built-in `is-json` + a schema file.
Gapfill and Feedback can't: their schemas reference a sibling file with a
relative `$ref` (`gapfill_output` / `feedback_output` both `$ref`
`hunt_task.schema.json`), and `is-json` loads one schema with no base to resolve
external file refs from. So those two suites validate **inside** the JS assertion
via `lib/validate-schema.cjs`, which registers the referenced schema under its
filename — the exact URI the relative `$ref` resolves to — so ajv links them. The
`schemas/*.json` files stay the single source of truth; nothing is duplicated.

The stage `.md` files stay the single source of truth — `stage-prompt.cjs` reads
them verbatim, so the eval exercises exactly what ships. (Helpers use the `.cjs`
extension because this package is `"type": "module"`; `.cjs` forces CommonJS.)

## Running

Run **from the repo root** (paths resolve relative to it). The API key lives in
`.env.development.local`, which promptfoo only auto-loads under
`NODE_ENV=development` — so pass it explicitly with `--env-file`:

```bash
bunx promptfoo@latest validate -c evals/dedupe/promptfooconfig.yaml
bunx promptfoo@latest eval -c evals/gapfill/promptfooconfig.yaml  --env-file .env.development.local -o /tmp/gapfill-eval.json  --no-cache --no-share
bunx promptfoo@latest eval -c evals/dedupe/promptfooconfig.yaml   --env-file .env.development.local -o /tmp/dedupe-eval.json   --no-cache --no-share
bunx promptfoo@latest eval -c evals/feedback/promptfooconfig.yaml --env-file .env.development.local -o /tmp/feedback-eval.json --no-cache --no-share
bunx promptfoo@latest eval -c evals/report/promptfooconfig.yaml   --env-file .env.development.local -o /tmp/report-eval.json   --no-cache --no-share
```

Inspect `results.stats`, then per-result `response.output`, `score`, and
`gradingResult.reason` in the JSON.

### Credentials / billing ⚠️

These suites use the `anthropic:messages` provider, which authenticates with
**`ANTHROPIC_API_KEY` (metered API billing)** — *not* the `CLAUDE_CODE_OAUTH_TOKEN`
subscription path the audit CLI itself uses. (`.env.example` deliberately warns
against setting `ANTHROPIC_API_KEY` for the agent.) Either:

- export `ANTHROPIC_API_KEY` only for the eval shell, **or**
- point promptfoo at a gateway via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
  (e.g. OpenRouter) to avoid first-party metered billing.

## What the suites assert

**Gapfill** (`prompts/04-gapfill.md`) — *pushes hunters toward the unexamined?*
- schema-valid against `schemas/gapfill_output.schema.json` (+ `hunt_task` `$ref`)
- **no reissue**: never re-emits a `(subsystem, attack_class)` tuple already in
  `completed_tasks`
- respects `max_new_tasks`; every task is `source: "gapfill"`, `task_id` `t_gf_*`,
  `priority` an integer 1–5
- **covers** the obvious gap: an untouched subsystem / a `gaps_observed` hint
  becomes a targeted task

**Dedupe** (`prompts/05-dedupe.md`) — *clusters strictly by root cause?*
- schema-valid against `schemas/dedupe_output.schema.json`
- **partition**: every input finding in exactly one group (no drops/dupes/inventions)
- same buggy helper, different call sites → **one** group
- structurally-identical bug, different functions → **separate** groups
- canonical id is a real member; PoC-proven member preferred

**Feedback** (`prompts/07-feedback.md`) — *hunts siblings, not the same bug?*
- schema-valid against `schemas/feedback_output.schema.json` (+ `hunt_task` `$ref`)
- **no retest**: never emits a task whose `attack_class` + a `target_file` match
  an input trace's already-proven bug
- respects `max_new_tasks`; every task is `source: "feedback"`, `task_id` `t_fb_*`,
  `priority` an integer 1–5; every task has a `rationale_per_task` entry
- *scope*: whether the proposed sibling `target_files` are real callsites needs a
  live repo → deferred to the agentic harness (this suite grades the contract)

**Report** (`prompts/08-report.md`) — *reachable-only, internally consistent?*
- schema-valid against `schemas/report.schema.json`
- ships **only** findings whose trace is `reachable: true`; drops the rest
- never invents finding ids
- `summary.total === findings.length`; `by_severity` sums to total
- admin-gated reachability downgrades severity one step (high → medium)

## Findings from the first run (2026-06-18, opus-4-8 + sonnet-4-6)

Every **behavioral** assertion passed on both suites from the start (clustering,
reachable-only inclusion, count consistency, admin-gated severity downgrade).
The failures were all **JSON-schema compliance**, and surfaced three real
prompt/schema bugs — now fixed; both suites are green (dedupe 8/8, report 6/6):

1. **`08-report.md` omitted a required field.** The schema requires `vuln_class`
   on every finding, but the prompt never instructed emitting it → both models
   dropped it → 100% fail. **Fixed:** the prompt now lists the carried-over
   required fields (`finding_id`, `vuln_class`, `file`, `line_start`,
   `line_end`, `description`) and pins exact key names.
2. **`05-dedupe.md` didn't pin the field name.** Models drifted to
   `root_cause_summary`; the schema requires `root_cause`
   (`additionalProperties: false`). Sonnet drifted on all 4 cases, Opus on 1.
   **Fixed:** the prompt now names the exact group keys.
3. **`report.schema.json` was inconsistent with `trace.schema.json`.** The
   report prompt copies `entry_points` from the trace, and an admin-gated trace
   carries `auth_required: true` — which the trace schema allows but the report
   schema forbade (`additionalProperties: false`). Any admin-gated finding
   would have failed in production. **Fixed:** `auth_required` added to the
   report schema's `entry_points` items.

These are exactly the actionable, deterministic results the suites exist to
produce — and they now stand as regression guards against this class of drift.

## Findings from the Gapfill + Feedback first run (opus-4-8 + sonnet-4-6)

The two new pure-reasoning suites repeated the pattern: every **behavioral**
check (no-reissue, cap, coverage, no-retest) held, and the failures were
**output-contract drift** — surfacing two more prompt bugs, now fixed; both
suites are green (gapfill 6/6, feedback 4/4):

1. **`04-gapfill.md` / `07-feedback.md` never pinned the output keys.** Opus
   emitted the task array under `tasks` (schema wants `new_tasks`); Sonnet
   renamed `coverage_analysis`'s arrays to `subsystems_under_covered` /
   `attack_classes_unattempted_per_subsystem`. Both models also **dropped the
   required `rationale`** field on each HuntTask. **Fixed:** both prompts now
   show the exact JSON skeleton with pinned key names and re-list every required
   HuntTask field — the same remediation applied to dedupe/report above.
2. **`07-feedback.md`'s no-retest rule was too loose.** It said only "skip tasks
   whose `target_files` are already covered," so Opus bundled the *proven* sink
   file into a broader "sweep" task alongside new siblings — re-testing the bug
   the stage exists to move past. **Fixed:** the prompt now forbids listing any
   proven `finding.file` in a new task's `target_files` at all.

A test-case bug also surfaced: feedback case 2 originally gave the model a
single-file recon summary, leaving it no sibling location to target without a
repo — so it could only point back at the proven file. Enriching the input with
plausible sibling subsystems (the realistic shape the stage sees in production)
fixed it. This is the inherent limit of grading feedback tool-lessly: the input
must *supply* the candidate locations the live grep would otherwise discover.

## Evaluating the agentic stages

The remaining seven stages — `01-recon`, `02-hunt`, `03-validate`, `06-trace`,
`09-fix`, `10-triage-intake`, `11-advise` — each need `Read`/`Grep`/`Glob`/`Bash`
against a real repo, so they can't be graded by the tool-less provider used here.

To grade them with real signal, the provider must give the model tools and a
target repo. Recommended path — a promptfoo **custom provider** (`exec` or a JS
provider) that invokes this project's Agent-SDK stage runner against a small
fixture repo with known planted bugs, then returns the stage's JSON. Assertions
then reuse the same schema + behavioral pattern (validate via
`lib/validate-schema.cjs` for any schema with cross-file `$ref`s), plus
stage-specific checks (e.g. hunt finds the planted sink; validate rejects a
planted false positive; trace marks a dead-code sink unreachable; triage-intake
declines an unreproducible report). That fixture + provider is the natural next
increment.
