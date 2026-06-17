#!/usr/bin/env bun
/**
 * CLI: auth-check, run, status, report. Built on Commander —
 * runs under Bun (uses bun:sqlite and other Bun-native APIs).
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { configureAuth, AuthError } from "./auth";
import { parseBaseline, buildBaseline, applyBaseline } from "./baseline";
import type { Delta } from "./baseline";
import { loadConfig } from "./config";
import { isGitRepo, changedFiles } from "./diff";
import { setVerbose, log } from "./logger";
import { runPipeline, CostExceeded } from "./orchestrator";
import { RESULTS, DB_PATH } from "./paths";
import { toSarif } from "./sarif";
import { StageContext, runFix } from "./stages";
import {  computeStats } from "./stats";
import type {Stats} from "./stats";
import { StateDB } from "./state";
import { serveViewer } from "./viewer";
import updateNotifier from "update-notifier";
import pkg from "../package.json";

type Json = any;

// Exit codes: 2 = usage error, 3 = cost-budget abort, 4 = --fail-on gate
// tripped (clean scan, but findings crossed the severity threshold).
const EXIT_GATE = 4;

// Highest (index 4) to lowest (index 0). Used for --fail-on thresholds.
const SEVERITIES = [
  "informational",
  "low",
  "medium",
  "high",
  "critical",
] as const;

function severityRank(sev: string): number {
  const i = SEVERITIES.indexOf(sev as (typeof SEVERITIES)[number]);
  return i < 0 ? 0 : i;
}

/** Load a run's final report.json, or exit(1) if it is missing. */
function loadReportOrExit(runId: string): Json {
  const reportPath = join(RESULTS, runId, "report", "report.json");
  if (!existsSync(reportPath)) {
    log.error(`no report at ${reportPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

function printDelta(delta: Delta): void {
  log.info(
    `baseline delta: ${delta.new_count} new, ${delta.still_present_count} still-present, ` +
      `${delta.fixed_count} fixed (baseline had ${delta.baseline_total})`,
  );
}

/**
 * Exit non-zero when the report contains a finding at or above `failOn`.
 * Returns normally (no exit) when the gate passes or is disabled. `quiet`
 * suppresses the success line so it cannot contaminate a machine-readable
 * report streamed to stdout (failures always log to stderr before exiting).
 */
function applyGate(
  report: Json,
  failOn: string | undefined,
  opts: { quiet?: boolean } = {},
): void {
  if (!failOn) return;
  const threshold = severityRank(failOn);
  const tripping = (report.findings ?? []).filter(
    (f: Json) => severityRank(f.severity) >= threshold,
  );
  if (tripping.length > 0) {
    log.error(
      `gate: ${tripping.length} finding(s) at or above "${failOn}" — failing (exit ${EXIT_GATE})`,
    );
    process.exit(EXIT_GATE);
  }
  if (!opts.quiet) log.success(`gate: no findings at or above "${failOn}"`);
}

function validateFailOn(failOn: string | undefined): void {
  if (failOn && !SEVERITIES.includes(failOn as (typeof SEVERITIES)[number])) {
    log.error(
      `invalid --fail-on ${JSON.stringify(failOn)}; use one of ${SEVERITIES.join(", ")}`,
    );
    process.exit(2);
  }
}

function allowApiKeyFromEnvOrFlag(flag: boolean): boolean {
  if (flag) return true;
  const v = (process.env.AUDIT_ALLOW_API_KEY ?? "").trim();
  return v !== "" && v !== "0" && v !== "false" && v !== "False";
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

const program = new Command();

program
  .name("audit")
  .description(
    "audit — Cloudflare-style 8-stage vulnerability discovery agent.",
  )
  .option("-v, --verbose", "DEBUG logging.")
  .hook("preAction", (thisCommand) => {
    setVerbose(Boolean(thisCommand.opts().verbose));
  });

// ---------------- auth-check ----------------

program
  .command("auth-check")
  .description("Verify Claude Code auth is configured correctly.")
  .option(
    "--allow-api-key",
    "Honor ANTHROPIC_API_KEY for metered Anthropic billing (also via AUDIT_ALLOW_API_KEY=1).",
  )
  .action((opts) => {
    const allow = allowApiKeyFromEnvOrFlag(Boolean(opts.allowApiKey));
    let status;
    try {
      status = configureAuth({ allowApiKey: allow });
    } catch (e) {
      if (e instanceof AuthError) {
        log.error(`auth error: ${e.message}`);
        process.exit(2);
      }
      throw e;
    }
    const ok = chalk.green("OK");
    switch (status.authMode) {
      case "oauth_token":
        log.print(`${ok} using CLAUDE_CODE_OAUTH_TOKEN`);
        break;
      case "api_key":
        log.print(`${ok} using ANTHROPIC_API_KEY (metered Anthropic API billing)`);
        break;
      case "keychain_login":
        log.print(`${ok} using stored login from ${status.credentialsFile}`);
        break;
      case "macos_keychain_login":
        log.print(`${ok} using macOS Keychain-backed Claude Code login`);
        break;
      case "gateway":
        log.print(
          `${ok} using LLM gateway at ${status.gatewayBaseUrl} (ANTHROPIC_AUTH_TOKEN)`,
        );
        if (status.gatewayModel)
          log.print(`          ANTHROPIC_MODEL=${status.gatewayModel}`);
        break;
    }
    if (status.apiKeyScrubbed)
      log.print(
        `${chalk.yellow("scrubbed")} ANTHROPIC_API_KEY removed from env (it would have outranked the active auth mode)`,
      );
    if (status.authTokenScrubbed)
      log.print(
        `${chalk.yellow("scrubbed")} ANTHROPIC_AUTH_TOKEN removed from env (no gateway base URL set — leaving it would outrank subscription)`,
      );
    log.print(
      `claude CLI: ${status.claudeCliPath ?? "(bundled by SDK)"} (${status.claudeCliVersion ?? "n/a"})`,
    );
  });

// ---------------- run ----------------

function collect(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}

program
  .command("run")
  .description("Run the full 8-stage pipeline against a target repo.")
  .option(
    "--repo <path>",
    "Path to the target source-code repo (default: current directory).",
    process.cwd(),
  )
  .option("--run-id <id>", "Run identifier (default: random).")
  .option("--resume", "Resume an existing run-id.")
  .option(
    "--base <ref>",
    "PR mode: scan only what this branch changed vs the merge-base with <ref> (git <ref>...HEAD).",
  )
  .option(
    "--since <ref>",
    "Incremental: scan only files changed between <ref> and HEAD (git <ref>..HEAD).",
  )
  .option(
    "--baseline <path>",
    "Suppress findings already present in this baseline file; report NEW/FIXED/STILL-PRESENT.",
  )
  .option(
    "--fail-on <severity>",
    `Exit ${EXIT_GATE} if any (new) finding is at or above this severity: ${SEVERITIES.join(" | ")}.`,
  )
  .option(
    "--max-cost-usd <usd>",
    "Abort if cumulative cost crosses this threshold.",
    Number.parseFloat,
  )
  .option(
    "--max-concurrency <n>",
    "Cap every stage's concurrency to this.",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--max-recon-tasks <n>",
    "Cap the number of initial Hunt tasks Recon may emit.",
    (v) => Number.parseInt(v, 10),
  )
  .option(
    "--target-url <url>",
    "URL of a live deployment the agents can hit to confirm findings.",
  )
  .option(
    "--target-creds <kv>",
    "Credentials for the live target as KEY=VALUE. Repeat for each pair.",
    collect,
    [] as string[],
  )
  .option(
    "--scope-notes <path>",
    "Path to a text file with target-specific scope rules.",
  )
  .option("--config <path>", "Override config/stages.yaml.")
  .option(
    "--allow-api-key",
    "Honor ANTHROPIC_API_KEY for metered Anthropic billing (also via AUDIT_ALLOW_API_KEY=1).",
  )
  .action(async (opts) => {
    const allow = allowApiKeyFromEnvOrFlag(Boolean(opts.allowApiKey));
    try {
      configureAuth({ allowApiKey: allow });
    } catch (e) {
      if (e instanceof AuthError) {
        log.error(`auth error: ${e.message}`);
        process.exit(2);
      }
      throw e;
    }

    if (!existsSync(opts.repo)) {
      log.error(`--repo path does not exist: ${opts.repo}`);
      process.exit(2);
    }

    validateFailOn(opts.failOn);
    const repoPath = resolve(opts.repo);

    // Diff/PR mode — constrain Recon's input to the changed-file set.
    let changed: string[] | null = null;
    if (opts.base || opts.since) {
      if (opts.base && opts.since) {
        log.error("--base and --since are mutually exclusive");
        process.exit(2);
      }
      if (!isGitRepo(repoPath)) {
        log.error(`--base/--since require a git repo: ${repoPath}`);
        process.exit(2);
      }
      try {
        const res = changedFiles(repoPath, {
          base: opts.base,
          since: opts.since,
        });
        changed = res.files;
        log.info(
          `diff mode: ${res.range} → ${res.files.length} changed file(s)${
            res.dropped ? ` (${res.dropped} deleted/ignored)` : ""
          }`,
        );
      } catch (e) {
        log.error("diff error:", (e as Error).message);
        process.exit(2);
      }
    }

    const config = opts.config ? loadConfig(opts.config) : loadConfig();
    if (opts.maxConcurrency !== undefined) {
      config.capConcurrency(opts.maxConcurrency);
      log.info(
        `capped concurrency to ${opts.maxConcurrency} across all stages`,
      );
    }

    // Live-target plumbing — agents receive {"url": ..., "credentials":{...}}.
    let liveTarget: Json = null;
    if (opts.targetUrl) {
      const creds: Record<string, string> = {};
      for (const kv of opts.targetCreds as string[]) {
        if (!kv.includes("=")) {
          log.error(
            `invalid --target-creds ${JSON.stringify(kv)} — expected KEY=VALUE`,
          );
          process.exit(2);
        }
        const idx = kv.indexOf("=");
        creds[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
      }
      liveTarget = { url: opts.targetUrl, credentials: creds };
      log.info(
        `live target: ${opts.targetUrl} (creds: ${Object.keys(creds).sort().join(", ")})`,
      );
    } else if ((opts.targetCreds as string[]).length > 0) {
      log.warn("--target-creds without --target-url is ignored");
    }

    let scopeNotes: string | null = null;
    if (opts.scopeNotes) {
      scopeNotes = readFileSync(opts.scopeNotes, "utf8");
      log.info(
        `scope notes loaded: ${opts.scopeNotes} (${scopeNotes.length} chars)`,
      );
    }

    const runId = opts.runId || `run_${shortId()}`;

    let reportPath: string;
    const db = new StateDB(DB_PATH);
    try {
      reportPath = await runPipeline({
        repoPath,
        runId,
        db,
        config,
        maxCostUsd: opts.maxCostUsd ?? null,
        resume: Boolean(opts.resume),
        maxReconTasks: opts.maxReconTasks ?? null,
        liveTarget,
        scopeNotes,
        changedFiles: changed,
      });
      log.success(`done: run_id=${runId} report=${reportPath}`);
    } catch (e) {
      if (e instanceof CostExceeded) {
        log.warn(`aborted: ${e.message}`);
        process.exit(3);
      }
      log.error(`failed: ${(e as Error).name}: ${(e as Error).message}`);
      throw e;
    } finally {
      db.close();
    }

    // Post-run: baseline delta + severity gate. Done after the DB is closed so
    // a process.exit() from the gate never skips cleanup. report.json on disk
    // stays the raw agent output; baseline filtering is applied in-memory here
    // (and the `report` subcommand re-derives any view on demand).
    if (opts.baseline || opts.failOn) {
      let view: Json = JSON.parse(readFileSync(reportPath, "utf8"));
      if (opts.baseline) {
        if (!existsSync(opts.baseline)) {
          log.error(`--baseline file not found: ${opts.baseline}`);
          process.exit(2);
        }
        const baseline = parseBaseline(readFileSync(opts.baseline, "utf8"));
        const applied = applyBaseline(view, baseline);
        view = applied.report;
        printDelta(applied.delta);
      }
      applyGate(view, opts.failOn);
    }
  });

// ---------------- status ----------------

program
  .command("status")
  .description("Show pipeline status: tasks, findings, traces, cost.")
  .option("--run-id <id>")
  .action((opts) => {
    const db = new StateDB(DB_PATH);
    try {
      if (!opts.runId) {
        showRunsTable(db);
        return;
      }
      if (db.getRun(opts.runId) === null) {
        log.error(`unknown run_id ${JSON.stringify(opts.runId)}`);
        process.exit(1);
      }
      showRunDetail(db, opts.runId);
    } finally {
      db.close();
    }
  });

// ---------------- report ----------------

program
  .command("report")
  .description("Print, convert, or gate the final report.")
  .requiredOption("--run-id <id>")
  .option("--format <fmt>", "json | md | sarif", "json")
  .option(
    "--baseline <path>",
    "Suppress findings already in this baseline; show NEW/FIXED/STILL-PRESENT.",
  )
  .option(
    "--fail-on <severity>",
    `Exit ${EXIT_GATE} if any (shown) finding is at or above this severity.`,
  )
  .option(
    "--out <path>",
    "Write the rendered report to a file instead of stdout.",
  )
  .option(
    "--serve",
    "Open the interactive triage viewer (local web UI) for this run instead of printing.",
  )
  .option(
    "--port <n>",
    "Port for --serve (default 7878).",
    (v) => Number.parseInt(v, 10),
  )
  .action((opts) => {
    if (opts.serve) {
      serveTriage(opts.runId, opts.port);
      return;
    }
    if (!["json", "md", "sarif"].includes(opts.format)) {
      log.error("invalid --format; use json, md, or sarif");
      process.exit(2);
    }
    validateFailOn(opts.failOn);

    let payload = loadReportOrExit(opts.runId);
    let delta: Delta | null = null;

    if (opts.baseline) {
      if (!existsSync(opts.baseline)) {
        log.error(`--baseline file not found: ${opts.baseline}`);
        process.exit(2);
      }
      const baseline = parseBaseline(readFileSync(opts.baseline, "utf8"));
      const applied = applyBaseline(payload, baseline);
      payload = applied.report;
      delta = applied.delta;
    }

    let rendered: string;
    if (opts.format === "json") rendered = JSON.stringify(payload, null, 2);
    else if (opts.format === "sarif")
      rendered = JSON.stringify(
        toSarif(payload, { toolVersion: pkg.version }),
        null,
        2,
      );
    else rendered = renderMarkdownReport(payload);

    // When the payload streams to stdout (json/sarif, no --out) keep stdout a
    // pristine machine artifact: render with a direct write, suppress logger
    // diagnostics that would otherwise interleave. With --out, stdout is free.
    const streamingToStdout = !opts.out;
    if (opts.out) {
      writeFileSync(opts.out, rendered);
      log.success(`wrote ${opts.format} → ${opts.out}`);
      if (delta) printDelta(delta);
    } else {
      process.stdout.write(
        rendered.endsWith("\n") ? rendered : `${rendered}\n`,
      );
    }

    applyGate(payload, opts.failOn, { quiet: streamingToStdout });
  });

// ---------------- baseline ----------------

program
  .command("baseline")
  .description(
    "Generate a baseline file from a run's report (accept current findings).",
  )
  .requiredOption("--run-id <id>")
  .option(
    "--out <path>",
    "Where to write the baseline JSON.",
    ".audit-baseline.json",
  )
  .action((opts) => {
    const payload = loadReportOrExit(opts.runId);
    const baseline = buildBaseline(payload);
    writeFileSync(opts.out, JSON.stringify(baseline, null, 2));
    log.success(
      `baseline written: ${opts.out} (${baseline.fingerprints.length} findings accepted)`,
    );
  });

// ---------------- fix (Stage 9, opt-in) ----------------

program
  .command("fix")
  .description(
    "Generate minimal patches + regression tests for confirmed, reachable findings (Stage 9, opt-in).",
  )
  .requiredOption("--run-id <id>")
  .option(
    "--repo <path>",
    "Path to the target source repo (default: current directory).",
    process.cwd(),
  )
  .option(
    "--apply",
    "Apply the generated patches to a new branch (requires a clean working tree).",
  )
  .option(
    "--open-pr",
    "Apply, push, and open a draft PR via `gh`. Never merges. Implies --apply.",
  )
  .option("--branch <name>", "Branch for --apply/--open-pr (default audit/fix-<run-id>).")
  .option("--config <path>", "Override config/stages.yaml.")
  .option("--allow-api-key", "Honor ANTHROPIC_API_KEY for metered billing.")
  .action(async (opts) => {
    const allow = allowApiKeyFromEnvOrFlag(Boolean(opts.allowApiKey));
    try {
      configureAuth({ allowApiKey: allow });
    } catch (e) {
      if (e instanceof AuthError) {
        log.error(`auth error: ${e.message}`);
        process.exit(2);
      }
      throw e;
    }

    const repoPath = resolve(opts.repo);
    if (!existsSync(repoPath)) {
      log.error(`--repo path does not exist: ${repoPath}`);
      process.exit(2);
    }
    if (!isGitRepo(repoPath)) {
      log.error(`audit fix requires a git repo (it patches inside a worktree): ${repoPath}`);
      process.exit(2);
    }

    const config = opts.config ? loadConfig(opts.config) : loadConfig();
    const db = new StateDB(DB_PATH);
    let summary: { generated: number; skipped: number; fixesPath: string };
    try {
      if (db.getRun(opts.runId) === null) {
        log.error(`unknown run_id ${JSON.stringify(opts.runId)}`);
        process.exit(1);
      }
      const ctx = new StageContext(opts.runId, repoPath, config);
      summary = await runFix(ctx, db);
    } finally {
      db.close();
    }

    if (summary.generated === 0) {
      log.info("no patches generated — nothing to apply");
      return;
    }
    if (opts.apply || opts.openPr) {
      applyFixes(repoPath, opts.runId, summary.fixesPath, {
        branch: opts.branch,
        openPr: Boolean(opts.openPr),
      });
    } else {
      log.info(
        `review patches in ${join(RESULTS, opts.runId, "fix")} — re-run with --apply to land them on a branch`,
      );
    }
  });

// ---------------- stats ----------------

program
  .command("stats")
  .description("Cost & token breakdown by stage/model, and cost-per-finding.")
  .requiredOption("--run-id <id>")
  .option("--config <path>", "Override config/stages.yaml (for stage→model mapping).")
  .option("--json", "Emit the raw stats object as JSON.")
  .action((opts) => {
    const db = new StateDB(DB_PATH);
    try {
      if (db.getRun(opts.runId) === null) {
        log.error(`unknown run_id ${JSON.stringify(opts.runId)}`);
        process.exit(1);
      }
      let config = null;
      try {
        config = opts.config ? loadConfig(opts.config) : loadConfig();
      } catch {
        config = null; // stage→model becomes "?" but the rollup still works
      }
      const stats = computeStats(db, config, opts.runId);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      } else {
        renderStats(stats);
      }
    } finally {
      db.close();
    }
  });

// ---------------- shared: triage viewer ----------------

function serveTriage(runId: string, port?: number): void {
  const db = new StateDB(DB_PATH);
  if (db.getRun(runId) === null) {
    log.error(`unknown run_id ${JSON.stringify(runId)}`);
    db.close();
    process.exit(1);
  }
  const server = serveViewer(db, runId, { port });
  const shutdown = () => {
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------- shared: apply fixes to a branch ----------------

function sh(
  cmd: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(cmd, { cwd });
  return {
    ok: p.exitCode === 0,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

function applyFixes(
  repoPath: string,
  runId: string,
  fixesPath: string,
  opts: { branch?: string; openPr: boolean },
): void {
  // Refuse to touch a dirty tree — we create a branch off HEAD and apply onto it.
  if (sh(["git", "status", "--porcelain"], repoPath).stdout.trim() !== "") {
    log.error(
      "working tree is not clean — commit or stash changes before --apply/--open-pr",
    );
    process.exit(2);
  }

  const fixes = (JSON.parse(readFileSync(fixesPath, "utf8")).fixes ??
    []) as Json[];
  const patches = fixes
    .map((f) => f.patch_file)
    .filter((p: string) => p && existsSync(p));
  if (patches.length === 0) {
    log.warn("no patch files to apply");
    return;
  }

  const branch = opts.branch || `audit/fix-${runId}`;
  if (!sh(["git", "checkout", "-b", branch], repoPath).ok) {
    log.error(`could not create branch ${branch} (does it already exist?)`);
    process.exit(2);
  }

  let applied = 0;
  for (const patch of patches) {
    const res = sh(["git", "apply", "--index", "--3way", patch], repoPath);
    if (res.ok) applied++;
    else log.warn(`patch did not apply cleanly, skipped: ${patch} — ${res.stderr.trim().slice(0, 160)}`);
  }
  if (applied === 0) {
    log.error("no patches applied cleanly; leaving branch uncommitted for manual review");
    return;
  }

  sh(
    [
      "git",
      "commit",
      "-m",
      `fix(security): auto-fix ${applied} reachable finding(s) [audit ${runId}]\n\nGenerated by \`audit fix\`. Review every hunk — never auto-merge.`,
    ],
    repoPath,
  );
  log.success(`applied ${applied}/${patches.length} patch(es) on branch ${branch}`);

  if (!opts.openPr) {
    log.info(`open a PR when ready: git push -u origin ${branch} && gh pr create`);
    return;
  }

  if (!sh(["gh", "--version"], repoPath).ok) {
    log.error("`gh` CLI not found — pushed nothing. Install GitHub CLI or push manually.");
    return;
  }
  if (!sh(["git", "push", "-u", "origin", branch], repoPath).ok) {
    log.error("git push failed — not opening a PR");
    return;
  }
  const pr = sh(
    [
      "gh",
      "pr",
      "create",
      "--draft",
      "--title",
      `Security auto-fixes (audit ${runId})`,
      "--body",
      `Automated patches for confirmed + reachable findings from \`audit\` run \`${runId}\`.\n\n**Draft on purpose — review every hunk. Do not auto-merge.**`,
    ],
    repoPath,
  );
  if (pr.ok) log.success(`draft PR opened: ${pr.stdout.trim()}`);
  else log.error(`gh pr create failed: ${pr.stderr.trim().slice(0, 200)}`);
}

