import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { RunningHoursPage, type RunningHoursGridRow, type RunningHoursInheritedDetails, type RunningHoursUpdateAction } from '../../pages/RunningHoursPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import {
  attachExecutionFailureScreenshot,
  attachRunningHoursComparison,
  executionActionStep,
  executionObservedCheck,
  executionScenario,
  executionValidationStep,
} from '../../utils/executionEvidence';
import { openPrimaryComponentsSession } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { normalizeRunningHours } from '../../utils/runningHoursValidation';

const attachFailureScreenshot = attachExecutionFailureScreenshot;
const componentActionStep = executionActionStep;
const componentObservedCheck = executionObservedCheck;
const componentScenario = executionScenario;
const componentValidationStep = executionValidationStep;

type Candidate = { vessel: string; row: RunningHoursGridRow; inherited: RunningHoursInheritedDetails };
type NegativeCase = {
  id: string;
  action: RunningHoursUpdateAction;
  value: (baseline: number) => string | undefined;
  expected: string;
  date?: (row: RunningHoursGridRow) => string | undefined;
  validation?: (baseline: number, row: RunningHoursGridRow) => string | RegExp;
};

const negativeCases: NegativeCase[] = [
  { id: 'RH-N01', action: 'Set Total', value: () => undefined, date: () => today(), expected: 'Verify missing New Value validation and update rejection.' },
  { id: 'RH-N02', action: 'Set Total', value: () => 'abc', expected: 'Nonnumeric text should be rejected and must not become zero.' },
  { id: 'RH-N03', action: 'Set Total', value: () => '-10', expected: 'A negative Set Total should be rejected.' },
  { id: 'RH-N04', action: 'Add Delta', value: () => '0', expected: 'A zero Add Delta should be rejected.' },
  { id: 'RH-N05', action: 'Add Delta', value: () => '-10', expected: 'A negative Add Delta should be rejected.' },
  { id: 'RH-N06', action: 'Set Total', value: (baseline) => String(baseline - 10), date: () => today(), expected: 'A lower normal reading should be blocked by RH validation.' },
  { id: 'RH-N09', action: 'Set Total', value: (baseline) => String(baseline + 1), date: () => undefined, validation: () => 'Date is required. Please select a date.', expected: 'A valid reading with a blank Date Updated field should produce the date-required validation.' },
  { id: 'RH-N10', action: 'Set Total', value: (baseline) => String(baseline + 1), date: () => dayOffset(1), validation: () => 'Date cannot be in the future', expected: 'A future-dated reading should be rejected.' },
  { id: 'RH-N11', action: 'Set Total', value: (baseline) => String(baseline + 10), date: (row) => dateRelativeToLastUpdated(row, -1), validation: () => /Completion Date \([^)]+\) is earlier than the component's last running-hours update \([^)]+\)\. Running hours can only be recorded on or after the latest reading\./i, expected: 'A date earlier than the component latest running-hours update should be rejected.' },
  { id: 'RH-N13', action: 'Set Total', value: (baseline) => String(baseline + 26), date: (row) => dateRelativeToLastUpdated(row, 1), validation: () => /Increase of 26 hours exceeds maximum allowed of 25 hours\. Maximum allowed is 1 day\(s\) [×x] 25 hours\/day = 25 hours\./i, expected: 'A 26 RH increase over exactly one day should be rejected by the 25 RH daily limit.' },
  { id: 'RH-N14', action: 'Set Total', value: (baseline) => String(baseline + 51), date: (row) => dateRelativeToLastUpdated(row, 2), validation: () => /Increase of 51 hours exceeds maximum allowed of 50 hours\. Maximum allowed is 2 day\(s\) [×x] 25 hours\/day = 50 hours\./i, expected: 'A 51 RH increase over exactly two days should be rejected by the configured rate limit.' },
];

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const count = (value: string) => Number(clean(value).replace(/[^\d.-]/g, '')) || 0;
const isoDate = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const today = () => isoDate(new Date());
const dayOffset = (days: number) => {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return isoDate(value);
};
const parseLastUpdated = (value: string): Date | undefined => {
  const match = value.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!match) return undefined;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
  if (month < 0) return undefined;
  return new Date(Number(match[3]), month, Number(match[1]));
};
const dateRelativeToLastUpdated = (row: RunningHoursGridRow, days: number): string | undefined => {
  const value = parseLastUpdated(row.lastUpdated);
  if (!value) return undefined;
  value.setDate(value.getDate() + days);
  return isoDate(value);
};
const isNotFuture = (date: string | undefined) => Boolean(date && date <= today());

