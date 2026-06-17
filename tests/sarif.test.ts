/** SARIF serializer tests. */

import { describe, expect, test } from "bun:test";
import { toSarif } from "../src/sarif";

const report = {
  run_id: "r",
  target: { repo_path: "/repo" },
  summary: { total: 2, by_severity: { high: 1, low: 1 } },
  findings: [
    {
      finding_id: "f_1",
      title: "SQLi",
      severity: "high",
      vuln_class: "sql_injection",
      cwe: "CWE-89",
      file: "/repo/src/db.ts",
      line_start: 10,
      line_end: 12,
      description: "bad",
      evidence: "q = `...${x}`",
      trace: {
        entry_points: [{ kind: "http_route", location: "POST /x" }],
        call_chain: [
          { file: "/repo/src/api.ts", function: "handle", line: 5 },
          { file: "/repo/src/db.ts", function: "query", line: 11 },
        ],
      },
      recommendation: "parameterize",
    },
    {
      finding_id: "f_2",
      title: "Redirect",
      severity: "low",
      vuln_class: "open_redirect",
      file: "/repo/src/r.ts",
      line_start: 3,
      line_end: 3,
      description: "x",
      evidence: "redirect(next)",
      trace: { entry_points: [], call_chain: [] },
      recommendation: "allowlist",
    },
  ],
};

describe("toSarif", () => {
  const sarif = toSarif(report, { toolVersion: "1.2.3" });
  const run = sarif.runs[0];

  test("is a well-formed SARIF 2.1.0 log", () => {
    expect(sarif.version).toBe("2.1.0");
    expect(run.tool.driver.name).toBe("audit");
    expect(run.tool.driver.version).toBe("1.2.3");
    expect(run.results.length).toBe(2);
  });

  test("derives one rule per distinct vuln_class", () => {
    const ids = run.tool.driver.rules.map((r: any) => r.id).sort();
    expect(ids).toEqual(["open_redirect", "sql_injection"]);
  });

  test("maps severity to level + security-severity", () => {
    const high = run.results[0];
    expect(high.level).toBe("error");
    expect(high.properties["security-severity"]).toBe("8.0");
    const low = run.results[1];
    expect(low.level).toBe("note");
  });

  test("emits paths repo-relative for the Security tab", () => {
    expect(
      run.results[0].locations[0].physicalLocation.artifactLocation.uri,
    ).toBe("src/db.ts");
  });

  test("turns the reachability trace into a codeFlow", () => {
    const flow = run.results[0].codeFlows[0].threadFlows[0].locations;
    expect(flow.length).toBe(2);
    expect(flow[1].location.physicalLocation.artifactLocation.uri).toBe(
      "src/db.ts",
    );
    // Findings without a call chain have no codeFlow.
    expect(run.results[1].codeFlows).toBeUndefined();
  });

  test("carries a stable partialFingerprint for cross-run dedupe", () => {
    expect(
      run.results[0].partialFingerprints["auditFingerprint/v1"],
    ).toMatch(/^[0-9a-f]{32}$/);
  });
});