// ---------------- table renderers ----------------

function row(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join("  ");
}

function showRunsTable(db: StateDB): void {
  const runs = db.listRuns();
  log.print(chalk.bold("runs"));
  const widths = [22, 40, 12, 10];
  log.print(chalk.dim(row(["run_id", "repo", "status", "cost ($)"], widths)));
  for (const r of runs) {
    log.print(
      row(
        [r.run_id, r.repo_path, r.status, db.totalCost(r.run_id).toFixed(4)],
        widths,
      ),
    );
  }
}

function showRunDetail(db: StateDB, runId: string): void {
  const tasks = db.getAllTasks(runId);
  const findings = db.getFindings(runId);
  const confirmed = findings.filter((f) => f.validationStatus === "confirmed");
  const canonical = confirmed.filter((f) => f.isCanonical);
  const reachable = db.getReachableCanonicalFindings(runId);

  log.print(chalk.bold(`run ${runId}`));
  const widths = [22, 8];
  const print = (m: string, c: number) =>
    log.print(row([m, String(c)], widths));
  print("tasks (total)", tasks.length);
  print("tasks (pending)", tasks.filter((t) => t.status === "pending").length);
  print("tasks (done)", tasks.filter((t) => t.status === "done").length);
  print("tasks (failed)", tasks.filter((t) => t.status === "failed").length);
  print("findings (raw)", findings.length);
  print("findings (confirmed)", confirmed.length);
  print("findings (canonical)", canonical.length);
  print("findings (reachable)", reachable.length);
  log.print(row(["total cost ($)", db.totalCost(runId).toFixed(4)], widths));
}

