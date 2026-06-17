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
  report [options]       Print, convert, gate, or triage (--serve) the report
  baseline [options]     Generate a baseline file from a run's report
  fix [options]          Stage 9 (opt-in): patch confirmed + reachable findings
  stats [options]        Cost & token breakdown by stage/model, cost-per-finding
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
| `--base <ref>` | **PR mode** — scan only what this branch changed vs the merge-base with `<ref>` (git `<ref>...HEAD`) |
| `--since <ref>` | **Incremental** — scan only files changed between `<ref>` and HEAD (git `<ref>..HEAD`) |
| `--baseline <path>` | Suppress findings already in this baseline; print the NEW/FIXED/STILL-PRESENT delta and gate on NEW only |
| `--fail-on <severity>` | Exit `4` if any (new) finding is `informational\|low\|medium\|high\|critical` or above |
| `--max-cost-usd <usd>` | Abort cleanly if cumulative cost crosses this threshold |
| `--max-concurrency <n>` | Cap every stage's concurrency to this value |
| `--max-recon-tasks <n>` | Cap the number of initial Hunt tasks Recon may emit |
| `--target-url <url>` | Live deployment the agents can hit to confirm findings ([live target](live-target.md)) |
| `--target-creds <KEY=VALUE>` | Credentials for the live target (repeatable) |
| `--scope-notes <path>` | Text file with target-specific scope rules ([scope notes](scope-notes.md)) |
| `--config <path>` | Override `config/stages.yaml` |
| `--allow-api-key` | Honor `ANTHROPIC_API_KEY` for metered billing |

Exit codes: `0` success · `2` auth/usage error · `3` budget exceeded (resumable)
· `4` `--fail-on` gate tripped (clean scan, but a finding crossed the threshold).

### Diff / PR mode

`--base` and `--since` (mutually exclusive) constrain **Recon** to the changed
files plus their immediate blast radius (callers, callees, importers) instead of
the whole repo — a PR scan costs cents instead of dollars. They require a git
repo. An empty diff yields an empty report (nothing new to hunt).

```bash
# On a PR branch: scan only what the branch introduced vs main.
audit run --base main --fail-on high
```

### Baseline gating (only fail on *new* findings)

```bash
# 1) Accept the current findings as the baseline (once, on the default branch):
audit run --run-id main-scan
audit baseline --run-id main-scan --out .audit-baseline.json

# 2) On every PR, suppress known findings and fail only on NEW ones:
audit run --base main --baseline .audit-baseline.json --fail-on high
```

Findings are matched by a stable fingerprint — `vuln_class` + repo-relative path
+ a hash of the sink's evidence snippet — so they survive line shifts and
reformatting. The run prints `N new, M still-present, K fixed`.

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
audit report --run-id my-run --format json              # default
audit report --run-id my-run --format md > report.md
audit report --run-id my-run --format sarif --out audit.sarif
audit report --run-id my-run --baseline .audit-baseline.json --fail-on high
```

| Flag | Description |
|------|-------------|
| `--run-id <id>` | **Required.** Which run to report on |
| `--format <fmt>` | `json` (default), `md`, or `sarif` |
| `--baseline <path>` | Suppress findings in this baseline; show NEW/FIXED/STILL-PRESENT |
| `--fail-on <severity>` | Exit `4` if any (shown) finding is at or above this severity |
| `--out <path>` | Write the rendered report to a file instead of stdout |
| `--serve` | Open the interactive triage viewer (local web UI) instead of printing |
| `--port <n>` | Port for `--serve` (default `7878`) |

Reads `results/<run-id>/report/report.json`. Exit `1` if no report exists yet,
`4` if `--fail-on` trips. When the rendered payload streams to stdout
(`json`/`sarif` with no `--out`), diagnostics go to **stderr** so the artifact
stays pipe-clean.

**SARIF** (`--format sarif`) emits SARIF 2.1.0 for the GitHub Advanced Security
"Security" tab, GitLab SAST, and other triage tooling. Because audit produces a
reachability trace, each result carries a `codeFlows` entry built from the Trace
stage's `call_chain` — reviewers see the entry-point→sink path, not just the
sink — plus a `partialFingerprints` value so GitHub dedupes across line shifts.

### Triage viewer (`--serve`)

```bash
audit report --run-id my-run --serve              # → http://127.0.0.1:7878
audit report --run-id my-run --serve --port 9000
```

A local, zero-build web UI reading straight from SQLite. Filter by severity /
reachability / status, inspect the call chain, and mark each finding
**confirm / false-positive / won't-fix** — verdicts persist to the `triage`
table. "Export baseline (suppressed)" downloads a baseline of everything you
marked false-positive or won't-fix, so those stop alerting on the next run.
Binds to `127.0.0.1` only; Ctrl-C to stop.

---

## `baseline`

Snapshots a run's findings into a baseline file you commit to the repo. Future
runs/reports compare against it so only *new* findings surface.

```bash
audit baseline --run-id my-run                          # → .audit-baseline.json
audit baseline --run-id my-run --out security/base.json
```

| Flag | Description |
|------|-------------|
| `--run-id <id>` | **Required.** Run whose report seeds the baseline |
| `--out <path>` | Where to write the baseline (default `.audit-baseline.json`) |

---

## `fix` (Stage 9, opt-in)

Generates a **minimal patch + regression test** for each confirmed *and
reachable* finding. The reachability gate is what makes this trustworthy — only
bugs proven exploitable get patched. Each fix is produced by an agent editing
inside a throwaway **git worktree** at HEAD, so your working tree is never
touched; the patch is captured with `git diff` and saved to
`results/<run-id>/fix/`. Requires a git repo and auth.

```bash
audit fix --run-id my-run                       # generate patches only (review them)
audit fix --run-id my-run --apply               # + apply to branch audit/fix-<run-id>
audit fix --run-id my-run --open-pr             # + push and open a DRAFT PR via gh
```

| Flag | Description |
|------|-------------|
| `--run-id <id>` | **Required.** Run whose reachable findings to patch |
| `--repo <path>` | Target repo (default: current directory) |
| `--apply` | Apply patches to a new branch (requires a clean working tree) |
| `--open-pr` | Apply, push, and open a **draft** PR via `gh`. Implies `--apply` |
| `--branch <name>` | Branch for `--apply`/`--open-pr` (default `audit/fix-<run-id>`) |
| `--config <path>` | Override `config/stages.yaml` |
| `--allow-api-key` | Honor `ANTHROPIC_API_KEY` for metered billing |

**Human-in-the-loop by design:** patches are never auto-applied without
`--apply`, `--open-pr` opens a **draft** PR and never merges, and `--apply`
refuses to run on a dirty working tree. Review every hunk.

---

## `stats`

Where the budget actually went — per-stage and per-model spend, token usage,
prompt-cache hit ratio, and cost-per-confirmed / cost-per-reachable finding.
Use it to tune `config/stages.yaml` concurrency and model choices with data.

```bash
audit stats --run-id my-run
audit stats --run-id my-run --json     # machine-readable
```

| Flag | Description |
|------|-------------|
| `--run-id <id>` | **Required.** Which run to break down |
| `--config <path>` | Override `config/stages.yaml` (for the stage→model mapping) |
| `--json` | Emit the raw stats object as JSON |

---

## From source (development)

When working in a clone instead of a global install, run the CLI through Bun:

```bash
bun install
bun run src/cli.ts auth-check     # run directly from source
bun link                          # or expose the `audit` binary locally
```

Every `audit <command>` above maps to `bun run src/cli.ts <command>`.
