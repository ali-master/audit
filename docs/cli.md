# CLI reference

Run via `bun run src/cli.ts <command>` (or `audit <command>` if you `bun link`
the package). Global flag: `-v, --verbose` for DEBUG logging.

```
audit [options] [command]

Commands:
  auth-check [options]   Verify Claude auth is configured correctly
  run [options]          Run the full 8-stage pipeline against a target repo
  status [options]       Show pipeline status: tasks, findings, traces, cost
  report [options]       Print (or generate) the final report
```

---

## `auth-check`

Verifies authentication and prints the selected mode (and anything scrubbed).

```bash
bun run src/cli.ts auth-check
```

| Flag | Description |
|------|-------------|
| `--allow-api-key` | Honor `ANTHROPIC_API_KEY` for metered billing (or set `AUDIT_ALLOW_API_KEY=1`) |

Exit code `2` if no usable auth is available. See [Authentication](authentication.md).

---

## `run`

Runs the full pipeline against a target repository.

```bash
bun run src/cli.ts run --repo /path/to/target --run-id my-run
```

| Flag | Description |
|------|-------------|
| `--repo <path>` | **Required.** Path to the target source repo |
| `--run-id <id>` | Run identifier (default: random `run_xxxxxxxx`) |
| `--resume` | Resume an existing run-id (re-queues interrupted/failed work) |
| `--max-cost-usd <usd>` | Abort cleanly if cumulative cost crosses this threshold |
| `--max-concurrency <n>` | Cap every stage's concurrency to this value |
| `--max-recon-tasks <n>` | Cap the number of initial Hunt tasks Recon may emit |
| `--target-url <url>` | Live deployment the agents can hit to confirm findings ([live target](live-target.md)) |
| `--target-creds <KEY=VALUE>` | Credentials for the live target (repeatable) |
| `--scope-notes <path>` | Text file with target-specific scope rules ([scope notes](scope-notes.md)) |
| `--config <path>` | Override `config/stages.yaml` |
| `--allow-api-key` | Honor `ANTHROPIC_API_KEY` for metered billing |

Exit codes: `0` success · `2` auth/usage error · `3` budget exceeded (resumable).

### Cost-contained example

```bash
bun run src/cli.ts run --repo /path/to/target \
  --max-concurrency 1 \
  --max-recon-tasks 15 \
  --max-cost-usd 30
```

---

## `status`

```bash
bun run src/cli.ts status            # table of all runs
bun run src/cli.ts status --run-id my-run   # detail for one run
```

Detail view shows task counts (total/pending/done/failed), finding counts
(raw/confirmed/canonical/reachable), and total cost.

---

## `report`

```bash
bun run src/cli.ts report --run-id my-run --format json   # default
bun run src/cli.ts report --run-id my-run --format md > report.md
```

| Flag | Description |
|------|-------------|
| `--run-id <id>` | **Required.** Which run to report on |
| `--format <fmt>` | `json` (default) or `md` |

Reads `results/<run-id>/report/report.json`. Exit `1` if no report exists yet.
