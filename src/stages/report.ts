/** Stage 8: Report — schema-validated final document. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB, Finding } from "../state";
import { log } from "../logger";
import type { StageContext } from "./common";

type Json = any;

export async function runReport(
  ctx: StageContext,
  db: StateDB,
): Promise<string> {
  const reachable = db.getReachableCanonicalFindings(ctx.runId);
  const ready = reachable.map(({ finding, trace }) => ({
    finding: finding.rawJson,
    validation: finding.validationJson,
    trace,
    variants: finding.groupId
      ? groupMembersExcluding(db, ctx.runId, finding.groupId, finding.findingId)
      : [],
  }));

  const sc = ctx.stage("report");
  const schema = ctx.schema("report");
  const target = { repo_path: ctx.repoPath };
  const userInput = {
    run_id: ctx.runId,
    target,
    ready_findings: ready,
    ...ctx.extras(),
  };

  const outPath = join(ctx.resultsDir("report"), "report.json");

  if (ready.length === 0) {
    // No reachable findings — emit a minimal empty report without an agent call.
    const empty = {
      run_id: ctx.runId,
      target,
      summary: { total: 0, by_severity: {} },
      findings: [],
    };
    writeFileSync(outPath, JSON.stringify(empty, null, 2));
    log.info(
      `[${ctx.runId}] report: no reachable findings — wrote empty report to ${outPath}`,
    );
    return outPath;
  }

  const st = log.stage(`[${ctx.runId}] report`, {
    detail: `compiling ${ready.length} ready findings`,
  });
  try {
    const result = await runAgent({
      stage: "report",
      promptFile: ctx.promptFile("08-report"),
      userInput,
      schemaName: schema.name,
      schemaText: schema.text,
      allowedTools: sc.tools,
      model: sc.model,
      cwd: ctx.repoPath,
      addDirs: [ctx.repoPath],
      maxTurns: sc.maxTurns,
      permissionMode: sc.permissionMode,
      artifactDir: ctx.resultsDir("report"),
      artifactName: "report_agent",
      repairAttempts: Math.max(sc.repairAttempts, 2), // report MUST validate
      onActivity: st.onActivity,
    });

    db.recordCost(ctx.runId, "report", null, result.rawResultMessage);
    db.addArtifact(ctx.runId, "report", null, "jsonl", result.artifactPath);
    writeFileSync(outPath, JSON.stringify(result.payload, null, 2));
    st.succeed(
      `[${ctx.runId}] report: ${(result.payload.findings ?? []).length} findings written to ${outPath}`,
    );
    return outPath;
  } catch (e) {
    if (e instanceof AgentRunError || e instanceof TransientAgentError) {
      st.warn(
        `[${ctx.runId}] report agent failed: ${e.message} — emitting fallback report`,
      );
      const fallback = buildFallbackReport(ctx, reachable, target);
      writeFileSync(outPath, JSON.stringify(fallback, null, 2));
      return outPath;
    }
    throw e;
  }
}

function groupMembersExcluding(
  db: StateDB,
  runId: string,
  groupId: string,
  exclude: string,
): string[] {
  const rows = db.raw
    .query(
      "SELECT finding_id FROM findings WHERE run_id = ? AND group_id = ? AND finding_id != ?",
    )
    .all(runId, groupId, exclude) as Array<{ finding_id: string }>;
  return rows.map((r) => r.finding_id);
}

function buildFallbackReport(
  ctx: StageContext,
  reachable: Array<{ finding: Finding; trace: Json }>,
  target: Json,
): Json {
  const bySev: Record<string, number> = {};
  const findingsOut = reachable.map(({ finding: f, trace }) => {
    bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
    return {
      finding_id: f.findingId,
      title: `${f.vulnClass} in ${f.file}`,
      severity: f.severity,
      vuln_class: f.vulnClass,
      file: f.file,
      line_start: f.lineStart,
      line_end: f.lineEnd,
      description: f.description,
      evidence: f.evidence,
      trace: {
        entry_points: trace.entry_points ?? [],
        call_chain: trace.call_chain ?? [],
      },
      recommendation:
        "Review the sink and add input validation / use a safe API.",
    };
  });
  return {
    run_id: ctx.runId,
    target,
    summary: { total: findingsOut.length, by_severity: bySev },
    findings: findingsOut,
  };
}
