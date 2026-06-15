/** Stage 2: Hunt — concurrent single-attack-class hunters. */

import {
  TransientAgentError,
  runAgent,
  QuotaExhaustedError,
  AgentRunError,
} from "../runner";
import type { Task, StateDB } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";
import { truncatedReconSummary, mapWithConcurrency } from "./common";

export type BudgetCheck = (stageName: string) => void;

/**
 * Run all pending Hunt tasks concurrently. Returns the number of findings
 * emitted. If `budgetCheck` is provided it is invoked before each task and
 * may throw to abort the stage early.
 */
export async function runHunt(
  ctx: StageContext,
  db: StateDB,
  budgetCheck?: BudgetCheck,
): Promise<number> {
  const pending = db.getPendingTasks(ctx.runId);
  if (pending.length === 0) {
    log.info(`[${ctx.runId}] hunt: no pending tasks`);
    return 0;
  }

  const sc = ctx.stage("hunt");
  const schema = ctx.schema("finding");
  const reconSummary = db.getReconOutput(ctx.runId) ?? {};
  let aborted = false;
  let quotaError: QuotaExhaustedError | null = null;

  log.info(
    `[${ctx.runId}] hunt: dispatching ${pending.length} tasks ` +
      `(concurrency=${sc.concurrency}, model=${sc.model})`,
  );

  const counters = { findings: 0, tasksDone: 0, tasksFailed: 0, skipped: 0 };

  const one = async (task: Task): Promise<void> => {
    if (aborted) {
      counters.skipped++;
      return;
    }
    if (budgetCheck) {
      try {
        budgetCheck(`hunt/${task.taskId}`);
      } catch (e) {
        log.warn(`[${ctx.runId}] hunt aborting: ${(e as Error).message}`);
        aborted = true;
        counters.skipped++;
        return;
      }
    }
    db.updateTaskStatus(task.taskId, "running");
    const scratch = ctx.workDir("hunt", task.taskId);
    const subsystemHint = task.targetFiles[0];
    const userInput = {
      task_id: task.taskId,
      attack_class: task.attackClass,
      scope_hint: task.scopeHint,
      target_files: task.targetFiles,
      rationale: task.rationale,
      repo_path: ctx.repoPath,
      scratch_dir: scratch,
      recon_summary: truncatedReconSummary(reconSummary, subsystemHint),
      ...ctx.extras(),
    };
    try {
      const result = await runAgent({
        stage: "hunt",
        promptFile: ctx.promptFile("02-hunt"),
        userInput,
        schemaName: schema.name,
        schemaText: schema.text,
        allowedTools: sc.tools,
        model: sc.model,
        cwd: scratch,
        addDirs: [ctx.repoPath],
        maxTurns: sc.maxTurns,
        permissionMode: sc.permissionMode,
        artifactDir: ctx.resultsDir("hunt"),
        artifactName: task.taskId,
        repairAttempts: sc.repairAttempts,
      });

      const findings = result.payload.findings ?? [];
      for (const f of findings) {
        db.addFinding(ctx.runId, task.taskId, f);
        counters.findings++;
      }
      db.updateTaskStatus(task.taskId, "done");
      db.recordCost(ctx.runId, "hunt", task.taskId, result.rawResultMessage);
      db.addArtifact(
        ctx.runId,
        "hunt",
        task.taskId,
        "jsonl",
        result.artifactPath,
      );
      db.addArtifact(ctx.runId, "hunt", task.taskId, "scratch_dir", scratch);
      counters.tasksDone++;
      log.info(
        `[${ctx.runId}] hunt ${task.taskId}: ${findings.length} findings ` +
          `(cost=$${(result.costUsd ?? 0).toFixed(4)})`,
      );
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        // Quota/session limit mid-flight. Leave the task 'pending' (resume
        // re-attempts it) and propagate so the pipeline aborts cleanly.
        log.error(
          `[${ctx.runId}] hunt task ${task.taskId} hit subscription quota — aborting stage`,
        );
        db.updateTaskStatus(task.taskId, "pending");
        aborted = true;
        quotaError = e;
        return;
      }
      if (e instanceof AgentRunError || e instanceof TransientAgentError) {
        log.warn(
          `[${ctx.runId}] hunt task ${task.taskId} failed: ${e.message}`,
        );
      } else {
        log.error(
          `[${ctx.runId}] hunt task ${task.taskId} unexpected error: ${e}`,
        );
      }
      db.updateTaskStatus(task.taskId, "failed");
      counters.tasksFailed++;
    }
  };

  await mapWithConcurrency(pending, sc.concurrency, one);

  if (quotaError) throw quotaError;

  log.info(
    `[${ctx.runId}] hunt: done=${counters.tasksDone} failed=${counters.tasksFailed} ` +
      `skipped=${counters.skipped} findings=${counters.findings}`,
  );
  return counters.findings;
}
