# CLI reference

Installed globally (`bun add -g @usex/audit`), the CLI is the `audit` binary on
your `PATH`. Invoke it as `audit <command>`. Global flag: `-v, --verbose` for
DEBUG logging.

```
audit [options] [command]

Commands:
  auth-check [options]   Verify Claude auth is configured correctly
  run [options]          Run the full 8-stage pipeline against a target repo
  status [options]       Show pipeline status: tasks, findings, traces, cost
  report [options]       Print (or generate) the final report
```

> **Running from source instead?** Swap `audit` for `bun run src/cli.ts` in any
> command below (e.g. `bun run src/cli.ts auth-check`), or `bun link` once to
> expose the `audit` binary locally. See [Development](#from-source-development).

> **Output:** stages stream live on a single self-updating line (spinner +
> current activity + progress) in an interactive terminal, then commit to a
> one-line summary. Informational output goes to **stdout**; only warnings and
> errors go to **stderr**. In a non-interactive shell (CI, pipes) the live line
> degrades to plain one-shot lines.

---

## `auth-check`

Verifies authentication and prints the selected mode (and anything scrubbed).

```bash
audit auth-check
```

| Flag | Description |
|------|-------------|
| `--allow-api-key` | Honor `ANTHROPIC_API_KEY` for metered billing (or set `AUDIT_ALLOW_API_KEY=1`) |

Exit code `2` if no usable auth is available. See [Authentication](authentication.md).

---

## `run`

Runs the full pipeline against a target repository. With no `--repo`, it audits
the **current working directory** — so the common flow is to `cd` into the repo
first.

```bash
cd /path/to/target
audit run --run-id my-run
```

| Flag | Description |
|------|-------------|
| `--repo <path>` | Path to the target source repo (default: current working directory) |
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

> **Where state lands:** `results/`, `work/`, and `state.db` are written to the
> current working directory (the repo you're auditing), not the install
> location. Redirect with `AUDIT_DATA_DIR=/some/path`. See
> [State & artifacts](state-and-artifacts.md).

### Cost-contained example

```bash
audit run \
  --max-concurrency 1 \
  --max-recon-tasks 15 \
  --max-cost-usd 30
```

### Auditing a repo without `cd`-ing into it

```bash
audit run --repo /path/to/target --run-id my-run
```

---

## `status`

```bash
audit status                    # table of all runs
audit status --run-id my-run    # detail for one run
```

Detail view shows task counts (total/pending/done/failed), finding counts
(raw/confirmed/canonical/reachable), and total cost.

---

## `report`

```bash
audit report --run-id my-run --format json   # default
audit report --run-id my-run --format md > report.md
```

| Flag | Description |
|------|-------------|
| `--run-id <id>` | **Required.** Which run to report on |
| `--format <fmt>` | `json` (default) or `md` |

Reads `results/<run-id>/report/report.json`. Exit `1` if no report exists yet.

---

## From source (development)

When working in a clone instead of a global install, run the CLI through Bun:

```bash
bun install
bun run src/cli.ts auth-check     # run directly from source
bun link                          # or expose the `audit` binary locally
```

Every `audit <command>` above maps to `bun run src/cli.ts <command>`.
