// Behavioral assertion for Stage 05 (Dedupe).
//
// Validates, from the test's own input + expectations:
//   - PARTITION: every input finding_id appears in exactly one group (the
//     prompt's hard rule: "no drops, no duplicates").
//   - GROUP COUNT: matches `expected_groups`.
//   - CO-GROUPING: each pair in `must_group` lands in the SAME group.
//   - SEPARATION: each pair in `must_separate` lands in DIFFERENT groups.
//   - CANONICAL VALIDITY: each group's canonical_finding_id is one of its
//     members.
//
// Returns a graded result so a partial pass still scores proportionally and the
// reason string pinpoints what diverged.
module.exports = (output, { vars }) => {
  let out;
  try {
    out = JSON.parse(output);
  } catch (e) {
    return { pass: false, score: 0, reason: `output not JSON: ${e.message}` };
  }

  const groups = out.groups || [];
  const inputIds = (vars.input.confirmed_findings || []).map((f) => f.finding_id);
  const checks = [];

  // group lookup: finding_id -> group_id
  const groupOf = {};
  const counts = {};
  for (const g of groups) {
    for (const m of g.member_finding_ids || []) {
      counts[m] = (counts[m] || 0) + 1;
      groupOf[m] = g.group_id;
    }
  }

  // PARTITION
  const dupes = Object.keys(counts).filter((k) => counts[k] > 1);
  const missing = inputIds.filter((id) => !counts[id]);
  const extra = Object.keys(counts).filter((id) => !inputIds.includes(id));
  checks.push({
    name: "partition",
    ok: dupes.length === 0 && missing.length === 0 && extra.length === 0,
    detail: `missing=[${missing}] dupes=[${dupes}] invented=[${extra}]`,
  });

  // GROUP COUNT
  if (typeof vars.expected_groups === "number") {
    checks.push({
      name: "group_count",
      ok: groups.length === vars.expected_groups,
      detail: `expected ${vars.expected_groups}, got ${groups.length}`,
    });
  }

  // CO-GROUPING
  for (const pair of vars.must_group || []) {
    const [a, b] = pair;
    checks.push({
      name: `co-group(${a},${b})`,
      ok: groupOf[a] && groupOf[a] === groupOf[b],
      detail: `${a}->${groupOf[a]} ${b}->${groupOf[b]}`,
    });
  }

  // SEPARATION
  for (const pair of vars.must_separate || []) {
    const [a, b] = pair;
    checks.push({
      name: `separate(${a},${b})`,
      ok: groupOf[a] && groupOf[b] && groupOf[a] !== groupOf[b],
      detail: `${a}->${groupOf[a]} ${b}->${groupOf[b]}`,
    });
  }

  // CANONICAL VALIDITY
  const badCanon = groups.filter(
    (g) => !(g.member_finding_ids || []).includes(g.canonical_finding_id),
  );
  checks.push({
    name: "canonical_is_member",
    ok: badCanon.length === 0,
    detail: badCanon.map((g) => g.group_id).join(","),
  });

  const passed = checks.filter((c) => c.ok).length;
  const score = passed / checks.length;
  const failed = checks.filter((c) => !c.ok);
  return {
    pass: failed.length === 0,
    score,
    reason:
      failed.length === 0
        ? `all ${checks.length} checks passed`
        : `failed: ${failed.map((c) => `${c.name} {${c.detail}}`).join("; ")}`,
  };
};
