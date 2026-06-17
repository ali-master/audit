/** Baseline fingerprinting + delta tests. */

import { describe, expect, test } from "bun:test";
import {
  applyBaseline,
  buildBaseline,
  fingerprintFinding,
  normalizeRepoPath,
  parseBaseline,
} from "../src/baseline";

const finding = (over: Record<string, unknown> = {}) => ({
  finding_id: "f_1",
  vuln_class: "sql_injection",
  severity: "high",
  file: "/repo/src/db.ts",
  line_start: 10,
  line_end: 12,
  evidence: "const q = `SELECT * FROM users WHERE id=${id}`",
  ...over,
});

describe("fingerprintFinding", () => {
  test("is stable across line shifts (line numbers excluded)", () => {
    const a = fingerprintFinding(finding({ line_start: 10, line_end: 12 }), "/repo");
    const b = fingerprintFinding(finding({ line_start: 99, line_end: 101 }), "/repo");
    expect(a).toBe(b);
  });

  test("survives reindentation / whitespace changes", () => {
    const a = fingerprintFinding(finding({ evidence: "const q = `SELECT * FROM users WHERE id=${id}`" }), "/repo");
    const b = fingerprintFinding(finding({ evidence: "    const   q =  `SELECT * FROM users WHERE id=${id}`  " }), "/repo");
    expect(a).toBe(b);
  });

  test("changes when the sink code changes", () => {
    const a = fingerprintFinding(finding(), "/repo");
    const b = fingerprintFinding(finding({ evidence: "db.query(sql, [id])" }), "/repo");
    expect(a).not.toBe(b);
  });

  test("absolute and repo-relative paths fingerprint identically", () => {
    const abs = fingerprintFinding(finding({ file: "/repo/src/db.ts" }), "/repo");
    const rel = fingerprintFinding(finding({ file: "src/db.ts" }), "/repo");
    expect(abs).toBe(rel);
  });

  test("accepts the raw hunt shape (evidence_snippet)", () => {
    const report = fingerprintFinding(finding({ evidence: "X" }), "/repo");
    const hunt = fingerprintFinding(
      finding({ evidence: undefined, evidence_snippet: "X" }),
      "/repo",
    );
    expect(report).toBe(hunt);
  });
});

describe("normalizeRepoPath", () => {
  test("strips repo prefix and normalizes separators", () => {
    expect(normalizeRepoPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
  });
  test("leaves paths outside the repo untouched", () => {
    expect(normalizeRepoPath("/other/a.ts", "/repo")).toBe("/other/a.ts");
  });
});

const report = (findings: unknown[]) => ({
  run_id: "r",
  target: { repo_path: "/repo" },
  summary: { total: findings.length, by_severity: {} },
  findings,
});

describe("buildBaseline + applyBaseline", () => {
  test("baseline round-trips through JSON", () => {
    const b = buildBaseline(report([finding()]));
    const parsed = parseBaseline(JSON.stringify(b));
    expect(parsed.fingerprints.length).toBe(1);
    expect(parsed.version).toBe(b.version);
  });

  test("dedupes identical findings in the baseline", () => {
    const b = buildBaseline(report([finding(), finding()]));
    expect(b.fingerprints.length).toBe(1);
  });

  test("classifies NEW, STILL-PRESENT, and FIXED", () => {
    const old = finding({ finding_id: "f_old", evidence: "OLD-SINK" });
    const keep = finding({ finding_id: "f_keep", evidence: "KEEP-SINK" });
    const baseline = buildBaseline(report([old, keep]));

    // Next run: keep is still here, old is gone, a brand-new one appears.
    const fresh = finding({ finding_id: "f_new", evidence: "NEW-SINK", severity: "critical" });
    const { report: view, delta } = applyBaseline(
      report([keep, fresh]),
      baseline,
    );

    expect(delta.new_count).toBe(1);
    expect(delta.still_present_count).toBe(1);
    expect(delta.fixed_count).toBe(1);
    // Suppressed view shows only the NEW finding, with a recomputed summary.
    expect(view.findings.length).toBe(1);
    expect(view.findings[0].finding_id).toBe("f_new");
    expect(view.summary.total).toBe(1);
    expect(view.summary.by_severity).toEqual({ critical: 1 });
  });

  test("empty baseline leaves everything NEW", () => {
    const { delta } = applyBaseline(report([finding()]), {
      version: 1,
      fingerprints: [],
    });
    expect(delta.new_count).toBe(1);
    expect(delta.still_present_count).toBe(0);
  });

  test("parseBaseline rejects malformed input", () => {
    expect(() => parseBaseline("{}")).toThrow();
    expect(() => parseBaseline("[]")).toThrow();
  });
});
