/**
 * Shared helpers for stage modules.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { StageConfig, HarnessConfig } from "../config";
import { WORK, SCHEMAS, RESULTS, PROMPTS } from "../paths";

type Json = any;

export interface LiveTarget {
  url: string;
  credentials: Record<string, string>;
}

export class StageContext {
  constructor(
    readonly runId: string,
    readonly repoPath: string,
    readonly config: HarnessConfig,
    /** When set, downstream prompts receive {"url":..., "credentials":{...}}. */
    readonly liveTarget: LiveTarget | null = null,
    /** Verbatim text appended to every agent's user_input. */
    readonly scopeNotes: string | null = null,
  ) {
    this.repoPath = resolve(repoPath);
  }

  stage(name: string): StageConfig {
    return this.config.get(name);
  }

  /** Optional fields merged into every agent's user_input. */
  extras(): Json {
    const out: Json = {};
    if (this.liveTarget) out.live_target = this.liveTarget;
    if (this.scopeNotes) out.scope_notes = this.scopeNotes;
    return out;
  }

  promptFile(name: string): string {
    const path = join(PROMPTS, `${name}.md`);
    if (!existsSync(path)) throw new Error(`Missing prompt: ${path}`);
    return path;
  }

  /** Returns the schema filename (Ajv key) and its raw text for the runner. */
  schema(name: string): { name: string; text: string } {
    const filename = `${name}.schema.json`;
    const path = join(SCHEMAS, filename);
    if (!existsSync(path)) throw new Error(`Missing schema: ${path}`);
    return { name: filename, text: readFileSync(path, "utf8") };
  }

  resultsDir(stage: string): string {
    const d = join(RESULTS, this.runId, stage);
    mkdirSync(d, { recursive: true });
    return d;
  }

  workDir(stage: string, ref?: string): string {
    const d = join(WORK, this.runId, stage, ref ?? "default");
    mkdirSync(d, { recursive: true });
    return d;
  }
}

/** Pass only the architecture facts downstream agents need. */
export function truncatedReconSummary(
  full: Json,
  subsystemFilter?: string,
): Json {
  const out: Json = {
    architecture: full.architecture ?? {},
    subsystems: full.subsystems ?? [],
  };
  if (subsystemFilter !== undefined) {
    out.subsystem_for_task =
      (out.subsystems as Json[]).find(
        (s) =>
          s.name === subsystemFilter ||
          subsystemFilter.startsWith(s.path ?? "##nope##"),
      ) ?? null;
  }
  return out;
}

/** Bounded concurrency map — the async equivalent of an asyncio.Semaphore. */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        for (;;) {
          const idx = cursor++;
          if (idx >= items.length) return;
          await worker(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(runners);
}
