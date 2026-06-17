#!/usr/bin/env bun
/**
 * CLI: auth-check, run, status, report. Built on Commander —
 * runs under Bun (uses bun:sqlite and other Bun-native APIs).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { configureAuth, AuthError } from "./auth";
import { loadConfig } from "./config";
import { setVerbose, log } from "./logger";
import { runPipeline, CostExceeded } from "./orchestrator";
import { RESULTS, DB_PATH } from "./paths";
import { StateDB } from "./state";
import updateNotifier from "update-notifier";
import pkg from "../package.json";

type Json = any;

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
        console.error(chalk.red("auth error:"), e.message);
        process.exit(2);
      }
      throw e;
    }
    switch (status.authMode) {
      case "oauth_token":
        console.log(chalk.green("OK"), "using CLAUDE_CODE_OAUTH_TOKEN");
        break;
      case "api_key":
        console.log(
          chalk.green("OK"),
          "using ANTHROPIC_API_KEY (metered Anthropic API billing)",
        );
        break;
      case "keychain_login":
        console.log(
          chalk.green("OK"),
          `using stored login from ${status.credentialsFile}`,
        );
        break;
      case "macos_keychain_login":
        console.log(
          chalk.green("OK"),
          "using macOS Keychain-backed Claude Code login",
        );
        break;
      case "gateway":
        console.log(
          chalk.green("OK"),
          `using LLM gateway at ${status.gatewayBaseUrl} (ANTHROPIC_AUTH_TOKEN)`,
        );
        if (status.gatewayModel)
          console.log(`          ANTHROPIC_MODEL=${status.gatewayModel}`);
        break;
    }
    if (status.apiKeyScrubbed) {
      console.log(
        chalk.yellow("scrubbed"),
        "ANTHROPIC_API_KEY removed from env (it would have outranked the active auth mode)",
      );
    }
    if (status.authTokenScrubbed) {
      console.log(
        chalk.yellow("scrubbed"),
        "ANTHROPIC_AUTH_TOKEN removed from env (no gateway base URL set — leaving it would outrank subscription)",
      );
    }
    console.log(
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
        console.error(chalk.red("auth error:"), e.message);
        process.exit(2);
      }
      throw e;
    }

    if (!existsSync(opts.repo)) {
      console.error(chalk.red(`--repo path does not exist: ${opts.repo}`));
      process.exit(2);
    }

    const config = opts.config ? loadConfig(opts.config) : loadConfig();
    if (opts.maxConcurrency !== undefined) {
      config.capConcurrency(opts.maxConcurrency);
      console.log(
        chalk.cyan(
          `capped concurrency to ${opts.maxConcurrency} across all stages`,
        ),
      );
    }

    // Live-target plumbing — agents receive {"url": ..., "credentials":{...}}.
    let liveTarget: Json = null;
    if (opts.targetUrl) {
      const creds: Record<string, string> = {};
      for (const kv of opts.targetCreds as string[]) {
        if (!kv.includes("=")) {
          console.error(
            chalk.red(
              `invalid --target-creds ${JSON.stringify(kv)} — expected KEY=VALUE`,
            ),
          );
          process.exit(2);
        }
        const idx = kv.indexOf("=");
        creds[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
      }
      liveTarget = { url: opts.targetUrl, credentials: creds };
      console.log(
        chalk.cyan("live target:"),
        `${opts.targetUrl} (creds: ${Object.keys(creds).sort()})`,
      );
    } else if ((opts.targetCreds as string[]).length > 0) {
      console.log(
        chalk.yellow("--target-creds without --target-url is ignored"),
      );
    }

    let scopeNotes: string | null = null;
    if (opts.scopeNotes) {
      scopeNotes = readFileSync(opts.scopeNotes, "utf8");
      console.log(
        chalk.cyan("scope notes loaded:"),
        `${opts.scopeNotes} (${scopeNotes.length} chars)`,
      );
    }

    const runId = opts.runId || `run_${shortId()}`;
    const repoPath = resolve(opts.repo);

    const db = new StateDB(DB_PATH);
    try {
      const report = await runPipeline({
        repoPath,
        runId,
        db,
        config,
        maxCostUsd: opts.maxCostUsd ?? null,
        resume: Boolean(opts.resume),
        maxReconTasks: opts.maxReconTasks ?? null,
        liveTarget,
        scopeNotes,
      });
      console.log(chalk.green("done"), `run_id=${runId} report=${report}`);
    } catch (e) {
      if (e instanceof CostExceeded) {
        console.log(chalk.yellow("aborted"), e.message);
        process.exit(3);
      }
      console.error(
        chalk.red("failed"),
        `${(e as Error).name}: ${(e as Error).message}`,
      );
      throw e;
    } finally {
      db.close();
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
        console.error(
          chalk.red(`unknown run_id ${JSON.stringify(opts.runId)}`),
        );
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
  .description("Print (or generate) the final report.")
  .requiredOption("--run-id <id>")
  .option("--format <fmt>", "json | md", "json")
  .action((opts) => {
    if (opts.format !== "json" && opts.format !== "md") {
      console.error(chalk.red("invalid --format; use json or md"));
      process.exit(2);
    }
    const reportPath = join(RESULTS, opts.runId, "report", "report.json");
    if (!existsSync(reportPath)) {
      console.error(chalk.red(`no report at ${reportPath}`));
      process.exit(1);
    }
    const payload = JSON.parse(readFileSync(reportPath, "utf8"));
    if (opts.format === "json") {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderMarkdownReport(payload));
    }
  });

// ---------------- table renderers ----------------

function row(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join("  ");
}

function showRunsTable(db: StateDB): void {
  const runs = db.listRuns();
  console.log(chalk.bold("runs"));
  const widths = [22, 40, 12, 10];
  console.log(chalk.dim(row(["run_id", "repo", "status", "cost ($)"], widths)));
  for (const r of runs) {
    console.log(
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

  console.log(chalk.bold(`run ${runId}`));
  const widths = [22, 8];
  const print = (m: string, c: number) =>
    console.log(row([m, String(c)], widths));
  print("tasks (total)", tasks.length);
  print("tasks (pending)", tasks.filter((t) => t.status === "pending").length);
  print("tasks (done)", tasks.filter((t) => t.status === "done").length);
  print("tasks (failed)", tasks.filter((t) => t.status === "failed").length);
  print("findings (raw)", findings.length);
  print("findings (confirmed)", confirmed.length);
  print("findings (canonical)", canonical.length);
  print("findings (reachable)", reachable.length);
  console.log(row(["total cost ($)", db.totalCost(runId).toFixed(4)], widths));
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
