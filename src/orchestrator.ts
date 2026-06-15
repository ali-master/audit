/**
 * Pipeline driver:
 *   Recon → (Hunt → Validate → Gapfill)* → Dedupe → Trace
 *         → Feedback → (Hunt → Validate → Dedupe → Trace)* → Report
 *
 */

import type { HarnessConfig } from "./config";
import { log } from "./logger";
import { QuotaExhaustedError } from "./runner";
import {
  StageContext,
  runValidate,
  runTrace,
  runReport,
  runRecon,
  runHunt,
  runGapfill,
  runFeedback,
  runDedupe,
} from "./stages";
import type { LiveTarget } from "./stages";
import type { StateDB } from "./state";

export class CostExceeded extends Error {}

export interface RunPipelineParams {
  repoPath: string;
  runId: string;
  db: StateDB;
  config: HarnessConfig;
  maxCostUsd?: number | null;
  resume?: boolean;
  maxReconTasks?: number | null;
  liveTarget?: LiveTarget | null;
  scopeNotes?: string | null;
}

export async function runPipeline(params: RunPipelineParams): Promise<string> {
  const {
    repoPath,
    runId,
    db,
    config,
    maxCostUsd = null,
    resume = false,
    maxReconTasks = null,
    liveTarget = null,
    scopeNotes = null,
  } = params;

  const ctx = new StageContext(runId, repoPath, config, liveTarget, scopeNotes);

  if (db.getRun(runId) === null) {
    db.createRun(repoPath, runId);
    log.info(`[${runId}] starting fresh pipeline run against ${repoPath}`);
  } else if (resume) {
    db.reopenRun(runId);
    // Re-queue tasks left 'running' (interrupted) or 'failed' so resume
    // actually re-attempts the incomplete work — Hunt only dispatches
    // 'pending' tasks.
    const requeued = db.resetIncompleteTasks(runId);
    if (requeued)
      log.info(
        `[${runId}] resume: re-queued ${requeued} interrupted/failed tasks`,
      );
    log.info(`[${runId}] resuming existing run`);
  } else {
    throw new Error(
      `run_id ${JSON.stringify(runId)} already exists; pass --resume to continue it.`,
    );
  }

  const budgetCheck = (stageName: string): void => {
    if (maxCostUsd === null) return;
    const spent = db.totalCost(runId);
    if (spent >= maxCostUsd) {
      throw new CostExceeded(
        `[${runId}] budget exhausted before ${stageName}: ` +
          `$${spent.toFixed(4)} >= $${maxCostUsd.toFixed(4)}`,
      );
    }
  };

  try {
    // ---- Stage 1: Recon ----
    budgetCheck("recon");
    await runRecon(ctx, db, maxReconTasks ?? undefined);

    // ---- Stages 2-3-4 loop: Hunt → Validate → Gapfill ----
    for (let i = 0; i <= config.gapfillIterations; i++) {
      budgetCheck(`hunt(iter=${i})`);
      const findingsAdded = await runHunt(ctx, db, budgetCheck);
      if (findingsAdded === 0 && i > 0) {
        log.info(`[${runId}] no new findings — exiting Hunt/Gapfill loop`);
        break;
      }

      budgetCheck(`validate(iter=${i})`);
      await runValidate(ctx, db);

      if (i >= config.gapfillIterations) break; // final iteration: don't gapfill again
      budgetCheck(`gapfill(iter=${i})`);
      const newTasks = await runGapfill(ctx, db);
      if (newTasks === 0) {
        log.info(`[${runId}] gapfill produced 0 tasks — exiting loop`);
        break;
      }
    }

    // ---- Stage 5: Dedupe ----
    budgetCheck("dedupe");
    await runDedupe(ctx, db);

    // ---- Stage 6: Trace ----
    budgetCheck("trace");
    await runTrace(ctx, db);

    // ---- Stage 7: Feedback (re-runs Hunt/Validate/Dedupe/Trace) ----
    for (let i = 0; i < config.feedbackIterations; i++) {
      budgetCheck(`feedback(iter=${i})`);
      const newTasks = await runFeedback(ctx, db);
      if (newTasks === 0) break;
      budgetCheck(`feedback-hunt(iter=${i})`);
      await runHunt(ctx, db);
      budgetCheck(`feedback-validate(iter=${i})`);
      await runValidate(ctx, db);
      budgetCheck(`feedback-dedupe(iter=${i})`);
      await runDedupe(ctx, db);
      budgetCheck(`feedback-trace(iter=${i})`);
      await runTrace(ctx, db);
    }

    // ---- Stage 8: Report ----
    budgetCheck("report");
    const reportPath = await runReport(ctx, db);

    db.finishRun(runId, "completed");
    log.info(
      `[${runId}] pipeline complete: total cost $${db.totalCost(runId).toFixed(4)} ` +
        `— report at ${reportPath}`,
    );
    return reportPath;
  } catch (e) {
    if (e instanceof CostExceeded) {
      log.error(e.message);
      db.finishRun(runId, "aborted");
      throw e;
    }
    if (e instanceof QuotaExhaustedError) {
      // Subscription quota exhausted — resumable via --resume once quota returns.
      log.error(
        `[${runId}] subscription quota exhausted — aborting (resumable with --resume): ${String(
          e.message,
        ).slice(0, 300)}`,
      );
      db.finishRun(runId, "aborted");
      throw e;
    }
    db.finishRun(runId, "failed");
    throw e;
  }
}
