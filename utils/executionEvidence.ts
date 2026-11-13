/**
 * Project-wide, module-neutral execution evidence API.
 *
 * Existing suites may continue importing componentValidationEvidence while they
 * migrate. New suites should import this file so the same reporter contract is
 * used for Components, Running Hours, imports, work orders, and future modules.
 */
export {
  ScenarioPlan,
  attachComponentStepScreenshot as attachExecutionStepScreenshot,
  attachFailureScreenshot as attachExecutionFailureScreenshot,
  attachRunningHoursComparison,
  componentActionStep as executionActionStep,
  componentNotExecutedStep as executionNotExecutedStep,
  componentObservedCheck as executionObservedCheck,
  componentScenario as executionScenario,
  componentValidationStep as executionValidationStep,
  type PlannedStep,
  type RunningHoursComparisonRow,
} from './componentValidationEvidence';
