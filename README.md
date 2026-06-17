<div align="center">
  <img src="assets/logo.svg" alt="@usex/audit" width="128" height="128" />
  <h1>audit</h1>
  <p><strong>An 8-stage AI vulnerability-discovery agent.</strong><br/>
  Many narrow agents · deliberate disagreement · reachability as the gate.</p>

  <p>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-7C3AED.svg"></a>
    <img alt="Runtime: Bun" src="https://img.shields.io/badge/runtime-Bun-06B6D4.svg">
    <img alt="Language: TypeScript" src="https://img.shields.io/badge/TypeScript-strict-6366F1.svg">
    <img alt="Claude Agent SDK" src="https://img.shields.io/badge/Claude-Agent%20SDK-1F2937.svg">
    <a href="docs/"><img alt="Docs" src="https://img.shields.io/badge/docs-reference-7C3AED.svg"></a>
  </p>
</div>

---

`audit` finds real vulnerabilities in a codebase by running **many narrow agents
in parallel** instead of one big "find bugs here" prompt. Each hunter looks for
exactly one attack class; a **different model** then tries to *disprove* every
finding; and the stage that decides what ships asks the only question that
matters — **can an attacker actually reach this sink from outside?**

It runs on **[Bun](https://bun.sh) + TypeScript**, is billed to your **Claude
Pro / Max subscription** through the official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (no API
key needed), and validates every agent output against a JSON Schema.

## Why it's different

- 🎯 **Narrow agents, not one mega-prompt** — one attack class per task, with the
  trust boundary spelled out. This is what actually surfaces bugs.
- 🥊 **Deliberate disagreement** — Validate runs on a *different model* than Hunt
  and is paid in *rejections*. It filters the noise that single-pass tools ship.
- 🔓 **Reachability is the gate** — a "buggy" sink that no attacker input can reach
  is dropped. Only confirmed **and** reachable findings make the report.
- 🔁 **It learns** — a proven-reachable bug seeds new hunts for the same pattern
  elsewhere in the repo.
- 🧾 **Schema-validated, resumable, budgeted** — every output is shape-checked,
  every run is checkpointed in SQLite, and a cost ceiling aborts cleanly.

## The pipeline

```
Recon → Hunt → Validate → Gapfill ↺ → Dedupe → Trace → Feedback ↺ → Report
```

| # | Stage | Model | Does |
|---|-------|-------|------|
| 1 | **Recon** | Opus | Maps the repo + git history, emits narrowly-scoped Hunt tasks |
| 2 | **Hunt** | Sonnet | One attack class per agent; compiles/runs PoCs |
| 3 | **Validate** | Opus | Adversarial re-read — tries to **disprove** (different model) |
| 4 | **Gapfill** | Sonnet | Re-queues under-covered `subsystem × attack class` cells |
| 5 | **Dedupe** | Sonnet | Clusters findings by root cause |
| 6 | **Trace** | Opus | Proves attacker input reaches the sink (the gate) |
| 7 | **Feedback** | Sonnet | Turns reachable traces into new hunts for siblings |
| 8 | **Report** | Sonnet | Schema-validated structured report |

Full details in **[docs/stages.md](docs/stages.md)**.

## Quickstart

```bash
# 1. Install globally — requires Bun ≥ 1.3 (https://bun.sh)
bun add -g @usex/audit

# 2. Auth — already logged in via `claude login`? You're done.
#    Or, for CI / headless:
claude setup-token && echo "CLAUDE_CODE_OAUTH_TOKEN=<paste>" > .env

# 3. Verify
audit auth-check

# 4. Run — `cd` into the repo you want to audit; results/state.db land there
cd /path/to/target
audit run --run-id my-run
audit status --run-id my-run
audit report --run-id my-run --format md > report.md
```

> The global install exposes an `audit` binary on your `PATH`. It runs under the
> Bun runtime (the bundled CLI uses `bun:sqlite`), so Bun must be installed even
> when invoked via npm.
>
> **Where state lives:** scan artifacts (`results/`, `work/`, `state.db`) are
> written to the current working directory — the repo you're auditing — not the
> install location. Set `AUDIT_DATA_DIR=/some/path` to redirect them.

### From source (development)

```bash
bun install
bun run src/cli.ts auth-check          # run directly from source
bun link                               # or expose the `audit` binary locally
```

### Keep it cheap

A real codebase yields 15–50 Hunt tasks; the loops *expand* coverage. Rein it in:

```bash
bun run src/cli.ts run --repo /path/to/target \
  --max-concurrency 1 \      # one agent at a time
  --max-recon-tasks 15 \     # smaller initial fan-out
  --max-cost-usd 30          # hard ceiling, resumable with --resume
```

## Example

Pointed at a small Flask app with two planted bugs, `audit` reported **seven**
confirmed + reachable findings — including a chain the planted bugs didn't
spell out:

```
total: 7  —  critical: 3, high: 2, medium: 2

• critical  command_injection      Unauthenticated OS command injection in GET /ping via `host` (shell=True)
• critical  logic_chain            Zero-credential SQLi→RCE: /lookup exfiltration pivots to /ping execution
• critical  broken_access_control  Missing auth on GET /ping exposes command execution to anonymous callers
• high      sql_injection          Unauthenticated SQL injection in GET /lookup via `name`
• high      ssrf                    Unauthenticated SSRF via /ping `host` enables internal host enumeration
• medium    information_disclosure  Werkzeug debug console discloses source + secrets when FLASK_DEBUG=1
• medium    resource_exhaustion     Unbounded subprocess in /ping enables WSGI worker exhaustion
```

The adversarial Validate stage also *rejected* several lower-confidence findings
before they reached the report — that's the point.

## On every pull request

Scan only what the branch changed, suppress findings you've already accepted,
and fail the build only on **new** issues at or above a severity:

```bash
# Once, on the default branch — accept the current findings as the baseline:
audit run --run-id main && audit baseline --run-id main --out .audit-baseline.json

# On every PR — diff-scoped scan, new-only gate, SARIF for the Security tab:
audit run --base main --baseline .audit-baseline.json --fail-on high
audit report --run-id <id> --format sarif --out audit.sarif
```

`--base`/`--since` feed **Recon** only the changed files plus their blast radius
(callers/callees/importers), so a PR scan costs cents. Findings are matched by a
line-shift-robust fingerprint; the exit code is `4` when the gate trips. The
SARIF output carries the reachability trace as `codeFlows` — reviewers see the
entry-point→sink path, not just the sink. See the [CLI reference](docs/cli.md).

## Features

- ✅ Subscription billing by default — `ANTHROPIC_API_KEY` is scrubbed so it can't
  silently route to metered billing ([auth docs](docs/authentication.md)).
- ✅ Bring your own model / gateway — OpenRouter and any Anthropic-compatible
  proxy, or opt into a metered API key.
- ✅ **Live-target mode** — reproduce findings against a running deployment with
  real HTTP ([docs](docs/live-target.md)).
- ✅ **Scope notes** — exclude intentional-by-design surfaces ([docs](docs/scope-notes.md)).
- ✅ **Diff / PR mode** — `--base`/`--since` scope the scan to changed files + blast radius.
- ✅ **Baseline & delta** — fingerprint findings, suppress known ones, surface NEW/FIXED.
- ✅ **SARIF + exit-code gating** — `--format sarif` and `--fail-on high` for CI / the GitHub Security tab.
- ✅ **Auto-fix (opt-in)** — `audit fix` writes a minimal patch + regression test per reachable finding in an isolated worktree; `--open-pr` opens a draft PR (never auto-merges).
- ✅ **Code-grounded fix guidance** — `audit advise` (and a "Generate fix" button in the viewer) reads the real sink and explains the fix for *your* code; the report surfaces it inline.
- ✅ **Triage viewer** — `audit report --serve` is a local web UI to confirm / dismiss findings and export suppressions to a baseline.
- ✅ **Cost observability** — `audit stats` breaks spend down by stage/model and reports cost-per-finding.
- ✅ **Bug-bounty / VDP triage** — `audit triage --report` reproduces an inbound submission, then runs it through the adversarial reviewer + reachability gate and dedupes it, emitting an accept/reject/duplicate verdict.
- ✅ Git-history mining — seeds hunts against unpatched siblings of past fixes.
- ✅ Resumable runs, per-stage concurrency, and a hard cost ceiling.
- ✅ **Background runs** — `audit run -d` detaches the pipeline; `audit sessions` lists what's active and whether it's still alive.

## Documentation

| Doc | |
|-----|---|
| [Architecture](docs/architecture.md) | Pipeline graph, data flow, loops |
| [Stages](docs/stages.md) | All 8 stages in detail |
| [CLI reference](docs/cli.md) | Every command and flag |
| [Configuration](docs/configuration.md) | `stages.yaml`, env vars, loop counts |
| [Authentication](docs/authentication.md) | Subscription, gateways, API key |
| [Live-target](docs/live-target.md) · [Scope notes](docs/scope-notes.md) | Opt-in modes |
| [State & artifacts](docs/state-and-artifacts.md) | SQLite, JSONL, resume |
| [Programmatic API](docs/programmatic-api.md) | Use it as a library |
| [Troubleshooting](docs/troubleshooting.md) | Quota, schema failures, cost |

## Development

```bash
bun test            # unit tests (offline)
bun run test:types  # tsc --noEmit
bun run build       # bundle to dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Safety

Hunt agents have Bash and run inside per-task scratch dirs — they are **not**
OS-sandboxed. Run the audit inside a disposable VM or container when you don't
trust the target source; a malicious build script could otherwise execute on
your host during PoC compilation. The agent reads everything under the target
(including any `.env` / secrets), and outputs in `results/<run-id>/` are
gitignored but **not** scrubbed of those reads. Only point `--target-url` at
systems you're authorized to test.

## License

[MIT](LICENSE). Reuse freely. No warranty.

## Acknowledgements

The pipeline design is from Cloudflare's
[Project Glasswing](https://blog.cloudflare.com/cyber-frontier-models/). Built on
the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

---

<div align="center">

Made with ❤️ by [Ali Torki](https://github.com/ali-master)

</div>
