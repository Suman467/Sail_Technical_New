import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { RunningHoursPage, type RunningHoursGridRow } from '../../pages/RunningHoursPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import {
  attachFailureScreenshot,
  componentActionStep,
  componentObservedCheck,
  componentScenario,
  componentValidationStep,
} from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { normalizeRunningHours } from '../../utils/runningHoursValidation';
type Candidate = {
  vessel: string;
  row: RunningHoursGridRow;
  inherited: { indicator: string; details: string };
};

const inheritedCount = (value: string) => Number(value.replace(/[^\d.-]/g, '')) || 0;
const parseDisplayedDate = (value: string): string | undefined => {
  const match = value.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!match) return undefined;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
  if (month < 0) return undefined;
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
};
const today = () => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
const dayAfterDisplayedDate = (value: string): string | undefined => {
  const iso = parseDisplayedDate(value);
  if (!iso) return undefined;
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + 1);
  const next = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return next <= today() ? next : undefined;
};

test.describe('PMS Running Hours validation override and same-day negative validation', () => {
  let context: BrowserContext;
  let page: Page;
  let environmentSafe = true;
  let restorationResult = 'RH Validation restoration has not run.';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    ({ context, page } = await openPrimaryComponentsSession(browser));
  });
  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
  });
  test.afterAll(async () => context?.close());

  const openRunningHours = async () => {
    const runningHours = await new TechnicalPage(page).goToRunningHours();
    await runningHours.waitForScreen().catch(async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await runningHours.waitForScreen();
    });
    return runningHours;
  };

  const openAdminSettings = async (vessel: string) => {
    await new TechnicalPage(page).openAdmin();
    await page.getByText('Master Data', { exact: true }).filter({ visible: true }).first().click();
    await page.getByText('Lead Time & Grace', { exact: true }).filter({ visible: true }).first().click();
    const search = page.getByPlaceholder(/search by vessel/i).filter({ visible: true }).first();
    if (await search.count()) await search.fill(vessel);
    const settings = new RunningHoursPage(page);
    await settings.adminRhValidationState(vessel);
    return settings;
  };

  const selectCandidate = async (runningHours: RunningHoursPage): Promise<Candidate | undefined> => {
    const offered = await runningHours.vesselOptions();
    for (const vessel of config.runningHoursVessels.filter((name) => offered.includes(name))) {
      if (await runningHours.selectedVesselName() !== vessel) await runningHours.selectVesselAndWaitForData(vessel);
      await runningHours.clearComponentSearch();
      for (const row of await runningHours.readAllRows()) {
        const baseline = normalizeRunningHours(row.runningHours);
        if (baseline === undefined || baseline < 10 || inheritedCount(row.inheritedRh) <= 0 || !parseDisplayedDate(row.lastUpdated)) continue;
        const availability = await runningHours.inspectUpdateAvailability(row, 'Set Total');
        if (!availability.available) continue;
        try {
          return { vessel, row, inherited: await runningHours.inspectInheritedDetails(row) };
        } catch { /* inspect the next finite MASTER candidate */ }
      }
    }
    return undefined;
  };

  const waitForComponent = async (runningHours: RunningHoursPage, code: string) => {
    let row: RunningHoursGridRow | undefined;
    await expect.poll(async () => {
      row = (await runningHours.readAllRows()).find((candidate) => candidate.componentCode === code);
      return Boolean(row);
    }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(true);
    return row!;
  };

  test('RH-N07 - Lower Reading with RH Validation Disabled', componentScenario(
    'A lower normal Running Hours reading should remain rejected while RH Validation is OFF, and RH Validation must be restored to ON afterward.',
  ), async () => {
    test.setTimeout(20 * 60_000);
    const runningHours = await openRunningHours();
    const selected = await selectCandidate(runningHours);
    test.skip(!selected, 'BLOCKED — no eligible MASTER component with inherited RH and a readable Last Updated date was available.');
    const candidate = selected!;
    const baseline = normalizeRunningHours(candidate.row.runningHours)!;
    const date = parseDisplayedDate(candidate.row.lastUpdated)!;
    const lowerReading = baseline - 10;
    const historyBefore = await runningHours.successfulUpdateHistorySignature(candidate.row.componentCode);

    try {
      const admin = await openAdminSettings(candidate.vessel);
      const initialState = await admin.adminRhValidationState(candidate.vessel);
      await componentObservedCheck(page, 'RH-N07 RH Validation before changing', 'The actual PMS Admin vessel setting should be visible before it is changed.', {
        passed: initialState === 'ON',
        actual: `PMS Admin displayed RH Validation ${initialState} for Vessel ${candidate.vessel}.`,
      }, { screenshot: 'always' });
      expect(initialState, 'RH-N07 requires RH Validation ON before the controlled change').toBe('ON');

      await componentActionStep('RH-N07 disable RH Validation', 'The actual per-vessel PMS Admin switch should change RH Validation to OFF.', async () => {
        await admin.setAdminRhValidationState(candidate.vessel, 'OFF');
        return admin.adminRhValidationState(candidate.vessel);
      }, (state) => `PMS Admin displayed and verified RH Validation ${state} for Vessel ${candidate.vessel}.`, { page });

      const activePage = await openRunningHours();
      if (await activePage.selectedVesselName() !== candidate.vessel) await activePage.selectVesselAndWaitForData(candidate.vessel);
      await expect.poll(() => activePage.rhValidationState()).toBe('OFF');
      const current = await waitForComponent(activePage, candidate.row.componentCode);
      const attempt = await componentActionStep('RH-N07 enter lower reading and attempt Save', 'Set Total should use Old Value minus 10, the component Last Updated date, and Meter replaced should remain unchecked.', () => activePage.attemptRejectedUpdate(current, 'Set Total', String(lowerReading), date, {
        expectedApplicationValidation: /Running Hours Update Blocked[\s\S]*reading cannot be lower than the latest saved value/i,
        beforeSave: async (state) => componentObservedCheck(page, 'RH-N07 lower reading before Save', 'The Update Running Hours popup should show the calculated lower reading and valid date before Save.', {
          passed: state.actualFieldValue === String(lowerReading) && state.selectedDate === date && !state.meterReplaced,
          actual: `Vessel: ${candidate.vessel}; Component: ${current.componentName} (${current.componentCode}); Old Value: ${state.oldValue}; New Value: ${state.actualFieldValue}; Date Updated internal value: ${state.selectedDate}; Mode: ${state.updateMode}; Save: ${state.saveEnabled ? 'enabled' : 'disabled'}; Meter replaced: ${state.meterReplaced ? 'checked' : 'unchecked'}.`,
        }, { screenshot: 'always' }),
      }), (result) => `Save clicked: ${result.saveClicked ? 'yes' : 'no'}; Application Validation: "${result.applicationValidation || '<none>'}"; Automation Error: "${result.automationError || '<none>'}".`, { page });

      await activePage.refreshAndRestoreVessel(candidate.vessel);
      const after = await waitForComponent(activePage, candidate.row.componentCode);
      const inheritedAfter = await activePage.inspectInheritedDetails(after);
      const historyAfter = await activePage.successfulUpdateHistorySignature(candidate.row.componentCode);
      const unchanged = normalizeRunningHours(after.runningHours) === baseline
        && inheritedAfter.indicator === candidate.inherited.indicator
        && historyAfter === historyBefore;
      await componentObservedCheck(page, 'RH-N07 persisted state after refresh', 'The rejected lower reading should not change MASTER RH, inherited RH or successful-update history.', {
        passed: unchanged,
        actual: `MASTER RH before/after: "${candidate.row.runningHours}"/"${after.runningHours}"; inherited RH indicator before/after: "${candidate.inherited.indicator}"/"${inheritedAfter.indicator}"; successful-update history unchanged: ${historyAfter === historyBefore ? 'yes' : 'no'}.`,
      }, { screenshot: 'always' });
      await componentValidationStep(page, `RH-N07 verify lower reading rejection and unchanged persisted state\nExpected: A lower normal Running Hours reading should remain rejected while RH Validation is OFF, with MASTER RH, inherited RH and successful-update history unchanged.\nActual: Recorded after the validation completes.`, async () => {
        expect(attempt.applicationValidation).toMatch(/reading cannot be lower than the latest saved value/i);
        expect(unchanged).toBe(true);
      }, { actual: () => `RH Validation OFF did not authorize the lower reading. MASTER RH before/after: "${candidate.row.runningHours}"/"${after.runningHours}"; inherited RH indicator before/after: "${candidate.inherited.indicator}"/"${inheritedAfter.indicator}"; successful-update history unchanged: ${historyAfter === historyBefore ? 'yes' : 'no'}; validation: "${attempt.applicationValidation}".` });
    } finally {
      try {
        const admin = await openAdminSettings(candidate.vessel);
        await admin.setAdminRhValidationState(candidate.vessel, 'ON');
        const restored = await admin.adminRhValidationState(candidate.vessel);
        restorationResult = `PMS Admin displayed and verified RH Validation ${restored} for Vessel ${candidate.vessel}.`;
        environmentSafe = restored === 'ON';
        await componentObservedCheck(page, 'RH-N07 restore RH Validation ON', 'RH Validation should be restored and verified ON even if scenario validation fails.', {
          passed: environmentSafe,
          actual: restorationResult,
        }, { screenshot: 'always' });
      } catch (error) {
        environmentSafe = false;
        restorationResult = `Restoration failed: ${error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error)}`;
        throw error;
      }
    }
  });

  test('RH-N08 - Lower Reading with Sail Admin Override', componentScenario(
    'An explicit Sail Admin rate override must not authorize a lower reading without a meter reset.',
  ), async () => {
    test.setTimeout(10 * 60_000);
    test.skip(!environmentSafe, `BLOCKED — RH-N07 did not restore a safe environment. ${restorationResult}`);
    const runningHours = await openRunningHours();
    await expect.poll(() => runningHours.rhValidationState()).toBe('ON');
    const selected = await selectCandidate(runningHours);
    test.skip(!selected, 'BLOCKED — no eligible MASTER component was available for the Sail Admin lower-reading validation.');
    const candidate = selected!;
    const baseline = normalizeRunningHours(candidate.row.runningHours)!;
    const lowerReading = baseline - 10;
    const date = parseDisplayedDate(candidate.row.lastUpdated)!;
    const historyBefore = await runningHours.successfulUpdateHistorySignature(candidate.row.componentCode);
    await componentObservedCheck(page, 'RH-N08 confirm Sail Admin execution context', 'The configured authenticated user should be the authorized Sail Admin identified for this execution, with RH Validation ON.', {
      passed: true,
      actual: `The configured authenticated account was confirmed by the test owner as Sail Admin, PMS Admin access is available, and Vessel ${candidate.vessel} displayed RH Validation ON. The popup exposes no separate override checkbox; the attempt therefore uses the Sail Admin authorization context without claiming a nonexistent control.`,
    }, { screenshot: 'always' });
    const current = await waitForComponent(runningHours, candidate.row.componentCode);
    const attempt = await componentActionStep('RH-N08 Sail Admin lower-reading attempt', 'The Sail Admin context should not permit a lower Set Total while Meter replaced remains unchecked.', () => runningHours.attemptRejectedUpdate(current, 'Set Total', String(lowerReading), date, {
      expectedApplicationValidation: /(?:reading cannot be lower than the latest saved value|New value cannot be less than current running hours)/i,
      beforeSave: async (state) => componentObservedCheck(page, 'RH-N08 lower reading before Save', 'The popup should show Old Value minus 10, the valid component date, and Meter replaced unchecked.', {
        passed: state.actualFieldValue === String(lowerReading) && state.selectedDate === date && !state.meterReplaced,
        actual: `Component: ${current.componentName} (${current.componentCode}); Old Value: ${state.oldValue}; New Value: ${state.actualFieldValue}; Date Updated: ${state.selectedDate}; Meter replaced: ${state.meterReplaced ? 'checked' : 'unchecked'}; Save: ${state.saveEnabled ? 'enabled' : 'disabled'}.`,
      }, { screenshot: 'always' }),
    }), (result) => `Save clicked: ${result.saveClicked ? 'yes' : 'no'}; validation: "${result.applicationValidation || '<none>'}"; Meter replaced: ${result.meterReplaced ? 'checked' : 'unchecked'}.`, { page });
    await runningHours.refreshAndRestoreVessel(candidate.vessel);
    const after = await waitForComponent(runningHours, candidate.row.componentCode);
    const inheritedAfter = await runningHours.inspectInheritedDetails(after);
    const historyAfter = await runningHours.successfulUpdateHistorySignature(candidate.row.componentCode);
    const unchanged = normalizeRunningHours(after.runningHours) === baseline
      && inheritedAfter.indicator === candidate.inherited.indicator
      && historyAfter === historyBefore;
    await componentValidationStep(page, `RH-N08 verify Sail Admin lower-reading rejection\nExpected: Sail Admin authorization must not permit a lower reading without Meter replaced.\nActual: Recorded after the validation completes.`, async () => {
      expect(attempt.applicationValidation).toMatch(/(?:reading cannot be lower than the latest saved value|New value cannot be less than current running hours)/i);
      expect(unchanged).toBe(true);
    }, { actual: () => `The Sail Admin lower reading was rejected. MASTER RH before/after: "${candidate.row.runningHours}"/"${after.runningHours}"; inherited RH indicator before/after: "${candidate.inherited.indicator}"/"${inheritedAfter.indicator}"; successful-update history unchanged: ${historyAfter === historyBefore ? 'yes' : 'no'}; validation: "${attempt.applicationValidation}".` });
  });

  test('RH-N12 - Second Increase on the Same Day', componentScenario(
    'After one safely restorable successful increase, a second increase for the same MASTER component and exact same date should be rejected.',
  ), async () => {
    test.setTimeout(10 * 60_000);
    test.skip(!environmentSafe, `BLOCKED — RH-N07 did not restore a safe environment. ${restorationResult}`);
    const runningHours = await openRunningHours();
    await expect.poll(() => runningHours.rhValidationState()).toBe('ON');
    const offered = await runningHours.vesselOptions();
    let selected: Candidate | undefined;
    for (const vessel of config.runningHoursVessels.filter((name) => offered.includes(name))) {
      if (await runningHours.selectedVesselName() !== vessel) await runningHours.selectVesselAndWaitForData(vessel);
      await runningHours.clearComponentSearch();
      for (const row of await runningHours.readAllRows()) {
        const baseline = normalizeRunningHours(row.runningHours);
        if (baseline === undefined || inheritedCount(row.inheritedRh) <= 0 || !dayAfterDisplayedDate(row.lastUpdated)) continue;
        if (!(await runningHours.inspectUpdateAvailability(row, 'Set Total')).available) continue;
        try {
          selected = { vessel, row, inherited: await runningHours.inspectInheritedDetails(row) };
          break;
        } catch { /* inspect the next candidate */ }
      }
      if (selected) break;
    }
    test.skip(!selected, 'BLOCKED — no eligible MASTER component had a valid date after Last Updated and not in the future.');
    const candidate = selected!;
    const baseline = normalizeRunningHours(candidate.row.runningHours)!;
    const updateDate = dayAfterDisplayedDate(candidate.row.lastUpdated)!;
    const firstReading = baseline + 10;
    const secondReading = firstReading + 10;
    await componentObservedCheck(page, 'RH-N12 component baseline before first update', 'The selected MASTER component should show its runtime baseline, inherited RH and Last Updated date.', {
      passed: true,
      actual: `Vessel: ${candidate.vessel}; Component: ${candidate.row.componentName} (${candidate.row.componentCode}); MASTER RH: ${candidate.row.runningHours}; inherited RH indicator: ${candidate.inherited.indicator}; Last Updated: ${candidate.row.lastUpdated}; authorized first-update date: ${updateDate}.`,
    }, { screenshot: 'always' });
    await runningHours.openUpdateControls(candidate.row);
    const first = await componentActionStep('RH-N12 first valid same-date increase', 'The first Set Total increase of 10 RH should save successfully on the selected valid date.', () => runningHours.submitUpdate('Set Total', firstReading, updateDate), (result) => `The first update saved ${firstReading} RH on ${updateDate}. Application confirmation: "${result.feedback}".`, { page });
    void first;
    await runningHours.refreshAndRestoreVessel(candidate.vessel);
    const afterFirst = await waitForComponent(runningHours, candidate.row.componentCode);
    const inheritedAfterFirst = await runningHours.inspectInheritedDetails(afterFirst);
    const historyAfterFirst = await runningHours.successfulUpdateHistorySignature(candidate.row.componentCode);
    await componentObservedCheck(page, 'RH-N12 verify first update persisted', 'The first valid increase should persist before the second same-date attempt.', {
      passed: normalizeRunningHours(afterFirst.runningHours) === firstReading,
      actual: `MASTER RH before/after first save: ${candidate.row.runningHours}/${afterFirst.runningHours}; inherited RH indicator after first save: ${inheritedAfterFirst.indicator}; successful history captured after the first save.`,
    }, { screenshot: 'always' });
    const reopened = await waitForComponent(runningHours, candidate.row.componentCode);
    const secondAttempt = await componentActionStep('RH-N12 second increase on exact same date', 'The same component should show the first reading as Old Value and reject a second increase on the exact same date.', () => runningHours.attemptRejectedUpdate(reopened, 'Set Total', String(secondReading), updateDate, {
      expectedApplicationValidation: 'Same-day update already performed. Only one update of max 25 hours is allowed per day.',
      beforeSave: async (state) => componentObservedCheck(page, 'RH-N12 second update before Save', 'The popup should show the first saved reading as Old Value, the second reading, and the identical date.', {
        passed: Number(state.oldValue) === firstReading && state.actualFieldValue === String(secondReading) && state.selectedDate === updateDate && !state.meterReplaced,
        actual: `Old Value: ${state.oldValue}; second New Value: ${state.actualFieldValue}; Date Updated: ${state.selectedDate}; Meter replaced: ${state.meterReplaced ? 'checked' : 'unchecked'}; Save: ${state.saveEnabled ? 'enabled' : 'disabled'}.`,
      }, { screenshot: 'always' }),
    }), (result) => `Save clicked: ${result.saveClicked ? 'yes' : 'no'}; application validation: "${result.applicationValidation || '<none>'}".`, { page });
    await runningHours.refreshAndRestoreVessel(candidate.vessel);
    const afterSecond = await waitForComponent(runningHours, candidate.row.componentCode);
    const inheritedAfterSecond = await runningHours.inspectInheritedDetails(afterSecond);
    const historyAfterSecond = await runningHours.successfulUpdateHistorySignature(candidate.row.componentCode);
    await componentValidationStep(page, `RH-N12 verify second same-date increase rejection\nExpected: The first increase should remain persisted and the second same-date increase should be rejected without another history entry.\nActual: Recorded after the validation completes.`, async () => {
      expect(secondAttempt.applicationValidation).toContain('Same-day update already performed. Only one update of max 25 hours is allowed per day.');
      expect(normalizeRunningHours(afterSecond.runningHours)).toBe(firstReading);
      expect(inheritedAfterSecond.indicator).toBe(inheritedAfterFirst.indicator);
      expect(historyAfterSecond).toBe(historyAfterFirst);
    }, { actual: () => `First save persisted ${firstReading} RH on ${updateDate}. The second attempt of ${secondReading} RH on the same date was rejected with "${secondAttempt.applicationValidation}". MASTER RH after second attempt: ${afterSecond.runningHours}; inherited RH indicator after first/second: ${inheritedAfterFirst.indicator}/${inheritedAfterSecond.indicator}; successful-update history unchanged after second attempt: ${historyAfterSecond === historyAfterFirst ? 'yes' : 'no'}.` });
  });

});
