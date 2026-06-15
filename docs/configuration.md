# Configuration

## `config/stages.yaml`

Per-stage settings. Override the file with `--config <path>`.

```yaml
defaults:
  max_turns: 25
  permission_mode: acceptEdits   # never bypassPermissions
  repair_attempts: 1             # re-emit chances on schema-validation failure

stages:
  recon:
    model: claude-opus-4-7
    concurrency: 1
    tools: [Read, Grep, Glob, Bash]
    max_turns: 60
    repair_attempts: 2
  hunt:
    model: claude-sonnet-4-6
    concurrency: 50
    tools: [Read, Grep, Glob, Bash]
  validate:
    model: claude-opus-4-7        # different from hunt — deliberate disagreement
    concurrency: 10
    tools: [Read, Grep, Glob]     # no Bash: pure analysis
  # … gapfill, dedupe, trace, feedback, report …

loops:
  gapfill_iterations: 2     # max Hunt → Validate → Gapfill cycles
  feedback_iterations: 1    # feedback passes after Trace
```

### Per-stage fields

| Field | Meaning |
|-------|---------|
| `model` | Model name (e.g. `claude-opus-4-7`). With a gateway, slash forms like `anthropic/claude-opus-4-7` work |
| `concurrency` | Max simultaneous agents for that stage (capped by `--max-concurrency`) |
| `tools` | Allowed tool names for the stage's agents |
| `max_turns` | Max agentic tool-use rounds per agent (falls back to `defaults`) |
| `permission_mode` | SDK permission mode (`acceptEdits` by default; never `bypassPermissions`) |
| `repair_attempts` | How many times the runner asks the model to fix schema-invalid output |

### Rules worth knowing

- **Hunt and Validate must use different models.** This is the load-bearing
  "deliberate disagreement" rule and is enforced by a test.
- **Trace runs on the strongest model** — it's the reachability gate.
- Lowering `concurrency` (or `--max-concurrency 1`) is the simplest cost lever.

## Loop counts

| Key | Effect |
|-----|--------|
| `gapfill_iterations` | The Hunt → Validate → Gapfill loop runs up to this many **extra** times (so `2` ⇒ up to 3 Hunt passes). Set `0` to disable Gapfill. |
| `feedback_iterations` | The Feedback → Hunt → Validate → Dedupe → Trace loop runs up to this many times. Set `0` to disable Feedback. |

Both loops also break early when they stop producing new work.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Headless subscription token (`claude setup-token`) |
| `ANTHROPIC_BASE_URL` | Gateway base URL (e.g. OpenRouter) — triggers gateway mode with a token |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token for a gateway |
| `ANTHROPIC_API_KEY` | Metered Anthropic key (only honored with `--allow-api-key`) |
| `ANTHROPIC_MODEL` | Forces every stage onto one model (useful with gateways) |
| `AUDIT_ALLOW_API_KEY` | `1` to opt into API-key billing without the flag |

`.env` is loaded automatically. See [Authentication](authentication.md) for how
these interact and what gets scrubbed.
