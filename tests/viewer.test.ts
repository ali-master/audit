/** Triage viewer data shaping + baseline-from-findings tests. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { baselineFromFindings } from "../src/baseline";
import { StateDB } from "../src/state";
import { buildViewerFindings } from "../src/viewer";

let dir: string;
let db: StateDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-viewer-"));
  db = new StateDB(join(dir, "state.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(rid: string, id: string, reachable: boolean): void {
  db.addTask(rid, {
    task_id: "t_" + id,
    attack_class: "sqli",
    scope_hint: "x",
    target_files: ["a.ts"],
    priority: 1,
    source: "recon",
  });
  db.addFinding(rid, "t_" + id, {
    finding_id: id,
    file: "/repo/a.ts",
    line_start: 1,
    line_end: 2,
    vuln_class: "sqli",
    severity: "high",
    description: "d",
    evidence_snippet: "SELECT " + id,
    confidence: 0.8,
  });
  db.addTrace(id, {
    finding_id: id,
    reachable,
    entry_points: [{ kind: "http_route", location: "POST /x" }],
    call_chain: [{ file: "/repo/a.ts", function: "h", line: 1 }],
  });
}

describe("buildViewerFindings", () => {
  test("joins trace reachability + triage status", () => {
    const rid = db.createRun("/repo", "r");
    seed(rid, "f1", true);
    seed(rid, "f2", false);
    db.setTriage(rid, "f1", "confirmed");

    const rows = buildViewerFindings(db, rid).sort((a, b) =>
      a.finding_id.localeCompare(b.finding_id),
    );
    expect(rows.length).toBe(2);
    expect(rows[0].reachable).toBe(true);
    expect(rows[0].triage_status).toBe("confirmed");
    expect(rows[0].call_chain.length).toBe(1);
    expect(rows[1].reachable).toBe(false);
    expect(rows[1].triage_status).toBe("new"); // default when untriaged
  });
});

describe("baselineFromFindings (viewer export)", () => {
  test("fingerprints DB-shaped findings (vulnClass/evidence)", () => {
    const rid = db.createRun("/repo", "r");
    seed(rid, "f1", true);
    const findings = db.getFindings(rid);
    const baseline = baselineFromFindings(findings, "/repo", rid);
    expect(baseline.fingerprints.length).toBe(1);
    expect(baseline.fingerprints[0].file).toBe("a.ts"); // repo-relative
    expect(baseline.run_id).toBe(rid);
  });
});
