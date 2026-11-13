import { test, type Page, type TestInfo } from '@playwright/test';

export const COMPONENT_VALIDATION_SCREENSHOT_PREFIX =
  'Components Validation Step Screenshot :: ';
/** Observed Actual Result recorded after a validation completes (attachment name prefix). */
export const COMPONENT_STEP_ACTUAL_PREFIX = 'Components Step Actual :: ';
/** Annotation marking the step that carries a scenario's overall Expected/Actual Result. */
export const COMPONENT_SCENARIO_STEP_ANNOTATION = 'components-scenario-step';
/** Annotation holding the scenario Expected Result declared before execution starts. */
export const COMPONENT_EXPECTED_RESULT_ANNOTATION = 'components-expected-result';
export const COMPONENT_FAILURE_SCREENSHOT_PREFIX = 'Failure screenshot :: ';
export const RUNNING_HOURS_COMPARISON_PREFIX = 'Running Hours Comparison Data :: ';

export type RunningHoursComparisonRow = {
  field: string;
  initial: string;
  entered: string;
  final: string;
};

type ValidationStepOptions<T> = {
  /** Builds the Actual Result from the values the validation really observed. */
  actual?: (value: T) => string;
};

/**
 * Declares the scenario-specific Expected Result as a static test annotation, so
 * the report can state what the scenario should prove even when it stops early
 * or is skipped before its body runs: `test(title, componentScenario('...'), body)`.
 */
export function componentScenario(expected: string): { annotation: { type: string; description: string } } {
  return { annotation: { type: COMPONENT_EXPECTED_RESULT_ANNOTATION, description: expected } };
}

/** Adds the observed before/entered/after values used by Running Hours reports. */
export async function attachRunningHoursComparison(
  title: string,
  rows: RunningHoursComparisonRow[],
): Promise<void> {
  await test.info().attach(`${RUNNING_HOURS_COMPARISON_PREFIX}${title}`, {
    body: JSON.stringify(rows),
    contentType: 'application/json',
  });
}

/**
 * Runs a Components business validation and attaches its resulting UI state.
 * Successful screenshots are taken only after the validation completes. If the
 * validation fails, the current failure state is captured before rethrowing.
 */
export async function componentValidationStep<T>(
  page: Page,
  title: string,
  body: () => Promise<T>,
  options: ValidationStepOptions<T> = {},
): Promise<T> {
  const executionStep = title.split(/\r?\n/, 1)[0].trim();
  test.info().annotations.push({ type: COMPONENT_SCENARIO_STEP_ANNOTATION, description: executionStep });
  return test.step(title, async () => {
    try {
      const value = await body();
      if (options.actual) {
        await test.info().attach(`${COMPONENT_STEP_ACTUAL_PREFIX}${executionStep}`, {
          body: options.actual(value),
          contentType: 'text/plain',
        });
      }
      await attachStepScreenshot(page, executionStep);
      return value;
    } catch (error) {
      // Preserve the original validation error even if the page cannot be captured.
      await attachStepScreenshot(page, executionStep).catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Records one business action whose Actual Result depends on values observed
 * while it runs. The Actual Result is attached only after the action completes;
 * if the action fails, the report describes the failure instead.
 */
export async function componentActionStep<T>(
  title: string,
  expected: string,
  body: () => Promise<T>,
  actual: (value: T) => string,
  /** Captures the resulting screen as evidence for this step. */
  evidence?: { page: Page },
): Promise<T> {
  return test.step(`${title}\nExpected: ${expected}\nActual: Recorded after the action completes.`, async () => {
    try {
      const value = await body();
      await test.info().attach(`${COMPONENT_STEP_ACTUAL_PREFIX}${title}`, {
        body: actual(value),
        contentType: 'text/plain',
      });
      if (evidence) await attachStepScreenshot(evidence.page, title);
      return value;
    } catch (error) {
      if (evidence) await attachStepScreenshot(evidence.page, title).catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Records a check whose outcome was evaluated from observed values before the
 * step is written, with its own Expected/Actual Result and evidence. A failed
 * check is reported FAIL without stopping the scenario, so later independent
 * checks still run; the scenario must still assert the collected failures.
 */
export async function componentObservedCheck(
  page: Page,
  title: string,
  expected: string,
  outcome: { passed: boolean; actual: string },
  /** `failure` captures evidence only for a failed check, for scenarios recording one check per record. */
  options: { screenshot?: 'always' | 'failure' } = {},
): Promise<void> {
  await test.step(`${title}\nExpected: ${expected}\nActual: ${oneLine(outcome.actual)}${outcome.passed ? '' : '\nStatus: FAIL'}`, async () => {
    if (!outcome.passed || options.screenshot !== 'failure') await attachStepScreenshot(page, title).catch(() => undefined);
  });
}

/** Records a planned step the browser did not reach, stating why. */
export async function componentNotExecutedStep(title: string, expected: string, reason: string): Promise<void> {
  await test.step(`${title}\nExpected: ${expected}\nActual: NOT EXECUTED; ${oneLine(reason)}\nStatus: NOT RUN`, async () => {});
}

/** Attaches the current screen as evidence for a step that failed outside a recorded check. */
export async function attachComponentStepScreenshot(page: Page, title: string): Promise<void> {
  await attachStepScreenshot(page, title).catch(() => undefined);
}

// The report parses Actual up to the next line, so observed text stays on one line.
const oneLine = (value: string) => value.replace(/\s*\r?\n\s*/g, ' ').trim();

export type PlannedStep = { title: string; expected: string };

/**
 * Tracks the business steps a scenario intends to perform, so steps the
 * browser never reached are reported as NOT EXECUTED after a failure.
 */
export class ScenarioPlan {
  private readonly pending: PlannedStep[];

  public constructor(steps: PlannedStep[]) {
    this.pending = [...steps];
  }

  public begin(title: string): void {
    const index = this.pending.findIndex((item) => item.title === title);
    if (index >= 0) this.pending.splice(index, 1);
  }

  public async run(body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      for (const item of this.pending) {
        await test.step(`${item.title}\nExpected: ${item.expected}\nActual: NOT EXECUTED; the browser did not reach this action because an earlier step failed.\nStatus: NOT RUN`, async () => {});
      }
      throw error;
    }
  }
}

/**
 * Captures the page state of a failed or timed-out scenario before the page is
 * restored, so failures outside a validation step still keep their evidence.
 */
export async function attachFailureScreenshot(page: Page | undefined, testInfo: TestInfo): Promise<void> {
  if (!page || page.isClosed() || testInfo.status === testInfo.expectedStatus) return;
  const body = await page.screenshot({ animations: 'disabled', fullPage: true, timeout: 10_000 }).catch(() => undefined);
  if (body) {
    await testInfo.attach(`${COMPONENT_FAILURE_SCREENSHOT_PREFIX}${testInfo.title}`, { body, contentType: 'image/png' });
  }
}

async function attachStepScreenshot(page: Page, executionStep: string): Promise<void> {
  await test.info().attach(
    `${COMPONENT_VALIDATION_SCREENSHOT_PREFIX}${executionStep}`,
    {
      body: await page.screenshot({
        animations: 'disabled',
        fullPage: true,
      }),
      contentType: 'image/png',
    },
  );
}
