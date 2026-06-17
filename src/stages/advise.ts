/**
 * Remediation advice — code-grounded "how to fix" guidance per finding.
 *
 * An agent reads the actual sink + trace and explains the fix in terms of the
 * real code (the function, the framework's safe API, the exact change). This is
 * deliberately distinct from the `fix` stage: `fix` writes a patch in a
 * worktree; `advise` produces explanatory guidance that the report and the
 * triage viewer surface inline. Read-only, so it's cheap and safe to run on
 * demand (`audit advise`, or the viewer's "Generate fix" button).
 */

import { log } from "../logger";
import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB, Finding } from "../state";
import {  mapWithConcurrency } from "./common";
import type {StageContext} from "./common";

type Json = any;

/** Generate (and persist) remediation advice for one finding. Returns the payload. */
export async function adviseOne(
  ctx: StageContext,
  db: StateDB,
  finding: Finding,
): Promise<Json> {
  const sc = ctx.stage("advise");
  const schema = ctx.schema("remediation");
  const result = await runAgent({
    stage: "advise",
    promptFile: ctx.promptFile("11-advise"),
    userInput: {
      finding: finding.rawJson,
      trace: db.getTrace(finding.findingId),
      repo_path: ctx.repoPath,
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
    artifactDir: ctx.resultsDir("advise"),
    artifactName: finding.findingId,
    repairAttempts: sc.repairAttempts,
  });
  // Pin finding_id (the agent occasionally drifts) before persisting.
  const payload = { ...result.payload, finding_id: finding.findingId };
  db.setRemediation(ctx.runId, finding.findingId, payload);
  db.recordCost(ctx.runId, "advise", finding.findingId, result.rawResultMessage);
  db.addArtifact(ctx.runId, "advise", finding.findingId, "jsonl", result.artifactPath);
  return payload;
}

/** Convenience wrapper used by the viewer: advise a finding by id. */
export async function adviseFinding(
  ctx: StageContext,
  db: StateDB,
  findingId: string,
): Promise<Json> {
  const f = db.getFindings(ctx.runId).find((x) => x.findingId === findingId);
  if (!f) throw new Error(`unknown finding ${findingId}`);
  return adviseOne(ctx, db, f);
}

export interface AdviseOptions {
  /** Which findings to advise; defaults to reachable canonical (the report set). */
  scope?: "reachable" | "confirmed" | "all";
  /** A single finding id (overrides scope). */
  findingId?: string;
  /** Re-generate even if advice already exists. */
  force?: boolean;
}

export interface AdviseSummary {
  advised: number;
  skipped: number;
  failed: number;
}

function selectFindings(db: StateDB, runId: string, opts: AdviseOptions): Finding[] {
  if (opts.findingId) {
    const f = db.getFindings(runId).find((x) => x.findingId === opts.findingId);
    return f ? [f] : [];
  }
  if (opts.scope === "all") return db.getFindings(runId);
  if (opts.scope === "confirmed")
    return db.getFindings(runId, { validationStatus: "confirmed" });
  // default: reachable canonical — the findings that actually ship.
  return db.getReachableCanonicalFindings(runId).map((r) => r.finding);
}

export async function runAdvise(
  ctx: StageContext,
  db: StateDB,
  opts: AdviseOptions = {},
): Promise<AdviseSummary> {
  let targets = selectFindings(db, ctx.runId, opts);
  if (!opts.force)
    targets = targets.filter((f) => db.getRemediation(f.findingId) === null);

  if (targets.length === 0) {
    log.info(`[${ctx.runId}] advise: nothing to do`);
    return { advised: 0, skipped: 0, failed: 0 };
  }

  const sc = ctx.stage("advise");
  const st = log.stage(`[${ctx.runId}] advise`, {
    total: targets.length,
    detail: `model=${sc.model}`,
  });
  const counters = { advised: 0, failed: 0 };

  await mapWithConcurrency(targets, sc.concurrency, async (f) => {
    try {
      await adviseOne(ctx, db, f);
      counters.advised++;
      st.step(`${f.findingId} advised`);
    } catch (e) {
      if (e instanceof AgentRunError || e instanceof TransientAgentError) {
        log.warn(`[${ctx.runId}] advise ${f.findingId} failed: ${e.message}`);
        counters.failed++;
        st.step(`${f.findingId} failed`);
        return;
      }
      throw e;
    }
  });

  st.succeed(
    `[${ctx.runId}] advise: ${counters.advised} advised, ${counters.failed} failed`,
  );
  return { advised: counters.advised, skipped: 0, failed: counters.failed };
}
