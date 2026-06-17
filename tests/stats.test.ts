/** Cost stats + triage + cost-breakdown DB tests. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { computeStats } from "../src/stats";
import { StateDB } from "../src/state";

let dir: string;
let db: StateDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-stats-"));
  db = new StateDB(join(dir, "state.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedFinding(rid: string, id: string, reachable: boolean): void {
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
    file: "a.ts",
    line_start: 1,
    line_end: 2,
    vuln_class: "sqli",
    severity: "high",
    description: "d",
    evidence_snippet: "e",
    confidence: 0.9,
  });
  db.setFindingValidation(id, "confirmed", { verdict: "confirmed" });
  db.assignFindingGroup(id, "g_" + id, true);
  db.addTrace(id, { finding_id: id, reachable, entry_points: [], call_chain: [] });
}

describe("costByStage + computeStats", () => {
  test("rolls cost up by stage and maps stage→model from config", () => {
    const rid = db.createRun("/repo", "r");
    db.recordCost(rid, "hunt", "t1", {
      total_cost_usd: 0.02,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 4000 },
      num_turns: 3,
    });
    db.recordCost(rid, "hunt", "t2", {
      total_cost_usd: 0.03,
      usage: { input_tokens: 1000, output_tokens: 100 },
      num_turns: 2,
    });
    db.recordCost(rid, "trace", "t1", {
      total_cost_usd: 0.06,
      usage: { input_tokens: 500, output_tokens: 500 },
      num_turns: 4,
    });
    seedFinding(rid, "f1", true);
    seedFinding(rid, "f2", false);

    const stats = computeStats(db, loadConfig(), rid);

    expect(Math.abs(stats.totalUsd - 0.11)).toBeLessThan(1e-9);
    const hunt = stats.stages.find((s) => s.stage === "hunt")!;
    expect(hunt.calls).toBe(2);
    expect(hunt.usd).toBeCloseTo(0.05, 9);
    expect(hunt.model).toBe(loadConfig().get("hunt").model);
    // Most expensive stage first (trace at 0.06 > hunt at 0.05).
    expect(stats.stages[0].stage).toBe("trace");
    // costShare sums to 1.
    expect(stats.stages.reduce((a, s) => a + s.costShare, 0)).toBeCloseTo(1, 9);

    expect(stats.counts.confirmed).toBe(2);
    expect(stats.counts.reachable).toBe(1);
    expect(stats.perConfirmedUsd).toBeCloseTo(0.055, 9);
    expect(stats.perReachableUsd).toBeCloseTo(0.11, 9);
    // cache hit ratio = 4000 / (2500 input + 4000 cache)
    expect(stats.cacheHitRatio).toBeCloseTo(4000 / 6500, 6);
  });

  test("no findings → per-finding metrics are null, model unknown without config", () => {
    const rid = db.createRun("/repo", "r");
    db.recordCost(rid, "recon", null, { total_cost_usd: 0.01, usage: {} });
    const stats = computeStats(db, null, rid);
    expect(stats.perConfirmedUsd).toBeNull();
    expect(stats.perReachableUsd).toBeNull();
    expect(stats.stages[0].model).toBe("?");
  });
});

describe("triage", () => {
  test("upsert + read back", () => {
    const rid = db.createRun("/repo", "r");
    db.setTriage(rid, "f1", "confirmed");
    db.setTriage(rid, "f2", "false_positive", "intentional");
    db.setTriage(rid, "f1", "wont_fix"); // upsert overrides

    const t = db.getTriage(rid);
    expect(t.f1.status).toBe("wont_fix");
    expect(t.f2.status).toBe("false_positive");
    expect(t.f2.note).toBe("intentional");
  });
});
