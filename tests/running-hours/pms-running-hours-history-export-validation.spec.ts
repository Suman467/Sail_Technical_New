import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { RunningHoursPage, type RunningHoursGridRow, type RunningHoursHistoryRecord, type RunningHoursInheritedChild } from '../../pages/RunningHoursPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import {
  attachExecutionFailureScreenshot,
  attachRunningHoursComparison,
  executionActionStep,
  executionNotExecutedStep,
  executionObservedCheck,
  executionScenario,
  executionValidationStep,
} from '../../utils/executionEvidence';
import { openPrimaryComponentsSession } from '../../utils/componentsSession';
import { config, HISTORY_TEST_CONFIG, type SelectionCount } from '../../utils/config';
import { normalizeRunningHours } from '../../utils/runningHoursValidation';

const validateSelectionCount = (name: string, value: SelectionCount): void => {
  if (value !== 'All' && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`${name} must be a positive integer or the exact case-sensitive value 'All'; received ${String(value)}.`);
  }
};
validateSelectionCount('HISTORY_TEST_CONFIG.vesselCount', HISTORY_TEST_CONFIG.vesselCount);
validateSelectionCount('HISTORY_TEST_CONFIG.componentsPerVessel', HISTORY_TEST_CONFIG.componentsPerVessel);

type SelectedComponent = {
  vessel: string;
  row: RunningHoursGridRow;
  baseline: number;
  child?: RunningHoursInheritedChild;
};
type ComponentResult = { vessel: string; component: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; passed: boolean; actual: string };
type SelectionCoverage = {
  vessel: string;
  discovered: number;
  eligible: number;
  selected: number;
  blocked: string[];
};

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalized = (value: unknown) => clean(value).replace(/,/g, '').toLowerCase();
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
const seedValue = () => {
  const configured = Number(HISTORY_TEST_CONFIG.randomSeed?.trim());
  return Number.isFinite(configured) && configured > 0 ? configured >>> 0 : Date.now() >>> 0;
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
const isAll = (count: SelectionCount): count is 'All' => count === 'All';
const configuredCount = (count: SelectionCount) => isAll(count) ? "'All'" : String(count);
const seedFor = (seed: number, value: string) => {
  let result = seed >>> 0;
  for (const character of value) result = (Math.imul(result ^ character.charCodeAt(0), 16777619)) >>> 0;
  return result;
};
const distinctComponents = (values: SelectedComponent[]) => {
  const seen = new Set<string>();
  return values.filter(({ row }) => {
    const code = clean(row.componentCode).toLowerCase();
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
};
const resultCounts = (results: ComponentResult[]) => ({
  passed: results.filter((item) => item.status === 'PASS').length,
  failed: results.filter((item) => item.status === 'FAIL').length,
  blocked: results.filter((item) => item.status === 'BLOCKED').length,
});
const recordValues = (record: RunningHoursHistoryRecord) => Object.values(record).map(normalized).filter(Boolean);
const field = (record: RunningHoursHistoryRecord, pattern: RegExp) => clean(Object.entries(record)
  .find(([header]) => pattern.test(clean(header)))?.[1]);
const canonicalDate = (value: string) => {
  const excelSerial = Number(value);
  if (Number.isFinite(excelSerial) && excelSerial > 20_000) {
    const decoded = XLSX.SSF.parse_date_code(excelSerial);
    if (decoded) return `${decoded.y}-${String(decoded.m).padStart(2, '0')}-${String(decoded.d).padStart(2, '0')}`;
  }
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = value.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  }
  const displayed = value.match(/\b(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})\b/);
  if (!displayed) return normalized(value);
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(displayed[2].toLowerCase()) + 1;
  return `${displayed[3]}-${String(month).padStart(2, '0')}-${displayed[1].padStart(2, '0')}`;
};
const canonicalNumber = (value: string) => {
  const parsed = Number(value.replace(/,/g, '').match(/[+-]?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? String(parsed) : normalized(value);
};
const canonicalRecord = (record: RunningHoursHistoryRecord) => {
  const values = Object.values(record).map(clean);
  const value = (pattern: RegExp, index: number) => field(record, pattern) || values[index] || '';
  return {
    date: canonicalDate(value(/date|time/i, 0)),
    componentCode: normalized(value(/component\s*code/i, 1)),
    componentName: normalized(value(/component\s*name/i, 2)),
    previousRh: canonicalNumber(value(/previous/i, 3)),
    newRh: canonicalNumber(value(/new\s*rh/i, 4)),
    change: canonicalNumber(value(/change|delta/i, 5)),
    updatedBy: normalized(value(/updated\s*by/i, 6)),
    source: normalized(value(/source|action|type/i, 7)).split('(', 1)[0].trim(),
  };
};
const recordKey = (record: RunningHoursHistoryRecord) => Object.values(canonicalRecord(record)).join('|');
const readExport = (filePath: string): RunningHoursHistoryRecord[] => {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [clean(key), clean(value)])));
};
const compareRecords = (ui: RunningHoursHistoryRecord[], exported: RunningHoursHistoryRecord[]) => {
  const uiCounts = new Map<string, number>();
  const exportCounts = new Map<string, number>();
  ui.forEach((record) => uiCounts.set(recordKey(record), (uiCounts.get(recordKey(record)) ?? 0) + 1));
  exported.forEach((record) => exportCounts.set(recordKey(record), (exportCounts.get(recordKey(record)) ?? 0) + 1));
  const missing = [...uiCounts].flatMap(([key, count]) => Array(Math.max(0, count - (exportCounts.get(key) ?? 0))).fill(key));
  const extra = [...exportCounts].flatMap(([key, count]) => Array(Math.max(0, count - (uiCounts.get(key) ?? 0))).fill(key));
  return { missing, extra, passed: ui.length === exported.length && missing.length === 0 && extra.length === 0 };
};

