/**
 * Public library surface for the audit harness. The CLI (src/cli.ts) is the
 * primary entry point; this module re-exports the building blocks for
 * programmatic use.
 */

export {
  AuthError,
  type AuthMode,
  type AuthStatus,
  configureAuth,
} from "./auth";
export {
  applyBaseline,
  BASELINE_VERSION,
  type BaselineEntry,
  type BaselineFile,
  buildBaseline,
  type Delta,
  fingerprintFinding,
  normalizeRepoPath,
  parseBaseline,
} from "./baseline";
export {
  HarnessConfig,
  loadConfig,
  type PermissionMode,
  type StageConfig,
} from "./config";
export {
  changedFiles,
  type ChangedFilesResult,
  type DiffSpec,
  isGitRepo,
} from "./diff";
export { extractJson, validateSchema } from "./jsonUtils";
export {
  CostExceeded,
  runPipeline,
  type RunPipelineParams,
} from "./orchestrator";
export * as paths from "./paths";
export {
  type AgentResult,
  AgentRunError,
  QuotaExhaustedError,
  runAgent,
  type RunAgentParams,
  TransientAgentError,
} from "./runner";
export { type SarifOptions, toSarif } from "./sarif";
export { type LiveTarget, StageContext } from "./stages";
export { type Finding, type RunRow, StateDB, type Task } from "./state";
