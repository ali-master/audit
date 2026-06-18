// Behavioral assertion for Stage 07 (Feedback / learning loop).
//
// SCOPE NOTE: Feedback's full value — finding structurally-similar *sibling*
// callsites elsewhere in the repo — needs live Grep against the target, so the
// correctness of the new tasks' target_files can only be graded by the agentic
// harness (see evals/README.md). What IS deterministically gradeable from the
// test's own input, and what this asserts, is the OUTPUT CONTRACT plus the
// anti-retest discipline the prompt mandates:
//   - SCHEMA: validates against feedback_output.schema.json (+ hunt_task $ref).
//   - SOURCE TAG: every new task has source === "feedback".
//   - ID PREFIX: every new task_id starts with "t_fb_".
//   - CAP: new_hunt_tasks.length <= max_new_tasks.
//   - PRIORITY: every priority is an integer in 1..5.
//   - RATIONALE COVERAGE: every new task_id has an entry in rationale_per_task
//     (the prompt: "rationale_per_task[task_id] must name which trace pattern
//     motivated the task").
//   - NO RETEST: a new task must not re-target the exact bug already found —
//     i.e. same attack_class AND a target_file equal to an input trace's
//     finding.file ("the point is to find its siblings, not re-test the bug").
const { buildValidator, schemaCheck } = require("../lib/validate-schema.cjs");

const validate = buildValidator("schemas/feedback_output.schema.json", [
  "schemas/hunt_task.schema.json",
]);

module.exports = (output, { vars }) => {
  let out;
  try {
    out = JSON.parse(output);
  } catch (e) {
    return { pass: false, score: 0, reason: `output not JSON: ${e.message}` };
  }

  const checks = [];
  const tasks = out.new_hunt_tasks || [];
  const rationales = out.rationale_per_task || {};

  // SCHEMA
  const sc = schemaCheck(validate, out);
  checks.push({ name: "schema", ok: sc.ok, detail: sc.detail });

  // SOURCE TAG
  const badSource = tasks.filter((t) => t.source !== "feedback").map((t) => t.task_id);
  checks.push({
    name: "source_feedback",
    ok: badSource.length === 0,
    detail: `wrong/absent source: [${badSource}]`,
  });

  // ID PREFIX
  const badId = tasks
    .filter((t) => !String(t.task_id || "").startsWith("t_fb_"))
    .map((t) => t.task_id);
  checks.push({
    name: "task_id_prefix",
    ok: badId.length === 0,
    detail: `not t_fb_*: [${badId}]`,
  });

  // CAP
  if (typeof vars.input.max_new_tasks === "number") {
    checks.push({
      name: "max_respected",
      ok: tasks.length <= vars.input.max_new_tasks,
      detail: `${tasks.length} tasks > cap ${vars.input.max_new_tasks}`,
    });
  }

  // PRIORITY
  const badPri = tasks
    .filter((t) => !Number.isInteger(t.priority) || t.priority < 1 || t.priority > 5)
    .map((t) => `${t.task_id}=${JSON.stringify(t.priority)}`);
  checks.push({
    name: "priority_int_1_5",
    ok: badPri.length === 0,
    detail: `bad priority: [${badPri}]`,
  });

  // RATIONALE COVERAGE
  const missingRationale = tasks
    .map((t) => t.task_id)
    .filter((id) => !(id in rationales));
  checks.push({
    name: "rationale_coverage",
    ok: missingRationale.length === 0,
    detail: `no rationale for: [${missingRationale}]`,
  });

  // NO RETEST — don't re-emit the bug we already have a trace for.
  const found = (vars.input.reachable_traces || []).map((rt) => ({
    file: rt.finding && rt.finding.file,
    cls: rt.finding && rt.finding.vuln_class,
  }));
  const retests = tasks
    .filter((t) =>
      found.some(
        (f) =>
          t.attack_class === f.cls &&
          (t.target_files || []).includes(f.file),
      ),
    )
    .map((t) => t.task_id);
  checks.push({
    name: "no_retest",
    ok: retests.length === 0,
    detail: `re-tests known bug: [${retests}]`,
  });

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
