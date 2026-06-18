# Prompt evals (`promptfoo`)

Promptfoo suites for the audit pipeline's stage prompts in [`../prompts/`](../prompts).

## What is and isn't covered here

The 11 stage prompts split into two kinds:

| Kind | Stages | Eval approach |
| --- | --- | --- |
| **Pure-reasoning** (input is structured JSON; no repo access needed) | `05-dedupe`, `08-report` | ✅ Covered here — deterministic + schema assertions. |
| **Agentic** (need `Read`/`Grep`/`Glob`/`Bash` against a live repo) | `01-recon`, `02-hunt`, `03-validate`, `04-gapfill`, `06-trace`, `07-feedback`, `09-fix`, `10-triage-intake`, `11-advise` | ⏳ Not via the plain provider — see [below](#evaluating-the-agentic-stages). |

A plain `anthropic:messages` provider gives the model **no tools**. Grading recon
or hunt that way would only grade *hallucinated* file reads — a green check that
means nothing. Dedupe and Report, by contrast, are near-pure functions of their
JSON input, so they give real signal today.

## Layout

```
evals/
  lib/
    stage-prompt.cjs    # loads prompts/<stage>.md as system + test `input` as user
    extract-json.cjs    # output transform: isolate JSON before asserting
  dedupe/   promptfooconfig.yaml, assert-dedupe.cjs, tests/cases.yaml
  report/   promptfooconfig.yaml, assert-report.cjs, tests/cases.yaml
```

The stage `.md` files stay the single source of truth — `stage-prompt.cjs` reads
them verbatim, so the eval exercises exactly what ships. (Helpers use the `.cjs`
extension because this package is `"type": "module"`; `.cjs` forces CommonJS.)

## Running

Run **from the repo root** (paths resolve relative to it):

```bash
npx promptfoo@latest validate config -c evals/dedupe/promptfooconfig.yaml
npx promptfoo@latest eval -c evals/dedupe/promptfooconfig.yaml -o /tmp/dedupe-eval.json --no-cache --no-share
npx promptfoo@latest eval -c evals/report/promptfooconfig.yaml -o /tmp/report-eval.json --no-cache --no-share
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

**Dedupe** (`prompts/05-dedupe.md`) — *clusters strictly by root cause?*
- schema-valid against `schemas/dedupe_output.schema.json`
- **partition**: every input finding in exactly one group (no drops/dupes/inventions)
- same buggy helper, different call sites → **one** group
- structurally-identical bug, different functions → **separate** groups
- canonical id is a real member; PoC-proven member preferred

**Report** (`prompts/08-report.md`) — *reachable-only, internally consistent?*
- schema-valid against `schemas/report.schema.json`
- ships **only** findings whose trace is `reachable: true`; drops the rest
- never invents finding ids
- `summary.total === findings.length`; `by_severity` sums to total
- admin-gated reachability downgrades severity one step (high → medium)

## Evaluating the agentic stages

To grade recon/hunt/trace/etc. with real signal, the provider must give the model
tools and a target repo. Recommended path — a promptfoo **custom provider** (`exec`
or a JS provider) that invokes this project's Agent-SDK stage runner against a small
fixture repo with known planted bugs, then returns the stage's JSON. Assertions
then reuse the same `is-json` + `schemas/*.json` pattern, plus stage-specific
behavioral checks (e.g. hunt finds the planted sink; validate rejects a planted
false positive; trace marks a dead-code sink unreachable). That fixture + provider
is the natural next increment.
