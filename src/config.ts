/**
 * Load per-stage configuration from config/stages.yaml.
 * Model diversity between Hunt and Validate is load-bearing
 * (the blog's "deliberate disagreement" rule), so the structure is preserved
 * verbatim.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONFIG_DIR } from "./paths";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export interface StageConfig {
  name: string;
  model: string;
  concurrency: number;
  tools: string[];
  maxTurns: number;
  permissionMode: PermissionMode;
  repairAttempts: number;
}

export class HarnessConfig {
  constructor(
    readonly stages: Record<string, StageConfig>,
    readonly gapfillIterations: number,
    readonly feedbackIterations: number,
  ) {}

  get(stage: string): StageConfig {
    const sc = this.stages[stage];
    if (!sc) {
      throw new Error(
        `Unknown stage ${JSON.stringify(stage)}. Known: ${Object.keys(this.stages).sort().join(", ")}`,
      );
    }
    return sc;
  }

  /** Mutate every stage's concurrency to min(current, cap). */
  capConcurrency(cap: number): void {
    if (cap < 1) throw new Error("concurrency cap must be >= 1");
    for (const sc of Object.values(this.stages)) {
      sc.concurrency = Math.min(sc.concurrency, cap);
    }
  }
}

interface RawStage {
  model: string;
  concurrency: number | string;
  tools: string[];
  max_turns?: number | string;
  permission_mode?: string;
  repair_attempts?: number | string;
}

export function loadConfig(path?: string): HarnessConfig {
  const file = path ?? join(CONFIG_DIR, "stages.yaml");
  const raw = parseYaml(readFileSync(file, "utf8")) as {
    defaults?: Record<string, unknown>;
    stages?: Record<string, RawStage>;
    loops?: Record<string, unknown>;
  };

  const defaults = raw.defaults ?? {};
  const stages: Record<string, StageConfig> = {};

  for (const [name, spec] of Object.entries(raw.stages ?? {})) {
    stages[name] = {
      name,
      model: spec.model,
      concurrency: Number(spec.concurrency),
      tools: [...spec.tools],
      maxTurns: Number(spec.max_turns ?? defaults.max_turns ?? 25),
      permissionMode: (spec.permission_mode ??
        defaults.permission_mode ??
        "acceptEdits") as PermissionMode,
      repairAttempts: Number(
        spec.repair_attempts ?? defaults.repair_attempts ?? 1,
      ),
    };
  }

  const loops = raw.loops ?? {};
  return new HarnessConfig(
    stages,
    Number(loops.gapfill_iterations ?? 2),
    Number(loops.feedback_iterations ?? 1),
  );
}
