/**
 * Baseline + delta. Gives every finding a stable fingerprint so a run can be
 * compared against a previously-accepted baseline:
 *
 *   - findings whose fingerprint is in the baseline are STILL-PRESENT (known,
 *     suppressed from the working report),
 *   - findings not in the baseline are NEW,
 *   - baseline entries with no matching current finding are FIXED.
 *
 * The fingerprint is `vuln_class + normalized-path + sink-code-hash`. Hashing
 * the (whitespace-normalized) evidence snippet rather than line numbers keeps
 * the identity stable when surrounding code shifts the finding up or down.
 */

import { createHash } from "node:crypto";
import { sep, relative, isAbsolute } from "node:path";

type Json = any;

export const BASELINE_VERSION = 1;

export interface BaselineEntry {
  fingerprint: string;
  finding_id?: string;
  vuln_class?: string;
  file?: string;
  severity?: string;
}

export interface BaselineFile {
  version: number;
  run_id?: string;
  fingerprints: BaselineEntry[];
}

export interface Delta {
  baseline_total: number;
  new_count: number;
  still_present_count: number;
  fixed_count: number;
  /** Baseline entries with no matching finding in the current run. */
  fixed: BaselineEntry[];
}

/** Repo-relative, posix-separated path — stable across machines and OSes. */
export function normalizeRepoPath(file: string, repoPath?: string): string {
  let p = file;
  if (repoPath && isAbsolute(file)) {
    const rel = relative(repoPath, file);
    if (rel && !rel.startsWith("..")) p = rel;
  }
  return p.split(sep).join("/").replace(/^\.\//, "");
}

/** Collapse whitespace so the hash survives reformatting and re-indentation. */
function normalizeCode(s: string): string {
  return (s ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/[ \t]+/g, " "))
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * Stable, line-shift-robust fingerprint for a report finding. Accepts both the
 * report shape (`evidence`) and the raw hunt shape (`evidence_snippet`).
 */
export function fingerprintFinding(f: Json, repoPath?: string): string {
  const vulnClass = String(f.vuln_class ?? "");
  const file = normalizeRepoPath(String(f.file ?? ""), repoPath);
  const code = normalizeCode(String(f.evidence ?? f.evidence_snippet ?? ""));
  return createHash("sha256")
    .update(`${vulnClass}\n${file}\n${code}`)
    .digest("hex")
    .slice(0, 32);
}

/** Build a baseline document from a final report (one entry per finding). */
export function buildBaseline(report: Json): BaselineFile {
  const repoPath = report?.target?.repo_path;
  const seen = new Set<string>();
  const fingerprints: BaselineEntry[] = [];
  for (const f of report?.findings ?? []) {
    const fp = fingerprintFinding(f, repoPath);
    if (seen.has(fp)) continue;
    seen.add(fp);
    fingerprints.push({
      fingerprint: fp,
      finding_id: f.finding_id,
      vuln_class: f.vuln_class,
      file: normalizeRepoPath(String(f.file ?? ""), repoPath),
      severity: f.severity,
    });
  }
  return { version: BASELINE_VERSION, run_id: report?.run_id, fingerprints };
}

/** Parse + sanity-check a baseline file's JSON payload. */
export function parseBaseline(raw: string): BaselineFile {
  const data = JSON.parse(raw) as Json;
  if (!data || !Array.isArray(data.fingerprints))
    throw new Error("invalid baseline file: missing `fingerprints` array");
  return data as BaselineFile;
}

/**
 * Apply a baseline to a report: suppress STILL-PRESENT findings, recompute the
 * summary over the NEW findings, and attach a `delta` block. The returned
 * report's `findings` are the NEW ones only — exactly "show me what changed".
 */
export function applyBaseline(
  report: Json,
  baseline: BaselineFile,
): { report: Json; delta: Delta } {
  const repoPath = report?.target?.repo_path;
  const known = new Set(baseline.fingerprints.map((e) => e.fingerprint));

  const current = report?.findings ?? [];
  const currentFps = new Set<string>();
  const fresh: Json[] = [];
  for (const f of current) {
    const fp = fingerprintFinding(f, repoPath);
    currentFps.add(fp);
    if (!known.has(fp)) fresh.push(f);
  }

  const fixed = baseline.fingerprints.filter(
    (e) => !currentFps.has(e.fingerprint),
  );
  const delta: Delta = {
    baseline_total: baseline.fingerprints.length,
    new_count: fresh.length,
    still_present_count: current.length - fresh.length,
    fixed_count: fixed.length,
    fixed,
  };

  const bySeverity: Record<string, number> = {};
  for (const f of fresh)
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  return {
    report: {
      ...report,
      findings: fresh,
      summary: { total: fresh.length, by_severity: bySeverity },
      delta,
    },
    delta,
  };
}
