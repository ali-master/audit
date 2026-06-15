/**
 * Robust JSON extraction + JSON-Schema validation for agent outputs.
 *
 * extractJson tolerates the three ways a
 * model tends to wrap JSON (bare, fenced, embedded in prose); validateSchema
 * loads every sibling schema into one Ajv instance so cross-file `$ref`s like
 * "hunt_task.schema.json" resolve.
 */

import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMAS } from "./paths";

const FENCE_RE = /```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/;

/**
 * Pull a JSON value out of an assistant message.
 *
 * Order of attempts:
 *   1. The whole text is valid JSON.
 *   2. The text contains a ```json ... ``` fenced block.
 *   3. The largest balanced {...} or [...] substring is valid JSON.
 *
 * Throws if no JSON can be extracted.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) throw new Error("Empty assistant output.");

  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  const m = FENCE_RE.exec(text);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* fall through */
    }
  }

  const candidate = largestBalanced(text);
  if (candidate !== null) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* fall through */
    }
  }

  throw new Error(
    `Could not extract JSON from assistant output (len=${text.length}). ` +
      `Head: ${JSON.stringify(text.slice(0, 200))}`,
  );
}

/** Return the largest balanced {...} or [...] substring, or null. */
function largestBalanced(text: string): string | null {
  let best: string | null = null;
  for (const [openC, closeC] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== openC) continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          continue;
        }
        if (c === '"') inStr = !inStr;
        if (inStr) continue;
        if (c === openC) depth++;
        else if (c === closeC) {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(i, j + 1);
            if (best === null || candidate.length > best.length)
              best = candidate;
            break;
          }
        }
      }
    }
  }
  return best;
}

let ajv: Ajv | null = null;

function getAjv(): Ajv {
  if (ajv) return ajv;
  const instance = new Ajv({ allErrors: true, strict: false });
  for (const f of readdirSync(SCHEMAS)) {
    if (!f.endsWith(".schema.json")) continue;
    const schema = JSON.parse(readFileSync(join(SCHEMAS, f), "utf8"));
    // Give each schema an $id equal to its filename so that cross-file
    // `$ref: "hunt_task.schema.json"` entries resolve by id.
    schema.$id = f;
    instance.addSchema(schema, f);
  }
  ajv = instance;
  return instance;
}

/**
 * Validate `payload` against the named schema (filename, e.g.
 * "finding.schema.json"). Returns a list of human-readable error strings;
 * empty means valid.
 */
export function validateSchema(payload: unknown, schemaName: string): string[] {
  const validate = getAjv().getSchema(schemaName) as
    | ValidateFunction
    | undefined;
  if (!validate) throw new Error(`Unknown schema: ${schemaName}`);
  if (validate(payload)) return [];
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath || "<root>"}: ${e.message ?? "invalid"}`,
  );
}
