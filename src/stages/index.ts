/**
 * One module per pipeline stage. Each exports a single async entry point
 * invoked by the orchestrator.
 */

export {
  adviseFinding,
  adviseOne,
  type AdviseOptions,
  type AdviseSummary,
  runAdvise,
} from "./advise";
export { type LiveTarget, StageContext } from "./common";
export { runDedupe } from "./dedupe";
export { runFeedback } from "./feedback";
export { type FixSummary, runFix } from "./fix";
export { runGapfill } from "./gapfill";
export { type BudgetCheck, runHunt } from "./hunt";
export { runRecon } from "./recon";
export { runReport } from "./report";
export { runTrace } from "./trace";
export {
  composeVerdict,
  runTriage,
  type TriageOptions,
  type TriageVerdict,
} from "./triage";
export { runValidate } from "./validate";
