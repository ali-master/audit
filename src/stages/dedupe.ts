/** Stage 5: Dedupe — cluster confirmed findings by root cause. */

import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";

export async function runDedupe(
  ctx: StageContext,
  db: StateDB,
): Promise<number> {
  const confirmed = db.getFindings(ctx.runId, {
    validationStatus: "confirmed",
  });
  if (confirmed.length === 0) {
    log.info(`[${ctx.runId}] dedupe: no confirmed findings to cluster`);
    return 0;
  }

  const sc = ctx.stage("dedupe");
  const schema = ctx.schema("dedupe_output");
  const payload = confirmed.map((f) => ({
    ...f.rawJson,
    validation: f.validationJson,
  }));

  const st = log.stage(`[${ctx.runId}] dedupe`, {
    detail: `clustering ${confirmed.length} confirmed findings`,
  });
  let result;
  try {
    result = await runAgent({
      stage: "dedupe",
      promptFile: ctx.promptFile("05-dedupe"),
      userInput: { confirmed_findings: payload, ...ctx.extras() },
      schemaName: schema.name,
      schemaText: schema.text,
      allowedTools: sc.tools,
      model: sc.model,
      cwd: ctx.repoPath,
      addDirs: [ctx.repoPath],
      maxTurns: sc.maxTurns,
      permissionMode: sc.permissionMode,
      artifactDir: ctx.resultsDir("dedupe"),
      artifactName: "dedupe",
      repairAttempts: sc.repairAttempts,
      onActivity: st.onActivity,
    });
  } catch (e) {
    if (e instanceof AgentRunError || e instanceof TransientAgentError) {
      st.warn(
        `[${ctx.runId}] dedupe failed: ${e.message} — treating each finding as its own group`,
      );
      // Fallback: one group per finding, all canonical.
      for (const f of confirmed) {
        const gid = f.findingId.startsWith("f_")
          ? `g_${f.findingId.slice(2)}`
          : `g_${f.findingId}`;
        db.addDedupeGroup(ctx.runId, {
          group_id: gid,
          root_cause: f.description.slice(0, 200),
          canonical_finding_id: f.findingId,
          member_finding_ids: [f.findingId],
        });
        db.assignFindingGroup(f.findingId, gid, true);
      }
      return confirmed.length;
    }
    throw e;
  }

  const groups = result.payload.groups ?? [];
  db.recordCost(ctx.runId, "dedupe", null, result.rawResultMessage);
  db.addArtifact(ctx.runId, "dedupe", null, "jsonl", result.artifactPath);
  for (const g of groups) {
    db.addDedupeGroup(ctx.runId, g);
    const canonical = g.canonical_finding_id;
    for (const fid of g.member_finding_ids) {
      db.assignFindingGroup(fid, g.group_id, fid === canonical);
    }
  }

  st.succeed(
    `[${ctx.runId}] dedupe: ${confirmed.length} findings → ${groups.length} groups`,
  );
  return groups.length;
}