test.describe('PMS Running Hours negative validation', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // A replacement worker may need to reopen the application with the saved
    // authenticated state after a failed case. Keep that recovery from being
    // cut off by the global one-minute test timeout.
    test.setTimeout(5 * 60_000);
    ({ context, page } = await openPrimaryComponentsSession(browser));
  });
  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
  });
  test.afterAll(async () => context?.close());

  const open = async () => {
    const runningHours = await new TechnicalPage(page).goToRunningHours();
    await runningHours.waitForScreen();
    return runningHours;
  };

  const selectCandidate = async (runningHours: RunningHoursPage, scenario: NegativeCase): Promise<Candidate | undefined> => {
    const offered = await runningHours.vesselOptions();
    for (const vessel of config.runningHoursVessels.filter((name) => offered.includes(name))) {
      if (await runningHours.selectedVesselName() !== vessel) await runningHours.selectVesselAndWaitForData(vessel);
      await runningHours.clearComponentSearch();
      for (const row of (await runningHours.readAllRows()).filter((item) => normalizeRunningHours(item.runningHours) !== undefined && count(item.inheritedRh) > 0)) {
        if (scenario.id === 'RH-N11' && !dateRelativeToLastUpdated(row, -1)) continue;
        if (scenario.id === 'RH-N13' && !isNotFuture(dateRelativeToLastUpdated(row, 1))) continue;
        if (scenario.id === 'RH-N14' && !isNotFuture(dateRelativeToLastUpdated(row, 2))) continue;
        const availability = await runningHours.inspectUpdateAvailability(row, scenario.action);
        if (!availability.available) continue;
        try {
          const inherited = await runningHours.inspectInheritedDetails(row);
          return { vessel, row, inherited };
        } catch { /* try the next finite row */ }
      }
    }
    return undefined;
  };

  const runNegative = async (scenario: NegativeCase, validationDisabled = false) => {
    const runningHours = await open();
    if (['RH-N13', 'RH-N14'].includes(scenario.id)) {
      const rhValidation = await runningHours.rhValidationState().catch(() => undefined);
      test.skip(rhValidation !== 'ON', `BLOCKED — ${scenario.id} requires RH Validation ON, but the Overview displayed ${rhValidation ?? 'no readable state'}.`);
    }
    const candidate = await selectCandidate(runningHours, scenario);
    if (!candidate) test.skip(true, `No eligible ${scenario.action} row with inherited data was found in the authorized vessels.`);
    const selected = candidate!;
    const baseline = normalizeRunningHours(selected.row.runningHours)!;
    const visibleHistoryBefore = `${selected.row.runningHours}|${selected.row.lastUpdated}`;
    const successfulHistoryBefore = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);
    const input = scenario.value(baseline);
    const selectedDate = scenario.id === 'RH-N09' ? '' : (scenario.date?.(selected.row) ?? today());
    const expectedValidation = scenario.validation?.(baseline, selected.row);
    const attempt = await componentActionStep(
      `${scenario.id} enter value and attempt Save`,
      `${scenario.expected} The dialog should retain the attempted input, selected date, update mode, Save state and exact PMS feedback for evidence.`,
      () => runningHours.attemptRejectedUpdate(selected.row, scenario.action, input, selectedDate, {
        expectedApplicationValidation: scenario.id === 'RH-N01'
          ? 'Please enter a valid number for the new value.'
          : expectedValidation,
        beforeSave: async (state) => componentObservedCheck(page,
          `${scenario.id} Update RH values before Save`,
          `${scenario.action} should show the actual Old Value, intended New/Delta Value and intended Date Updated before Save.`,
          {
            passed: state.selectedDate === selectedDate && state.actualFieldValue === (input ?? ''),
            actual: `Vessel: ${selected.vessel}; Component: ${selected.row.componentName} (${selected.row.componentCode}); Last Updated: "${selected.row.lastUpdated}"; Update Mode: ${state.updateMode}; Old Value: "${state.oldValue}"; Attempted Value: "${state.attemptedValue || '<blank>'}"; Actual Field Value: "${state.actualFieldValue || '<blank>'}"; Date Updated internal value: "${state.selectedDate || '<blank>'}"; Save button: ${state.saveEnabled ? 'enabled' : 'disabled'}.`,
          }, { screenshot: 'always' }),
      }),
      (result) => `Update Mode: ${result.updateMode}; Old Value: "${result.oldValue || '<not displayed>'}"; Attempted Input: "${result.attemptedValue || '<blank>'}"; Actual Field Value: "${result.actualFieldValue || '<blank>'}"; Selected Date Updated: "${result.selectedDate || '<blank>'}"; Save button: ${result.saveEnabled ? 'enabled' : 'disabled'}; Save clicked: ${result.saveClicked ? 'yes' : 'no'}; Application Validation: "${result.applicationValidation || '<none>'}"; Automation Error: "${result.automationError || '<none>'}".`,
      { page },
    );
    await componentActionStep(
      `${scenario.id} refresh and restore the selected vessel`,
      `Running Hours should reload for Vessel ${selected.vessel} so rejected data can be checked from persisted state.`,
      () => runningHours.refreshAndRestoreVessel(selected.vessel),
      () => `Running Hours reloaded and Vessel ${selected.vessel} was restored.`,
    );
    let after: RunningHoursGridRow | undefined;
    await expect.poll(async () => {
      after = (await runningHours.readAllRows()).find((row) => row.componentCode === selected.row.componentCode);
      return Boolean(after);
    }, {
      message: `Component ${selected.row.componentCode} should return after the Running Hours refresh`,
      timeout: 30_000,
      intervals: [250, 500, 1_000],
    }).toBe(true);
    const inheritedAfter = after ? await runningHours.inspectInheritedDetails(after) : undefined;
    const visibleHistoryAfter = `${after?.runningHours ?? ''}|${after?.lastUpdated ?? ''}`;
    const successfulHistoryAfter = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);
    const unchanged = normalizeRunningHours(after?.runningHours ?? '') === baseline
      && inheritedAfter?.indicator === selected.inherited.indicator
      && visibleHistoryAfter === visibleHistoryBefore
      && successfulHistoryAfter === successfulHistoryBefore;
    const intendedRejection = expectedValidation instanceof RegExp
      ? expectedValidation.test(attempt.applicationValidation)
      : expectedValidation
        ? attempt.applicationValidation.includes(expectedValidation)
        : scenario.id === 'RH-N01'
          ? attempt.applicationValidation.includes('Please enter a valid number for the new value.')
          : Boolean(attempt.applicationValidation || attempt.automationError || !attempt.saveEnabled);
    await componentObservedCheck(page,
      `${scenario.id} verify rejection and unchanged persisted state`,
      `${scenario.expected} MASTER RH, inherited RH indicator and successful-update history should remain unchanged after refresh.`,
      {
        passed: unchanged && intendedRejection,
        actual: `Application Validation: "${attempt.applicationValidation || '<none>'}". Automation Error: "${attempt.automationError || '<none>'}". MASTER RH before/after: "${selected.row.runningHours}"/"${after?.runningHours ?? '<missing>'}". Inherited indicator before/after: "${selected.inherited.indicator}"/"${inheritedAfter?.indicator ?? '<missing>'}". Visible RH/Last Updated before/after: "${visibleHistoryBefore}"/"${visibleHistoryAfter}". Successful-update history unchanged: ${successfulHistoryAfter === successfulHistoryBefore ? 'yes' : 'no'}.`,
      }, { screenshot: 'always' });
    await componentValidationStep(page,
      `${scenario.id} negative Running Hours validation\nExpected: ${scenario.expected}\nActual: Recorded after the validation completes.`,
      async () => {
        if (!unchanged || !intendedRejection) throw new Error(`Observed Application Result:\n${scenario.id} did not produce its intended rejection with unchanged persisted data.`);
      }, { actual: () => `${scenario.id} passed with PMS validation "${attempt.applicationValidation || '<none>'}", automation interaction result "${attempt.automationError || '<none>'}", and unchanged MASTER RH, inherited RH indicator and successful-update history after refresh.` });
  };

  for (const scenario of negativeCases) {
    test(`${scenario.id} - ${scenario.expected}`, componentScenario(scenario.expected), async () => {
      test.setTimeout(20 * 60_000);
      await runNegative(scenario);
    });
  }

  test('RH-N16 - Meter Replacement Reset Without Confirmation', executionScenario(
    'Cancelling a prepared meter replacement before Save should leave the selected MASTER and linked INHERITED Running Hours, Last Updated values, and successful-update history unchanged.',
  ), async () => {
    test.setTimeout(20 * 60_000);
    const runningHours = await open();
    const rhValidation = await runningHours.rhValidationState().catch(() => undefined);
    test.skip(rhValidation !== 'ON', `BLOCKED — RH-N16 requires RH Validation ON, but Overview displayed ${rhValidation ?? 'no readable state'}.`);
    const candidate = await selectCandidate(runningHours, {
      id: 'RH-N16', action: 'Set Total', value: () => '0',
      expected: 'Cancelling Meter Replacement must preserve all Running Hours data.',
    });
    test.skip(!candidate, 'BLOCKED — no eligible MASTER component with linked INHERITED Running Hours and an available Update RH workflow was found in the authorized vessels.');
    const selected = candidate!;
    const child = selected.inherited.children[0];
    test.skip(!child, `BLOCKED — ${selected.row.componentName} (${selected.row.componentCode}) exposed an inherited indicator but no linked INHERITED identity was returned.`);
    const inherited = child!;
    const historyBefore = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);

    await executionObservedCheck(page, 'RH-N16 initial MASTER and INHERITED Running Hours',
      `Vessel ${selected.vessel}, MASTER ${selected.row.componentName} (${selected.row.componentCode}), and linked INHERITED ${inherited.name} (${inherited.componentCode}) should expose their runtime baseline before Meter Replacement.`, {
        passed: normalizeRunningHours(selected.row.runningHours) !== undefined && normalizeRunningHours(inherited.currentCumulativeRH) !== undefined,
        actual: `Vessel ${selected.vessel}; MASTER ${selected.row.componentName} (${selected.row.componentCode}) RH ${selected.row.runningHours}, Last Updated ${selected.row.lastUpdated || '<not displayed>'}; INHERITED ${inherited.name} (${inherited.componentCode}) RH ${inherited.currentCumulativeRH}, Last Updated ${inherited.lastUpdated || '<not displayed>'}; RH Validation ${rhValidation}; successful history captured.`,
      }, { screenshot: 'always' });

    await executionActionStep('RH-N16 open Update Running Hours',
      `Update Running Hours should open for MASTER ${selected.row.componentName} (${selected.row.componentCode}) on Vessel ${selected.vessel}.`,
      () => runningHours.openUpdateControls(selected.row),
      (result) => `Opened the ${result.tooltip} workflow for MASTER ${selected.row.componentName} (${selected.row.componentCode}) on Vessel ${selected.vessel}.`, { page });

    const confirmation = await executionActionStep('RH-N16 open Meter Replacement Confirmation',
      `Checking Meter replaced for MASTER ${selected.row.componentName} (${selected.row.componentCode}) should open the real Meter Replacement Confirmation dialog without saving data.`,
      () => runningHours.openMeterReplacementConfirmation(selected.row, { alreadyOpen: true }),
      (state) => `Displayed "${state.title}" for ${state.componentName || selected.row.componentName} (${state.componentCode || selected.row.componentCode}), Current RH ${state.currentRh || selected.row.runningHours}. Instruction: "${state.instruction}".`, { page });

    const requests: Array<{ method: string; url: string; status?: number; failure?: string }> = [];
    const consoleErrors: string[] = [];
    const requestListener = (request: import('@playwright/test').Request) => {
      if (/running-hours/i.test(request.url()) && !['GET', 'OPTIONS'].includes(request.method())) requests.push({ method: request.method(), url: request.url() });
    };
    const responseListener = (response: import('@playwright/test').Response) => {
      const request = response.request();
      const record = requests.find((item) => item.method === request.method() && item.url === request.url() && item.status === undefined);
      if (record) record.status = response.status();
    };
    const requestFailedListener = (request: import('@playwright/test').Request) => {
      const record = requests.find((item) => item.method === request.method() && item.url === request.url() && item.failure === undefined);
      if (record) record.failure = request.failure()?.errorText ?? 'request failed';
    };
    const consoleListener = (message: import('@playwright/test').ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    };
    page.on('request', requestListener);
    page.on('response', responseListener);
    page.on('requestfailed', requestFailedListener);
    page.on('console', consoleListener);
    let prepared;
    let cancelled;
    try {
      prepared = await executionActionStep('RH-N16 prepare reset reading in Meter Replacement',
        `The confirmation should use Action Type Replaced and return to Update Running Hours with New Meter Start 0 for MASTER ${selected.row.componentName} (${selected.row.componentCode}), without clicking Save.`,
        () => runningHours.confirmMeterReplacementDetails(`RH-N16 cancellation verification for ${selected.row.componentCode}`),
        (state) => `Confirmation text: "${confirmation.confirmationText}". Action Type ${state.actionType}; Reason "${state.reason}"; Meter replaced ${state.meterReplaced ? 'checked' : 'unchecked'}; Old Meter Final ${state.oldMeterFinal || '<blank>'}; New Meter Start ${state.newMeterStart}; Save ${state.saveEnabled ? 'enabled' : 'disabled'} and not clicked.`, { page });
      cancelled = await executionActionStep('RH-N16 click Cancel on prepared Meter Replacement',
        `Cancel should close Update Running Hours for MASTER ${selected.row.componentName} (${selected.row.componentCode}) without clicking Save or committing the reset.`,
        () => runningHours.cancelPreparedMeterReplacement(),
        (state) => `Cancel closed the prepared Meter Replacement: ${state.dialogClosed ? 'yes' : 'no'}; application notification: "${state.notification || '<none; silent cancellation>'}"; Save was not clicked.`, { page });
    } finally {
      page.off('request', requestListener);
      page.off('response', responseListener);
      page.off('requestfailed', requestFailedListener);
      page.off('console', consoleListener);
    }

    await executionObservedCheck(page, 'RH-N16 cancellation response and network behavior',
      `Cancellation for MASTER ${selected.row.componentName} (${selected.row.componentCode}) should return to Overview without a successful Running Hours write request.`, {
        passed: Boolean(cancelled?.dialogClosed) && requests.length === 0,
        actual: `Returned to Running Hours Overview after Cancel. Notification: "${cancelled?.notification || '<none; silent cancellation>'}". Non-GET Running Hours requests observed between confirmation and Cancel: ${requests.length ? requests.map((item) => `${item.method} ${new URL(item.url).pathname} ${item.status ? `HTTP ${item.status}` : item.failure || 'no response'}`).join(' | ') : 'none'}. Browser console errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}.`,
      }, { screenshot: 'always' });

    await executionActionStep('RH-N16 refresh Running Hours and restore vessel',
      `Running Hours should reload and restore Vessel ${selected.vessel} for persisted-state verification of MASTER ${selected.row.componentName} (${selected.row.componentCode}).`,
      () => runningHours.refreshAndRestoreVessel(selected.vessel),
      () => `Running Hours reloaded and Vessel ${selected.vessel} was restored.`, { page });
    const after = (await runningHours.readAllRows()).find((row) => row.componentCode === selected.row.componentCode);
    expect(after, `MASTER ${selected.row.componentCode} should remain present after refresh`).toBeDefined();
    const inheritedAfterDetails = await runningHours.inspectInheritedDetails(after!);
    const inheritedAfter = inheritedAfterDetails.children.find((item) => item.componentCode === inherited.componentCode);
    const historyAfter = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);

    await attachRunningHoursComparison('RH-N16 Initial-Input-Final Comparison', [
      { field: 'Vessel', initial: selected.vessel, entered: 'Meter Replacement prepared then cancelled', final: selected.vessel },
      { field: 'MASTER component', initial: `${selected.row.componentName} (${selected.row.componentCode})`, entered: 'New Meter Start 0; Save not clicked', final: `${after!.componentName} (${after!.componentCode})` },
      { field: 'MASTER RH', initial: selected.row.runningHours, entered: prepared!.newMeterStart, final: after!.runningHours },
      { field: 'MASTER Last Updated', initial: selected.row.lastUpdated || '<not displayed>', entered: 'No committed date', final: after!.lastUpdated || '<not displayed>' },
      { field: 'INHERITED component', initial: `${inherited.name} (${inherited.componentCode})`, entered: 'No direct change', final: `${inheritedAfter?.name ?? '<missing>'} (${inheritedAfter?.componentCode ?? '<missing>'})` },
      { field: 'INHERITED RH', initial: inherited.currentCumulativeRH, entered: 'No direct change', final: inheritedAfter?.currentCumulativeRH ?? '<missing>' },
      { field: 'INHERITED Last Updated', initial: inherited.lastUpdated || '<not displayed>', entered: 'No committed date', final: inheritedAfter?.lastUpdated || '<not displayed>' },
      { field: 'Successful update history', initial: historyBefore || '<empty>', entered: 'No Save/Confirm update request', final: historyAfter || '<empty>' },
    ]);

    const unchanged = normalizeRunningHours(after!.runningHours) === normalizeRunningHours(selected.row.runningHours)
      && after!.lastUpdated === selected.row.lastUpdated
      && normalizeRunningHours(inheritedAfter?.currentCumulativeRH ?? '') === normalizeRunningHours(inherited.currentCumulativeRH)
      && (inheritedAfter?.lastUpdated ?? null) === (inherited.lastUpdated ?? null)
      && historyAfter === historyBefore
      && requests.length === 0;
    await executionObservedCheck(page, 'RH-N16 final MASTER, INHERITED, date and history verification',
      `After refresh, MASTER ${selected.row.componentName} (${selected.row.componentCode}), INHERITED ${inherited.name} (${inherited.componentCode}), their Last Updated values, and successful-update history should exactly match the initial baseline.`, {
        passed: unchanged,
        actual: `MASTER RH before/after ${selected.row.runningHours}/${after!.runningHours}; MASTER Last Updated before/after ${selected.row.lastUpdated || '<not displayed>'}/${after!.lastUpdated || '<not displayed>'}; INHERITED RH before/after ${inherited.currentCumulativeRH}/${inheritedAfter?.currentCumulativeRH ?? '<missing>'}; INHERITED Last Updated before/after ${inherited.lastUpdated || '<not displayed>'}/${inheritedAfter?.lastUpdated || '<missing>'}; successful history unchanged ${historyAfter === historyBefore ? 'yes' : 'no'}; successful or attempted Running Hours write requests ${requests.length}.`,
      }, { screenshot: 'always' });
    await executionValidationStep(page, `RH-N16 verify cancellation preserved persisted Running Hours\nExpected: Cancelling Meter Replacement before Save should leave MASTER and linked INHERITED values, dates, and history unchanged.\nActual: Recorded after validation completes.`, async () => {
      expect(unchanged).toBe(true);
    }, { actual: () => `Vessel ${selected.vessel}; MASTER ${selected.row.componentName} (${selected.row.componentCode}) remained ${after!.runningHours}; INHERITED ${inherited.name} (${inherited.componentCode}) remained ${inheritedAfter!.currentCumulativeRH}; Last Updated values and successful history were unchanged; no Running Hours write request occurred before or during Cancel.` });
  });

  });
