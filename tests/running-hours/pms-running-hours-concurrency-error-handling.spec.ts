import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { RunningHoursPage, type RunningHoursGridRow } from '../../pages/RunningHoursPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import { readAppNotification } from '../../utils/appNotification';
import { attachFailureScreenshot, attachRunningHoursComparison, componentActionStep, componentObservedCheck, componentScenario, componentValidationStep } from '../../utils/componentValidationEvidence';
import { openPrimaryPmsSession } from '../../utils/componentsSession';
import { normalizeRunningHours } from '../../utils/runningHoursValidation';

type Candidate = {
  vessel: string;
  row: RunningHoursGridRow;
  baseline: number;
  inheritedBefore: string;
  historyBefore: string;
};

const authorizedVessels = ['AUTO_VESSEL_001', 'AUTO_VESSEL_002', 'AUTO_VESSEL_003', 'PMS Test 1', 'PMS Test 2', 'PMS Test 3', 'PMS Test 4', 'PMS Test 5'];
const inheritedCount = (value: string) => Number(value.replace(/[^\d.-]/g, '')) || 0;
const today = () => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
const displayedDate = (value: string) => {
  const match = value.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!match) return undefined;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
  return month < 0 ? undefined : `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
};
// These testing-only MASTER components were explicitly approved for the controlled
// RH-N21/RH-N22 writes. An environment override can narrow or replace this list.
const defaultDisposableComponentCodes = '651.001,601.001,652.001,653.001';
const approvedCodes = () => new Set((process.env.RH_CONCURRENCY_DISPOSABLE_COMPONENT_CODES ?? defaultDisposableComponentCodes)
  .split(',').map((value) => value.trim()).filter(Boolean));

test.describe('PMS Running Hours concurrency and error handling negative validation', () => {
  let context: BrowserContext;
  let page: Page;
  const reservedCodes = new Set<string>();

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    ({ context, page } = await componentActionStep(
      'Common setup - open authenticated PMS session',
      'The configured PMS user should authenticate successfully and open Running Hours Overview.',
      () => openPrimaryPmsSession(browser),
      (session) => `The authenticated PMS session opened ${session.page.url()}; the login page was ${/\/login(?:\/|$)/i.test(new URL(session.page.url()).pathname) ? 'still displayed' : 'not displayed after authentication'}.`,
    ));
    await observedStep(page, 'Common setup - verify Running Hours Overview', 'PMS > Running Hours > Overview should be ready for the scenarios.',
      `Running Hours Overview opened at ${page.url()} using the shared authenticated session.`);
  });
  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
  });
  test.afterAll(async () => context?.close());

  const openRunningHours = async (target: Page) => {
    let runningHours = new RunningHoursPage(target);
    await runningHours.waitForScreen().catch(async () => {
      runningHours = await new TechnicalPage(target).goToRunningHours();
      await runningHours.waitForScreen();
    });
    await expect.poll(() => runningHours.rhValidationState()).toBe('ON');
    return runningHours;
  };

  const findCandidate = async (runningHours: RunningHoursPage, requireApprovedWrite: boolean): Promise<Candidate | undefined> => {
    const offered = await runningHours.vesselOptions();
    const allowlist = approvedCodes();
    const discovery = process.env.RH_CONCURRENCY_DISCOVERY?.toLowerCase() === 'true';
    for (const vessel of authorizedVessels.filter((name) => offered.includes(name))) {
      if (await runningHours.selectedVesselName() !== vessel) await runningHours.selectVesselAndWaitForData(vessel);
      await runningHours.clearComponentSearch();
      const rows = await runningHours.readAllRows();
      const unique = new Map<string, number>();
      rows.forEach((row) => unique.set(row.componentCode, (unique.get(row.componentCode) ?? 0) + 1));
      const candidates = rows.filter((row) => {
        const baseline = normalizeRunningHours(row.runningHours);
        const lastUpdated = displayedDate(row.lastUpdated);
        return baseline !== undefined && baseline >= 0 && inheritedCount(row.inheritedRh) > 0
          && (!lastUpdated || lastUpdated < today()) && unique.get(row.componentCode) === 1
          && !reservedCodes.has(row.componentCode)
          && (!requireApprovedWrite || discovery || allowlist.has(row.componentCode));
      });
      for (const row of candidates) {
        if (!(await runningHours.inspectUpdateAvailability(row, 'Set Total')).available) continue;
        const inheritedBefore = (await runningHours.inspectInheritedDetails(row)).indicator;
        const historyBefore = await runningHours.successfulUpdateHistorySignature(row.componentCode);
        reservedCodes.add(row.componentCode);
        return { vessel, row, baseline: normalizeRunningHours(row.runningHours)!, inheritedBefore, historyBefore };
      }
    }
    return undefined;
  };

  const currentRow = async (runningHours: RunningHoursPage, code: string) => {
    const row = (await runningHours.readAllRows()).find((item) => item.componentCode === code);
    expect(row, `Component ${code} should be visible without a repeated code search`).toBeDefined();
    return row!;
  };

  const observedStep = async (target: Page, title: string, expected: string, actual: string) =>
    componentActionStep(title, expected, async () => actual, (value) => value, { page: target });

  const recordSelectedComponent = async (target: Page, selected: Candidate, session = '') => {
    const label = session ? `${session} ` : '';
    await observedStep(target, `${label}select vessel`, 'The Running Hours Overview should show the required vessel.',
      `${label}selected Vessel ${selected.vessel} on Running Hours Overview.`);
    await observedStep(target, `${label}locate MASTER component`, 'The intended MASTER component should be visible and uniquely identified.',
      `${label}located ${selected.row.componentName} (${selected.row.componentCode}); category ${selected.row.componentCategory}.`);
    await observedStep(target, `${label}record initial Running Hours state`, 'The initial MASTER RH, inherited RH, last-updated date, and history should be captured before any action.',
      `${label}initial MASTER RH ${selected.row.runningHours}; inherited RH ${selected.inheritedBefore}; last updated ${selected.row.lastUpdated || '<not displayed>'}; successful-history signature captured (${selected.historyBefore ? 'present' : 'empty'}).`);
  };

  const popupValues = async (target: Page) => {
    const dialog = target.getByRole('dialog').filter({ visible: true }).last();
    const inputs = dialog.locator('input').filter({ visible: true });
    return {
      oldValue: await inputs.first().inputValue().catch(() => '<not displayed>'),
      date: await dialog.locator('input[type="date"]').filter({ visible: true }).first().inputValue().catch(() => '<not displayed>'),
    };
  };

  test('RH-N21 - Concurrent Stale Update', componentScenario(
    'The second session should not overwrite the newer Running Hours value, and the rejected stale request should not create another successful change.',
  ), async ({ browser }) => {
    test.setTimeout(20 * 60_000);
    test.skip(process.env.RH_N21_WRITE_APPROVED?.toLowerCase() === 'false', 'RH-N21 was explicitly disabled with RH_N21_WRITE_APPROVED=false.');
    const runningA = await openRunningHours(page);
    const candidate = await findCandidate(runningA, true);
    test.skip(!candidate, 'BLOCKED — no eligible component was present in the exact disposable-component allowlist.');
    const selected = candidate!;
    test.skip(process.env.RH_CONCURRENCY_DISCOVERY?.toLowerCase() === 'true', `DISCOVERY ONLY — RH-N21 reserved ${selected.row.componentName} (${selected.row.componentCode}) on ${selected.vessel}; no Save was attempted.`);
    const authoritative = selected.baseline + 20;
    const stale = selected.baseline + 10;
    let sessionB: { context: BrowserContext; page: Page } | undefined;
    try {
      await recordSelectedComponent(page, selected, 'Session A');
      sessionB = await componentActionStep('RH-N21 open independently authenticated Session B', 'A second authenticated browser context should open Running Hours independently.',
        () => openPrimaryPmsSession(browser),
        (result) => `Session B opened independently at ${result.page.url()}.`, { page });
      const runningB = await openRunningHours(sessionB.page);
      await observedStep(sessionB.page, 'RH-N21 Session B open Running Hours Overview', 'Session B should display Running Hours Overview.', `Session B displayed Running Hours Overview at ${sessionB.page.url()}.`);
      if (await runningB.selectedVesselName() !== selected.vessel) {
        await componentActionStep('RH-N21 Session B select the same vessel', 'Session B should display the same vessel as Session A.',
          async () => { await runningB.selectVesselAndWaitForData(selected.vessel); return selected.vessel; },
          (vessel) => `Session B selected Vessel ${vessel}.`, { page: sessionB.page });
      } else {
        await observedStep(sessionB.page, 'RH-N21 Session B confirm the same vessel', 'Session B should display the same vessel as Session A.', `Session B already displayed Vessel ${selected.vessel}.`);
      }
      const staleRow = await currentRow(runningB, selected.row.componentCode);
      await observedStep(sessionB.page, 'RH-N21 Session B locate the same MASTER component', 'Session B should show the same component and its stale initial value.',
        `Session B located ${staleRow.componentName} (${staleRow.componentCode}) with initial MASTER RH ${staleRow.runningHours}, inherited RH ${staleRow.inheritedRh}, and last updated ${staleRow.lastUpdated || '<not displayed>'}.`);
      await componentActionStep('RH-N21 Session B open stale Update RH popup', 'Session B should open Update RH while it still holds the initial reading.',
        () => runningB.openUpdateControls(staleRow), () => `Session B opened Update RH for ${staleRow.componentName} (${staleRow.componentCode}).`, { page: sessionB.page });
      const sessionBPopup = await popupValues(sessionB.page);
      await observedStep(sessionB.page, 'RH-N21 Session B record stale popup values', 'The popup should expose the old value and initially displayed date.',
        `Session B popup old value ${sessionBPopup.oldValue}; initially displayed date ${sessionBPopup.date}.`);

      await componentActionStep('RH-N21 Session A open Update RH popup', 'Session A should open Update RH for the selected MASTER component.',
        () => runningA.openUpdateControls(selected.row), () => `Session A opened Update RH for ${selected.row.componentName} (${selected.row.componentCode}).`, { page });
      const sessionAPopup = await popupValues(page);
      await observedStep(page, 'RH-N21 Session A record current popup values', 'The popup should expose the current old value and initially displayed date.',
        `Session A popup old value ${sessionAPopup.oldValue}; initially displayed date ${sessionAPopup.date}.`);
      await componentActionStep('RH-N21 Session A saves the authoritative reading', 'Session A should save the newer Set Total reading successfully.', () => runningA.submitUpdate('Set Total', authoritative, today(), { beforeSave: async (state) => {
        await observedStep(page, 'RH-N21 Session A enter authoritative Set Total', 'The new Set Total value and reading date should be ready before Save.',
          `Session A selected ${state.updateMode}; old value ${state.oldValue}; entered ${state.enteredValue} RH; date ${state.selectedDate}; Save not yet clicked.`);
      } }),
        (result) => `Session A clicked Save once and saved ${authoritative} RH for ${selected.row.componentName} (${selected.row.componentCode}) on Vessel ${selected.vessel}. Application response: "${result.feedback}".`, { page });
      await componentActionStep('RH-N21 refresh Session A after authoritative Save', 'Session A should reload the saved authoritative reading.',
        async () => { await runningA.refreshAndRestoreVessel(selected.vessel); return currentRow(runningA, selected.row.componentCode); },
        (row) => `Session A refreshed; ${row.componentName} (${row.componentCode}) displayed MASTER RH ${row.runningHours}.`, { page });
      expect(normalizeRunningHours((await currentRow(runningA, selected.row.componentCode)).runningHours)).toBe(authoritative);
      const historyAfterA = await runningA.successfulUpdateHistorySignature(selected.row.componentCode);

      const staleDialog = sessionB.page.getByRole('dialog').filter({ visible: true }).last();
      await staleDialog.getByRole('radio', { name: 'Set Total', exact: true }).or(staleDialog.getByText('Set Total', { exact: true })).first().click();
      await staleDialog.locator('input[type="number"]').filter({ visible: true }).last().fill(String(stale));
      await staleDialog.getByLabel(/date updated|date/i).filter({ visible: true }).first().or(staleDialog.locator('input[type="date"]').filter({ visible: true }).first()).fill(today());
      await observedStep(sessionB.page, 'RH-N21 Session B enter stale Set Total', 'Session B should show the stale Set Total and date before any Save attempt.',
        `Session B selected Set Total and entered stale value ${stale} RH with date ${today()}; Save not yet clicked.`);
      const staleSave = staleDialog.getByRole('button', { name: /^save$/i });
      const staleSaveEnabled = await staleSave.isEnabled().catch(() => false);
      const staleResponsePromise = sessionB.page.waitForResponse((response) => /running-hours/i.test(response.url()) && ['POST', 'PUT', 'PATCH'].includes(response.request().method()), { timeout: 30_000 }).catch(() => undefined);
      const notification = readAppNotification(sessionB.page, 30_000).catch(() => '');
      let staleSaveClicked = false;
      if (staleSaveEnabled) {
        await staleSave.click();
        staleSaveClicked = true;
      }
      const staleResponse = staleSaveClicked ? await staleResponsePromise : undefined;
      const staleFeedback = await notification;
      const staleDialogVisible = await staleDialog.isVisible().catch(() => false);
      await observedStep(sessionB.page, 'RH-N21 Session B observe stale Save outcome', 'The stale action should expose whether Save was enabled/clicked and the application response.',
        `Save enabled: ${staleSaveEnabled ? 'yes' : 'no'}; Save clicked: ${staleSaveClicked ? 'yes' : 'no'}; dialog remained open: ${staleDialogVisible ? 'yes' : 'no'}; backend response: ${staleResponse ? `HTTP ${staleResponse.status()}` : '<none captured>'}; visible application response: "${staleFeedback || '<no visible message>'}".`);

      await componentActionStep('RH-N21 refresh Session A for final authoritative state', 'Session A should still show the authoritative MASTER reading after the stale attempt.',
        async () => { await runningA.refreshAndRestoreVessel(selected.vessel); return currentRow(runningA, selected.row.componentCode); },
        (row) => `Session A final MASTER RH was ${row.runningHours} for ${row.componentName} (${row.componentCode}).`, { page });
      const after = await currentRow(runningA, selected.row.componentCode);
      await componentActionStep('RH-N21 refresh Session B for final persisted state', 'Session B should reload the same final authoritative MASTER reading.',
        async () => { await runningB.refreshAndRestoreVessel(selected.vessel); return currentRow(runningB, selected.row.componentCode); },
        (row) => `Session B final MASTER RH was ${row.runningHours} for ${row.componentName} (${row.componentCode}).`, { page: sessionB.page });
      const sessionBAfter = await currentRow(runningB, selected.row.componentCode);
      const inheritedAfter = (await runningA.inspectInheritedDetails(after)).indicator;
      const historyAfter = await runningA.successfulUpdateHistorySignature(selected.row.componentCode);
      await attachRunningHoursComparison('RH-N21 Before-and-After Comparison', [
        { field: 'Vessel', initial: selected.vessel, entered: '—', final: selected.vessel },
        { field: 'Component', initial: `${selected.row.componentName} (${selected.row.componentCode})`, entered: '—', final: `${after.componentName} (${after.componentCode})` },
        { field: 'Session A MASTER RH', initial: selected.row.runningHours, entered: String(authoritative), final: after.runningHours },
        { field: 'Session B MASTER RH', initial: staleRow.runningHours, entered: String(stale), final: sessionBAfter.runningHours },
        { field: 'Inherited RH', initial: selected.inheritedBefore, entered: '—', final: inheritedAfter },
        { field: 'Reading date', initial: selected.row.lastUpdated || '<not displayed>', entered: today(), final: after.lastUpdated || '<not displayed>' },
        { field: 'Successful history', initial: selected.historyBefore || '<empty>', entered: '—', final: historyAfter || '<empty>' },
      ]);
      await componentValidationStep(page, `RH-N21 verify stale update cannot overwrite Session A\nExpected: Session B must not reduce the authoritative reading or create another successful history change.\nActual: Recorded after validation completes.`, async () => {
        expect(normalizeRunningHours(after.runningHours)).toBe(authoritative);
        expect(normalizeRunningHours(sessionBAfter.runningHours)).toBe(authoritative);
        expect(staleSaveClicked || !staleSaveEnabled).toBe(true);
        expect(historyAfterA).not.toBe(selected.historyBefore);
        expect(historyAfter).toBe(historyAfterA);
      }, { actual: () => `Session A saved ${authoritative} RH. Session B Save enabled/clicked: ${staleSaveEnabled ? 'yes' : 'no'}/${staleSaveClicked ? 'yes' : 'no'}; dialog remained open: ${staleDialogVisible ? 'yes' : 'no'}; backend response: ${staleResponse ? `HTTP ${staleResponse.status()}` : '<none captured>'}; visible response: "${staleFeedback || '<no visible message>'}". Final MASTER RH in Session A/Session B: ${after.runningHours}/${sessionBAfter.runningHours}; inherited RH: ${selected.inheritedBefore}/${inheritedAfter}; successful history unchanged after Session B: ${historyAfter === historyAfterA ? 'yes' : 'no'}.` });
    } finally {
      await sessionB?.context.close();
    }
  });

  test('RH-N22 - Repeated Submission', componentScenario(
    'Submitting the same Set Total request twice should not apply the increase twice or create a duplicate effective update.',
  ), async () => {
    test.setTimeout(15 * 60_000);
    test.skip(process.env.RH_N22_REPEAT_APPROVED?.toLowerCase() === 'false', 'RH-N22 was explicitly disabled with RH_N22_REPEAT_APPROVED=false.');
    const runningHours = await openRunningHours(page);
    const candidate = await findCandidate(runningHours, true);
    test.skip(!candidate, 'BLOCKED — no eligible component was present in the exact disposable-component allowlist.');
    const selected = candidate!;
    test.skip(process.env.RH_CONCURRENCY_DISCOVERY?.toLowerCase() === 'true', `DISCOVERY ONLY — RH-N22 reserved ${selected.row.componentName} (${selected.row.componentCode}) on ${selected.vessel}; no Save was attempted.`);
    const target = selected.baseline + 20;
    await recordSelectedComponent(page, selected);
    await componentActionStep('RH-N22 open Update RH for the first request', 'The Update RH popup should open for the selected MASTER component.',
      () => runningHours.openUpdateControls(selected.row), () => `Opened Update RH for ${selected.row.componentName} (${selected.row.componentCode}).`, { page });
    const firstPopup = await popupValues(page);
    await observedStep(page, 'RH-N22 record first popup values', 'The popup should show its old value and initially displayed date.',
      `Popup old value ${firstPopup.oldValue}; initially displayed date ${firstPopup.date}.`);
    await componentActionStep('RH-N22 submit the first Set Total request', 'The first Set Total request should save the target reading once.', () => runningHours.submitUpdate('Set Total', target, today(), { beforeSave: async (state) => {
      await observedStep(page, 'RH-N22 enter first Set Total reading', 'The first target reading and date should be visible before Save.',
        `Selected ${state.updateMode}; old value ${state.oldValue}; entered ${state.enteredValue} RH; date ${state.selectedDate}; Save not yet clicked.`);
    } }),
      (result) => `The first request saved ${target} RH for ${selected.row.componentName} (${selected.row.componentCode}) on Vessel ${selected.vessel}. Response: "${result.feedback}".`, { page });
    await componentActionStep('RH-N22 refresh after the first Save', 'The first target reading should persist after refresh.',
      async () => { await runningHours.refreshAndRestoreVessel(selected.vessel); return currentRow(runningHours, selected.row.componentCode); },
      (row) => `After refresh, MASTER RH was ${row.runningHours} for ${row.componentName} (${row.componentCode}).`, { page });
    const afterFirst = await currentRow(runningHours, selected.row.componentCode);
    const historyAfterFirst = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);
    await componentActionStep('RH-N22 reopen Update RH for the repeated request', 'The popup should reopen with the first saved reading as its current value.',
      () => runningHours.openUpdateControls(afterFirst), () => `Reopened Update RH for ${afterFirst.componentName} (${afterFirst.componentCode}) at MASTER RH ${afterFirst.runningHours}.`, { page });
    const repeated = await componentActionStep('RH-N22 repeat the identical Set Total request', 'The repeated identical Set Total request should not apply another effective increase.',
      () => runningHours.attemptRejectedUpdate(afterFirst, 'Set Total', String(target), today(), { alreadyOpen: true, beforeSave: async (state) => {
        await observedStep(page, 'RH-N22 enter identical Set Total reading', 'The identical target and date should be visible before the repeated Save.',
          `Selected ${state.updateMode}; old value ${state.oldValue}; entered ${state.actualFieldValue} RH; date ${state.selectedDate}; Save enabled: ${state.saveEnabled ? 'yes' : 'no'}; Save not yet clicked.`);
      } }),
      (result) => `The repeated request attempted Set Total ${target} RH. Save clicked: ${result.saveClicked ? 'yes' : 'no'}; application response: "${result.applicationValidation || result.feedback || '<none>'}".`, { page });
    await componentActionStep('RH-N22 refresh after the repeated request', 'The page should reload the final persisted MASTER and inherited values.',
      async () => { await runningHours.refreshAndRestoreVessel(selected.vessel); return currentRow(runningHours, selected.row.componentCode); },
      (row) => `After the repeated request and refresh, MASTER RH was ${row.runningHours}.`, { page });
    const afterSecond = await currentRow(runningHours, selected.row.componentCode);
    const inheritedAfter = (await runningHours.inspectInheritedDetails(afterSecond)).indicator;
    const historyAfterSecond = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);
    await attachRunningHoursComparison('RH-N22 Before-and-After Comparison', [
      { field: 'Vessel', initial: selected.vessel, entered: '—', final: selected.vessel },
      { field: 'Component', initial: `${selected.row.componentName} (${selected.row.componentCode})`, entered: '—', final: `${afterSecond.componentName} (${afterSecond.componentCode})` },
      { field: 'MASTER RH', initial: selected.row.runningHours, entered: `${target} (first and repeated)`, final: afterSecond.runningHours },
      { field: 'Inherited RH', initial: selected.inheritedBefore, entered: '—', final: inheritedAfter },
      { field: 'Reading date', initial: selected.row.lastUpdated || '<not displayed>', entered: today(), final: afterSecond.lastUpdated || '<not displayed>' },
      { field: 'Successful history', initial: selected.historyBefore || '<empty>', entered: '—', final: historyAfterSecond || '<empty>' },
    ]);
    await componentValidationStep(page, `RH-N22 verify repeated Set Total is not applied twice\nExpected: MASTER should remain at the first target, inherited RH should not receive another increase, and successful history should not gain a duplicate effective update.\nActual: Recorded after validation completes.`, async () => {
      expect(normalizeRunningHours(afterSecond.runningHours)).toBe(target);
      expect(historyAfterSecond).toBe(historyAfterFirst);
    }, { actual: () => `The first request persisted ${target} RH. The identical repeated request response was "${repeated.applicationValidation || repeated.feedback || '<none>'}". Final MASTER RH: ${afterSecond.runningHours}; inherited indicator before/after: ${selected.inheritedBefore}/${inheritedAfter}; successful history unchanged after the repeat: ${historyAfterSecond === historyAfterFirst ? 'yes' : 'no'}.` });
  });

  test('RH-N23 - Cancel an Update', componentScenario(
    'Cancelling a Running Hours update should not save any changes; MASTER RH, inherited RH, and successful-update history should remain unchanged.',
  ), async () => {
    test.setTimeout(10 * 60_000);
    const runningHours = await openRunningHours(page);
    const candidate = await findCandidate(runningHours, false);
    test.skip(!candidate, 'BLOCKED — no eligible MASTER component with linked inherited RH was available for a non-persistent Cancel test.');
    const selected = candidate!;
    const target = selected.baseline + 1;
    await recordSelectedComponent(page, selected);
    await componentActionStep('RH-N23 open Update RH popup', 'The Update RH popup should open for the selected MASTER component.',
      () => runningHours.openUpdateControls(selected.row), () => `Opened Update RH for ${selected.row.componentName} (${selected.row.componentCode}).`, { page });
    const cancelPopup = await popupValues(page);
    await observedStep(page, 'RH-N23 record current popup values', 'The popup should show the current value and initially displayed date.',
      `Popup old value ${cancelPopup.oldValue}; initially displayed date ${cancelPopup.date}.`);
    const cancelled = await componentActionStep('RH-N23 enter a valid reading and click Cancel', 'The dialog should accept the proposed value and close on Cancel without sending a save.',
      () => runningHours.cancelPendingUpdate(selected.row, 'Set Total', target, today(), { alreadyOpen: true, beforeCancel: async (state) => {
        await observedStep(page, 'RH-N23 enter proposed reading before Cancel', 'The proposed Set Total value and date should be visible before Cancel.',
          `Selected ${state.updateMode}; old value ${state.oldValue}; entered ${state.enteredValue} RH; date ${state.selectedDate}; Cancel not yet clicked.`);
      } }),
      (result) => `Vessel ${selected.vessel}; Component ${selected.row.componentName} (${selected.row.componentCode}); Old RH ${selected.baseline}; entered RH ${result.enteredValue}; date ${result.selectedDate}; dialog closed after Cancel: ${result.dialogClosed ? 'yes' : 'no'}.`, { page });
    expect(cancelled.dialogClosed).toBe(true);
    await observedStep(page, 'RH-N23 verify popup closed after Cancel', 'Cancel should close the popup without displaying a saved update.',
      `The Update RH popup closed after Cancel; no Save action was performed.`);
    await componentActionStep('RH-N23 refresh after Cancel', 'The page should reload the unchanged persisted component values.',
      async () => { await runningHours.refreshAndRestoreVessel(selected.vessel); return currentRow(runningHours, selected.row.componentCode); },
      (row) => `After refresh, ${row.componentName} (${row.componentCode}) displayed MASTER RH ${row.runningHours}.`, { page });
    const after = await currentRow(runningHours, selected.row.componentCode);
    const inheritedAfter = (await runningHours.inspectInheritedDetails(after)).indicator;
    const historyAfter = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);
    await attachRunningHoursComparison('RH-N23 Before-and-After Comparison', [
      { field: 'Vessel', initial: selected.vessel, entered: '—', final: selected.vessel },
      { field: 'Component', initial: `${selected.row.componentName} (${selected.row.componentCode})`, entered: '—', final: `${after.componentName} (${after.componentCode})` },
      { field: 'MASTER RH', initial: selected.row.runningHours, entered: String(target), final: after.runningHours },
      { field: 'Inherited RH', initial: selected.inheritedBefore, entered: '—', final: inheritedAfter },
      { field: 'Reading date', initial: selected.row.lastUpdated || '<not displayed>', entered: today(), final: after.lastUpdated || '<not displayed>' },
      { field: 'Successful history', initial: selected.historyBefore || '<empty>', entered: '—', final: historyAfter || '<empty>' },
    ]);
    await componentValidationStep(page, `RH-N23 verify Cancel preserved persisted data\nExpected: The original MASTER RH, inherited indicator, and successful-update history should remain unchanged after refresh.\nActual: Recorded after validation completes.`, async () => {
      expect(normalizeRunningHours(after.runningHours)).toBe(selected.baseline);
      expect(inheritedAfter).toBe(selected.inheritedBefore);
      expect(historyAfter).toBe(selected.historyBefore);
    }, { actual: () => `Cancel did not persist the entered ${target} RH. Vessel ${selected.vessel}; Component ${selected.row.componentName} (${selected.row.componentCode}); MASTER before/after: ${selected.baseline}/${after.runningHours}; inherited indicator before/after: ${selected.inheritedBefore}/${inheritedAfter}; successful history unchanged: ${historyAfter === selected.historyBefore ? 'yes' : 'no'}.` });
  });

  

  test('RH-N24 - Failed Save Handling', componentScenario(
    'If saving fails, the application should display an error, must not falsely report success, and must leave authoritative MASTER, inherited RH, and history unchanged.',
  ), async () => {
    test.setTimeout(15 * 60_000);
    test.skip(process.env.RH_N24_FAILURE_INJECTION_APPROVED?.toLowerCase() !== 'true', 'BLOCKED — RH-N24 requires coordinator approval for a controlled failure simulation.');
    test.skip(process.env.RH_N24_FAILURE_MODE !== 'abort-request', 'BLOCKED — no supported approved failure-injection mechanism was configured.');
    const runningHours = await openRunningHours(page);
    const candidate = await findCandidate(runningHours, true);
    test.skip(!candidate, 'BLOCKED — no eligible component was present in the exact disposable-component allowlist.');
    const selected = candidate!;
    test.skip(process.env.RH_CONCURRENCY_DISCOVERY?.toLowerCase() === 'true', `DISCOVERY ONLY — RH-N24 reserved ${selected.row.componentName} (${selected.row.componentCode}) on ${selected.vessel}; no Save was attempted.`);
    const target = selected.baseline + 1;
    await recordSelectedComponent(page, selected);
    await componentActionStep('RH-N24 open Update RH popup', 'The Update RH popup should open for the selected MASTER component.',
      () => runningHours.openUpdateControls(selected.row), () => `Opened Update RH for ${selected.row.componentName} (${selected.row.componentCode}).`, { page });
    const failurePopup = await popupValues(page);
    await observedStep(page, 'RH-N24 record current popup values', 'The popup should show the current value and initially displayed date.',
      `Popup old value ${failurePopup.oldValue}; initially displayed date ${failurePopup.date}.`);
    let failureObserved = '';
    const routePattern = '**/technical/api/running-hours/cascade';
    await page.route(routePattern, async (route) => route.abort('failed'));
    try {
      const attempt = await componentActionStep('RH-N24 submit once with approved request failure simulation', 'The application should report the failed save and must not display a false success.',
        () => runningHours.attemptRejectedUpdate(selected.row, 'Set Total', String(target), today(), { alreadyOpen: true, beforeSave: async (state) => {
          await observedStep(page, 'RH-N24 enter reading before failed Save', 'The entered value and date should be visible before the single Save attempt.',
            `Selected ${state.updateMode}; old value ${state.oldValue}; entered ${state.actualFieldValue} RH; date ${state.selectedDate}; Save enabled: ${state.saveEnabled ? 'yes' : 'no'}; Save not yet clicked.`);
        } }),
        (result) => `Save clicked once: ${result.saveClicked ? 'yes' : 'no'}; application response: "${result.applicationValidation || result.feedback || '<none>'}"; automation interaction error: "${result.automationError || '<none>'}".`, { page });
      failureObserved = attempt.applicationValidation || attempt.feedback;
    } finally {
      await page.unroute(routePattern);
    }
    await componentActionStep('RH-N24 refresh after the failed Save', 'The page should reload the unchanged authoritative values after the failed request.',
      async () => { await runningHours.refreshAndRestoreVessel(selected.vessel); return currentRow(runningHours, selected.row.componentCode); },
      (row) => `After refresh, ${row.componentName} (${row.componentCode}) displayed MASTER RH ${row.runningHours}.`, { page });
    const after = await currentRow(runningHours, selected.row.componentCode);
    const inheritedAfter = (await runningHours.inspectInheritedDetails(after)).indicator;
    const historyAfter = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);
    const unchanged = normalizeRunningHours(after.runningHours) === selected.baseline
      && inheritedAfter === selected.inheritedBefore && historyAfter === selected.historyBefore;
    const visibleFailure = /error|fail|unable|network/i.test(failureObserved);
    const falseSuccess = /completed successfully|success/i.test(failureObserved);
    await attachRunningHoursComparison('RH-N24 Before-and-After Comparison', [
      { field: 'Vessel', initial: selected.vessel, entered: '—', final: selected.vessel },
      { field: 'Component', initial: `${selected.row.componentName} (${selected.row.componentCode})`, entered: '—', final: `${after.componentName} (${after.componentCode})` },
      { field: 'MASTER RH', initial: selected.row.runningHours, entered: String(target), final: after.runningHours },
      { field: 'Inherited RH', initial: selected.inheritedBefore, entered: '—', final: inheritedAfter },
      { field: 'Reading date', initial: selected.row.lastUpdated || '<not displayed>', entered: today(), final: after.lastUpdated || '<not displayed>' },
      { field: 'Successful history', initial: selected.historyBefore || '<empty>', entered: '—', final: historyAfter || '<empty>' },
    ]);
    await componentObservedCheck(page, 'RH-N24 observed failed-save handling and persisted state', 'The failed request should display an error, show no false success, and leave MASTER, inherited RH, and history unchanged.', {
      passed: visibleFailure && !falseSuccess && unchanged,
      actual: `Controlled request failure message: "${failureObserved || '<no visible application message>'}"; visible failure shown: ${visibleFailure ? 'yes' : 'no'}; false success shown: ${falseSuccess ? 'yes' : 'no'}; MASTER before/after: ${selected.baseline}/${after.runningHours}; inherited indicator before/after: ${selected.inheritedBefore}/${inheritedAfter}; successful history unchanged: ${historyAfter === selected.historyBefore ? 'yes' : 'no'}.`,
    }, { screenshot: 'always' });
    await componentValidationStep(page, `RH-N24 verify failed Save did not report or persist success\nExpected: A visible failure should be shown, no success should be shown, and authoritative values/history should remain unchanged.\nActual: Recorded after validation completes.`, async () => {
      expect(visibleFailure).toBe(true);
      expect(falseSuccess).toBe(false);
      expect(unchanged).toBe(true);
    }, { actual: () => `The controlled failed request displayed "${failureObserved || '<no visible application message>'}". MASTER before/after: ${selected.baseline}/${after.runningHours}; inherited indicator before/after: ${selected.inheritedBefore}/${inheritedAfter}; history unchanged: ${historyAfter === selected.historyBefore ? 'yes' : 'no'}; false success observed: ${/completed successfully|success/i.test(failureObserved) ? 'yes' : 'no'}.` });
  });
});
