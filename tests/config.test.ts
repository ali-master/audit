/** Config loading tests. */

import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("default config loads with all stages", () => {
    const cfg = loadConfig();
    for (const name of [
      "recon",
      "hunt",
      "validate",
      "gapfill",
      "dedupe",
      "trace",
      "feedback",
      "report",
    ]) {
      const sc = cfg.get(name);
      expect(sc.model).toBeTruthy();
      expect(sc.concurrency).toBeGreaterThanOrEqual(1);
      expect(sc.tools.length).toBeGreaterThan(0);
    }
  });

  test("hunt and validate use different models (deliberate disagreement)", () => {
    const cfg = loadConfig();
    expect(cfg.get("hunt").model).not.toBe(cfg.get("validate").model);
  });

  test("capConcurrency lowers every stage", () => {
    const cfg = loadConfig();
    cfg.capConcurrency(1);
    for (const sc of Object.values(cfg.stages)) {
      expect(sc.concurrency).toBe(1);
    }
  });

  test("unknown stage throws", () => {
    expect(() => loadConfig().get("nope")).toThrow();
  });
});
