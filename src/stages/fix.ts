/**
 * Stage 9 (opt-in): Auto-fix. For each confirmed + reachable finding, generate
 * a minimal patch and a regression test. The reachability gate is what makes
 * this safe to attempt — we only patch bugs proven real and externally
 * exploitable.
 *
 * Each fix agent runs inside its own throwaway **git worktree** checked out at
 * HEAD, so the developer's working tree is never touched. The agent edits code
 * there; we capture the change with `git diff` and save it as a reviewable
 * `.patch`. Nothing is applied or merged here — that is an explicit, separate,
 * human-driven step (`audit fix --apply` / `--open-pr`).
 */

import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger";
import { WORK } from "../paths";
import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB, Finding } from "../state";
import {  mapWithConcurrency } from "./common";
import type {StageContext} from "./common";

type Json = any;

function git(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args]);
  return {
    ok: p.exitCode === 0,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

export interface FixSummary {
  generated: number;
  skipped: number;
  fixesPath: string;
}

export async function runFix(ctx: StageContext, db: StateDB): Promise<FixSummary> {
  const reachable = db.getReachableCanonicalFindings(ctx.runId);
  const fixDir = ctx.resultsDir("fix");
  const fixesPath = join(fixDir, "fixes.json");
  const target = { repo_path: ctx.repoPath };

  if (reachable.length === 0) {
    writeFileSync(
      fixesPath,
      JSON.stringify(
        { run_id: ctx.runId, target, generated: 0, fixes: [], skipped: [] },
        null,
        2,
      ),
    );
    log.info(`[${ctx.runId}] fix: no reachable findings to patch`);
    return { generated: 0, skipped: 0, fixesPath };
  }

  const sc = ctx.stage("fix");
  const schema = ctx.schema("fix_output");
  git(ctx.repoPath, ["worktree", "prune"]); // clear any stale worktrees first

  const st = log.stage(`[${ctx.runId}] fix`, {
    total: reachable.length,
    detail: `model=${sc.model}`,
  });

  const fixes: Json[] = [];
  const skipped: Json[] = [];

  await mapWithConcurrency(reachable, sc.concurrency, async ({ finding, trace }) => {
    try {
      const fix = await fixOne(ctx, sc, schema, finding, trace, fixDir);
      if (fix) fixes.push(fix);
      else
        skipped.push({
          finding_id: finding.findingId,
          reason: "agent produced no code change",
        });
    } catch (e) {
      const reason =
        e instanceof AgentRunError || e instanceof TransientAgentError
          ? e.message
          : String((e as Error).message ?? e);
      skipped.push({ finding_id: finding.findingId, reason });
    }
    st.step();
  });

  writeFileSync(
    fixesPath,
    JSON.stringify(
      {
        run_id: ctx.runId,
        target,
        generated: fixes.length,
        fixes,
        skipped,
      },
      null,
      2,
    ),
  );
  db.addArtifact(ctx.runId, "fix", null, "json", fixesPath);

  st.succeed(
    `[${ctx.runId}] fix: ${fixes.length} patch(es) generated, ${skipped.length} skipped → ${fixesPath}`,
  );
  return { generated: fixes.length, skipped: skipped.length, fixesPath };
}

async function fixOne(
  ctx: StageContext,
  sc: ReturnType<StageContext["stage"]>,
  schema: { name: string; text: string },
  finding: Finding,
  trace: Json,
  fixDir: string,
): Promise<Json | null> {
  // Fresh worktree at HEAD, isolated per finding so concurrent fixes never
  // collide. Outside the repo tree so it is not itself scanned.
  const wt = join(WORK, ctx.runId, "fix-wt", finding.findingId);
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(dirname(wt), { recursive: true });

  const add = git(ctx.repoPath, ["worktree", "add", "--detach", "--force", wt, "HEAD"]);
  if (!add.ok)
    throw new Error(`git worktree add failed: ${add.stderr.trim().slice(0, 200)}`);

  try {
    const result = await runAgent({
      stage: "fix",
      promptFile: ctx.promptFile("09-fix"),
      userInput: {
        finding: finding.rawJson,
        validation: finding.validationJson,
        trace,
        repo_path: wt,
        ...ctx.extras(),
      },
      schemaName: schema.name,
      schemaText: schema.text,
      allowedTools: sc.tools,
      model: sc.model,
      cwd: wt,
      addDirs: [wt],
      maxTurns: sc.maxTurns,
      permissionMode: sc.permissionMode,
      artifactDir: fixDir,
      artifactName: `fix_${finding.findingId}`,
      repairAttempts: sc.repairAttempts,
    });

    const payload = result.payload as Json;

    // Capture whatever the agent actually changed, regardless of what it
    // claimed — the git diff is the source of truth, not the model's report.
    git(wt, ["add", "-A"]);
    const diff = git(wt, ["diff", "--cached", "--no-color"]).stdout;
    const names = git(wt, ["diff", "--cached", "--name-only"])
      .stdout.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (payload.fixed === false || diff.trim() === "") return null;

    const patchFile = join(fixDir, `${finding.findingId}.patch`);
    writeFileSync(patchFile, diff);

    return {
      finding_id: finding.findingId,
      vuln_class: finding.vulnClass,
      severity: finding.severity,
      file: finding.file,
      summary: payload.summary,
      root_cause: payload.root_cause,
      fix_approach: payload.fix_approach ?? null,
      regression_test: payload.regression_test ?? null,
      confidence: payload.confidence ?? null,
      caveats: payload.caveats ?? null,
      changed_files: names,
      patch_file: patchFile,
    };
  } finally {
    git(ctx.repoPath, ["worktree", "remove", "--force", wt]);
    rmSync(wt, { recursive: true, force: true });
  }
}
