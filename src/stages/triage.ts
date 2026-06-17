/**
 * Bug-bounty / VDP report triage. Ingest an inbound researcher submission,
 * reproduce it against the real code, then run it through the same machinery
 * that decides what ships in a normal scan:
 *
 *   reproduce → Validate (adversarial, different model) → Trace (reachability)
 *             → dedupe vs known issues → verdict
 *
 * The selling point is reuse: the **skeptical triager** is the existing Validate
 * stage (paid in rejections), and "can an attacker actually reach this?" is the
 * existing Trace gate. Triage just adds an intake reproduction front-end and a
 * dedupe/verdict back-end.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeRepoPath, fingerprintFinding } from "../baseline";
import type { BaselineFile } from "../baseline";
import { validateSchema } from "../jsonUtils";
import { log } from "../logger";
import { TransientAgentError, runAgent, AgentRunError } from "../runner";
import type { StateDB } from "../state";
import type { StageContext } from "./common";
import { runTrace } from "./trace";
import { runValidate } from "./validate";

type Json = any;

const REPRO_TASK_ID = "t_report_repro";

export interface TriageOptions {
  /** Verbatim researcher submission. */
  reportText: string;
  /** Human label for where the report came from (a file path, usually). */
  reportSource: string;
  /** A prior run whose findings (and recon) form the known-issues corpus. */
  knownRunId?: string | null;
  /** A baseline file to also dedupe against. */
  baseline?: BaselineFile | null;
  baselinePath?: string | null;
}

export interface TriageVerdict {
  run_id: string;
  source: string;
  target: { repo_path: string };
  reproduced: boolean;
  recommendation: "accept" | "reject" | "duplicate" | "needs_info" | "not_reproduced";
  validity: "valid" | "invalid" | "needs_more_info" | "not_reproduced";
  reachable: boolean | null;
  severity: string | null;
  duplicate_of: { finding_id: string; source: string; fingerprint: string } | null;
  fingerprint: string | null;
  rationale: string;
  finding: Json | null;
  validation: Json | null;
  trace: Json | null;
}

/**
 * Pure verdict logic — given the four signals (reproduction, adversarial
 * verdict, reachability, dedupe match), decide the recommendation. Exported for
 * testing; the reachability gate is decisive exactly as in a real scan.
 */
export function composeVerdict(input: {
  finding: Json | null;
  validation: Json | null;
  trace: Json | null;
  duplicate: { finding_id: string; source: string; fingerprint: string } | null;
}): {
  reproduced: boolean;
  recommendation: TriageVerdict["recommendation"];
  validity: TriageVerdict["validity"];
  reachable: boolean | null;
  severity: string | null;
  rationale: string;
} {
  const { finding, validation, trace, duplicate } = input;

  if (!finding)
    return {
      reproduced: false,
      recommendation: "not_reproduced",
      validity: "not_reproduced",
      reachable: null,
      severity: null,
      rationale:
        "Could not reproduce the reported issue against the current code — the claimed sink is absent, guarded, or unreachable as described.",
    };

  const severity = finding.severity ?? null;
  const verdict = validation?.verdict ?? "needs_more_info";
  const validity: TriageVerdict["validity"] =
    verdict === "confirmed"
      ? "valid"
      : verdict === "rejected"
        ? "invalid"
        : "needs_more_info";
  const reachable = trace ? Boolean(trace.reachable) : null;

  if (duplicate)
    return {
      reproduced: true,
      recommendation: "duplicate",
      validity,
      reachable,
      severity,
      rationale: `Reproduced, but it is a duplicate of known finding ${duplicate.finding_id} (${duplicate.source}).`,
    };

  if (verdict === "rejected")
    return {
      reproduced: true,
      recommendation: "reject",
      validity,
      reachable,
      severity,
      rationale: `Reproduced the described pattern, but the independent reviewer rejected it: ${validation?.rationale ?? "no benign-input guard was bypassed."}`,
    };

  if (verdict === "needs_more_info")
    return {
      reproduced: true,
      recommendation: "needs_info",
      validity,
      reachable,
      severity,
      rationale: `Reproduced, but the reviewer could not confirm it without more information: ${validation?.rationale ?? ""}`.trim(),
    };

  // confirmed — reachability is the gate.
  if (reachable === false)
    return {
      reproduced: true,
      recommendation: "reject",
      validity,
      reachable,
      severity,
      rationale: `Confirmed as a real code defect, but no attacker-controlled input can reach the sink from outside (${trace?.rationale ?? "no external entry point"}). Out of scope for an external report.`,
    };

  return {
    reproduced: true,
    recommendation: "accept",
    validity,
    reachable,
    severity,
    rationale:
      "Reproduced, independently confirmed, and reachable from an external entry point. Valid submission — accept and route for remediation.",
  };
}

/** Fingerprint every finding of a prior run → fingerprint:finding_id. */
function knownFingerprints(
  db: StateDB,
  knownRunId: string,
): Map<string, string> {
  const repo = db.getRun(knownRunId)?.repo_path;
  const map = new Map<string, string>();
  for (const f of db.getFindings(knownRunId)) {
    const fp = fingerprintFinding(
      { vuln_class: f.vulnClass, file: f.file, evidence: f.evidence },
      repo,
    );
    if (!map.has(fp)) map.set(fp, f.findingId);
  }
  return map;
}

