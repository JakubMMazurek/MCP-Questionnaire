/**
 * The engine — the rules engine, the answer store and the payload builder.
 *
 * Pure TypeScript: no React, no DOM, no host. React subscribes to the store
 * from `src/`; the host bridge drives it from `src/host/`; the tests drive it
 * directly. DESIGN.html §4.6, §4.7, §5.1.
 */

export {
  type ComputeContext,
  computeValue,
  isChanged,
  isVisible,
  leavesFor,
  needsReview,
} from "./computed.js";
export {
  baselineOf,
  type Effective,
  type EffectiveOrigin,
  effectiveValue,
  isTouched,
  NO_OVERLAYS,
  type Overlays,
  type PrefillMapCanonical,
  sameValue,
  type ValueContext,
} from "./effective.js";
export {
  canonicalPrefill,
  type Effects,
  EMPTY_EFFECTS,
  type EvaluateOptions,
  evaluate,
  MAX_ITERATIONS,
} from "./evaluate.js";
export { formLeaves, type Leaf, type RowMap, repeatablePaths } from "./leaves.js";
export { canon, joinPath, mintRowId, segments, withinTarget } from "./paths.js";
export {
  computeContext,
  createEngineStore,
  type EngineActions,
  type EngineState,
  type EngineStore,
  type FormStatus,
  reconcileEffects,
} from "./store.js";
export {
  buildSubmission,
  highConfidence,
  labelFor,
  type NoteTriple,
  needsReviewPaths,
  type Submission,
  type SubmissionSummary,
  summaryLine,
} from "./submission.js";