function renderStats(s: Stats): void {
  const n = (x: number) => x.toLocaleString("en-US");
  const usd = (x: number) => `$${x.toFixed(4)}`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  log.print(chalk.bold(`cost breakdown — ${s.runId}`));
  const widths = [10, 20, 6, 12, 12, 12, 11, 7];
  log.print(
    chalk.dim(
      row(
        ["stage", "model", "calls", "in", "out", "cache_rd", "cost", "%"],
        widths,
      ),
    ),
  );
  for (const st of s.stages) {
    log.print(
      row(
        [
          st.stage,
          st.model,
          n(st.calls),
          n(st.inputTokens),
          n(st.outputTokens),
          n(st.cacheReadTokens),
          usd(st.usd),
          pct(st.costShare),
        ],
        widths,
      ),
    );
  }
  log.print(
    chalk.bold(
      row(
        [
          "TOTAL",
          "",
          n(s.stages.reduce((a, x) => a + x.calls, 0)),
          "",
          "",
          "",
          usd(s.totalUsd),
          "100%",
        ],
        widths,
      ),
    ),
  );

  if (s.byModel.length > 1) {
    log.print(chalk.bold("\nby model"));
    for (const m of s.byModel)
      log.print(
        row([m.model, `${n(m.calls)} calls`, usd(m.usd)], [22, 14, 10]),
      );
  }

  log.print(chalk.bold("\nyield"));
  const k2 = [24, 16];
  log.print(
    row(
      ["findings (raw/conf/reach)", `${s.counts.raw}/${s.counts.confirmed}/${s.counts.reachable}`],
      k2,
    ),
  );
  log.print(
    row(
      [
        "cost / confirmed",
        s.perConfirmedUsd == null ? "—" : usd(s.perConfirmedUsd),
      ],
      k2,
    ),
  );
  log.print(
    row(
      [
        "cost / reachable",
        s.perReachableUsd == null ? "—" : usd(s.perReachableUsd),
      ],
      k2,
    ),
  );
  log.print(row(["prompt-cache hit ratio", pct(s.cacheHitRatio)], k2));
  log.print(row(["total tokens", n(s.totalTokens)], k2));
}

