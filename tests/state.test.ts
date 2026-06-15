/** StateDB roundtrip tests. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StateDB } from "../src/state";

let dir: string;
let db: StateDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-state-"));
  db = new StateDB(join(dir, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sampleTask = (taskId: string) => ({
  task_id: taskId,
  attack_class: "sqli",
  scope_hint: "lookup name parameter",
  target_files: ["app.py"],
  rationale: "raw string formatting",
  priority: 1,
  source: "recon",
});

describe("StateDB", () => {
  test("run and task lifecycle", () => {
    const rid = db.createRun("/some/repo", "test_run");
    expect(db.getRun(rid)?.status).toBe("running");

    db.addTask(rid, sampleTask("t_1"));
    const pending = db.getPendingTasks(rid);
    expect(pending.length).toBe(1);
    expect(pending[0].taskId).toBe("t_1");

    db.updateTaskStatus("t_1", "done");
    expect(db.getPendingTasks(rid)).toEqual([]);
    expect(db.getAllTasks(rid).some((t) => t.status === "done")).toBe(true);

    db.finishRun(rid);
    expect(db.getRun(rid)?.status).toBe("completed");
  });

  test("reset incomplete tasks re-queues running + failed only", () => {
    const rid = db.createRun("/some/repo", "test_run");
    for (const [tid, status] of [
      ["t_done", "done"],
      ["t_run", "running"],
      ["t_fail", "failed"],
      ["t_pend", "pending"],
    ] as const) {
      db.addTask(rid, sampleTask(tid));
      db.updateTaskStatus(tid, status);
    }

    expect(db.resetIncompleteTasks(rid)).toBe(2);
    const byStatus = Object.fromEntries(
      db.getAllTasks(rid).map((t) => [t.taskId, t.status]),
    );
    expect(byStatus).toEqual({
      t_done: "done",
      t_run: "pending",
      t_fail: "pending",
      t_pend: "pending",
    });
    expect(new Set(db.getPendingTasks(rid).map((t) => t.taskId))).toEqual(
      new Set(["t_run", "t_fail", "t_pend"]),
    );
  });

  test("finding validation, dedupe, and reachability", () => {
    const rid = db.createRun("/some/repo", "test_run");
    db.addTask(rid, sampleTask("t_1"));
    db.addFinding(rid, "t_1", {
      finding_id: "f_1",
      file: "a.py",
      line_start: 1,
      line_end: 2,
      vuln_class: "sqli",
      severity: "high",
      description: "x",
      evidence_snippet: "y",
      confidence: 0.9,
    });
    expect(db.getUnvalidatedFindings(rid).length).toBe(1);

    db.setFindingValidation("f_1", "confirmed", {
      finding_id: "f_1",
      verdict: "confirmed",
      rationale: "ok",
      validator_confidence: 0.9,
    });
    expect(db.getFindings(rid, { validationStatus: "confirmed" }).length).toBe(
      1,
    );

    db.addDedupeGroup(rid, {
      group_id: "g_1",
      root_cause: "rc",
      canonical_finding_id: "f_1",
      member_finding_ids: ["f_1"],
    });
    db.assignFindingGroup("f_1", "g_1", true);
    expect(db.getFindings(rid, { canonicalOnly: true }).length).toBe(1);

    db.addTrace("f_1", {
      finding_id: "f_1",
      reachable: true,
      confidence: 0.9,
      rationale: "trivial",
      entry_points: [],
      call_chain: [],
    });
    expect(db.getReachableCanonicalFindings(rid).length).toBe(1);
  });

  test("cost aggregation", () => {
    const rid = db.createRun("/r", "test_run");
    db.recordCost(rid, "hunt", "t_1", {
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
      num_turns: 3,
      duration_ms: 1234,
    });
    db.recordCost(rid, "hunt", "t_2", {
      total_cost_usd: 0.02,
      usage: { input_tokens: 200, output_tokens: 100 },
      num_turns: 5,
      duration_ms: 4321,
    });
    expect(Math.abs(db.totalCost(rid) - 0.03)).toBeLessThan(1e-9);
  });
});
