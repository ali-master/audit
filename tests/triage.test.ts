/** Triage verdict decision matrix + cross-run dedupe fingerprinting. */

import { describe, expect, test } from "bun:test";
import { fingerprintFinding } from "../src/baseline";
import { composeVerdict } from "../src/stages/triage";

const finding = { vuln_class: "sql_injection", file: "a.ts", severity: "high", evidence: "q=`${x}`" };
const confirmed = { verdict: "confirmed", rationale: "reaches the sink with no guard, demonstrated" };
const rejected = { verdict: "rejected", rationale: "the input is parameterized upstream at db.ts:10" };
const needs = { verdict: "needs_more_info", rationale: "could not determine the auth context" };

describe("composeVerdict", () => {
  test("not reproduced → not_reproduced", () => {
    const v = composeVerdict({ finding: null, validation: null, trace: null, duplicate: null });
    expect(v.recommendation).toBe("not_reproduced");
    expect(v.reproduced).toBe(false);
    expect(v.reachable).toBeNull();
  });

  test("confirmed + reachable → accept", () => {
    const v = composeVerdict({
      finding,
      validation: confirmed,
      trace: { reachable: true },
      duplicate: null,
    });
    expect(v.recommendation).toBe("accept");
    expect(v.validity).toBe("valid");
    expect(v.reachable).toBe(true);
    expect(v.severity).toBe("high");
  });

  test("confirmed but NOT reachable → reject (gate is decisive)", () => {
    const v = composeVerdict({
      finding,
      validation: confirmed,
      trace: { reachable: false, rationale: "no external entry point" },
      duplicate: null,
    });
    expect(v.recommendation).toBe("reject");
    expect(v.validity).toBe("valid"); // still a real defect…
    expect(v.reachable).toBe(false); // …but out of scope
  });

  test("rejected by adversarial reviewer → reject", () => {
    const v = composeVerdict({ finding, validation: rejected, trace: null, duplicate: null });
    expect(v.recommendation).toBe("reject");
    expect(v.validity).toBe("invalid");
  });

  test("needs_more_info → needs_info", () => {
    const v = composeVerdict({ finding, validation: needs, trace: null, duplicate: null });
    expect(v.recommendation).toBe("needs_info");
    expect(v.validity).toBe("needs_more_info");
  });

  test("duplicate takes precedence over validity", () => {
    const v = composeVerdict({
      finding,
      validation: confirmed,
      trace: { reachable: true },
      duplicate: { finding_id: "f_known", source: "run:prev", fingerprint: "abc" },
    });
    expect(v.recommendation).toBe("duplicate");
    expect(v.rationale).toContain("f_known");
  });
});

describe("cross-run dedupe via fingerprint", () => {
  test("a re-reported known bug fingerprints identically (line-shift robust)", () => {
    const known = fingerprintFinding(
      { vuln_class: "sql_injection", file: "/repo/a.ts", evidence: "q = `SELECT ${x}`", line_start: 10 },
      "/repo",
    );
    const reported = fingerprintFinding(
      { vuln_class: "sql_injection", file: "a.ts", evidence: "q = `SELECT ${x}`", line_start: 88 },
      "/repo",
    );
    expect(reported).toBe(known); // → triage flags it as duplicate
  });
});
