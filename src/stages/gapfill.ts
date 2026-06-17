/** Stage 4: Gapfill — re-queue under-covered areas back to Hunt. */

import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";
import { truncatedReconSummary } from "./common";

type Json = any;

// Gapfill defaults to a modest number — large counts amplify cost
// quadratically at low concurrency.
export const DEFAULT_MAX_NEW_TASKS = 8;

export async function runGapfill(
  ctx: StageContext,
  db: StateDB,
  maxNewTasks: number = DEFAULT_MAX_NEW_TASKS,
): Promise<number> {
  const reconSummary = db.getReconOutput(ctx.runId) ?? {};
  const allTasks = db.getAllTasks(ctx.runId);
  const completed = allTasks.filter(
    (t) => t.status === "done" || t.status === "failed",
  );
  if (completed.length === 0) {
    log.info(`[${ctx.runId}] gapfill: nothing to analyze`);
    return 0;
  }

  const findingsByTask = new Map<string, number>();
  for (const f of db.getFindings(ctx.runId)) {
    findingsByTask.set(f.taskId, (findingsByTask.get(f.taskId) ?? 0) + 1);
  }

  const sc = ctx.stage("gapfill");
  const schema = ctx.schema("gapfill_output");
  const completedPayload = completed.map((t) => ({
    task_id: t.taskId,
    attack_class: t.attackClass,
    subsystem: inferSubsystem(t.targetFiles, reconSummary),
    scope_hint: t.scopeHint,
    findings_count: findingsByTask.get(t.taskId) ?? 0,
    gaps_observed: [],
    status: t.status,
  }));

  const userInput = {
    recon_summary: truncatedReconSummary(reconSummary),
    completed_tasks: completedPayload,
    max_new_tasks: maxNewTasks,
    ...ctx.extras(),
  };

  const st = log.stage(`[${ctx.runId}] gapfill`, {
    detail: `analyzing ${completed.length} completed tasks`,
  });
  let result;
  try {
    result = await runAgent({
      stage: "gapfill",
      promptFile: ctx.promptFile("04-gapfill"),
      userInput,
      schemaName: schema.name,
      schemaText: schema.text,
      allowedTools: sc.tools,
      model: sc.model,
      cwd: ctx.repoPath,
      addDirs: [ctx.repoPath],
      maxTurns: sc.maxTurns,
      permissionMode: sc.permissionMode,
      artifactDir: ctx.resultsDir("gapfill"),
      artifactName: `gapfill_iter_${db.artifactCount(ctx.runId, "gapfill") + 1}`,
      repairAttempts: sc.repairAttempts,
      onActivity: st.onActivity,
    });
  } catch (e) {
    if (e instanceof AgentRunError || e instanceof TransientAgentError) {
      st.warn(`[${ctx.runId}] gapfill failed: ${e.message} — skipping iteration`);
      return 0;
    }
    throw e;
  }

  const newTasks: Json[] = result.payload.new_tasks ?? [];
  let added = 0;
  for (const t of newTasks) {
    t.source ??= "gapfill";
    if (allTasks.some((x) => x.taskId === t.task_id)) continue; // skip duplicate id
    db.addTask(ctx.runId, t);
    added++;
  }
  db.recordCost(ctx.runId, "gapfill", null, result.rawResultMessage);
  db.addArtifact(ctx.runId, "gapfill", null, "jsonl", result.artifactPath);
  st.succeed(`[${ctx.runId}] gapfill: added ${added} new tasks`);
  return added;
}

function inferSubsystem(targetFiles: string[], recon: Json): string {
  if (targetFiles.length === 0) return "unknown";
  const f = targetFiles[0];
  for (const s of recon.subsystems ?? []) {
    const p = s.path ?? "";
    if (p && f.startsWith(p)) return s.name ?? "unknown";
  }
  return "unknown";
}
