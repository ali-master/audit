/** Stage 6: Trace — reachability from entry point to sink, per canonical finding. */

import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB, Finding } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";
import { truncatedReconSummary, mapWithConcurrency } from "./common";

export async function runTrace(
  ctx: StageContext,
  db: StateDB,
): Promise<number> {
  const canonicals = db.getFindings(ctx.runId, {
    validationStatus: "confirmed",
    canonicalOnly: true,
  });
  if (canonicals.length === 0) {
    log.info(`[${ctx.runId}] trace: no canonical findings to trace`);
    return 0;
  }

  const sc = ctx.stage("trace");
  const schema = ctx.schema("trace");
  const reconSummary = db.getReconOutput(ctx.runId) ?? {};
  log.info(
    `[${ctx.runId}] trace: ${canonicals.length} canonicals ` +
      `(concurrency=${sc.concurrency}, model=${sc.model})`,
  );
  const counters = { reachable: 0, unreachable: 0, failed: 0 };

  const one = async (f: Finding): Promise<void> => {
    if (db.getTrace(f.findingId) !== null) return; // already traced (resume)
    const userInput = {
      finding: f.rawJson,
      recon_summary: truncatedReconSummary(reconSummary),
      repo_path: ctx.repoPath,
      ...ctx.extras(),
    };
    try {
      const result = await runAgent({
        stage: "trace",
        promptFile: ctx.promptFile("06-trace"),
        userInput,
        schemaName: schema.name,
        schemaText: schema.text,
        allowedTools: sc.tools,
        model: sc.model,
        cwd: ctx.repoPath,
        addDirs: [ctx.repoPath],
        maxTurns: sc.maxTurns,
        permissionMode: sc.permissionMode,
        artifactDir: ctx.resultsDir("trace"),
        artifactName: f.findingId,
        repairAttempts: sc.repairAttempts,
      });

      db.addTrace(f.findingId, result.payload);
      db.recordCost(ctx.runId, "trace", f.findingId, result.rawResultMessage);
      db.addArtifact(
        ctx.runId,
        "trace",
        f.findingId,
        "jsonl",
        result.artifactPath,
      );
      if (result.payload.reachable) counters.reachable++;
      else counters.unreachable++;
    } catch (e) {
      if (e instanceof AgentRunError || e instanceof TransientAgentError) {
        log.warn(`[${ctx.runId}] trace ${f.findingId} failed: ${e.message}`);
        counters.failed++;
        // Conservative: mark unreachable on failure.
        db.addTrace(f.findingId, {
          finding_id: f.findingId,
          reachable: false,
          confidence: 0.0,
          rationale: `tracer failed: ${e.message}`,
          blockers: [
            {
              kind: "other",
              location: "tracer",
              description: "agent failed to emit valid trace",
            },
          ],
        });
        return;
      }
      throw e;
    }
  };

  await mapWithConcurrency(canonicals, sc.concurrency, one);
  log.info(
    `[${ctx.runId}] trace: reachable=${counters.reachable} ` +
      `unreachable=${counters.unreachable} failed=${counters.failed}`,
  );
  return counters.reachable;
}
