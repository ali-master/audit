/** Background-session registry tests. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StateDB } from "../src/state";

let dir: string;
let db: StateDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-sessions-"));
  db = new StateDB(join(dir, "state.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("sessions registry", () => {
  test("record + read back a background session", () => {
    db.createRun("/repo", "bg1");
    db.recordSession("bg1", 4242, "/logs/bg1.log", "run --run-id bg1");
    const s = db.getSession("bg1");
    expect(s?.pid).toBe(4242);
    expect(s?.log_path).toBe("/logs/bg1.log");
    expect(db.getSession("nope")).toBeNull();
  });

  test("runningRuns only returns in-progress runs", () => {
    db.createRun("/repo", "active");
    db.createRun("/repo", "done");
    db.finishRun("done", "completed");
    const ids = db.runningRuns().map((r) => r.run_id);
    expect(ids).toContain("active");
    expect(ids).not.toContain("done");
  });

  test("pruneFinishedSessions drops sessions for non-running runs only", () => {
    db.createRun("/repo", "active");
    db.createRun("/repo", "done");
    db.recordSession("active", 1, null, null);
    db.recordSession("done", 2, null, null);
    db.finishRun("done", "completed");

    expect(db.pruneFinishedSessions()).toBe(1);
    expect(db.getSession("active")).not.toBeNull(); // still running → kept
    expect(db.getSession("done")).toBeNull(); // finished → pruned
  });

  test("recordSession upserts on the same run_id", () => {
    db.createRun("/repo", "bg1");
    db.recordSession("bg1", 1, "/a", "cmd1");
    db.recordSession("bg1", 99, "/b", "cmd2");
    expect(db.getSession("bg1")?.pid).toBe(99);
  });
});
