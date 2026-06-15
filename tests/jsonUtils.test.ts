/** JSON extraction + schema-validation tests. */

import { describe, expect, test } from "bun:test";
import { extractJson, validateSchema } from "../src/jsonUtils";

describe("extractJson", () => {
  test("plain json object", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  test("json array", () => {
    expect(extractJson("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  test("fenced json", () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```\nDone.')).toEqual({
      a: 1,
    });
  });

  test("fenced without language", () => {
    expect(extractJson('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  test("prose with embedded json", () => {
    expect(
      extractJson('Here is my answer: {"a": 1, "b": [1,2]} please use it.'),
    ).toEqual({
      a: 1,
      b: [1, 2],
    });
  });

  test("embedded json with braces in strings", () => {
    expect(
      extractJson('preamble {"k": "value with } brace"} epilogue'),
    ).toEqual({
      k: "value with } brace",
    });
  });

  test("empty throws", () => {
    expect(() => extractJson("")).toThrow();
  });

  test("no json throws", () => {
    expect(() => extractJson("just text, no json here")).toThrow();
  });
});

describe("validateSchema", () => {
  const HUNT_TASK_OK = {
    task_id: "t_routes_sqli_1",
    attack_class: "sql_injection",
    scope_hint:
      "GET /lookup reads `name` from query string, passed via f-string into cur.execute() in app.py:30",
    target_files: ["app.py"],
    rationale: "Direct format string concatenation of untrusted input.",
    priority: 1,
    source: "recon",
  };

  test("valid hunt task passes", () => {
    expect(validateSchema(HUNT_TASK_OK, "hunt_task.schema.json")).toEqual([]);
  });

  test("recon output with $ref to hunt_task resolves and passes", () => {
    const recon = {
      subsystems: [
        { name: "web", path: "app.py", language: "python", purpose: "Flask" },
      ],
      architecture: {
        build_commands: ["pip install -r requirements.txt"],
        entry_points: [
          {
            kind: "http_route",
            location: "app.py:lookup",
            auth_required: false,
          },
        ],
        trust_boundaries: [
          { name: "http_to_db", description: "HTTP query string → SQL" },
        ],
      },
      initial_tasks: [HUNT_TASK_OK],
    };
    expect(validateSchema(recon, "recon_output.schema.json")).toEqual([]);
  });

  test("invalid hunt task (bad priority) reports errors", () => {
    const bad = { ...HUNT_TASK_OK, priority: 9 };
    const errors = validateSchema(bad, "hunt_task.schema.json");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("missing required field reports errors", () => {
    const { task_id, ...withoutId } = HUNT_TASK_OK;
    void task_id;
    expect(
      validateSchema(withoutId, "hunt_task.schema.json").length,
    ).toBeGreaterThan(0);
  });
});