test.describe('PMS Running Hours history, persistence and export validation', () => {
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    ({ context, page } = await openPrimaryComponentsSession(browser));
  });
  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachExecutionFailureScreenshot(page, testInfo);
    if (page && !page.isClosed()) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    }
  });
  test.afterAll(async () => context?.close());

  const open = async () => {
    const runningHours = await new TechnicalPage(page).goToRunningHours();
    await runningHours.waitForScreen();
    return runningHours;
  };

  const selectData = async (runningHours: RunningHoursPage, seed: number, requireWritable: boolean) => {
    const offered = await runningHours.vesselOptions();
    // config.runningHoursVessels is the explicit test-write boundary. RH-P17 may
    // discover component codes dynamically, but it never leaves these vessels.
    const authorized = config.runningHoursVessels.filter((name) => offered.includes(name));
    const vesselCandidates = isAll(HISTORY_TEST_CONFIG.vesselCount) ? [...authorized] : shuffle(authorized, seed);
    const selections: Array<{ vessel: string; components: SelectedComponent[] }> = [];
    const shortfalls: string[] = [];
    const componentShortfalls: string[] = [];
    const coverage: SelectionCoverage[] = [];
    for (const vessel of vesselCandidates) {
      if (!isAll(HISTORY_TEST_CONFIG.vesselCount) && selections.length >= HISTORY_TEST_CONFIG.vesselCount) break;
      if (await runningHours.selectedVesselName() !== vessel) await runningHours.selectVesselAndWaitForData(vessel);
      await runningHours.clearComponentSearch();
      const discoveredRows = await runningHours.readAllRows();
      const baselineEligible = discoveredRows.filter((row) => {
        const rh = normalizeRunningHours(row.runningHours);
        const date = displayedDate(row.lastUpdated);
        return rh !== undefined && rh >= 0 && (!requireWritable || !date || date < today());
      });
      const eligible: SelectedComponent[] = [];
      const blocked: string[] = [];
      const distinctBaseline = distinctComponents(baselineEligible.map((row) => ({
        vessel,
        row,
        baseline: normalizeRunningHours(row.runningHours)!,
      })));
      const candidates = isAll(HISTORY_TEST_CONFIG.componentsPerVessel)
        ? distinctBaseline
        : shuffle(distinctBaseline, seedFor(seed, vessel));
      for (const candidate of candidates) {
        const row = candidate.row;
        if (requireWritable) {
          const availability = await runningHours.inspectUpdateAvailability(row, 'Set Total');
          if (!availability.available) {
            blocked.push(`${row.componentName} (${row.componentCode}): ${availability.reason}`);
            continue;
          }
        } else {
          try {
            await runningHours.openComponentHistory(row.componentCode);
            const preview = await runningHours.readAllComponentHistoryPages(false);
            await runningHours.backFromComponentHistory();
            await page.getByRole('button', { name: 'Overview', exact: true }).click();
            await runningHours.waitForScreen();
            if (!preview.records.length) {
              blocked.push(`${row.componentName} (${row.componentCode}): no existing History records to export and compare`);
              continue;
            }
          } catch (error) {
            blocked.push(`${row.componentName} (${row.componentCode}): History eligibility could not be confirmed — ${error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error)}`);
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
            await runningHours.waitForScreen().catch(() => undefined);
            if (await runningHours.selectedVesselName().catch(() => '') !== vessel) {
              await runningHours.selectVesselAndWaitForData(vessel).catch(() => undefined);
            }
            continue;
          }
        }
        let child: RunningHoursInheritedChild | undefined;
        if (requireWritable && Number(row.inheritedRh.replace(/\D/g, '')) > 0) {
          child = (await runningHours.inspectInheritedDetails(row).catch(() => undefined))?.children
            .find((item) => item.rhCounterType.toUpperCase() === 'INHERITED');
        }
        eligible.push({ vessel, row, baseline: normalizeRunningHours(row.runningHours)!, child });
        if (!isAll(HISTORY_TEST_CONFIG.componentsPerVessel)
          && eligible.length >= HISTORY_TEST_CONFIG.componentsPerVessel) break;
      }
      const distinctEligible = distinctComponents(eligible);
      const chosen = isAll(HISTORY_TEST_CONFIG.componentsPerVessel)
        ? distinctEligible
        : distinctEligible.slice(0, HISTORY_TEST_CONFIG.componentsPerVessel);
      coverage.push({ vessel, discovered: discoveredRows.length, eligible: distinctEligible.length, selected: chosen.length, blocked });
      if (requireWritable && isAll(HISTORY_TEST_CONFIG.componentsPerVessel) && distinctEligible.length === 0 && blocked.length) {
        shortfalls.push(`${vessel}: no safe writable components were eligible in the authorized test vessel; ${blocked.join(' | ')}`);
      }
      if (!isAll(HISTORY_TEST_CONFIG.componentsPerVessel) && distinctEligible.length < HISTORY_TEST_CONFIG.componentsPerVessel) {
        componentShortfalls.push(`${vessel}: requested ${HISTORY_TEST_CONFIG.componentsPerVessel} distinct eligible component codes, available ${distinctEligible.length}; ${blocked.join(' | ') || 'no further eligible components'}`);
        continue;
      }
      selections.push({ vessel, components: chosen });
    }
    if (!isAll(HISTORY_TEST_CONFIG.vesselCount) && authorized.length < HISTORY_TEST_CONFIG.vesselCount) {
      shortfalls.unshift(`Requested ${HISTORY_TEST_CONFIG.vesselCount} authorized vessels, available ${authorized.length}.`);
    }
    if (!isAll(HISTORY_TEST_CONFIG.vesselCount) && selections.length < HISTORY_TEST_CONFIG.vesselCount) {
      shortfalls.push(`Selected ${selections.length} of ${HISTORY_TEST_CONFIG.vesselCount} requested vessels after checking all authorized candidates. ${componentShortfalls.join('; ')}`);
    }
    return { selections, shortfalls, offered, authorized, coverage };
  };

  test('RH-P17 - History and Persistence', executionScenario(
    'Valid updates for the configured components should persist after refresh, propagate to linked INHERITED components, and create accurate component History entries.',
  ), async () => {
    test.setTimeout(60 * 60_000);
    const seed = seedValue();
    const runningHours = await open();
    const data = await selectData(runningHours, seed, true);
    const actualCount = data.selections.reduce((sum, item) => sum + item.components.length, 0);
    test.skip(data.shortfalls.length > 0 || actualCount === 0,
      `BLOCKED — seed ${seed}: required ${HISTORY_TEST_CONFIG.vesselCount} authorized vessels × ${HISTORY_TEST_CONFIG.componentsPerVessel} writable components; selected ${data.selections.length} vessels/${actualCount} components. ${data.shortfalls.join('; ')}`);
    await executionObservedCheck(page, 'RH-P17 randomized vessel and component selection',
      `${HISTORY_TEST_CONFIG.vesselCount} distinct authorized vessels and ${HISTORY_TEST_CONFIG.componentsPerVessel} writable components per vessel should be selected reproducibly.`, {
        passed: data.shortfalls.length === 0 && actualCount > 0,
        actual: `Seed ${seed}; configured vessels ${configuredCount(HISTORY_TEST_CONFIG.vesselCount)}; components per vessel ${configuredCount(HISTORY_TEST_CONFIG.componentsPerVessel)}; live vessel options ${data.offered.length}; authorized vessels discovered ${data.authorized.length}; vessels selected ${data.selections.length}; components selected ${actualCount}; coverage ${data.coverage.map((item) => `${item.vessel}: discovered ${item.discovered}, eligible ${item.eligible}, selected ${item.selected}, blocked ${item.blocked.length}`).join(' | ')}; selected identities ${data.selections.map((item) => `${item.vessel}: ${item.components.map((entry) => `${entry.row.componentName} (${entry.row.componentCode})`).join(', ')}`).join(' | ')}.`,
      }, { screenshot: 'always' });

    const results: ComponentResult[] = [];
    for (const vesselSelection of data.selections) {
      if (await runningHours.selectedVesselName() !== vesselSelection.vessel) await runningHours.selectVesselAndWaitForData(vesselSelection.vessel);
      for (const [index, selected] of vesselSelection.components.entries()) {
        const target = selected.baseline + 1;
        const comment = `RH-P17 ${selected.vessel} ${selected.row.componentCode} ${seed}-${index + 1}`;
        const childBefore = selected.child ? normalizeRunningHours(selected.child.currentCumulativeRH) : undefined;
        try {
          await executionObservedCheck(page, `RH-P17 ${selected.row.componentCode} initial Running Hours`,
            `The runtime MASTER baseline, Last Updated date, and linked INHERITED baseline should be captured for ${selected.row.componentName} (${selected.row.componentCode}) on ${selected.vessel}.`, {
              passed: true,
              actual: `Vessel ${selected.vessel}; MASTER ${selected.row.componentName} (${selected.row.componentCode}) RH ${selected.row.runningHours}; Last Updated ${selected.row.lastUpdated || '<not displayed>'}; linked INHERITED ${selected.child ? `${selected.child.name} (${selected.child.componentCode}) RH ${selected.child.currentCumulativeRH}` : '<none>'}.`,
            }, { screenshot: 'always' });
          await executionActionStep(`RH-P17 ${selected.row.componentCode} open Update RH`,
            `Update RH should open for ${selected.row.componentName} (${selected.row.componentCode}) on ${selected.vessel}.`,
            () => runningHours.openUpdateControls(selected.row),
            () => `Opened Update RH for ${selected.row.componentName} (${selected.row.componentCode}) on ${selected.vessel}.`, { page });
          const save = await executionActionStep(`RH-P17 ${selected.row.componentCode} enter reading, date and comment then Save`,
            `Set Total ${target}, date ${today()}, and unique comment "${comment}" should save once for ${selected.row.componentName} (${selected.row.componentCode}).`,
            () => runningHours.submitUpdate('Set Total', target, today(), {
              comment,
              beforeSave: async (state) => executionObservedCheck(page, `RH-P17 ${selected.row.componentCode} values before Save`,
                `The popup should show the runtime old value, target ${target}, date ${today()}, and unique comment before Save.`, {
                  passed: Number(state.enteredValue) === target && state.selectedDate === today(),
                  actual: `Old Value ${state.oldValue}; New Value ${state.enteredValue}; Date Updated ${state.selectedDate}; Comment "${comment}"; Save not yet clicked.`,
                }, { screenshot: 'always' }),
            }),
            (result) => `Save clicked once; backend response ${result.responseStatus ?? '<not captured>'}; UI response "${result.feedback}"; dialog closed ${result.dialogClosed ? 'yes' : 'no'}.`, { page });
          await runningHours.refreshAndRestoreVessel(selected.vessel);
          const after = (await runningHours.readAllRows()).find((row) => row.componentCode === selected.row.componentCode);
          expect(after, `Updated component ${selected.row.componentCode} should remain present`).toBeDefined();
          const childAfter = selected.child
            ? (await runningHours.inspectInheritedDetails(after!)).children.find((item) => item.componentCode === selected.child!.componentCode)
            : undefined;
          await runningHours.openComponentHistory(selected.row.componentCode);
          const history = await runningHours.readAllComponentHistoryPages(HISTORY_TEST_CONFIG.verifyAllHistoryPages);
          const matching = history.records.filter((record) => recordValues(record).includes(normalized(selected.row.componentCode))
            && recordValues(record).some((value) => value.includes(normalized(String(target)))));
          const commentSupported = history.records.some((record) => Object.keys(record).some((key) => /comment|note|reason/i.test(key)));
          const commentMatched = !commentSupported || matching.some((record) => recordValues(record).includes(normalized(comment)));
          const inheritanceOk = childBefore === undefined || normalizeRunningHours(childAfter?.currentCumulativeRH ?? '') === childBefore + 1;
          const passed = normalizeRunningHours(after!.runningHours) === target && matching.length > 0 && commentMatched && inheritanceOk;
          await attachRunningHoursComparison(`RH-P17 ${selected.row.componentCode} Initial-Input-Final`, [
            { field: 'Vessel', initial: selected.vessel, entered: selected.vessel, final: selected.vessel },
            { field: 'Component', initial: `${selected.row.componentName} (${selected.row.componentCode})`, entered: `${target} on ${today()}`, final: `${after!.componentName} (${after!.componentCode})` },
            { field: 'MASTER RH', initial: selected.row.runningHours, entered: String(target), final: after!.runningHours },
            { field: 'INHERITED RH', initial: selected.child?.currentCumulativeRH ?? '<not linked>', entered: selected.child ? '+1 propagation expected' : '<not linked>', final: childAfter?.currentCumulativeRH ?? '<not linked>' },
            { field: 'Comment', initial: '<new audit comment>', entered: comment, final: commentSupported ? (commentMatched ? comment : '<missing>') : '<History UI has no comment column>' },
            { field: 'History', initial: '<before update>', entered: 'one Set Total Save', final: `${matching.length} matching record(s) across ${history.pages} page(s)` },
          ]);
          await executionObservedCheck(page, `RH-P17 ${selected.row.componentCode} persistence and History verification`,
            `The target RH should persist, linked inheritance should receive +1, and History should identify ${selected.row.componentCode}, reading ${target}, date ${today()}, and comment when the UI exposes comments.`, {
              passed,
              actual: `MASTER ${selected.row.runningHours}→${after!.runningHours}; INHERITED ${selected.child?.currentCumulativeRH ?? '<not linked>'}→${childAfter?.currentCumulativeRH ?? '<not linked>'}; History pages ${history.pages}; records ${history.records.length}; matching component/reading records ${matching.length}; comment column ${commentSupported ? 'available' : 'not exposed by UI'}; comment match ${commentMatched ? 'yes' : 'no'}; Save response "${save.feedback}".`,
            }, { screenshot: 'always' });
          results.push({ vessel: selected.vessel, component: `${selected.row.componentName} (${selected.row.componentCode})`, status: passed ? 'PASS' : 'FAIL', passed, actual: `MASTER ${after!.runningHours}; history ${matching.length}; inheritance ${inheritanceOk ? 'correct' : 'incorrect'}` });
          await runningHours.backFromComponentHistory();
          await page.getByRole('button', { name: 'Overview', exact: true }).click();
        } catch (error) {
          results.push({ vessel: selected.vessel, component: `${selected.row.componentName} (${selected.row.componentCode})`, status: 'FAIL', passed: false, actual: error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error) });
          break; // an uncertain Save outcome prevents further writes
        }
      }
    }
    await executionValidationStep(page, `RH-P17 verify all component persistence and History results\nExpected: Every selected component should persist its valid update and produce accurate History evidence.\nActual: Recorded after validation completes.`, async () => {
      expect(results).toHaveLength(actualCount);
      expect(results.every((item) => item.passed)).toBe(true);
    }, { actual: () => { const counts = resultCounts(results); return `Seed ${seed}; executed ${results.length}; PASS ${counts.passed}; FAIL ${counts.failed}; BLOCKED ${counts.blocked}; ${results.map((item) => `${item.vessel} / ${item.component}: ${item.status} — ${item.actual}`).join(' | ')}`; } });
  });

  test('RH-P18 - History Filters and Export', executionScenario(
    'For the configured vessels and components, component-filtered History exports should contain the complete UI dataset across every available page with no missing, extra, duplicate, or mismatched records.',
  ), async () => {
    test.setTimeout(45 * 60_000);
    const seed = (seedValue() ^ 0x18e7) >>> 0;
    const runningHours = await open();
    const data = await selectData(runningHours, seed, false);
    const selectedCount = data.selections.reduce((sum, item) => sum + item.components.length, 0);
    test.skip(data.shortfalls.length > 0 || selectedCount === 0,
      `BLOCKED — seed ${seed}: required ${HISTORY_TEST_CONFIG.vesselCount} authorized vessels × ${HISTORY_TEST_CONFIG.componentsPerVessel} components; selected ${data.selections.length} vessels/${selectedCount} components. ${data.shortfalls.join('; ')}`);
    await executionObservedCheck(page, 'RH-P18 randomized read-only vessel and component selection',
      `${HISTORY_TEST_CONFIG.vesselCount} distinct authorized vessels and ${HISTORY_TEST_CONFIG.componentsPerVessel} distinct components per vessel should be selected for read-only History/export checks.`, {
        passed: data.shortfalls.length === 0 && selectedCount > 0,
        actual: `Seed ${seed}; configured vessels ${configuredCount(HISTORY_TEST_CONFIG.vesselCount)}; components per vessel ${configuredCount(HISTORY_TEST_CONFIG.componentsPerVessel)}; live vessel options ${data.offered.length}; authorized vessels discovered ${data.authorized.length}; vessels selected ${data.selections.length}; components selected ${selectedCount}; coverage ${data.coverage.map((item) => `${item.vessel}: discovered ${item.discovered}, History-eligible ${item.eligible}, selected ${item.selected}, rejected ${item.blocked.length}${item.blocked.length ? ` [${item.blocked.join(' | ')}]` : ''}`).join(' | ')}; selected identities ${data.selections.map((item) => `${item.vessel}: ${item.components.map((entry) => `${entry.row.componentName} (${entry.row.componentCode})`).join(', ')}`).join(' | ')}.`,
      }, { screenshot: 'always' });

    const results: ComponentResult[] = [];
    for (const vesselSelection of data.selections) {
      if (await runningHours.selectedVesselName() !== vesselSelection.vessel) await runningHours.selectVesselAndWaitForData(vesselSelection.vessel);
      for (const selected of vesselSelection.components) {
        try {
          await runningHours.openComponentHistory(selected.row.componentCode);
          const filters = await runningHours.componentHistoryFilterState();
          const ui = await runningHours.readAllComponentHistoryPages(HISTORY_TEST_CONFIG.verifyAllHistoryPages);
          if (!ui.records.length) {
            results.push({ vessel: selected.vessel, component: `${selected.row.componentName} (${selected.row.componentCode})`, status: 'BLOCKED', passed: false, actual: 'No existing History records; export completeness was not verified and no export comparison was invented.' });
            await executionNotExecutedStep(`RH-P18 ${selected.row.componentCode} export and comparison`,
              `History should remain available so its complete UI dataset can be exported and compared.`,
              `The component had History during seeded selection but no records were present when validation ran; export and comparison were blocked.`);
            await runningHours.backFromComponentHistory();
            continue;
          }
          await executionObservedCheck(page, `RH-P18 ${selected.row.componentCode} applied History filters and pagination`,
            `History should be filtered to ${selected.row.componentName} (${selected.row.componentCode}); the available Period control should be recorded and all pages collected.`, {
              passed: ui.records.every((record) => recordValues(record).includes(normalized(selected.row.componentCode))),
              actual: `Vessel ${selected.vessel}; component filter ${selected.row.componentName} (${selected.row.componentCode}); detail ${filters.component || '<not labelled>'}; Period control "${filters.period || '<default/all available records>'}"; pages ${ui.pages}; displayed total "${ui.totalText || '<not displayed>'}"; collected UI records ${ui.records.length}; multi-page coverage ${ui.pages > 1 ? 'exercised' : 'NOT EXERCISED — all matching records fit one page'}.`,
            }, { screenshot: 'always' });
          const download = await executionActionStep(`RH-P18 ${selected.row.componentCode} export filtered History`,
            `Export CSV should download the complete filtered History dataset for ${selected.row.componentName} (${selected.row.componentCode}).`,
            () => runningHours.exportComponentHistory(HISTORY_TEST_CONFIG.exportDownloadTimeoutMs),
            (item) => `Download completed with suggested filename "${item.suggestedFilename()}" for ${selected.row.componentName} (${selected.row.componentCode}).`, { page });
          const directory = test.info().outputPath('RH-P18-exports');
          fs.mkdirSync(directory, { recursive: true });
          const exportPath = path.join(directory, `RH-P18-${selected.vessel.replace(/[^a-z0-9]+/gi, '-')}-${selected.row.componentCode.replace(/[^a-z0-9]+/gi, '-')}-${download.suggestedFilename()}`);
          await download.saveAs(exportPath);
          await test.info().attach(`RH-P18 Export :: ${selected.vessel} :: ${selected.row.componentCode}`, { path: exportPath });
          const exported = readExport(exportPath);
          const comparison = compareRecords(ui.records, exported);
          await executionObservedCheck(page, `RH-P18 ${selected.row.componentCode} UI and export comparison`,
            `All ${ui.records.length} UI History records across ${ui.pages} page(s) should match the downloaded export with no missing or extra records.`, {
              passed: comparison.passed,
              actual: `Vessel ${selected.vessel}; Component ${selected.row.componentName} (${selected.row.componentCode}); UI records ${ui.records.length}; exported records ${exported.length}; missing ${comparison.missing.length}; extra ${comparison.extra.length}; mismatched values ${comparison.missing.length + comparison.extra.length}; duplicate UI keys ${ui.records.length - new Set(ui.records.map(recordKey)).size}; duplicate export keys ${exported.length - new Set(exported.map(recordKey)).size}; first missing key "${comparison.missing[0] ?? '<none>'}"; first extra key "${comparison.extra[0] ?? '<none>'}"; file ${exportPath}.`,
            }, { screenshot: 'always' });
          results.push({ vessel: selected.vessel, component: `${selected.row.componentName} (${selected.row.componentCode})`, status: comparison.passed ? 'PASS' : 'FAIL', passed: comparison.passed, actual: `UI ${ui.records.length}; export ${exported.length}; missing ${comparison.missing.length}; extra ${comparison.extra.length}; pages ${ui.pages}; ${exportPath}` });
          await runningHours.backFromComponentHistory();
        } catch (error) {
          results.push({ vessel: selected.vessel, component: `${selected.row.componentName} (${selected.row.componentCode})`, status: 'FAIL', passed: false, actual: error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error) });
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await open();
          if (await runningHours.selectedVesselName().catch(() => '') !== vesselSelection.vessel) await runningHours.selectVesselAndWaitForData(vesselSelection.vessel).catch(() => undefined);
        }
      }
    }
    await executionValidationStep(page, `RH-P18 verify all filtered History exports\nExpected: Every selected component should have a complete export matching every collected UI History page.\nActual: Recorded after validation completes.`, async () => {
      expect(results).toHaveLength(selectedCount);
      expect(results.every((item) => item.passed)).toBe(true);
    }, { actual: () => { const counts = resultCounts(results); return `Seed ${seed}; executed ${results.length}; PASS ${counts.passed}; FAIL ${counts.failed}; BLOCKED ${counts.blocked}; ${results.map((item) => `${item.vessel} / ${item.component}: ${item.status} — ${item.actual}`).join(' | ')}`; } });
  });
});
