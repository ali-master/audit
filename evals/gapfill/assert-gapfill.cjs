// Behavioral assertion for Stage 04 (Gapfill).
//
// Gapfill is pure-reasoning over Recon's structured output: it builds a
// subsystem × attack_class coverage matrix from the input and emits NEW hunt
// tasks aimed at under-covered cells. Every rule below is a deterministic
// function of the test's own `input` + expectations — no repo access required,
// so this scores the real contract, not hallucinated file reads.
//
// Checks:
//   - SCHEMA: validates against gapfill_output.schema.json (+ hunt_task $ref).
//   - NO REISSUE: no new task repeats a (subsystem, attack_class) tuple that
//     already appears in completed_tasks (the prompt's hard dedup rule).
//   - CAP: new_tasks.length <= max_new_tasks.
//   - SOURCE TAG: every new task has source === "gapfill".
//   - ID PREFIX: every new task_id starts with "t_gf_".
//   - PRIORITY: every priority is an integer in 1..5 (not a string).
//   - MUST COVER: each [subsystem, attack_class] in `must_cover` is targeted by
//     at least one new task (the obvious gap was actually filled).
const { buildValidator, schemaCheck } = require("../lib/validate-schema.cjs");

const validate = buildValidator("schemas/gapfill_output.schema.json", [
  "schemas/hunt_task.schema.json",
]);

const tuple = (s, a) => `${(s || "").toLowerCase()}|${(a || "").toLowerCase()}`;

module.exports = (output, { vars }) => {
  let out;
  try {
    out = JSON.parse(output);
  } catch (e) {
    return { pass: false, score: 0, reason: `output not JSON: ${e.message}` };
  }

  const checks = [];
  const tasks = out.new_tasks || [];

  // SCHEMA
  const sc = schemaCheck(validate, out);
  checks.push({ name: "schema", ok: sc.ok, detail: sc.detail });

  // NO REISSUE — completed (subsystem, attack_class) tuples must not recur.
  const completed = new Set(
    (vars.input.completed_tasks || []).map((t) =>
      tuple(t.subsystem, t.attack_class),
    ),
  );
  const reissued = tasks
    .filter((t) => completed.has(tuple(t.subsystem, t.attack_class)))
    .map((t) => t.task_id);
  checks.push({
    name: "no_reissue",
    ok: reissued.length === 0,
    detail: `reissued: [${reissued}]`,
  });

  // CAP
  if (typeof vars.input.max_new_tasks === "number") {
    checks.push({
      name: "max_respected",
      ok: tasks.length <= vars.input.max_new_tasks,
      detail: `${tasks.length} tasks > cap ${vars.input.max_new_tasks}`,
    });
  }

  // SOURCE TAG
  const badSource = tasks.filter((t) => t.source !== "gapfill").map((t) => t.task_id);
  checks.push({
    name: "source_gapfill",
    ok: badSource.length === 0,
    detail: `wrong/absent source: [${badSource}]`,
  });

  // ID PREFIX
  const badId = tasks
    .filter((t) => !String(t.task_id || "").startsWith("t_gf_"))
    .map((t) => t.task_id);
  checks.push({
    name: "task_id_prefix",
    ok: badId.length === 0,
    detail: `not t_gf_*: [${badId}]`,
  });

  // PRIORITY — integer 1..5
  const badPri = tasks
    .filter((t) => !Number.isInteger(t.priority) || t.priority < 1 || t.priority > 5)
    .map((t) => `${t.task_id}=${JSON.stringify(t.priority)}`);
  checks.push({
    name: "priority_int_1_5",
    ok: badPri.length === 0,
    detail: `bad priority: [${badPri}]`,
  });

  // MUST COVER — expected gaps actually got a task.
  const covered = new Set(tasks.map((t) => tuple(t.subsystem, t.attack_class)));
  for (const pair of vars.must_cover || []) {
    const [s, a] = pair;
    checks.push({
      name: `covers(${s},${a})`,
      ok: covered.has(tuple(s, a)),
      detail: `tuple ${tuple(s, a)} not among new tasks`,
    });
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
