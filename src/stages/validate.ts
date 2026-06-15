/** Stage 3: Validate — adversarial review, different model from Hunt. */

import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB, Finding } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";
import { mapWithConcurrency } from "./common";

/** Validate every not-yet-validated finding. Returns count confirmed. */
export async function runValidate(
  ctx: StageContext,
  db: StateDB,
): Promise<number> {
  const unvalidated = db.getUnvalidatedFindings(ctx.runId);
  if (unvalidated.length === 0) {
    log.info(`[${ctx.runId}] validate: nothing to validate`);
    return 0;
  }

  const sc = ctx.stage("validate");
  const schema = ctx.schema("validation");
  log.info(
    `[${ctx.runId}] validate: ${unvalidated.length} findings ` +
      `(concurrency=${sc.concurrency}, model=${sc.model})`,
  );

  const tasksById = new Map(
    db.getAllTasks(ctx.runId).map((t) => [t.taskId, t]),
  );
  const counters: Record<string, number> = {
    confirmed: 0,
    rejected: 0,
    needs_more_info: 0,
    failed: 0,
  };

  const one = async (f: Finding): Promise<void> => {
    const task = tasksById.get(f.taskId);
    const ctxBlock = {
      attack_class: task ? task.attackClass : f.vulnClass,
      scope_hint: task ? task.scopeHint : "",
      rationale: task ? task.rationale : "",
    };
    const userInput = {
      finding: f.rawJson,
      task_context: ctxBlock,
      repo_path: ctx.repoPath,
      ...ctx.extras(),
    };
    try {
      const result = await runAgent({
        stage: "validate",
        promptFile: ctx.promptFile("03-validate"),
        userInput,
        schemaName: schema.name,
        schemaText: schema.text,
        allowedTools: sc.tools,
        model: sc.model,
        cwd: ctx.repoPath,
        addDirs: [ctx.repoPath],
        maxTurns: sc.maxTurns,
        permissionMode: sc.permissionMode,
        artifactDir: ctx.resultsDir("validate"),
        artifactName: f.findingId,
        repairAttempts: sc.repairAttempts,
      });

      const verdict = result.payload.verdict ?? "needs_more_info";
      db.setFindingValidation(f.findingId, verdict, result.payload);
      db.recordCost(
        ctx.runId,
        "validate",
        f.findingId,
        result.rawResultMessage,
      );
      db.addArtifact(
        ctx.runId,
        "validate",
        f.findingId,
        "jsonl",
        result.artifactPath,
      );
      counters[verdict] = (counters[verdict] ?? 0) + 1;
    } catch (e) {
      if (e instanceof AgentRunError || e instanceof TransientAgentError) {
        log.warn(`[${ctx.runId}] validate ${f.findingId} failed: ${e.message}`);
        counters.failed++;
        // Treat unparseable validation as needs_more_info to avoid silently
        // confirming.
        db.setFindingValidation(f.findingId, "needs_more_info", {
          finding_id: f.findingId,
          verdict: "needs_more_info",
          rationale: `validator failed to produce schema-valid output: ${e.message}`,
          validator_confidence: 0.0,
        });
        return;
      }
      throw e;
    }
  };

  await mapWithConcurrency(unvalidated, sc.concurrency, one);
  log.info(
    `[${ctx.runId}] validate: confirmed=${counters.confirmed} rejected=${counters.rejected} ` +
      `needs_more_info=${counters.needs_more_info} failed=${counters.failed}`,
  );
  return counters.confirmed ?? 0;
}
