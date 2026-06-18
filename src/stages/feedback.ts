/** Stage 7: Feedback — convert reachable traces into new Hunt tasks. */

import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";
import { truncatedReconSummary } from "./common";

type Json = any;

export const DEFAULT_MAX_NEW_TASKS = 40;

export async function runFeedback(
  ctx: StageContext,
  db: StateDB,
  maxNewTasks: number = DEFAULT_MAX_NEW_TASKS,
): Promise<number> {
  const reachable = db.getReachableCanonicalFindings(ctx.runId);
  if (reachable.length === 0) {
    log.info(`[${ctx.runId}] feedback: no reachable findings; nothing to seed`);
    return 0;
  }

  const sc = ctx.stage("feedback");
  const schema = ctx.schema("feedback_output");
  const reconSummary = db.getReconOutput(ctx.runId) ?? {};
  const payload = reachable.map(({ finding, trace }) => ({
    finding: finding.rawJson,
    trace,
  }));

  const st = log.stage(`[${ctx.runId}] feedback`, {
    detail: `seeding from ${reachable.length} reachable traces`,
  });
  let result;
  try {
    result = await runAgent({
      stage: "feedback",
      promptFile: ctx.promptFile("07-feedback"),
      userInput: {
        reachable_traces: payload,
        recon_summary: truncatedReconSummary(reconSummary),
        max_new_tasks: maxNewTasks,
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
      artifactDir: ctx.resultsDir("feedback"),
      artifactName: "feedback",
      repairAttempts: sc.repairAttempts,
      onActivity: st.onActivity,
    });
  } catch (e) {
    if (e instanceof AgentRunError || e instanceof TransientAgentError) {
      st.warn(`[${ctx.runId}] feedback failed: ${e.message}`);
      return 0;
    }
    throw e;
  }

  const newTasks: Json[] = result.payload.new_hunt_tasks ?? [];
  const existingIds = new Set(db.getAllTasks(ctx.runId).map((t) => t.taskId));
  // Files of bugs we have already proven reachable. The prompt forbids
  // re-targeting them (find siblings, not re-test the known bug), but that
  // semantic rule has no schema backstop — so enforce a deterministic floor.
  const provenFiles = new Set(reachable.map(({ finding }) => finding.file));
  const { kept, dropped } = partitionRetests(newTasks, provenFiles);
  for (const { task, offending } of dropped) {
    // Surface the drop rather than swallowing it silently.
    log.info(
      `[${ctx.runId}] feedback: dropping ${task.task_id} — re-targets a proven file (${offending.join(", ")})`,
    );
  }
  const retestsDropped = dropped.length;
  let added = 0;
  for (const t of kept) {
    t.source ??= "feedback";
    if (existingIds.has(t.task_id)) continue;
    db.addTask(ctx.runId, t);
    added++;
  }
  db.recordCost(ctx.runId, "feedback", null, result.rawResultMessage);
  db.addArtifact(ctx.runId, "feedback", null, "jsonl", result.artifactPath);
  st.succeed(
    `[${ctx.runId}] feedback: ${added} new tasks from ${reachable.length} reachable traces` +
      (retestsDropped > 0 ? ` (dropped ${retestsDropped} re-test${retestsDropped === 1 ? "" : "s"})` : ""),
  );
  return added;
}

/**
 * Split feedback's proposed tasks into the ones to keep and the ones that
 * re-test an already-proven file. Feedback exists to hunt a bug's *siblings*,
 * not to re-test the bug itself; `prompts/07-feedback.md` forbids listing any
 * proven `finding.file` in a new task's `target_files`. That rule is relational
 * to the input, so no JSON schema can enforce it — this is the deterministic
 * floor under it. A drop is unambiguously safe: re-hunting a proven sink is
 * never useful. Exported (and pure) for unit testing.
 */
export function partitionRetests(
  tasks: Json[],
  provenFiles: Set<string>,
): { kept: Json[]; dropped: Array<{ task: Json; offending: string[] }> } {
  const kept: Json[] = [];
  const dropped: Array<{ task: Json; offending: string[] }> = [];
  for (const t of tasks) {
    const offending: string[] = (t.target_files ?? []).filter((f: string) =>
      provenFiles.has(f),
    );
    if (offending.length > 0) dropped.push({ task: t, offending });
    else kept.push(t);
  }
  return { kept, dropped };
}
