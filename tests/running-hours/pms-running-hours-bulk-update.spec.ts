import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { RunningHoursPage, type RunningHoursGridRow, type RunningHoursInheritedChild, type RunningHoursUpdateAction } from '../../pages/RunningHoursPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import { attachFailureScreenshot, componentActionStep, componentObservedCheck, componentScenario, componentValidationStep } from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession } from '../../utils/componentsSession';
import { BULK_UPDATE_CONFIG, config, type SelectionCount } from '../../utils/config';
import { normalizeRunningHours } from '../../utils/runningHoursValidation';

const validateSelectionCount = (name: string, value: SelectionCount): void => {
  if (value !== 'All' && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`${name} must be a positive integer or the exact case-sensitive value 'All'; received ${String(value)}.`);
  }
};
validateSelectionCount('BULK_UPDATE_CONFIG.vesselCount', BULK_UPDATE_CONFIG.vesselCount);
validateSelectionCount('BULK_UPDATE_CONFIG.componentsPerVessel', BULK_UPDATE_CONFIG.componentsPerVessel);
if (BULK_UPDATE_CONFIG.inheritedComponents !== 'All'
  && (!Number.isInteger(BULK_UPDATE_CONFIG.inheritedComponents) || BULK_UPDATE_CONFIG.inheritedComponents < 0)) {
  throw new Error(`BULK_UPDATE_CONFIG.inheritedComponents must be a non-negative integer or the exact case-sensitive value 'All'; received ${String(BULK_UPDATE_CONFIG.inheritedComponents)}.`);
}
if (BULK_UPDATE_CONFIG.componentsPerVessel !== 'All'
  && BULK_UPDATE_CONFIG.inheritedComponents !== 'All'
  && BULK_UPDATE_CONFIG.inheritedComponents > BULK_UPDATE_CONFIG.componentsPerVessel) {
  throw new Error('BULK_UPDATE_CONFIG.inheritedComponents cannot exceed BULK_UPDATE_CONFIG.componentsPerVessel.');
}

type Selected = {
  row: RunningHoursGridRow;
  type: 'Standalone' | 'Inherited-linked';
  oldRh: number;
  newRh: number;
  invalid: boolean;
  inheritedBefore: string;
  historyBefore: string;
  validation: string;
  persisted: string;
};

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
const shuffle = <T>(values: T[], seed: number) => {
  let state = seed >>> 0;
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = Math.floor((state / 0x100000000) * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
};
const isAll = (value: SelectionCount): value is 'All' => value === 'All';
const configuredCount = (value: SelectionCount) => isAll(value) ? "'All'" : String(value);
const seedValue = (salt = 0) => {
  const configured = Number(BULK_UPDATE_CONFIG.randomSeed?.trim());
  return (((Number.isFinite(configured) && configured > 0 ? configured : Date.now()) >>> 0) ^ salt) >>> 0;
};
const seedFor = (seed: number, value: string) => {
  let result = seed >>> 0;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619) >>> 0;
  return result;
};
type InheritanceSelection<T> = {
  selected: T[];
  inheritedDiscovered: number;
  nonInheritedDiscovered: number;
  inheritedSelected: number;
  nonInheritedSelected: number;
  inheritedMissing: number;
  totalMissing: number;
  exact: boolean;
  fallbackReason: string;
  shortage: string;
};
const selectByInheritance = <T extends { row: RunningHoursGridRow }>(values: T[], seed: number): InheritanceSelection<T> => {
  const inherited = shuffle(values.filter(({ row }) => inheritedCount(row.inheritedRh) > 0), seed ^ 0x1a11);
  const nonInherited = shuffle(values.filter(({ row }) => inheritedCount(row.inheritedRh) === 0), seed ^ 0x0a11);
  const configuredInherited = BULK_UPDATE_CONFIG.inheritedComponents;
  const configuredTotal = BULK_UPDATE_CONFIG.componentsPerVessel;
  const totalTarget = isAll(configuredTotal) ? values.length : configuredTotal;
  const inheritedTarget = isAll(configuredInherited) ? totalTarget : Math.min(configuredInherited, totalTarget);
  const nonInheritedTarget = totalTarget - inheritedTarget;
  const selectedInherited = inherited.slice(0, inheritedTarget);
  const selectedNonInherited = nonInherited.slice(0, nonInheritedTarget);
  let remaining = totalTarget - selectedInherited.length - selectedNonInherited.length;
  if (remaining > 0) {
    selectedNonInherited.push(...nonInherited.slice(selectedNonInherited.length, selectedNonInherited.length + remaining));
    remaining = totalTarget - selectedInherited.length - selectedNonInherited.length;
  }
  if (remaining > 0) selectedInherited.push(...inherited.slice(selectedInherited.length, selectedInherited.length + remaining));
  const inheritedMissing = Math.max(0, inheritedTarget - selectedInherited.length);
  const totalMissing = Math.max(0, totalTarget - selectedInherited.length - selectedNonInherited.length);
  const exact = inheritedMissing === 0 && totalMissing === 0 && selectedNonInherited.length === nonInheritedTarget;
  const fallbackParts: string[] = [];
  if (inheritedMissing) fallbackParts.push(`${inheritedMissing} inherited slot(s) substituted with eligible non-inherited components where available`);
  if (selectedInherited.length > inheritedTarget) fallbackParts.push(`${selectedInherited.length - inheritedTarget} non-inherited slot(s) filled with additional eligible inherited components`);
  if (totalMissing) fallbackParts.push(`${totalMissing} total component slot(s) unavailable`);
  if (!inherited.length && inheritedTarget) fallbackParts.push('inheritance coverage was not exercised because no inherited component was eligible');
  const fallbackReason = fallbackParts.join('; ') || 'exact configured mix available';
  return {
    selected: shuffle([...selectedInherited, ...selectedNonInherited], seed ^ 0xb017),
    inheritedDiscovered: inherited.length,
    nonInheritedDiscovered: nonInherited.length,
    inheritedSelected: selectedInherited.length,
    nonInheritedSelected: selectedNonInherited.length,
    inheritedMissing,
    totalMissing,
    exact,
    fallbackReason,
    shortage: totalMissing ? `requested ${totalTarget} total components, maximum safe executable count ${totalTarget - totalMissing}` : '',
  };
};
const componentTable = (vessel: string, rows: Selected[]) => [
  'Row | Vessel | Component | Type | Old RH | New RH | Validation | Persisted Result',
  ...rows.map((item, index) => `${index + 1} | ${vessel} | ${item.row.componentName} (${item.row.componentCode}) | ${item.type} | ${item.oldRh} | ${item.newRh} | ${item.validation || 'Pending'} | ${item.persisted || 'Pending'}`),
].join(' / ');