export async function runTriage(
  ctx: StageContext,
  db: StateDB,
  opts: TriageOptions,
): Promise<TriageVerdict> {
  const target = { repo_path: ctx.repoPath };
  const outPath = join(ctx.resultsDir("triage"), "verdict.json");

  // Borrow the known run's architecture map so Trace has context (a triage run
  // has no Recon of its own).
  if (opts.knownRunId && db.getReconOutput(ctx.runId) === null) {
    const recon = db.getReconOutput(opts.knownRunId);
    if (recon) db.saveReconOutput(ctx.runId, recon);
  }

  const sc = ctx.stage("triage");
  const schema = ctx.schema("finding");
  db.addTask(ctx.runId, {
    task_id: REPRO_TASK_ID,
    source: "report",
    attack_class: "researcher_report",
    scope_hint: opts.reportText.split("\n")[0].slice(0, 200),
    target_files: [],
    rationale: "inbound bug-bounty / VDP submission",
    priority: 1,
  });

  const st = log.stage(`[${ctx.runId}] triage`, {
    detail: `reproducing report · model=${sc.model}`,
  });

  let reproduced: Json | null = null;
  try {
    const result = await runAgent({
      stage: "triage",
      promptFile: ctx.promptFile("10-triage-intake"),
      userInput: {
        task_id: REPRO_TASK_ID,
        report: opts.reportText,
        repo_path: ctx.repoPath,
        ...ctx.extras(),
      },
      schemaName: schema.name,
      schemaText: schema.text,
      allowedTools: sc.tools,
      model: sc.model,
      cwd: ctx.workDir("triage", REPRO_TASK_ID),
      addDirs: [ctx.repoPath],
      maxTurns: sc.maxTurns,
      permissionMode: sc.permissionMode,
      artifactDir: ctx.resultsDir("triage"),
      artifactName: "intake",
      repairAttempts: sc.repairAttempts,
      onActivity: st.onActivity,
    });
    db.recordCost(ctx.runId, "triage", REPRO_TASK_ID, result.rawResultMessage);
    db.addArtifact(ctx.runId, "triage", REPRO_TASK_ID, "jsonl", result.artifactPath);
    // The intake prompt caps output at one finding — take the first.
    reproduced = (result.payload.findings ?? [])[0] ?? null;
  } catch (e) {
    if (e instanceof AgentRunError || e instanceof TransientAgentError) {
      st.warn(`[${ctx.runId}] triage: reproduction agent failed: ${e.message}`);
      reproduced = null;
    } else {
      throw e;
    }
  }

  if (!reproduced) {
    st.succeed(`[${ctx.runId}] triage: not reproduced`);
    return finalize(db, ctx, opts, outPath, target, {
      finding: null,
      validation: null,
      trace: null,
      duplicate: null,
      fingerprint: null,
    });
  }

  db.addFinding(ctx.runId, REPRO_TASK_ID, reproduced);
  const findingId = reproduced.finding_id as string;
  st.succeed(`[${ctx.runId}] triage: reproduced ${findingId} — handing to reviewer`);

  // Adversarial review (the skeptical triager) — different model, paid in rejections.
  await runValidate(ctx, db);
  const validated = db.getFindings(ctx.runId).find((f) => f.findingId === findingId);

  // Reachability gate — only trace confirmed findings (mark canonical so Trace picks it up).
  let traceJson: Json | null = null;
  if (validated?.validationStatus === "confirmed") {
    db.assignFindingGroup(findingId, `g_${findingId}`, true);
    await runTrace(ctx, db);
    traceJson = db.getTrace(findingId);
  }

  // Dedupe against known issues (prior run + baseline) by stable fingerprint.
  const fp = fingerprintFinding(reproduced, ctx.repoPath);
  let duplicate: TriageVerdict["duplicate_of"] = null;
  if (opts.knownRunId) {
    const known = knownFingerprints(db, opts.knownRunId);
    const hit = known.get(fp);
    if (hit) duplicate = { finding_id: hit, source: `run:${opts.knownRunId}`, fingerprint: fp };
  }
  if (!duplicate && opts.baseline) {
    const hit = opts.baseline.fingerprints.find((e) => e.fingerprint === fp);
    if (hit)
      duplicate = {
        finding_id: hit.finding_id ?? "(baseline)",
        source: `baseline:${opts.baselinePath ?? "baseline"}`,
        fingerprint: fp,
      };
  }

  return finalize(db, ctx, opts, outPath, target, {
    finding: validated?.rawJson ?? reproduced,
    validation: validated?.validationJson ?? null,
    trace: traceJson,
    duplicate,
    fingerprint: fp,
  });
}

function finalize(
  db: StateDB,
  ctx: StageContext,
  opts: TriageOptions,
  outPath: string,
  target: { repo_path: string },
  signals: {
    finding: Json | null;
    validation: Json | null;
    trace: Json | null;
    duplicate: TriageVerdict["duplicate_of"];
    fingerprint: string | null;
  },
): TriageVerdict {
  const decided = composeVerdict(signals);
  // Normalize the finding's path for a portable verdict artifact.
  if (signals.finding?.file)
    signals.finding = {
      ...signals.finding,
      file: normalizeRepoPath(String(signals.finding.file), ctx.repoPath),
    };

  const verdict: TriageVerdict = {
    run_id: ctx.runId,
    source: opts.reportSource,
    target,
    reproduced: decided.reproduced,
    recommendation: decided.recommendation,
    validity: decided.validity,
    reachable: decided.reachable,
    severity: decided.severity,
    duplicate_of: signals.duplicate,
    fingerprint: signals.fingerprint,
    rationale: decided.rationale,
    finding: signals.finding,
    validation: signals.validation,
    trace: signals.trace,
  };

  const errs = validateSchema(verdict, "triage_verdict.schema.json");
  if (errs.length)
    log.warn(`[${ctx.runId}] triage verdict schema warnings: ${errs.join("; ")}`);

  writeFileSync(outPath, JSON.stringify(verdict, null, 2));
  db.addArtifact(ctx.runId, "triage", null, "json", outPath);
  return verdict;
}
