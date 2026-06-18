// Shared schema validator for stage evals.
//
// WHY THIS EXISTS (and why we don't just use promptfoo's `is-json` here):
// some stage schemas reference a sibling file via a relative `$ref`
// (e.g. gapfill_output / feedback_output both do `"$ref": "hunt_task.schema.json"`).
// promptfoo's `is-json` loads a single schema file and hands it to ajv with no
// base to resolve external file refs from, so that cross-file `$ref` fails to
// compile. Here we register the referenced schemas explicitly under their
// filename — which is exactly the URI the relative `$ref` resolves to — so ajv
// links them. The schemas in schemas/*.json stay the single source of truth;
// nothing is duplicated.
//
// Usage from an assertion:
//   const { buildValidator } = require("../lib/validate-schema.cjs");
//   const validate = buildValidator("schemas/gapfill_output.schema.json",
//                                   ["schemas/hunt_task.schema.json"]);
//   const ok = validate(parsedOutput); // validate.errors holds details on miss

const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");

// Repo root = two levels up from evals/lib, so resolution is cwd-independent.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readSchema(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
  return JSON.parse(fs.readFileSync(abs, "utf8"));
}

// Build a compiled ajv validator for `primaryRel`, registering each schema in
// `refRels` under its basename so relative `$ref`s (by filename) resolve.
function buildValidator(primaryRel, refRels = []) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const rel of refRels) {
    ajv.addSchema(readSchema(rel), path.basename(rel));
  }
  return ajv.compile(readSchema(primaryRel));
}

// Convenience: run a validator and return a compact { ok, detail } for use as
// one check inside a graded assertion.
function schemaCheck(validate, value) {
  const ok = validate(value);
  const detail = ok
    ? ""
    : (validate.errors || [])
        .map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join("; ");
  return { ok, detail };
}

module.exports = { buildValidator, schemaCheck, readSchema };
