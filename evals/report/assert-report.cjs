// Behavioral assertion for Stage 08 (Report).
//
// From the test's input + expectations, checks the rules the prompt states:
//   - REACHABLE-ONLY: no finding with trace.reachable === false is shipped.
//   - NO INVENTION: every shipped finding_id came from the input set.
//   - EXPECTED COUNT: findings.length === expected_findings.
//   - SUMMARY CONSISTENCY: summary.total === findings.length, and the
//     by_severity buckets sum to total.
//   - SEVERITY OVERRIDES: when `expected_severity` maps finding_id -> sev
//     (e.g. an admin-gated trace downgrades high -> medium), enforce it.
module.exports = (output, { vars }) => {
  let out;
  try {
    out = JSON.parse(output);
  } catch (e) {
    return { pass: false, score: 0, reason: `output not JSON: ${e.message}` };
  }

  const ready = vars.input.ready_findings || [];
  const reachableIds = ready
    .filter((rf) => rf.trace && rf.trace.reachable)
    .map((rf) => rf.finding.finding_id);
  const allIds = ready.map((rf) => rf.finding.finding_id);
  const unreachableIds = allIds.filter((id) => !reachableIds.includes(id));

  const findings = out.findings || [];
  const shippedIds = findings.map((f) => f.finding_id);
  const checks = [];

  // REACHABLE-ONLY
  const leaked = shippedIds.filter((id) => unreachableIds.includes(id));
  checks.push({
    name: "reachable_only",
    ok: leaked.length === 0,
    detail: `unreachable shipped: [${leaked}]`,
  });

  // NO INVENTION
  const invented = shippedIds.filter((id) => !allIds.includes(id));
  checks.push({
    name: "no_invention",
    ok: invented.length === 0,
    detail: `invented: [${invented}]`,
  });

  // EXPECTED COUNT
  if (typeof vars.expected_findings === "number") {
    checks.push({
      name: "expected_count",
      ok: findings.length === vars.expected_findings,
      detail: `expected ${vars.expected_findings}, got ${findings.length}`,
    });
  }

  // SUMMARY CONSISTENCY
  const total = out.summary ? out.summary.total : undefined;
  checks.push({
    name: "total_matches_findings",
    ok: total === findings.length,
    detail: `summary.total=${total}, findings=${findings.length}`,
  });
  const bySev = (out.summary && out.summary.by_severity) || {};
  const sevSum = Object.values(bySev).reduce((a, b) => a + (b || 0), 0);
  checks.push({
    name: "by_severity_sums_to_total",
    ok: sevSum === total,
    detail: `by_severity sum=${sevSum}, total=${total}`,
  });

  // SEVERITY OVERRIDES
  if (vars.expected_severity) {
    for (const [fid, sev] of Object.entries(vars.expected_severity)) {
      const f = findings.find((x) => x.finding_id === fid);
      checks.push({
        name: `severity(${fid})`,
        ok: f && f.severity === sev,
        detail: `got ${f && f.severity}, expected ${sev}`,
      });
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    pass: failed.length === 0,
    score: checks.filter((c) => c.ok).length / checks.length,
    reason:
      failed.length === 0
        ? `all ${checks.length} checks passed`
        : `failed: ${failed.map((c) => `${c.name} {${c.detail}}`).join("; ")}`,
  };
};
