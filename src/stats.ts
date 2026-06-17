/**
 * Cost observability. The `costs` table records spend + tokens per stage call,
 * but a single total hides where the budget actually went. This rolls the rows
 * up by stage (and by the model each stage runs on, via the config) and derives
 * the metrics that drive tuning decisions: cost-per-confirmed-finding,
 * cost-per-reachable-finding, and the prompt-cache hit ratio.
 *
 * `costs` rows don't store a model — but each stage runs on a fixed model
 * (see config/stages.yaml), so stage → model is an exact lookup, not a guess.
 */

import type { HarnessConfig } from "./config";
import type { StateDB } from "./state";

export interface StageStat {
  stage: string;
  model: string;
  calls: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  durationMs: number;
  /** Share of total run cost, 0..1. */
  costShare: number;
}

export interface ModelStat {
  model: string;
  usd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Stats {
  runId: string;
  totalUsd: number;
  stages: StageStat[];
  byModel: ModelStat[];
  counts: {
    raw: number;
    confirmed: number;
    canonical: number;
    reachable: number;
  };
  /** Total cost divided by confirmed / reachable findings (null when zero). */
  perConfirmedUsd: number | null;
  perReachableUsd: number | null;
  /** cache_read / (input + cache_read) across the run, 0..1. */
  cacheHitRatio: number;
  totalTokens: number;
}

function modelForStage(config: HarnessConfig | null, stage: string): string {
  if (!config) return "?";
  try {
    return config.get(stage).model;
  } catch {
    return "?";
  }
}

export function computeStats(
  db: StateDB,
  config: HarnessConfig | null,
  runId: string,
): Stats {
  const rows = db.costByStage(runId);
  const totalUsd = rows.reduce((a, r) => a + r.usd, 0);

  const stages: StageStat[] = rows.map((r) => ({
    stage: r.stage,
    model: modelForStage(config, r.stage),
    calls: r.calls,
    usd: r.usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    numTurns: r.num_turns,
    durationMs: r.duration_ms,
    costShare: totalUsd > 0 ? r.usd / totalUsd : 0,
  }));

  const byModelMap = new Map<string, ModelStat>();
  for (const s of stages) {
    const m = byModelMap.get(s.model) ?? {
      model: s.model,
      usd: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    m.usd += s.usd;
    m.calls += s.calls;
    m.inputTokens += s.inputTokens;
    m.outputTokens += s.outputTokens;
    byModelMap.set(s.model, m);
  }
  const byModel = [...byModelMap.values()].sort((a, b) => b.usd - a.usd);

  const counts = {
    raw: db.getFindings(runId).length,
    confirmed: db.getFindings(runId, { validationStatus: "confirmed" }).length,
    canonical: db.getFindings(runId, { canonicalOnly: true }).length,
    reachable: db.getReachableCanonicalFindings(runId).length,
  };

  const input = stages.reduce((a, s) => a + s.inputTokens, 0);
  const output = stages.reduce((a, s) => a + s.outputTokens, 0);
  const cacheRead = stages.reduce((a, s) => a + s.cacheReadTokens, 0);
  const cacheCreate = stages.reduce((a, s) => a + s.cacheCreationTokens, 0);

  return {
    runId,
    totalUsd,
    stages,
    byModel,
    counts,
    perConfirmedUsd: counts.confirmed > 0 ? totalUsd / counts.confirmed : null,
    perReachableUsd: counts.reachable > 0 ? totalUsd / counts.reachable : null,
    cacheHitRatio: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : 0,
    totalTokens: input + output + cacheRead + cacheCreate,
  };
}