type PositiveSelected = {
  row: RunningHoursGridRow;
  type: 'Standalone' | 'Inherited-linked';
  oldRh: number;
  delta: number;
  entered: number;
  expected: number;
  child?: RunningHoursInheritedChild;
  historyBefore: string;
};

test.describe('PMS Running Hours bulk update positive and negative validation', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    ({ context, page } = await openPrimaryComponentsSession(browser));
  });
  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    // A stalled/error bulk dialog can leave the shared page unusable for the
    // next independent case. Reload only after evidence is captured; never
    // click Save again or retry an uncertain write.
    if (page && !page.isClosed()) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      const restored = await new TechnicalPage(page).goToRunningHours().catch(() => undefined);
      await restored?.waitForScreen().catch(() => undefined);
    }
  });
  test.afterAll(async () => context?.close());

  const discoverBulkRows = async (runningHours: RunningHoursPage, rows: RunningHoursGridRow[]) => {
    const dialog = await runningHours.openBulkUpdateControls();
    const discovered = new Map<string, RunningHoursGridRow>();
    await dialog.evaluate((node) => {
      const scrollable = [node, ...Array.from(node.querySelectorAll('*'))]
        .filter((item) => item.scrollHeight > item.clientHeight)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];
      if (scrollable) scrollable.scrollTop = 0;
    });
    for (let guard = 0; guard < 200; guard += 1) {
      for (const row of rows) {
        if (!discovered.has(row.componentCode) && await runningHours.bulkUpdateRow(dialog, row).count()) {
          discovered.set(row.componentCode, row);
        }
      }
      const state = await dialog.evaluate((node) => {
        const scrollable = [node, ...Array.from(node.querySelectorAll('*'))]
          .filter((item) => item.scrollHeight > item.clientHeight)
          .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];
        if (!scrollable) return { atEnd: true, before: 0, after: 0 };
        const before = scrollable.scrollTop;
        const maximum = Math.max(0, scrollable.scrollHeight - scrollable.clientHeight);
        scrollable.scrollTop = Math.min(maximum, before + Math.max(1, Math.floor(scrollable.clientHeight * 0.8)));
        return { atEnd: before >= maximum, before, after: scrollable.scrollTop };
      });
      if (state.atEnd || state.after === state.before) break;
      await page.waitForTimeout(100);
    }
    const close = dialog.getByRole('button', { name: /^(?:cancel|close)$/i }).filter({ visible: true }).last();
    if (await close.count()) await close.click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    return [...discovered.values()];
  };

  const selectPositiveBulkData = async (seed: number, excludedVessels = new Set<string>()): Promise<{ runningHours: RunningHoursPage; vessel: string; selected: PositiveSelected[]; coverage: string; authorizedCount: number }> => {
    const runningHours = await new TechnicalPage(page).goToRunningHours();
    await runningHours.waitForScreen();
    await expect.poll(() => runningHours.rhValidationState()).toBe('ON');
    const offered = await runningHours.vesselOptions();
    const authorized = config.runningHoursVessels.filter((name) => offered.includes(name));
    const vesselCandidates = authorized.filter((vessel) => !excludedVessels.has(vessel));
    const plans: Array<{ vessel: string; selection: InheritanceSelection<{ row: RunningHoursGridRow; type: 'Standalone' | 'Inherited-linked' }>; exclusions: string }> = [];
    for (const vessel of vesselCandidates) {
      if (await runningHours.selectedVesselName() !== vessel) await runningHours.selectVesselAndWaitForData(vessel);
      await runningHours.clearComponentSearch();
      const rows = await runningHours.readAllRows();
      const bulkRows = await discoverBulkRows(runningHours, rows);
      const counts = new Map<string, number>();
      bulkRows.forEach((row) => counts.set(row.componentCode, (counts.get(row.componentCode) ?? 0) + 1));
      const eligible = bulkRows.filter((row) => {
        const rh = normalizeRunningHours(row.runningHours);
        const date = displayedDate(row.lastUpdated);
        return rh !== undefined && rh >= 0
          && (!date || date < today()) && counts.get(row.componentCode) === 1;
      });
      const excludedNotInBulk = Math.max(0, rows.length - bulkRows.length);
      const excludedDuplicate = bulkRows.filter((row) => counts.get(row.componentCode)! > 1).length;
      const excludedInvalidRh = bulkRows.filter((row) => {
        const rh = normalizeRunningHours(row.runningHours);
        return rh === undefined || rh < 0;
      }).length;
      const excludedDate = bulkRows.filter((row) => {
        const date = displayedDate(row.lastUpdated);
        return Boolean(date && date >= today());
      }).length;
      const distinct = [...new Map(eligible.map((row) => [row.componentCode, row])).values()];
      const inheritanceSelection = selectByInheritance(distinct.map((row) => ({
        row,
        type: inheritedCount(row.inheritedRh) > 0 ? 'Inherited-linked' as const : 'Standalone' as const,
      })), seedFor(seed, vessel));
      plans.push({
        vessel,
        selection: inheritanceSelection,
        exclusions: `excluded not-in-Bulk/duplicate-code/invalid-RH/date-unsafe ${excludedNotInBulk}/${excludedDuplicate}/${excludedInvalidRh}/${excludedDate}`,
      });
    }
    const inventory = plans.map(({ vessel, selection, exclusions }) => `${vessel}: available inherited/non-inherited ${selection.inheritedDiscovered}/${selection.nonInheritedDiscovered}; executable inherited/non-inherited ${selection.inheritedSelected}/${selection.nonInheritedSelected}; missing inherited/total ${selection.inheritedMissing}/${selection.totalMissing}; ${selection.fallbackReason}; ${exclusions}`).join(' | ');
    const executable = plans.filter(({ selection }) => selection.selected.length > 0);
    if (!executable.length) return { runningHours, vessel: '', selected: [], coverage: inventory || 'No authorized vessels were available.', authorizedCount: authorized.length };
    const exact = executable.filter(({ selection }) => selection.exact);
    const candidatePool = exact.length ? exact : executable;
    const maximum = Math.max(...candidatePool.map(({ selection }) => selection.selected.length));
    const maximumTotal = candidatePool.filter(({ selection }) => selection.selected.length === maximum);
    const maximumInherited = Math.max(...maximumTotal.map(({ selection }) => selection.inheritedSelected));
    const best = maximumTotal.filter(({ selection }) => selection.inheritedSelected === maximumInherited);
    const plan = shuffle(best, seed ^ 0x5e1ec7)[0];
    if (await runningHours.selectedVesselName() !== plan.vessel) await runningHours.selectVesselAndWaitForData(plan.vessel);
    const selected: PositiveSelected[] = [];
    for (let index = 0; index < plan.selection.selected.length; index += 1) {
        const item = plan.selection.selected[index];
        const oldRh = normalizeRunningHours(item.row.runningHours)!;
        const delta = [5, 10, 15, 20][index % 4];
        const inheritedDetails = item.type === 'Inherited-linked' ? await runningHours.inspectInheritedDetails(item.row) : undefined;
        const child = inheritedDetails?.children.find((entry) => entry.rhCounterType.toUpperCase() === 'INHERITED');
        if (item.type === 'Inherited-linked' && !child) continue;
        selected.push({ ...item, oldRh, delta, entered: oldRh + delta, expected: oldRh + delta, child,
          historyBefore: await runningHours.successfulUpdateHistorySignature(item.row.componentCode) });
    }
    const requested = isAll(BULK_UPDATE_CONFIG.componentsPerVessel) ? selected.length : BULK_UPDATE_CONFIG.componentsPerVessel;
    const missing = Math.max(0, requested - selected.length);
    const status = plan.selection.exact ? 'FULL' : 'PARTIAL';
    return {
      runningHours,
      vessel: plan.vessel,
      selected,
      coverage: `${inventory}; selected vessel ${plan.vessel}; requested/executed/missing total ${requested}/${selected.length}/${missing}; requested/executed/missing inherited ${isAll(BULK_UPDATE_CONFIG.inheritedComponents) ? requested : BULK_UPDATE_CONFIG.inheritedComponents}/${selected.filter((item) => item.type === 'Inherited-linked').length}/${plan.selection.inheritedMissing}; automatic fallback: ${plan.selection.fallbackReason}; coverage ${status}`,
      authorizedCount: authorized.length,
    };
  };

  const runPositiveBulk = async (id: 'RH-P10' | 'RH-P11', action: RunningHoursUpdateAction) => {
    const seed = Number(process.env[`${id.replace('-', '_')}_SEED`]?.trim()) || seedValue(id === 'RH-P10' ? 0x10 : 0x11);
    const completedVessels = new Set<string>();
    let authorizedCount = 0;
    const requestedVessels = isAll(BULK_UPDATE_CONFIG.vesselCount) ? Number.POSITIVE_INFINITY : BULK_UPDATE_CONFIG.vesselCount;
    while (completedVessels.size < requestedVessels) {
    const selection = await selectPositiveBulkData(seed, completedVessels);
    const { runningHours, vessel, selected, coverage } = selection;
    authorizedCount = selection.authorizedCount;
    if (!vessel && completedVessels.size > 0) {
      await componentObservedCheck(page, `${id} remaining configured coverage`, `Every requested authorized vessel should satisfy components ${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)} with inherited quota ${configuredCount(BULK_UPDATE_CONFIG.inheritedComponents)}.`, {
        passed: false,
        actual: `BLOCKED after ${completedVessels.size} completed vessel(s); no remaining randomized authorized vessel satisfied the configured quota. ${coverage}`,
      }, { screenshot: 'always' });
      break;
    }
    if (vessel) completedVessels.add(vessel);
    test.skip(!vessel, `BLOCKED — seed ${seed}: no remaining authorized test vessel satisfied components ${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)} / inherited ${configuredCount(BULK_UPDATE_CONFIG.inheritedComponents)}. ${coverage}`);
    await componentObservedCheck(page, `${id} selected vessel and randomized component list`, `The automation should inventory every authorized vessel, prefer exact coverage, and otherwise execute the seeded maximum available eligible component mix.`, {
      passed: selected.length > 0,
      actual: `Seed ${seed}; configured vessels/components/inherited ${configuredCount(BULK_UPDATE_CONFIG.vesselCount)}/${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)}/${configuredCount(BULK_UPDATE_CONFIG.inheritedComponents)}; Vessel ${vessel}; ${coverage}; selected ${selected.length}. ${selected.map((item) => `${item.row.componentName} (${item.row.componentCode}) ${item.type}: MASTER ${item.oldRh}, delta ${item.delta}, expected ${item.expected}${item.child ? `; child ${item.child.name} (${item.child.componentCode}) ${item.child.currentCumulativeRH}→${normalizeRunningHours(item.child.currentCumulativeRH)! + item.delta}` : ''}`).join(' | ')}`,
    }, { screenshot: 'always' });
    const dialog = await runningHours.openBulkUpdateControls();
    const configured = await runningHours.configureBulkUpdate(dialog, today(), action);
    for (const item of selected) {
      const input = action === 'Set Total' ? item.entered : item.delta;
      const state = await runningHours.fillBulkUpdateValue(dialog, item.row, String(input));
      expect(state.meterReplaced).toBe(false);
      expect(state.validation, `${item.row.componentCode} should not show validation for ${input}`).toBe('');
    }
    await componentObservedCheck(page, `${id} completed genuine multi-component bulk form`, `All ${selected.length} rows should be ready in ${action} mode for one Bulk Save.`, {
      passed: await runningHours.bulkUpdateSaveEnabled(dialog),
      actual: `Vessel ${vessel}; mode ${configured.mode}; date ${configured.date}; rows ${selected.length}; distinct inputs ${new Set(selected.map((item) => action === 'Set Total' ? item.entered : item.delta)).size}; Bulk Save actions planned: 1.`,
    }, { screenshot: 'always' });
    const diagnosticWindowMs = Number(process.env.RH_BULK_DIAGNOSTIC_TIMEOUT_MS ?? '120000');
    const save = await componentActionStep(`${id} click Bulk Save once and monitor response`, 'One Bulk Save should process every selected valid row and reach a definitive UI/backend outcome.',
      () => runningHours.saveBulkUpdate(dialog, Number.isFinite(diagnosticWindowMs) ? diagnosticWindowMs : 120_000),
      (result) => `Vessel ${vessel}; outcome ${result.outcome}; submitted ${result.submittedAt}; observed ${(result.elapsedMs / 1000).toFixed(1)}s; requests ${result.requests.map((request) => `${request.method} ${new URL(request.url).pathname} ${request.state}${request.status ? ` HTTP ${request.status}` : ''}`).join(' | ') || '<none>'}; notifications ${result.notifications.join(' | ') || '<none>'}; validations ${result.validations.join(' | ') || '<none>'}; console errors ${result.consoleErrors.join(' | ') || '<none>'}.`, { page });
    try {
      await runningHours.refreshAndRestoreVessel(vessel);
    } catch (error) {
      const requests = save.requests;
      const completed = requests.filter((request) => request.state === 'completed').length;
      const failed = requests.filter((request) => request.state === 'failed').length;
      const pending = requests.filter((request) => request.state === 'pending').length;
      await componentValidationStep(page, `${id} classify Bulk Save and persisted-state verification\nExpected: The Bulk Save should complete successfully, after which every selected MASTER, linked child and history should be verified.\nActual: Recorded after validation completes.`, async () => {
        expect(save.outcome, `Bulk Save ended as ${save.outcome}; persistence could not be confirmed after the Running Hours page failed to restore`).toBe('success');
      }, { actual: () => `Vessel ${vessel}; Bulk Save outcome ${save.outcome}; selected/submitted ${selected.length}/${selected.length}; Bulk Save actions 1; requests completed/failed/pending ${completed}/${failed}/${pending}; notifications "${save.notifications.join(' | ') || '<none>'}"; persisted MASTER, INHERITED, Last Updated and history checks NOT EXECUTED because the application did not restore the vessel after the backend failure. Refresh observation: ${error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error)}.` });
      return;
    }
    const afterRows = await runningHours.readAllRows();
    const results: string[] = [];
    let verified = 0;
    for (const item of selected) {
      const after = afterRows.find((row) => row.componentCode === item.row.componentCode);
      const actual = normalizeRunningHours(after?.runningHours ?? '');
      const historyAfter = await runningHours.successfulUpdateHistorySignature(item.row.componentCode);
      let childResult = 'not applicable';
      let childOk = true;
      if (item.child && after) {
        const details = await runningHours.inspectInheritedDetails(after);
        const childAfter = details.children.find((child) => child.componentCode === item.child!.componentCode);
        const expectedChild = normalizeRunningHours(item.child.currentCumulativeRH)! + item.delta;
        const actualChild = normalizeRunningHours(childAfter?.currentCumulativeRH ?? '');
        childOk = actualChild === expectedChild;
        childResult = `${item.child.name} (${item.child.componentCode}) ${item.child.currentCumulativeRH}→${childAfter?.currentCumulativeRH ?? '<not found>'}, expected ${expectedChild}`;
      }
      const ok = actual === item.expected && childOk && historyAfter !== item.historyBefore;
      if (ok) verified += 1;
      results.push(`${item.row.componentName} (${item.row.componentCode}) ${item.type}: MASTER ${item.oldRh}→${actual}, input ${action === 'Set Total' ? item.entered : item.delta}, expected ${item.expected}; INHERITED ${childResult}; history ${historyAfter === item.historyBefore ? 'unchanged' : 'changed'}; ${ok ? 'PASS' : 'FAIL'}`);
    }
    await componentValidationStep(page, `${id} verify every bulk result after refresh\nExpected: Every MASTER should receive only its own ${action === 'Set Total' ? 'total' : 'delta'}, linked children should receive the corresponding delta, and history should record the update.\nActual: Recorded after validation completes.`, async () => {
      expect(save.outcome).toBe('success');
      expect(verified).toBe(selected.length);
    }, { actual: () => `Seed ${seed}; configured vessels ${configuredCount(BULK_UPDATE_CONFIG.vesselCount)}; components per vessel ${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)}; Vessel ${vessel}; selected/submitted/verified ${selected.length}/${selected.length}/${verified}; Bulk Save actions: 1. ${results.join(' | ')}` });
    }
    expect(completedVessels.size).toBe(isAll(BULK_UPDATE_CONFIG.vesselCount) ? authorizedCount : BULK_UPDATE_CONFIG.vesselCount);
  };

  test('RH-P10 - Bulk Set Total', componentScenario('One Bulk Set Total operation should update every configured eligible MASTER component with its own total and propagate the corresponding delta to each selected linked INHERITED child.'), async () => {
    test.setTimeout(45 * 60_000);
    await runPositiveBulk('RH-P10', 'Set Total');
  });

  test('RH-P11 - Bulk Add Delta', componentScenario('One Bulk Add Delta operation should increase every configured eligible MASTER component by its own delta and propagate that delta to each selected linked INHERITED child.'), async () => {
    test.setTimeout(45 * 60_000);
    await runPositiveBulk('RH-P11', 'Add Delta');
  });

  test('RH-N20 - Invalid row in a genuine multi-component Bulk RH Update', componentScenario(
    'The configured MASTER components should be entered in one Bulk RH dialog, lower values should be rejected, and the remaining valid test-environment rows should be saved together and verified after refresh.',
  ), async () => {
    test.setTimeout(30 * 60_000);
    const seed = Number(process.env.RH_N20_SEED?.trim()) || seedValue(0x20);
    const runningHours = await new TechnicalPage(page).goToRunningHours();
    await runningHours.waitForScreen();
    await expect.poll(() => runningHours.rhValidationState()).toBe('ON');

    const offered = await runningHours.vesselOptions();
    const authorizedVessels = config.runningHoursVessels.filter((name) => offered.includes(name));
    const plannedCoverage = new Map<string, string>();
    const plannedVessels: string[] = [];
    const excludedVessels = new Set<string>();
    const plannedTarget = isAll(BULK_UPDATE_CONFIG.vesselCount) ? authorizedVessels.length : BULK_UPDATE_CONFIG.vesselCount;
    while (plannedVessels.length < plannedTarget) {
      const planned = await selectPositiveBulkData(seed, excludedVessels);
      if (!planned.vessel) break;
      if (planned.selected.length < 3) {
        plannedCoverage.set(planned.vessel, `${planned.coverage}; RH-N20 requires at least two invalid rows and one valid row`);
        excludedVessels.add(planned.vessel);
        continue;
      }
      plannedVessels.push(planned.vessel);
      plannedCoverage.set(planned.vessel, planned.coverage);
      excludedVessels.add(planned.vessel);
    }
    const vessels = plannedVessels;
    const requestedN20Vessels = isAll(BULK_UPDATE_CONFIG.vesselCount) ? authorizedVessels.length : BULK_UPDATE_CONFIG.vesselCount;
    test.skip(authorizedVessels.length === 0, `BLOCKED — seed ${seed}: no configured authorized vessel was available in the Running Hours vessel list.`);
    test.skip(vessels.length === 0, `BLOCKED — seed ${seed}: ${authorizedVessels.length} authorized vessel(s) were inspected, but no safe scenario-relevant Bulk Update component was eligible.`);
    let processedVessels = 0;
    for (const candidateVessel of vessels) {
      if (processedVessels >= requestedN20Vessels) break;
      const vessel = candidateVessel;
      if (await runningHours.selectedVesselName() !== candidateVessel) await runningHours.selectVesselAndWaitForData(candidateVessel);
      await runningHours.clearComponentSearch();
      const rows = await runningHours.readAllRows();
      const bulkRows = await discoverBulkRows(runningHours, rows);
      const counts = new Map<string, number>();
      bulkRows.forEach((row) => counts.set(row.componentCode, (counts.get(row.componentCode) ?? 0) + 1));
      const eligible = bulkRows.filter((row) => {
        const rh = normalizeRunningHours(row.runningHours);
        const date = displayedDate(row.lastUpdated);
        return rh !== undefined && rh >= 0 && (!date || date < today()) && counts.get(row.componentCode) === 1;
      });
      const standaloneCandidates = eligible.filter((row) => inheritedCount(row.inheritedRh) === 0);
      const inheritedCandidates = eligible.filter((row) => inheritedCount(row.inheritedRh) > 0);
      const available = standaloneCandidates.length + inheritedCandidates.length;
      const inheritanceSelection = selectByInheritance([
        ...standaloneCandidates.map((row) => ({ row, type: 'Standalone' as const })),
        ...inheritedCandidates.map((row) => ({ row, type: 'Inherited-linked' as const })),
      ], seedFor(seed, vessel));
      if (available === 0 || inheritanceSelection.selected.length === 0) {
        await componentObservedCheck(page, `RH-N20 ${vessel} component coverage`, `Vessel ${vessel} should provide components ${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)} with inherited quota ${configuredCount(BULK_UPDATE_CONFIG.inheritedComponents)} in the actual Bulk Update table.`, {
          passed: false,
          actual: `BLOCKED for Vessel ${vessel}; Overview rows discovered ${rows.length}; Bulk Update rows discovered ${bulkRows.length}; inherited/non-inherited discovered ${inheritanceSelection.inheritedDiscovered}/${inheritanceSelection.nonInheritedDiscovered}; shortage ${inheritanceSelection.shortage || 'no eligible components'}; no values entered and no Bulk Save attempted.`,
        }, { screenshot: 'always' });
        continue;
      }
      const standalone = standaloneCandidates;
      const inherited = inheritedCandidates;
    const candidates = [...new Map([
      ...standalone.map((row) => ({ row, type: 'Standalone' as const })),
      ...inherited.map((row) => ({ row, type: 'Inherited-linked' as const })),
    ].map((item) => [item.row.componentCode, item])).values()];
    const chosen = selectByInheritance(candidates, seedFor(seed, vessel)).selected;
    const invalidIndexes = new Set(Array.from({ length: Math.min(2, chosen.length) }, (_, index) => index));
    const selected: Selected[] = [];
    for (let index = 0; index < chosen.length; index += 1) {
      const item = chosen[index];
      const oldRh = normalizeRunningHours(item.row.runningHours)!;
      selected.push({ ...item, oldRh, newRh: oldRh + (invalidIndexes.has(index) ? -1 : 1), invalid: invalidIndexes.has(index),
        inheritedBefore: item.type === 'Inherited-linked' ? (await runningHours.inspectInheritedDetails(item.row)).indicator : item.row.inheritedRh,
        historyBefore: await runningHours.successfulUpdateHistorySignature(item.row.componentCode), validation: '', persisted: '' });
    }
    const validRows = selected.filter((item) => !item.invalid);
    await componentObservedCheck(page, 'RH-N20 selected vessel and randomized component list', `The reproducible selection should contain ${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)} distinct eligible Bulk Update rows, using up to two rows for invalid lower-value checks.`, {
      passed: selected.length > 0,
      actual: `Seed ${seed}; configured vessels/components/inherited ${configuredCount(BULK_UPDATE_CONFIG.vesselCount)}/${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)}/${configuredCount(BULK_UPDATE_CONFIG.inheritedComponents)}; Vessel ${vessel}; ${plannedCoverage.get(vessel) ?? '<coverage unavailable>'}; discovered inherited/non-inherited ${inheritanceSelection.inheritedDiscovered}/${inheritanceSelection.nonInheritedDiscovered}; selected inherited/non-inherited ${inheritanceSelection.inheritedSelected}/${inheritanceSelection.nonInheritedSelected}; valid ${validRows.length}; invalid ${selected.length - validRows.length}. ${componentTable(vessel, selected)}`,
    }, { screenshot: 'always' });

    const dialog = await runningHours.openBulkUpdateControls();
    const configured = await runningHours.configureBulkUpdate(dialog, today());
    for (const item of selected) {
      const state = await runningHours.fillBulkUpdateValue(dialog, item.row, String(item.newRh));
      item.validation = item.invalid ? state.validation : (/Ready to update/i.test(state.status) ? 'Ready to update' : state.status);
      expect(state.meterReplaced).toBe(false);
    }
    const mixedSaveEnabled = await runningHours.bulkUpdateSaveEnabled(dialog);
    const invalidIdentified = selected.filter((item) => item.invalid).every((item) => /(?:cannot be less than current running hours|cannot be negative)/i.test(item.validation));
    await componentObservedCheck(page, 'RH-N20 mixed valid and invalid values in one Bulk RH dialog', 'All selected rows should remain in one dialog, both invalid rows should show their exact application validation, and the actual Save state should be recorded.', {
      passed: invalidIdentified && !mixedSaveEnabled,
      actual: `Vessel: ${vessel}; mode/date: ${configured.mode}/${configured.date}; Save: ${mixedSaveEnabled ? 'enabled' : 'disabled'}; selected: ${selected.length}; valid: ${validRows.length}; invalid: ${selected.length - validRows.length}. ${componentTable(vessel, selected)}`,
    }, { screenshot: 'always' });

    if (validRows.length === 0) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await runningHours.waitForScreen();
      if (await runningHours.selectedVesselName() !== vessel) await runningHours.selectVesselAndWaitForData(vessel);
      const afterRows = await runningHours.readAllRows();
      let unchanged = 0;
      for (const item of selected) {
        const after = afterRows.find((row) => row.componentCode === item.row.componentCode);
        const historyAfter = await runningHours.successfulUpdateHistorySignature(item.row.componentCode);
        const verified = normalizeRunningHours(after?.runningHours ?? '') === item.oldRh && historyAfter === item.historyBefore;
        if (verified) unchanged += 1;
        item.persisted = `MASTER ${item.oldRh}→${normalizeRunningHours(after?.runningHours ?? '')}; history ${historyAfter === item.historyBefore ? 'unchanged' : 'changed'}; ${verified ? 'verified' : 'mismatch'}`;
      }
      await componentValidationStep(page, `RH-N20 verify rejected configured rows remained unchanged\nExpected: With every configured input invalid, Bulk Save should remain disabled and no Running Hours or successful History should change.\nActual: Recorded after validation completes.`, async () => {
        expect(mixedSaveEnabled).toBe(false);
        expect(unchanged).toBe(selected.length);
      }, { actual: () => `Seed ${seed}; configured vessels ${configuredCount(BULK_UPDATE_CONFIG.vesselCount)}; components per vessel ${configuredCount(BULK_UPDATE_CONFIG.componentsPerVessel)}; Vessel ${vessel}; invalid rows ${selected.length}; Bulk Save actions 0; unchanged after refresh ${unchanged}/${selected.length}. ${componentTable(vessel, selected)}` });
      processedVessels += 1;
      continue;
    }

    for (const item of selected.filter((row) => row.invalid)) await runningHours.clearBulkUpdateValue(dialog, item.row);
    await componentObservedCheck(page, 'RH-N20 valid rows ready for one Bulk Save', 'Only invalid entries should be cleared while every available valid fallback row remains in the same dialog with Save enabled.', {
      passed: validRows.length > 0 && await runningHours.bulkUpdateSaveEnabled(dialog),
      actual: `Vessel: ${vessel}; valid components remaining: ${validRows.length}; invalid entries cleared: ${selected.length - validRows.length}; planned Bulk Save actions: 1. ${componentTable(vessel, selected)}`,
    }, { screenshot: 'always' });
    const configuredWindow = Number(process.env.RH_N20_DIAGNOSTIC_TIMEOUT_MS ?? '120000');
    const diagnosticWindowMs = Number.isFinite(configuredWindow) && configuredWindow >= 1_000 ? configuredWindow : 120_000;
    const saveDiagnostic = await componentActionStep('RH-N20 save all valid rows together and monitor the application response', 'One Bulk Save should submit every remaining valid row, then the automation should observe UI, validation, notification, backend-request and console outcomes for the bounded diagnostic window.',
      () => runningHours.saveBulkUpdate(dialog, diagnosticWindowMs),
      (result) => {
        const completed = result.requests.filter((request) => request.state === 'completed').length;
        const failed = result.requests.filter((request) => request.state === 'failed').length;
        const pending = result.requests.filter((request) => request.state === 'pending').length;
        const requestDetails = result.requests.map((request) => `${request.method} ${new URL(request.url).pathname}: ${request.state}${request.status !== undefined ? ` HTTP ${request.status}` : ''}${request.body ? `; body="${request.body}"` : ''}${request.failure ? `; failure="${request.failure}"` : ''}`).join(' | ');
        return `Vessel: ${vessel}; submitted together: ${validRows.length}; Bulk Save actions: 1; submitted at: ${result.submittedAt}; observed for: ${(result.elapsedMs / 1_000).toFixed(1)} seconds of ${(result.observationWindowMs / 1_000).toFixed(0)} seconds; outcome: ${result.outcome}; Saving state observed: ${result.savingStateObserved}; Save button: "${result.saveButtonText}" (${result.saveButtonEnabled ? 'enabled' : 'disabled'}); dialog: ${result.dialogVisible ? 'open' : 'closed'}; notifications: "${result.notifications.join(' | ') || '<none>'}"; validations: "${result.validations.join(' | ') || '<none>'}"; requests completed/failed/pending: ${completed}/${failed}/${pending}; ${pending ? 'No backend response received within the configured observation window.' : ''} request details: ${requestDetails || '<no relevant write request observed>'}; browser console errors: "${result.consoleErrors.join(' | ') || '<none>'}".`;
      }, { page });

    await runningHours.refreshAndRestoreVessel(vessel);
    const afterRows = await runningHours.readAllRows();
    let saved = 0;
    let rejected = 0;
    for (const item of selected) {
      const after = afterRows.find((row) => row.componentCode === item.row.componentCode);
      expect(after).toBeDefined();
      const actualRh = normalizeRunningHours(after!.runningHours);
      const inheritedAfter = item.type === 'Inherited-linked' ? (await runningHours.inspectInheritedDetails(after!)).indicator : after!.inheritedRh;
      const historyAfter = await runningHours.successfulUpdateHistorySignature(item.row.componentCode);
      const verified = item.invalid
        ? actualRh === item.oldRh && inheritedAfter === item.inheritedBefore && historyAfter === item.historyBefore
        : actualRh === item.newRh && historyAfter !== item.historyBefore;
      if (verified && item.invalid) rejected += 1;
      if (verified && !item.invalid) saved += 1;
      item.persisted = `MASTER ${item.oldRh}→${actualRh}; inherited ${item.inheritedBefore}→${inheritedAfter}; history ${historyAfter === item.historyBefore ? 'unchanged' : 'changed'}; ${verified ? 'verified' : 'mismatch'}`;
    }
    await componentValidationStep(page, `RH-N20 classify the Save outcome and verify all selected components after refresh\nExpected: The application should complete the Save successfully and persist every valid row, or the test should fail with the exact observed UI/network diagnostic outcome and post-refresh data state.\nActual: Recorded after validation completes.`, async () => {
      expect(saveDiagnostic.outcome, `Bulk Save diagnostic outcome was ${saveDiagnostic.outcome}`).toBe('success');
      expect(saved).toBe(validRows.length);
      expect(rejected).toBe(selected.length - validRows.length);
    }, { actual: () => `Vessel: ${vessel}; Save outcome: ${saveDiagnostic.outcome}; selected: ${selected.length}; submitted together: ${validRows.length}; observed valid rows persisted: ${saved}/${validRows.length}; observed invalid rows unchanged: ${rejected}/${selected.length - validRows.length}; Bulk Save actions: 1. ${componentTable(vessel, selected)}` });
    processedVessels += 1;
    }
    expect(processedVessels, 'The requested number of randomized authorized vessels should complete RH-N20; recorded coverage shortages must not be presented as PASS').toBe(requestedN20Vessels);
  });
});
