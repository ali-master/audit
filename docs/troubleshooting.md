# Troubleshooting

## `auth error: No auth available`

No usable auth path. Pick one:

- `claude login` (interactive), or
- `claude setup-token` → put `CLAUDE_CODE_OAUTH_TOKEN=…` in `.env`, or
- a gateway (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), or
- `ANTHROPIC_API_KEY` + `--allow-api-key`.

Run `audit auth-check` to see what's detected and what was scrubbed. See
[Authentication](authentication.md).

## "ANTHROPIC_API_KEY was set but ignored"

By design — the key is scrubbed so subscription auth wins (it would otherwise
outrank OAuth and route to metered billing). Re-run with `--allow-api-key` (or
`AUDIT_ALLOW_API_KEY=1`) if you actually want metered billing.

## A stage fails schema validation after repair attempts

The model produced output that doesn't match the stage's schema. Look at
`results/<run-id>/<stage>/<id>.jsonl` — the `schema_errors` and `final_payload`
lines show exactly what was emitted and which fields were wrong.

- For most stages this degrades gracefully (e.g. Validate → `needs_more_info`,
  Trace → unreachable, Dedupe → one-group-per-finding).
- **Recon** is the exception: if it can't validate, the run aborts (nothing
  downstream works without it). Re-run, or bump `recon.repair_attempts` in
  `config/stages.yaml`. If the model keeps adding a field, that field may need
  to be allowed in `schemas/` — see [Stages](stages.md).

## The run aborted with "budget exhausted"

You hit `--max-cost-usd`. The run is left resumable:

```bash
bun run src/cli.ts run --repo … --run-id <same-id> --resume --max-cost-usd <higher>
```

## "subscription quota exhausted"

Your Claude session/usage limit was hit. The in-flight task is left `pending`,
the run is marked `aborted`, and it's fully resumable once your quota resets:

```bash
bun run src/cli.ts run --repo … --run-id <same-id> --resume
```

## It's taking a long time / costing a lot

A real codebase can yield 15–50 Hunt tasks and 25+ findings, and the Gapfill /
Feedback loops *expand* coverage. Rein it in:

```bash
--max-concurrency 1     # one agent at a time
--max-recon-tasks 15    # smaller initial fan-out
--max-cost-usd 30       # hard ceiling
```

To skip the expansion loops entirely, pass a `--config` whose `loops:` sets
`gapfill_iterations: 0` and `feedback_iterations: 0`. See
[Configuration](configuration.md).

## "Cannot find module 'bun:sqlite'" / `Bun is not defined`

You're running under Node. This is a **Bun** application — use
`bun run src/cli.ts …` (or `bun test`, `bun run build`), not `node`.

## Transient API errors (529 / overloaded / 5xx)

The runner retries these automatically with exponential backoff before giving
up. If a whole stage fails after retries, it's logged and (for per-item stages)
that item is skipped; re-run with `--resume` to retry skipped work.

## Empty report

`results/<run-id>/report/report.json` with `total: 0` means nothing survived the
gate — no finding was both confirmed *and* reachable. That's a valid outcome
(the tool is conservative by design), not an error. Check `audit status
--run-id <id>` to see where findings dropped (raw → confirmed → canonical →
reachable).
