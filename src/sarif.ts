/**
 * SARIF 2.1.0 serializer for audit reports.
 *
 * SARIF is the lingua franca of code-scanning tooling — emitting it lets an
 * audit report flow into the GitHub Advanced Security "Security" tab, GitLab
 * SAST, and most triage UIs with no extra integration.
 *
 * The differentiator: most SAST tools emit a single location per finding.
 * audit produces a *reachability trace*, so each result carries a `codeFlows`
 * entry built from the Trace stage's `call_chain` — reviewers see the path
 * from entry point to sink, not just the sink. The baseline fingerprint is
 * emitted as `partialFingerprints` so GitHub dedupes results across line
 * shifts automatically.
 */

import { normalizeRepoPath, fingerprintFinding } from "./baseline";

type Json = any;

// SARIF result.level is a coarse error/warning/note; the numeric
// `security-severity` (0–10, the GitHub convention) preserves the full scale.
const SEV_LEVEL: Record<string, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  informational: "note",
};
const SEV_SCORE: Record<string, string> = {
  critical: "9.5",
  high: "8.0",
  medium: "5.0",
  low: "3.0",
  informational: "0.0",
};

function physicalLocation(file: string, line: number, repoPath?: string): Json {
  return {
    artifactLocation: { uri: normalizeRepoPath(file, repoPath) },
    region: { startLine: Math.max(1, line || 1) },
  };
}

/** Turn a finding's reachability trace into a single SARIF codeFlow. */
function buildCodeFlow(f: Json, repoPath?: string): Json | null {
  const chain = (f.trace?.call_chain ?? []) as Json[];
  if (chain.length === 0) return null;
  const locations = chain.map((frame) => ({
    location: {
      physicalLocation: physicalLocation(
        String(frame.file ?? f.file ?? ""),
        Number(frame.line ?? f.line_start ?? 1),
        repoPath,
      ),
      message: { text: `${frame.function ?? "?"}()` },
    },
  }));
  return { threadFlows: [{ locations }] };
}

export interface SarifOptions {
  toolVersion?: string;
  informationUri?: string;
}

/** Serialize a final report (raw or baseline-applied) to a SARIF 2.1.0 log. */
export function toSarif(report: Json, opts: SarifOptions = {}): Json {
  const repoPath = report?.target?.repo_path;
  const findings = (report?.findings ?? []) as Json[];
  const rules = new Map<string, Json>();
  const results: Json[] = [];

  for (const f of findings) {
    const ruleId = String(f.vuln_class ?? "finding");
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: ruleId,
        shortDescription: { text: ruleId },
        properties: { tags: ["security", ...(f.cwe ? [f.cwe] : [])] },
      });
    }

    const startLine = Math.max(1, Number(f.line_start ?? 1));
    const endLine = Math.max(startLine, Number(f.line_end ?? startLine));
    const result: Json = {
      ruleId,
      level: SEV_LEVEL[f.severity] ?? "warning",
      message: {
        text: `${f.title ?? ruleId}\n\n${f.description ?? ""}`.trim(),
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: normalizeRepoPath(String(f.file ?? ""), repoPath),
            },
            region: { startLine, endLine },
          },
        },
      ],
      partialFingerprints: {
        "auditFingerprint/v1": fingerprintFinding(f, repoPath),
      },
      properties: {
        "security-severity": SEV_SCORE[f.severity] ?? "5.0",
        ...(f.cwe ? { cwe: f.cwe } : {}),
        ...(f.recommendation ? { recommendation: f.recommendation } : {}),
      },
    };

    const flow = buildCodeFlow(f, repoPath);
    if (flow) result.codeFlows = [flow];
    results.push(result);
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "audit",
            informationUri:
              opts.informationUri ?? "https://github.com/ali-master/audit",
            version: opts.toolVersion ?? "0.0.0",
            rules: [...rules.values()],
          },
        },
        results,
      },
    ],
  };
}