function renderMarkdownReport(report: Json): string {
  const lines: string[] = [];
  lines.push(`# Vulnerability report — \`${report.run_id}\``);
  lines.push(`Target: \`${report.target.repo_path}\`  `);
  const s = report.summary;
  const by = s.by_severity ?? {};
  const bySevStr = Object.entries(by)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  lines.push(
    Object.keys(by).length
      ? `**Total findings: ${s.total}** — ${bySevStr}`
      : `**Total findings: ${s.total}**`,
  );
  if (report.delta) {
    const d = report.delta;
    lines.push("");
    lines.push(
      `_Baseline delta_: **${d.new_count} new**, ${d.still_present_count} still-present, ` +
        `${d.fixed_count} fixed (baseline had ${d.baseline_total}).`,
    );
  }
  lines.push("");
  for (const f of report.findings ?? []) {
    lines.push(`## ${f.title}`);
    lines.push(`- **Severity**: ${f.severity}  `);
    lines.push(`- **Class**: ${f.vuln_class}${f.cwe ? ` (${f.cwe})` : ""}`);
    lines.push(`- **Location**: \`${f.file}:${f.line_start}-${f.line_end}\`  `);
    lines.push("");
    lines.push(f.description);
    lines.push("");
    lines.push("```");
    lines.push(f.evidence);
    lines.push("```");
    lines.push("");
    const ep = f.trace.entry_points ?? [];
    if (ep.length) {
      lines.push("**Entry points**:");
      for (const e of ep) lines.push(`- \`${e.kind}\` at \`${e.location}\``);
      lines.push("");
    }
    const cc = f.trace.call_chain ?? [];
    if (cc.length) {
      lines.push("**Call chain**:");
      for (const frame of cc)
        lines.push(
          `1. \`${frame.file}:${frame.line}\` — \`${frame.function}()\``,
        );
      lines.push("");
    }
    lines.push(`**Recommendation**: ${f.recommendation}`);
    lines.push("");
    if (f.variants?.length) {
      lines.push(`_Variants_: ${f.variants.join(", ")}`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

// Notify the user when a newer version of the CLI is published to npm.
updateNotifier({ pkg: { name: pkg.name, version: pkg.version } }).notify({
  isGlobal: true,
  defer: false, // Show immediately
});

program.parseAsync().catch((e) => {
  log.error(String((e as Error)?.stack ?? e));
  process.exit(1);
});
