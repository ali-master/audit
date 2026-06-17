/** Stage 1: Recon — map the repo, emit initial hunt tasks. */

import { runAgent } from "../runner";
import type { StateDB } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";

type Json = any;

export const DEFAULT_MAX_TASKS = 80;

export async function runRecon(
  ctx: StageContext,
  db: StateDB,
  maxTasks: number = DEFAULT_MAX_TASKS,
): Promise<Json> {
  const existing = db.getReconOutput(ctx.runId);
  if (existing !== null) {
    log.info(`[${ctx.runId}] recon already complete, skipping`);
    return existing;
  }

  const sc = ctx.stage("recon");
  const schema = ctx.schema("recon_output");
  const diffMode = ctx.changedFiles !== null;
  const st = log.stage(`[${ctx.runId}] recon`, {
    detail: diffMode
      ? `model=${sc.model} diff-mode (${ctx.changedFiles!.length} changed files)`
      : `model=${sc.model} max_tasks=${maxTasks}`,
  });

  const result = await runAgent({
    stage: "recon",
    promptFile: ctx.promptFile("01-recon"),
    userInput: {
      repo_path: ctx.repoPath,
      max_tasks: maxTasks,
      ...(diffMode ? { changed_files: ctx.changedFiles } : {}),
      ...ctx.extras(),
    },
    schemaName: schema.name,
    schemaText: schema.text,
    allowedTools: sc.tools,
    model: sc.model,
    cwd: ctx.repoPath,
    addDirs: [ctx.repoPath],
    maxTurns: sc.maxTurns,
    permissionMode: sc.permissionMode,
    artifactDir: ctx.resultsDir("recon"),
    artifactName: "recon",
    repairAttempts: sc.repairAttempts,
    onActivity: st.onActivity,
  });

  const payload = result.payload;
  db.saveReconOutput(ctx.runId, payload);
  db.recordCost(ctx.runId, "recon", null, result.rawResultMessage);
  db.addArtifact(ctx.runId, "recon", null, "jsonl", result.artifactPath);

  for (const task of payload.initial_tasks ?? []) {
    task.source ??= "recon";
    db.addTask(ctx.runId, task);
  }

  st.succeed(
    `[${ctx.runId}] recon done: subsystems=${(payload.subsystems ?? []).length} ` +
      `entry_points=${(payload.architecture?.entry_points ?? []).length} ` +
      `initial_tasks=${(payload.initial_tasks ?? []).length} cost=$${(result.costUsd ?? 0).toFixed(4)}`,
  );
  return payload;
}
