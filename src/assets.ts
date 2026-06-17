/**
 * Asset access that works in three modes: a source checkout, an npm install,
 * and a `bun build --compile` standalone binary. Disk copies (prompts/,
 * schemas/, config/) are preferred; when they are absent — the Homebrew binary
 * has no sibling files — we fall back to the embedded snapshot baked in at
 * build time by scripts/embed-assets.ts.
 */

import {
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDED } from "./generated-assets";
import { SCHEMAS, PROMPTS, CONFIG_DIR } from "./paths";

function readDisk(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Raw text of a schema file (e.g. "finding.schema.json"). */
export function schemaText(filename: string): string {
  const disk = readDisk(join(SCHEMAS, filename));
  if (disk != null) return disk;
  const embedded = EMBEDDED[`schemas/${filename}`];
  if (embedded != null) return embedded;
  throw new Error(`Missing schema: ${filename}`);
}

/** Every schema as {name, text} — disk dir in dev, embedded map in a binary. */
export function schemaList(): Array<{ name: string; text: string }> {
  if (existsSync(SCHEMAS)) {
    try {
      return readdirSync(SCHEMAS)
        .filter((f) => f.endsWith(".schema.json"))
        .map((f) => ({ name: f, text: readFileSync(join(SCHEMAS, f), "utf8") }));
    } catch {
      /* fall through to embedded */
    }
  }
  return Object.keys(EMBEDDED)
    .filter((k) => k.startsWith("schemas/") && k.endsWith(".schema.json"))
    .map((k) => ({ name: k.slice("schemas/".length), text: EMBEDDED[k] }));
}

/** Text of config/stages.yaml, or an explicit override path. */
export function configText(path?: string): string {
  if (path) {
    const disk = readDisk(path);
    if (disk != null) return disk;
    throw new Error(`Missing config: ${path}`);
  }
  const disk = readDisk(join(CONFIG_DIR, "stages.yaml"));
  if (disk != null) return disk;
  const embedded = EMBEDDED["config/stages.yaml"];
  if (embedded != null) return embedded;
  throw new Error("Missing config/stages.yaml");
}

// The agent runner reads the system prompt from a file path. In a binary the
// prompt lives only in the embedded map, so materialize it to a temp file once
// and hand back that path — keeping the runner's file-based contract intact.
let promptTmpDir: string | null = null;
const materialized = new Map<string, string>();

export function promptPath(name: string): string {
  const disk = join(PROMPTS, `${name}.md`);
  if (existsSync(disk)) return disk;

  const cached = materialized.get(name);
  if (cached) return cached;

  const text = EMBEDDED[`prompts/${name}.md`];
  if (text == null) throw new Error(`Missing prompt: ${name}.md`);
  if (!promptTmpDir) {
    promptTmpDir = join(tmpdir(), "audit-prompts");
    mkdirSync(promptTmpDir, { recursive: true });
  }
  const out = join(promptTmpDir, `${name}.md`);
  writeFileSync(out, text);
  materialized.set(name, out);
  return out;
}

/** Counts for `audit doctor` — confirms the binary packaged its assets. */
export function assetInventory(): {
  prompts: number;
  schemas: number;
  config: boolean;
  source: "disk" | "embedded";
} {
  const onDisk = existsSync(PROMPTS) && existsSync(SCHEMAS);
  if (onDisk) {
    return {
      prompts: readdirSync(PROMPTS).filter((f) => f.endsWith(".md")).length,
      schemas: readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"))
        .length,
      config: existsSync(join(CONFIG_DIR, "stages.yaml")),
      source: "disk",
    };
  }
  const keys = Object.keys(EMBEDDED);
  return {
    prompts: keys.filter((k) => k.startsWith("prompts/")).length,
    schemas: keys.filter((k) => k.endsWith(".schema.json")).length,
    config: EMBEDDED["config/stages.yaml"] != null,
    source: "embedded",
  };
}
