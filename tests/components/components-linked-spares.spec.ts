import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  ComponentsPage,
  type ComponentSpareRow,
  type DiscoveredSpare,
  type LinkedSpareInventory,
  type SparePartDetails,
  type SpareListView,
  type SparePageState,
} from '../../pages/ComponentsPage';
import { SparesPage, type SparesModuleSearch } from '../../pages/SparesPage';
import { config } from '../../utils/config';
import { recordMissingTreePrerequisite, searchComponentTree, type TreeComponentVisit, type TreeSearchResult, type TreeWalkControl } from '../../utils/componentTreeSearch';
import {
  attachComponentStepScreenshot,
  attachFailureScreenshot,
  componentActionStep,
  componentNotExecutedStep,
  componentObservedCheck,
  componentScenario,
  componentValidationStep,
} from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { resolveComponentLimit, resolveSpareSampling, type ComponentLimitSetting, type SpareSamplingSetting } from '../../utils/componentRunSettings';
import { routes } from '../../utils/routes';

const vessel = config.vesselName;
const emptyMessage = 'No spare parts linked to this component';
const step = (title: string, expected: string, actual = 'Recorded after the validation completes.') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}`;
const keyOf = (spare: ComponentSpareRow) => `${spare.partCode}\u0000${spare.partName}`;
const spareLabel = (spare: ComponentSpareRow) => `${spare.partCode || '[no code]'} (${spare.partName || '[no name]'})`;
const numberFrom = (value: string) => Number(value.replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/)?.[0] ?? Number.NaN);
const normalizedMessage = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type FullSpareList = { spares: ComponentSpareRow[]; view?: SpareListView; initial: ComponentSpareRow[] };

// ---- Spare sampling shared by CMP-142 and CMP-143 (spareLimit / spareSeed, see utils/componentRunSettings.ts) ----
type SpareOutcome = 'PASS' | 'FAIL' | 'NOT EXECUTED';
type ComponentSpareRun = {
  visit: TreeComponentVisit;
  inventory?: LinkedSpareInventory;
  componentSeed?: number;
  selected: DiscoveredSpare[];
  outcomes: Map<string, SpareOutcome>;
  /** Spares whose popup opened in the first pass and are rechecked after refresh. */
  opened: Set<string>;
  /** Unique Part Codes available for sampling. */
  available?: number;
  /** Part Codes of this component already selected for an earlier component, so excluded here. */
  excluded?: number;
};

/**
 * The spare validation target of one test case. spareLimit counts unique Part Codes
 * validated in total across every component, not per component; CMP-142 and
 * CMP-143 each create their own budget, so they count independently.
 */
type SpareBudget = {
  /** Target number of validated unique spares; undefined in ALL mode. */
  limit?: number;
  /** Spares whose validation reached a result from the values the application displayed (PASS or FAIL). */
  validated: number;
  /** Part Codes already selected in this test case; they are never selected again. */
  selectedCodes: Set<string>;
  /** Component after which the target was reached. */
  reachedAt?: string;
};
const createSpareBudget = (setting: SpareSamplingSetting): SpareBudget =>
  ({ limit: setting.mode === 'LIMITED' ? setting.limit : undefined, validated: 0, selectedCodes: new Set() });
const targetReached = (budget: SpareBudget) => budget.limit !== undefined && budget.validated >= budget.limit;
const openTarget = (budget: SpareBudget) => (budget.limit === undefined ? undefined : Math.max(budget.limit - budget.validated, 0));

type Cmp142State = {
  setting: SpareSamplingSetting;
  components: ComponentLimitSetting;
  budget: SpareBudget;
  runs: ComponentSpareRun[];
  finalized: boolean;
  stopReason?: string;
  /** Unique components the tree walk inspected. */
  inspected?: number;
};

/** Report lines describing the effective spare sample size and seed of one test case. */
const samplingLines = (setting: SpareSamplingSetting, everyText: string) => [
  `Execution mode: ${setting.mode}${setting.mode === 'LIMITED' ? ` (spare limit ${setting.limit} unique spares in total for this test case)` : ` (no spare limit; ${everyText})`}`,
  `Requested spare limit: ${setting.mode === 'LIMITED' ? `${setting.limit} unique spare(s) in total per test case` : 'none (ALL)'} — source: ${setting.limitSource}`,
  `Effective spare seed: ${setting.mode === 'LIMITED'
    ? `${setting.seed} (${setting.seedSource}; set spareSeed or SPARE_SEED to ${setting.seed} with the same spare limit to reproduce this sample)`
    : `${setting.seed} (${setting.seedSource}; not used in ALL mode, so no spare is excluded)`}`,
];
const componentLimitLine = (limit: ComponentLimitSetting) => `Component limit: ${limit.text}`;

/** FNV-1a, so every component gets its own reproducible sample from the run seed. */
const hashText = (value: string) => {
  let hash = 0x811c9dc5;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
};
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
};

/**
 * Samples from every discovered page. The pool is sorted by identity first, so
 * the same seed reproduces the same sample regardless of discovery order. The
 * result is ordered by descending page because discovery leaves the list on
 * its last page.
 */
const selectSpares = (spares: DiscoveredSpare[], limit: number | undefined, seed: number): DiscoveredSpare[] => {
  const pool = [...spares].sort((a, b) => a.partCode.localeCompare(b.partCode) || a.partName.localeCompare(b.partName));
  if (limit !== undefined && limit < pool.length) {
    const random = mulberry32(seed);
    for (let index = 0; index < limit; index += 1) {
      const swap = index + Math.floor(random() * (pool.length - index));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    pool.length = limit;
  }
  const discoveryOrder = new Map(spares.map((spare, index) => [keyOf(spare), index]));
  return pool.sort((a, b) => b.page - a.page || discoveryOrder.get(keyOf(a))! - discoveryOrder.get(keyOf(b))!);
};

/** CMP-143 identifies a spare by its exact Part Code; the first row of a repeated code is kept. */
const uniqueByPartCode = (spares: DiscoveredSpare[]) => {
  const byCode = new Map<string, DiscoveredSpare>();
  for (const spare of spares) {
    const key = spare.partCode.trim() || keyOf(spare);
    if (!byCode.has(key)) byCode.set(key, spare);
  }
  return [...byCode.values()];
};

const partCodeKey = (spare: ComponentSpareRow) => spare.partCode.trim() || keyOf(spare);

/**
 * Draws one component's random sample from the Part Codes not yet selected in this
 * test case, up to the part of the test-case target still open. The pool is
 * deterministic for a given seed, so the same seed reproduces the same selection.
 */
const drawSpares = (budget: SpareBudget, available: DiscoveredSpare[], seed: number) => {
  const eligible = available.filter((spare) => !budget.selectedCodes.has(partCodeKey(spare)));
  const open = openTarget(budget);
  const selected = selectSpares(eligible, open, seed);
  for (const spare of selected) budget.selectedCodes.add(partCodeKey(spare));
  return { eligible: eligible.length, excluded: available.length - eligible.length, open, selected };
};

const selectionText = (draw: { eligible: number; excluded: number; open?: number; selected: DiscoveredSpare[] }, budget: SpareBudget, seedText: string) =>
  (budget.limit === undefined
    ? `ALL mode: all ${draw.selected.length} eligible spare(s) were selected`
    : `LIMITED mode (test-case target ${budget.limit} unique spares, ${seedText}): ${draw.selected.length} of ${draw.eligible} eligible spare(s) were selected at random for the ${draw.open} still open in the target`
      + (draw.selected.length < draw.open! ? ' (fewer eligible spares were available than still needed, so all were selected)' : ''))
  + (draw.excluded ? `; ${draw.excluded} Part Code(s) were already selected for an earlier component in this test case and were excluded` : '');

/** Report lines with the effective target, the unique spares validated and why the traversal stopped. */
const spareTargetLines = (budget: SpareBudget, failed: number, stopReason: string) => [
  `Effective spare validation target: ${budget.limit === undefined ? 'none (ALL mode; every eligible unique spare is validated)' : `${budget.limit} unique spare(s) in total for this test case`}`,
  `Unique spares validated (PASS or FAIL result reached): ${budget.validated}${budget.limit === undefined ? '' : ` of ${budget.limit}`}; failed spare validations: ${failed}`,
  `Reason for stopping: ${stopReason}`,
];

/** Why a CMP-142/CMP-143 traversal ended; an interruption (for example a lost resume) takes precedence. */
const stopReasonText = <T>(budget: SpareBudget, search: TreeSearchResult<T>, limit: ComponentLimitSetting, interrupted?: string) => {
  if (interrupted) return interrupted;
  if (targetReached(budget)) {
    return `the spare validation target of ${budget.limit} unique spare(s) was reached after Component ${budget.reachedAt}; the traversal stopped there and later components were not inspected.`;
  }
  const short = budget.limit === undefined ? '' : `, fewer than the target of ${budget.limit}`;
  if (search.incomplete) {
    return `the component tree could not be read to its end (${search.incomplete}) after ${search.visited.length} unique component(s) were inspected and ${budget.validated} unique spare(s) were validated${short}; coverage is incomplete.`;
  }
  return search.limitReached
    ? `the component limit of ${limit.limit} unique components (${limit.source}) was reached after ${budget.validated} unique spare(s) were validated${short}; later components were not inspected.`
    : `every accessible component in the tree was inspected; ${budget.validated} unique spare(s) were validated${short ? `${short} because no further eligible unique spares were available` : ''}.`;
};

// ---- CMP-143 cross-module stock verification ----
/** Where CMP-143 left Components to check a mismatch, so it can resume with the next spare of the same sample. */
type ResumePoint = {
  vessel: string;
  componentCode: string;
  componentName: string;
  component: string;
  location: string;
  pageOf: (spare: DiscoveredSpare) => string;
  seed?: number;
  selected: string[];
  index: number;
};
/** A Components Stock Status mismatch and what the separate PMS → Spares module showed for it. */
type StockMismatch = {
  component: string;
  spare: string;
  location: string;
  expected: string;
  componentsStatus: string;
  rob: string;
  min: string;
  moduleStatus?: string;
  moduleRob?: string;
  moduleMin?: string;
  stockValueIssue?: string;
  reason?: string;
  note?: string;
  result: 'PASS' | 'FAIL';
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The complete code, not part of a longer code such as 401.0051 or 1401.005. Names are rendered directly against the code. */
const exactCodeInText = (code: string) => new RegExp(`(?<![0-9.\\-/])${escapeRegex(code)}(?![0-9A-Za-z.\\-/])`, 'i');
const namedCodeInText = (name: string, code: string) => {
  const n = escapeRegex(name.trim()).replace(/\s+/g, '\\s+');
  const c = escapeRegex(code);
  return new RegExp(`${n}\\s*${c}(?![0-9A-Za-z.\\-/])|(?<![0-9A-Za-z.\\-/])${c}\\s*${n}`, 'i');
};
const sameText = (left: string, right: string) => left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();
const statusKey = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '');
const pageText = (spare: DiscoveredSpare, inventory?: LinkedSpareInventory) =>
  spare.page ? `Page ${spare.page} of ${inventory?.totalPages ?? '?'}` : 'the F. Spares list';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Business text for the step, with the raw diagnostic kept below it for Technical Details. */
const businessError = (observed: string, error: unknown) =>
  /Observed Application Result:/i.test(errorText(error))
    ? error
    : new Error(`Observed Application Result:\n${observed}\n\n${errorText(error)}`);

/** Compares the popup's spare identity and Linked Components with the selected spare and component. */
const evaluateSpareDetails = (visit: TreeComponentVisit, spare: DiscoveredSpare, details: SparePartDetails) => {
  const componentName = visit.identity.name || visit.name;
  const issues: string[] = [];
  if (!sameText(details.partCode, spare.partCode)) issues.push(`Part Code showed "${details.partCode || 'blank'}" instead of "${spare.partCode}"`);
  if (!sameText(details.partName, spare.partName)) issues.push(`Part Name showed "${details.partName || 'blank'}" instead of "${spare.partName}"`);
  const linkedText = details.linkedComponentTexts.join(' ');
  if (!details.linkedComponentsShown) issues.push('the Linked Components section was not displayed');
  else if (!namedCodeInText(componentName, visit.code).test(linkedText)) {
    issues.push(exactCodeInText(visit.code).test(linkedText)
      ? `Linked Components showed Component Code ${visit.code} but not together with Component Name "${componentName}"`
      : `Linked Components did not contain the complete Component Code ${visit.code}`);
  }
  // Stock values (ROB, Minimum Level, Stock Status) are validated by CMP-143, not here.
  const observed = `The popup showed Part Code ${details.partCode || '[blank]'}, Part Name ${details.partName || '[blank]'}, `
    + `Linked Components${details.linkedCount === undefined ? '' : ` (${details.linkedCount})`}: ${details.linkedComponentTexts.join(' | ') || '[none]'}.`;
  return {
    passed: !issues.length,
    issues,
    actual: issues.length
      ? `${observed} Difference: ${issues.join('; ')}.`
      : `${observed} The Part Code and Part Name matched the selected spare, and Linked Components listed Component ${visit.code} (${componentName}).`,
  };
};

const cmp142Summary = (state: Cmp142State) => {
  const { setting, runs } = state;
  const all = runs.flatMap((run) => run.selected.map((spare) => run.outcomes.get(keyOf(spare)) ?? 'NOT EXECUTED'));
  const count = (outcome: SpareOutcome) => all.filter((value) => value === outcome).length;
  const lines = [
    'Test Case: CMP-142',
    ...samplingLines(setting, 'every linked spare is validated'),
    componentLimitLine(state.components),
    ...spareTargetLines(state.budget, count('FAIL'), state.stopReason ?? 'the scenario stopped before the component traversal finished.'),
    `Vessel: ${[...new Set(runs.map((run) => run.visit.identity.vesselName).filter(Boolean))].join(', ') || vessel}`,
    `Unique components inspected: ${state.inspected ?? 'not recorded (the tree walk did not finish)'}`,
    `Components with linked spares: ${runs.length}`,
    `Spares selected: ${all.length}; passed: ${count('PASS')}; failed: ${count('FAIL')}; not executed: ${count('NOT EXECUTED')}`,
  ];
  for (const run of runs) {
    const { visit, inventory } = run;
    lines.push('', `Component ${visit.code} (${visit.identity.name || visit.name}): ${inventory ? `${run.available ?? inventory.spares.length} unique Part Code(s) available across ${inventory.totalPages} page(s)` : 'linked spares could not be discovered'}; selected ${run.selected.length}${run.excluded ? ` (${run.excluded} already selected for an earlier component were excluded)` : ''}${run.componentSeed === undefined ? '' : `; component sample seed ${run.componentSeed}`}`);
    for (const spare of run.selected) {
      lines.push(`  ${(run.outcomes.get(keyOf(spare)) ?? 'NOT EXECUTED').padEnd(12)} ${spareLabel(spare)}${spare.page ? ` — Page ${spare.page}` : ''}`);
    }
  }
  return { text: lines.join('\n'), passed: count('PASS'), failed: count('FAIL'), notExecuted: count('NOT EXECUTED'), selected: all.length };
};

test.describe('CMP-142 to CMP-148 - Linked Spares', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;

  test.beforeAll(async ({ browser }) => {
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
  });

  let cmp142: Cmp142State | undefined;

  const verifyTitle = (run: ComponentSpareRun, spare: DiscoveredSpare) =>
    `Verify Spare Part Details of ${spareLabel(spare)} for Component ${run.visit.code}`;
  const verifyExpected = (run: ComponentSpareRun, spare: DiscoveredSpare) =>
    `The popup should show Part Code ${spare.partCode} and Part Name ${spare.partName}, list Component ${run.visit.code} (${run.visit.identity.name || run.visit.name}) in Linked Components.`;

  /** Marks every selected spare that has no result as NOT EXECUTED and attaches the run summary once. */
  const finalizeCmp142 = async (state: Cmp142State, reason: string) => {
    if (state.finalized) return;
    state.finalized = true;
    for (const run of state.runs) {
      for (const spare of run.selected) {
        if (run.outcomes.has(keyOf(spare))) continue;
        run.outcomes.set(keyOf(spare), 'NOT EXECUTED');
        await componentNotExecutedStep(verifyTitle(run, spare), verifyExpected(run, spare), reason);
      }
    }
    await test.info().attach('CMP-142 spare validation summary', { body: cmp142Summary(state).text, contentType: 'text/plain' });
  };

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    if (cmp142) {
      await finalizeCmp142(cmp142, 'the scenario stopped before this selected spare was reached.').catch(() => undefined);
      cmp142 = undefined;
    }
    await restoreComponentsPage(page, components, vessel);
  });

  test.afterAll(async () => context?.close());

  const action = <T>(title: string, expected: string, body: () => Promise<T>, actual: (value: T) => string) =>
    componentActionStep(title, expected, body, actual, { page });

  /**
   * Resolves the settings of one test case once (component limit for every case;
   * spare limit and seed for CMP-142/CMP-143), attaches them to the report, and
   * fails the case before any component is opened when a configured value is invalid.
   */
  const prepareRun = async (testCase: string, sampling?: SpareSamplingSetting) => {
    const limit = resolveComponentLimit();
    await test.info().attach(`${testCase} run settings`, {
      body: [componentLimitLine(limit), ...(sampling ? samplingLines(sampling, 'every spare is validated') : [])].join('\n'),
      contentType: 'text/plain',
    });
    const errors = [limit.error, sampling?.error].filter(Boolean);
    if (errors.length) {
      const observed = `${errors.join(' ')} No component or spare was opened.`;
      await componentObservedCheck(page, `Read the ${testCase} run settings`,
        'The component limit should be blank (no limit) or a positive whole number'
          + (sampling ? '; the spare limit should be blank (all spares) or a positive whole number; the spare seed, when set, should be a whole number from 0 to 4294967295.' : '.'),
        { passed: false, actual: observed });
      throw new Error(`Observed Application Result:\n${observed}\n\nCOMPONENT_LIMIT=${JSON.stringify(process.env.COMPONENT_LIMIT)} SPARE_LIMIT=${JSON.stringify(process.env.SPARE_LIMIT)} SPARE_SEED=${JSON.stringify(process.env.SPARE_SEED)}`);
    }
    return { limit, maxComponents: limit.limit ?? Number.POSITIVE_INFINITY };
  };

  const readFullList = async (visit: TreeComponentVisit): Promise<FullSpareList> => {
    const initial = await components.readLoadedLinkedSpares();
    if (!initial.spares.length) return { spares: [], initial: [] };
    const controls = await components.readLinkedSparesControls();
    if (!controls.showAll) return { spares: initial.spares, initial: initial.spares };
    const view = await action(
      `Click ${controls.showAll} for Component ${visit.code}`,
      `The full spare list for Component ${visit.code} should open without losing the initially displayed records.`,
      () => components.showAllLinkedSpares(),
      (value) => `${value.label} opened the full spare list ${value.mode === 'dialog' ? 'in a popup' : 'inside F. Spares'}.`,
    );
    const full = await components.readSparesAcrossPages(view.list, view.scope);
    return { spares: full.spares, view, initial: initial.spares };
  };

  const closeFullList = async (full: FullSpareList) => {
    if (full.view) await components.collapseLinkedSpares(full.view);
  };

  test('CMP-142 - View linked spare parts and verify linked components', componentScenario(
    'Each validated linked spare (every unique spare, or a random sample of unique Part Codes up to the configured spare limit in total for this test case) should open Spare Part Details showing its exact Part Code and Part Name, list the selected Component Code and Name in Linked Components, and keep that association after refresh.'), async () => {
    const setting = resolveSpareSampling();
    const { limit: componentLimit, maxComponents } = await prepareRun('CMP-142', setting);
    const state: Cmp142State = { setting, components: componentLimit, budget: createSpareBudget(setting), runs: [], finalized: false };
    cmp142 = state;
    // The tree walk gets a fixed budget; each selected spare then adds time for one open and one recheck.
    test.setTimeout(30 * 60_000);
    const perSpareBudget = 60_000;
    const perComponentBudget = 30_000;
    const failures: string[] = [];
    const diagnostics: string[] = [];

    /** Waits for F. Spares and expands it when Show All is offered; undefined when the component has no linked spares. */
    const openSpareList = async (visit: TreeComponentVisit, record: boolean): Promise<{ view?: SpareListView } | undefined> => {
      const initial = await components.readLoadedLinkedSpares();
      if (!initial.spares.length) return undefined;
      const controls = await components.readLinkedSparesControls();
      if (!controls.showAll) return {};
      if (!record) return { view: await components.showAllLinkedSpares() };
      return {
        view: await action(
          `Click ${controls.showAll} for Component ${visit.code}`,
          `The full spare list for Component ${visit.code} should open without losing the initially displayed records.`,
          () => components.showAllLinkedSpares(),
          (value) => `${value.label} opened the full spare list ${value.mode === 'dialog' ? 'in a popup' : 'inside F. Spares'}.`,
        ),
      };
    };

    const collapse = async (visit: TreeComponentVisit, view?: SpareListView) => {
      if (!view) return;
      await components.collapseLinkedSpares(view).catch(async (error) => {
        diagnostics.push(`Component ${visit.code}; collapse F. Spares: ${errorText(error)}`);
        await page.keyboard.press('Escape').catch(() => undefined);
      });
    };

    const closePopup = async (details: SparePartDetails) => {
      await components.closeSparePopup(details.dialog).catch(async () => {
        await page.keyboard.press('Escape').catch(() => undefined);
        await expect(details.dialog).toBeHidden({ timeout: 5_000 });
      });
    };

    /** Stops a component after repeated failures instead of retrying; its remaining spares are NOT EXECUTED. */
    const abandon = async (run: ComponentSpareRun, from: number, reason: string) => {
      const remaining = run.selected.slice(from).filter((spare) => !run.outcomes.has(keyOf(spare)));
      if (!remaining.length) return;
      failures.push(`Component ${run.visit.code}: ${remaining.length} selected spare(s) were not validated because ${reason}`);
      for (const spare of remaining) {
        run.outcomes.set(keyOf(spare), 'NOT EXECUTED');
        await componentNotExecutedStep(verifyTitle(run, spare), verifyExpected(run, spare), reason);
      }
    };

    const validateSelectedSpares = async (run: ComponentSpareRun, view?: SpareListView) => {
      let consecutiveOpenFailures = 0;
      for (const [index, spare] of run.selected.entries()) {
        const key = keyOf(spare);
        const label = spareLabel(spare);
        const location = pageText(spare, run.inventory);
        const openTitle = `Open Spare Part Details of ${label} for Component ${run.visit.code}`;
        let details: SparePartDetails;
        try {
          details = await componentActionStep(
            openTitle,
            `Clicking Part Code ${spare.partCode || spare.partName} on ${location} should open the Spare Part Details popup for that spare.`,
            () => components.openSparePartDetails(spare, view).catch((error: unknown) => {
              throw businessError(`Clicking ${label} on ${location} did not display its Spare Part Details popup.`, error);
            }),
            (value) => `The "${value.title || 'Spare Part Details'}" popup opened from ${location} and displayed Part Code ${value.partCode || '[blank]'}.`,
          );
        } catch (error) {
          run.outcomes.set(key, 'FAIL');
          failures.push(`Component ${run.visit.code}: the Spare Part Details popup for ${label} could not be opened from ${location}.`);
          diagnostics.push(`Component ${run.visit.code}; spare ${label}; open details: ${errorText(error)}`);
          await attachComponentStepScreenshot(page, openTitle);
          await componentNotExecutedStep(verifyTitle(run, spare), verifyExpected(run, spare),
            'the Spare Part Details popup did not open, so its values could not be checked.');
          await page.keyboard.press('Escape').catch(() => undefined);
          consecutiveOpenFailures += 1;
          if (consecutiveOpenFailures >= 3) {
            await abandon(run, index + 1, `three consecutive selected spares of Component ${run.visit.code} could not be opened, so the remaining ones were not attempted to avoid repeated retries.`);
            return;
          }
          continue;
        }
        consecutiveOpenFailures = 0;
        const check = evaluateSpareDetails(run.visit, spare, details);
        await componentObservedCheck(page, verifyTitle(run, spare), verifyExpected(run, spare), check);
        run.outcomes.set(key, check.passed ? 'PASS' : 'FAIL');
        // The popup values were read and judged, so this spare counts toward the test-case target either way.
        state.budget.validated += 1;
        run.opened.add(key);
        if (!check.passed) failures.push(`Component ${run.visit.code}; spare ${label}: ${check.issues.join('; ')}.`);
        try {
          await closePopup(details);
        } catch (error) {
          diagnostics.push(`Component ${run.visit.code}; spare ${label}; close details: ${errorText(error)}`);
          failures.push(`Component ${run.visit.code}: the Spare Part Details popup for ${label} did not close.`);
          await componentObservedCheck(page, `Close Spare Part Details of ${label}`,
            'Close should dismiss the popup and return to the F. Spares list.',
            { passed: false, actual: `The Spare Part Details popup for ${label} remained open after Close and Escape.` });
          await abandon(run, index + 1, `the Spare Part Details popup for ${label} did not close, so the F. Spares list was not available.`);
          return;
        }
      }
    };

    const search = await searchComponentTree(page, components, async (visit) => {
      // Unlimited coverage walks the whole tree, so every component adds its own time instead of a fixed walk budget.
      test.setTimeout(test.info().timeout + perComponentBudget);
      if (visit.depth === 0) return undefined;
      let list: { view?: SpareListView } | undefined;
      try {
        list = await openSpareList(visit, true);
      } catch (error) {
        failures.push(`Component ${visit.code}: its F. Spares list could not be loaded or expanded.`);
        diagnostics.push(`Component ${visit.code}; open F. Spares: ${errorText(error)}`);
        await componentObservedCheck(page, `Open F. Spares for Component ${visit.code}`,
          `F. Spares for Component ${visit.code} should load its linked spares or its empty-state message.`,
          { passed: false, actual: `F. Spares for Component ${visit.code} did not finish loading or could not be expanded, so its linked spares were not validated.` });
        return undefined;
      }
      if (!list) return undefined;
      const { view } = list;
      const run: ComponentSpareRun = { visit, selected: [], outcomes: new Map(), opened: new Set() };
      state.runs.push(run);
      const open = openTarget(state.budget);
      try {
        await action(
          `Discover and select linked spares for Component ${visit.code}`,
          setting.mode === 'ALL'
            ? `Every F. Spares page of Component ${visit.code} should be read once and every unique linked spare not already selected in this test case selected for validation.`
            : `Every F. Spares page of Component ${visit.code} should be read once and up to ${open} unique spare(s) not already selected in this test case selected at random from all pages (test-case target ${setting.limit}, ${state.budget.validated} already validated).`,
          async () => {
            const inventory = await components.discoverLinkedSpares(view);
            if (!inventory.spares.length) {
              throw new Error(`Observed Application Result:\nF. Spares for Component ${visit.code} displayed rows, but no Part Code or Part Name could be read from them.`);
            }
            run.inventory = inventory;
            const available = uniqueByPartCode(inventory.spares);
            run.available = available.length;
            if (setting.mode === 'LIMITED') run.componentSeed = (setting.seed ^ hashText(visit.code)) >>> 0;
            const draw = drawSpares(state.budget, available, run.componentSeed ?? 0);
            run.selected = draw.selected;
            run.excluded = draw.excluded;
            return { inventory, draw };
          },
          ({ inventory, draw }) => {
            const pages = inventory.pageLabels.length ? ` across ${inventory.totalPages} page(s) (${inventory.pageLabels.join(', ')})` : '';
            const listed = run.selected.map((spare) => `${spareLabel(spare)}${spare.page ? ` [Page ${spare.page}]` : ''}`).join(', ') || 'none';
            const selection = selectionText(draw, state.budget, `run seed ${setting.seed}, component seed ${run.componentSeed}`);
            return `Component ${visit.code} (${visit.identity.name}) listed ${run.available} unique Part Code(s)${pages} from ${inventory.rowsRead} row(s) read. ${selection}: ${listed}.`;
          },
        );
      } catch (error) {
        failures.push(`Component ${visit.code}: its linked spares could not be read from every F. Spares page.`);
        diagnostics.push(`Component ${visit.code}; discover spares: ${errorText(error)}`);
        await collapse(visit, view);
        return undefined;
      }
      test.setTimeout(test.info().timeout + run.selected.length * perSpareBudget);
      await validateSelectedSpares(run, view);
      await collapse(visit, view);
      // Stop the tree walk as soon as the test-case target is met.
      if (targetReached(state.budget)) {
        state.budget.reachedAt = visit.code;
        return 'target reached' as const;
      }
      return undefined;
    }, maxComponents);
    state.stopReason = stopReasonText(state.budget, search, componentLimit);
    state.inspected = search.visited.length;
    // An unreadable remainder of the tree is missing coverage, never a pass.
    if (search.incomplete) failures.push(`The component tree could not be read to its end: ${search.incomplete}. Components after that point and their spares were not validated.`);

    if (!state.runs.length && !failures.length) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, 'a child component has at least one linked spare');
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }

    const recheckRuns = state.runs.filter((run) => run.opened.size);
    const recheckTitle = (run: ComponentSpareRun) => `Recheck ${run.opened.size} spare(s) of Component ${run.visit.code} after refresh`;
    const recheckExpected = (run: ComponentSpareRun) =>
      `After refresh, Component ${run.visit.code} should still list the ${run.opened.size} validated spare(s), and each should still show ${run.visit.code} (${run.visit.identity.name || run.visit.name}) in Linked Components.`;
    let refreshed = false;
    if (recheckRuns.length) {
      try {
        await action('Refresh the Components page and reselect the vessel',
          `After a browser refresh, the Components page should reload in the same authenticated session with Vessel ${vessel} selected.`,
          async () => {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await components.selectVessel(vessel);
            await components.expectTreeLoaded();
            return vessel;
          },
          (value) => `The Components page reloaded without a new login and Vessel ${value} was selected.`);
        refreshed = true;
      } catch (error) {
        failures.push('The Components page could not be refreshed, so the associations were not rechecked after refresh.');
        diagnostics.push(`Refresh: ${errorText(error)}`);
        for (const run of recheckRuns) {
          await componentNotExecutedStep(recheckTitle(run), recheckExpected(run), 'the Components page did not reload successfully.');
        }
      }
    }

    for (const run of refreshed ? recheckRuns : []) {
      const { code } = run.visit;
      const name = run.visit.identity.name || run.visit.name;
      const issues: string[] = [];
      const failedKeys = new Set<string>();
      try {
        await components.searchAndSelectComponentByCode(code);
        const list = await openSpareList(run.visit, false);
        const after = list ? await components.discoverLinkedSpares(list.view) : undefined;
        const current = new Map((after?.spares ?? []).map((spare) => [keyOf(spare), spare]));
        const targets: DiscoveredSpare[] = [];
        for (const spare of run.selected.filter((item) => run.opened.has(keyOf(item)))) {
          const found = current.get(keyOf(spare));
          if (found) targets.push(found);
          else {
            failedKeys.add(keyOf(spare));
            issues.push(`${spareLabel(spare)} was no longer listed in F. Spares`);
          }
        }
        targets.sort((a, b) => b.page - a.page);
        for (const spare of targets) {
          try {
            const details = await components.openSparePartDetails(spare, list?.view);
            if (!namedCodeInText(name, code).test(details.linkedComponentTexts.join(' '))) {
              failedKeys.add(keyOf(spare));
              issues.push(`${spareLabel(spare)} no longer showed ${code} (${name}) in Linked Components (displayed: ${details.linkedComponentTexts.join(' | ') || 'none'})`);
            }
            await closePopup(details);
          } catch (error) {
            failedKeys.add(keyOf(spare));
            issues.push(`${spareLabel(spare)} could not be reopened`);
            diagnostics.push(`After refresh; Component ${code}; spare ${spareLabel(spare)}: ${errorText(error)}`);
            await page.keyboard.press('Escape').catch(() => undefined);
          }
        }
        await collapse(run.visit, list?.view);
      } catch (error) {
        issues.push(`the F. Spares list of Component ${code} could not be reopened after refresh`);
        for (const key of run.opened) failedKeys.add(key);
        diagnostics.push(`After refresh; Component ${code}: ${errorText(error)}`);
      }
      for (const key of failedKeys) run.outcomes.set(key, 'FAIL');
      if (issues.length) failures.push(`After refresh, Component ${code}: ${issues.join('; ')}.`);
      await componentObservedCheck(page, recheckTitle(run), recheckExpected(run), {
        passed: !issues.length,
        actual: issues.length
          ? `After refresh: ${issues.join('; ')}. ${run.opened.size - failedKeys.size} other spare(s) kept the association.`
          : `After refresh, all ${run.opened.size} spare(s) were still listed and each still showed ${code} (${name}) in Linked Components.`,
      });
    }

    await finalizeCmp142(state, 'the scenario stopped before this selected spare was reached.');
    const summary = cmp142Summary(state);
    const modeText = setting.mode === 'ALL' ? 'ALL mode' : `LIMITED mode (target ${setting.limit} unique spares in total, seed ${setting.seed})`;
    await componentValidationStep(page, step(`Verify the ${setting.mode} linked-spare validation results`,
      `${modeText}: every selected spare should show its exact Part Code and Part Name in Spare Part Details, list the selected component in Linked Components, and keep the association after refresh; no selected spare may fail or remain unvalidated.`), async () => {
      expect(failures, [...failures, '', 'Technical details:', ...diagnostics].join('\n')).toEqual([]);
      return summary;
    }, { actual: (value) => `${modeText}: ${value.selected} selected unique spare(s) across ${state.runs.length} component(s) were validated — ${value.passed} passed, ${value.failed} failed, ${value.notExecuted} not executed. Each showed its exact Part Code and Part Name, listed the selected Component Code and Name in Linked Components, and kept the association after refresh. The traversal stopped because ${state.stopReason}` });
  });

  test('CMP-143 - Check stock above, at and below minimum', componentScenario(
    'Each validated spare (every unique spare, or a random sample of unique Part Codes up to the configured spare limit in total for this test case) should show Stock Status OK when ROB is above Min, At Min when equal, and Low when below. When Components → F. Spares shows a different status, the same Part Code in the separate PMS → Spares module should show the expected status with the same ROB and Min; unavailable conditions should be reported as missing coverage.'), async () => {
    test.setTimeout(45 * 60_000);
    const setting = resolveSpareSampling();
    const { limit: componentLimit, maxComponents } = await prepareRun('CMP-143', setting);
    const modeText = setting.mode === 'ALL' ? 'ALL mode' : `LIMITED mode (target ${setting.limit} unique spares in total, seed ${setting.seed})`;
    const budget = createSpareBudget(setting);
    const sparesModule = new SparesPage(page);
    const allConditions = ['OK', 'At Min', 'Low'];
    const encountered = new Set<string>();
    const verified = new Set<string>();
    /** Conditions whose only passing evidence came from the separate PMS → Spares module. */
    const moduleOnly = new Set<string>();
    const failures: string[] = [];
    const diagnostics: string[] = [];
    const tally = {
      checkedComponents: 0, withSpares: 0, available: 0, selected: 0, rowsRead: 0, passed: 0, failed: 0, notExecuted: 0,
      unknownNotExecuted: 0, multiPage: 0, pagesRead: 0, moduleVerified: 0,
    };
    const mismatches: StockMismatch[] = [];
    const componentLines: string[] = [];
    let stoppedAfter: string | undefined;

    /** Applies the CMP-143 rule (ROB above Min = OK, equal = At Min, below = Low) to the values F. Spares displayed. */
    const evaluateStock = (spare: DiscoveredSpare) => {
      const rob = numberFrom(spare.rob);
      const min = numberFrom(spare.min);
      const shown = spare.stock.trim();
      if (!Number.isFinite(rob) || !Number.isFinite(min)) {
        return { passed: false, expected: undefined, difference: `ROB "${spare.rob || 'blank'}" or Min "${spare.min || 'blank'}" was missing or not numeric, so the expected Stock Status could not be determined` };
      }
      const expected = rob === min ? 'At Min' : rob > min ? 'OK' : 'Low';
      const passed = shown.toLowerCase() === expected.toLowerCase();
      return { passed, expected, difference: passed ? '' : `Stock showed ${shown ? `"${shown}"` : 'no value'} instead of "${expected}"` };
    };

    /**
     * Resolves a Components Stock Status mismatch in the separate PMS → Spares
     * module (the authoritative source): opens it in the same tab, confirms the
     * vessel, searches the exact Part Code and reads ROB, Min and Stock there.
     */
    const crossVerify = async (point: ResumePoint, spare: DiscoveredSpare, expected: string): Promise<StockMismatch> => {
      test.setTimeout(test.info().timeout + 3 * 60_000);
      const record: StockMismatch = {
        component: point.component, spare: spareLabel(spare), location: point.location, expected,
        componentsStatus: spare.stock.trim(), rob: spare.rob, min: spare.min, result: 'FAIL',
      };
      const searchTitle = `Search Part Code ${spare.partCode} in the PMS → Spares module`;
      const searchExpected = `Searching ${spare.partCode} under Vessel ${point.vessel} should return the spare with exactly Part Code ${spare.partCode} (${spare.partName}); partial matches are not accepted.`;
      const readTitle = `Read Stock Status of ${spareLabel(spare)} in the PMS → Spares module`;
      const readExpected = `The PMS → Spares row for Part Code ${spare.partCode} under Vessel ${point.vessel} should display Stock "${expected}" for ROB ${spare.rob} and Min ${spare.min}.`;
      const compareTitle = `Compare ROB and Min of ${spare.partCode} between Components and the PMS → Spares module`;
      const compareExpected = `The PMS → Spares module should show the same ROB ${spare.rob} and Min ${spare.min} for Part Code ${spare.partCode} as Components → F. Spares.`;
      const unreached = async (from: number, reason: string) => {
        const planned = [[searchTitle, searchExpected], [readTitle, readExpected], [compareTitle, compareExpected]].slice(from);
        for (const [title, plannedExpected] of planned) await componentNotExecutedStep(title, plannedExpected, reason);
      };

      try {
        await componentActionStep(
          `Open the separate PMS → Spares module for Vessel ${point.vessel}`,
          `Spares Inventory should open in the same signed-in browser tab, without a new login, with Vessel ${point.vessel} selected.`,
          async () => {
            await sparesModule.openInventory();
            return sparesModule.ensureVessel(point.vessel);
          },
          (value) => `Spares Inventory opened in the same browser tab without a new login. Its vessel selector showed ${value.before}${value.changed ? `, so Vessel ${point.vessel} was selected` : `, the same vessel as Components`}.`,
          { page },
        );
      } catch (error) {
        diagnostics.push(`PMS → Spares module; open for ${spareLabel(spare)}: ${errorText(error)}`);
        record.reason = `the separate PMS → Spares module could not be opened with Vessel ${point.vessel} selected`;
        await unreached(0, `${record.reason}.`);
        return record;
      }

      let found: SparesModuleSearch;
      try {
        found = await componentActionStep(searchTitle, searchExpected,
          async () => {
            const result = await sparesModule.searchExactPartCode(spare.partCode);
            if (!result.exact.length) {
              throw new Error(`Observed Application Result:\nSearching ${spare.partCode} in the PMS → Spares module under Vessel ${point.vessel} returned ${result.returned} row(s)${result.countText ? ` (${result.countText})` : ''}, none with exactly Part Code ${spare.partCode}${result.morePages ? '; further result pages were not inspected' : ''}.`);
            }
            return result;
          },
          (value) => `The search returned ${value.returned} row(s)${value.countText ? ` (${value.countText})` : ''}; ${value.exact.length} row(s) had exactly Part Code ${spare.partCode}: ${value.exact.map((row) => `${row.partName || '[no name]'} in ${row.componentName || '[no component]'}`).join('; ')}.`,
          { page });
      } catch (error) {
        diagnostics.push(`PMS → Spares module; search ${spare.partCode}: ${errorText(error)}`);
        record.reason = `searching Part Code ${spare.partCode} in the PMS → Spares module did not return a row with that exact Part Code`;
        await unreached(1, `${record.reason}.`);
        await sparesModule.clearSearch().catch(() => undefined);
        return record;
      }

      const named = found.exact.filter((row) => sameText(row.partName, spare.partName));
      const componentName = point.componentName;
      const own = named.filter((row) => sameText(row.componentName, componentName));
      const candidates = own.length ? own : named;
      const distinct = new Set(candidates.map((row) => `${statusKey(row.stock)}|${numberFrom(row.rob)}|${numberFrom(row.min)}`));
      if (!candidates.length || distinct.size > 1) {
        record.reason = !candidates.length
          ? `the PMS → Spares row with Part Code ${spare.partCode} showed Part Name "${found.exact.map((row) => row.partName || 'blank').join('", "')}" instead of "${spare.partName}", so it is not the same spare`
          : `Part Code ${spare.partCode} appeared in ${candidates.length} PMS → Spares rows with different stock values, so the row for Component ${point.componentCode} could not be identified`;
        await unreached(1, `${record.reason}.`);
        await sparesModule.clearSearch().catch(() => undefined);
        return record;
      }

      const row = candidates[0];
      record.moduleStatus = row.stock.trim();
      record.moduleRob = row.rob;
      record.moduleMin = row.min;
      tally.moduleVerified += 1;
      const stockShown = await sparesModule.revealStockColumn().catch((error) => {
        diagnostics.push(`PMS → Spares module; show Stock for ${spare.partCode}: ${errorText(error)}`);
        return false;
      });
      if (!stockShown) diagnostics.push(`PMS → Spares module; the Stock column of ${spare.partCode} could not be scrolled into view for the evidence screenshot.`);
      const statusMatches = statusKey(record.moduleStatus) === statusKey(expected);
      await componentObservedCheck(page, readTitle, readExpected, {
        passed: statusMatches,
        actual: `PMS → Spares (Vessel ${point.vessel}) showed Part Code ${row.partCode} (${row.partName}) in Component ${row.componentName || '[blank]'} with ROB ${row.rob || '[blank]'}, Min ${row.min || '[blank]'} and Stock ${record.moduleStatus ? `"${record.moduleStatus}"` : '[blank]'}.`
          + (statusMatches ? ` This matches the expected "${expected}".` : ` Difference: Stock showed ${record.moduleStatus ? `"${record.moduleStatus}"` : 'no value'} instead of "${expected}".`),
      });

      const moduleRob = numberFrom(row.rob);
      const moduleMin = numberFrom(row.min);
      const stockValueIssues: string[] = [];
      if (Number.isFinite(moduleRob) && moduleRob !== numberFrom(spare.rob)) stockValueIssues.push(`ROB ${row.rob} instead of ${spare.rob}`);
      if (Number.isFinite(moduleMin) && moduleMin !== numberFrom(spare.min)) stockValueIssues.push(`Min ${row.min} instead of ${spare.min}`);
      const unavailable = [!Number.isFinite(moduleRob) && 'ROB', !Number.isFinite(moduleMin) && 'Min'].filter(Boolean).join(' and ');
      record.stockValueIssue = stockValueIssues.join(' and ') || undefined;
      await componentObservedCheck(page, compareTitle, compareExpected, {
        passed: !stockValueIssues.length,
        actual: stockValueIssues.length
          ? `The PMS → Spares module showed ${stockValueIssues.join(' and ')} shown in Components → F. Spares.`
          : `The PMS → Spares module showed ROB ${row.rob || '[blank]'} and Min ${row.min || '[blank]'}${unavailable ? `; ${unavailable} could not be compared because no numeric value was displayed` : ', the same values as Components → F. Spares'}.`,
      }, { screenshot: 'failure' });
      record.result = statusMatches && !stockValueIssues.length ? 'PASS' : 'FAIL';
      await sparesModule.clearSearch().catch((error) => diagnostics.push(`PMS → Spares module; clear search: ${errorText(error)}`));
      return record;
    };

    /** Returns to Components, restores the vessel, the component and the F. Spares page of the next selected spare. */
    const resume = async (point: ResumePoint, walk: TreeWalkControl, next: DiscoveredSpare | undefined, remaining: number) => {
      const target = next ? ` at ${point.pageOf(next)}` : '';
      return componentActionStep(
        `Return to Components and resume Component ${point.componentCode}${target}`,
        `Components should reopen in the same session with Vessel ${point.vessel} selected and Component ${point.componentCode} (${point.componentName}) selected again in the tree`
          + (next ? `, with F. Spares showing ${point.pageOf(next)} and the next selected spare ${spareLabel(next)}` : '')
          + ', without restarting the tree, revalidating completed spares or drawing a new sample.',
        async () => {
          await page.goto(routes.componentPage, { waitUntil: 'domcontentloaded' });
          await components.expectToBeOnPage();
          const reselected = await components.selectVessel(point.vessel);
          const identity = await walk.restore();
          let view: SpareListView | undefined;
          let shownPage: SparePageState | undefined;
          if (next) {
            const initial = await components.readLoadedLinkedSpares();
            if (!initial.spares.length) throw new Error(`Observed Application Result:\nAfter returning, F. Spares of Component ${point.componentCode} displayed no spare rows, so ${spareLabel(next)} could not be resumed.`);
            if ((await components.readLinkedSparesControls()).showAll) view = await components.showAllLinkedSpares();
            if (next.page > 0 && view) shownPage = await components.goToLinkedSparesPage(view, next.page);
            const listed = shownPage?.spares ?? (await components.readLoadedLinkedSpares()).spares;
            if (!listed.some((item) => sameText(item.partCode, next.partCode))) {
              throw new Error(`Observed Application Result:\nAfter returning, ${point.pageOf(next)} of Component ${point.componentCode} did not list the next selected spare ${spareLabel(next)}, so validation could not resume from it.`);
            }
          }
          return { reselected, identity, view, shownPage };
        },
        (value) => `Components reopened in the same browser tab without a new login; Vessel ${point.vessel} ${value.reselected ? 'was selected again' : 'was still selected'}, and Component ${value.identity.code} (${value.identity.name}) was selected again in the tree.`
          + (next ? ` F. Spares ${value.shownPage ? `showed ${value.shownPage.label}` : 'was reopened'} listing ${spareLabel(next)}; validation continues with the remaining ${remaining} selected spare(s) of the same sample.` : ' No selected spares remained for this component, so the tree walk continues with the next component.'),
        { page },
      );
    };

    const search = await searchComponentTree(page, components, async (visit, walk) => {
      // Unlimited coverage walks the whole tree, so every component adds its own time instead of a fixed walk budget.
      test.setTimeout(test.info().timeout + 30_000);
      if (visit.depth === 0) return undefined;
      tally.checkedComponents += 1;
      const componentName = visit.identity.name || visit.name;
      const runtimeVessel = visit.identity.vesselName && visit.identity.vesselName !== '—' ? visit.identity.vesselName : vessel;
      let view: SpareListView | undefined;
      let statedTotal = Number.NaN;
      let read: { inventory: LinkedSpareInventory; available: DiscoveredSpare[]; selected: DiscoveredSpare[]; componentSeed?: number; draw: ReturnType<typeof drawSpares> };
      const open = openTarget(budget);
      try {
        const initial = await components.readLoadedLinkedSpares();
        if (!initial.spares.length) return undefined;
        tally.withSpares += 1;
        const controls = await components.readLinkedSparesControls();
        statedTotal = Number(controls.showAll.match(/\((\d+)\s+(?:total|spares?)\)/i)?.[1] ?? Number.NaN);
        if (controls.showAll) {
          view = await action(
            `Click ${controls.showAll} for Component ${visit.code}`,
            `The full spare list for Component ${visit.code} should open without losing the initially displayed records.`,
            () => components.showAllLinkedSpares(),
            (value) => `${value.label} opened the full spare list ${value.mode === 'dialog' ? 'in a popup' : 'inside F. Spares'}.`,
          );
        }
        read = await componentActionStep(
          setting.mode === 'ALL'
            ? `Read every F. Spares page of Component ${visit.code}`
            : `Read every F. Spares page of Component ${visit.code} and select up to ${open} spares at random`,
          `Every F. Spares page of Component ${visit.code} should be read once, with Part Code, Part Name, ROB, Min and Stock for each spare row`
            + (setting.mode === 'ALL'
              ? '; every unique Part Code not already selected in this test case is validated.'
              : `; up to ${open} unique Part Codes not already selected in this test case are then selected at random from all pages (test-case target ${setting.limit}, ${budget.validated} already validated).`),
          async () => {
            const inventory = await components.discoverLinkedSpares(view);
            const available = uniqueByPartCode(inventory.spares);
            const componentSeed = setting.mode === 'LIMITED' ? (setting.seed ^ hashText(visit.code)) >>> 0 : undefined;
            const draw = drawSpares(budget, available, componentSeed ?? 0);
            return { inventory, available, selected: draw.selected, componentSeed, draw };
          },
          ({ inventory, available, selected, componentSeed, draw }) => `Component ${visit.code} (${componentName}) listed ${available.length} unique Part Code(s) from ${inventory.rowsRead} row(s)`
            + `${inventory.pageLabels.length ? ` across ${inventory.totalPages} page(s) (${inventory.pageLabels.join(', ')})` : ' on a single unpaginated list'}`
            + `${Number.isFinite(statedTotal) ? `; ${controls.showAll} stated ${statedTotal}` : ''}.`
            + ` ${selectionText(draw, budget, `run seed ${setting.seed}, component seed ${componentSeed}`)}: ${selected.map((spare) => `${spare.partCode} [${pageText(spare, inventory)}]`).join(', ') || 'none'}.`,
        );
      } catch (error) {
        const unread = Number.isFinite(statedTotal) ? `${statedTotal} spare(s)` : 'an unknown number of spares';
        if (Number.isFinite(statedTotal)) tally.notExecuted += statedTotal; else tally.unknownNotExecuted += 1;
        failures.push(`Component ${visit.code}: its F. Spares list could not be loaded or read, so ${unread} were not checked.`);
        diagnostics.push(`Component ${visit.code}; read F. Spares: ${errorText(error)}`);
        componentLines.push(`Component ${visit.code} (${componentName}): F. Spares could not be read; ${unread} NOT EXECUTED`);
        await componentNotExecutedStep(`Check Stock Status of the spares of Component ${visit.code}`,
          `Each spare of Component ${visit.code} should show the Stock Status matching its ROB and Min.`,
          `the F. Spares list of Component ${visit.code} could not be read, so ${unread} were not checked.`);
        if (view) await components.collapseLinkedSpares(view).catch(() => page.keyboard.press('Escape').catch(() => undefined));
        return undefined;
      }

      const { inventory, available, selected } = read;
      tally.available += available.length;
      tally.selected += selected.length;
      tally.rowsRead += inventory.rowsRead;
      tally.pagesRead += Math.max(inventory.pageLabels.length, 1);
      if (inventory.totalPages > 1) tally.multiPage += 1;
      const outcomes = new Map<string, SpareOutcome>();
      const counts = { passed: 0, failed: 0, notExecuted: 0 };
      /** Records a spare's outcome; it counts toward the test-case target only when its validation reached a result from displayed values. */
      const settle = (spare: DiscoveredSpare, outcome: SpareOutcome, counted = outcome !== 'NOT EXECUTED') => {
        outcomes.set(spare.partCode, outcome);
        if (counted) budget.validated += 1;
        if (outcome === 'PASS') counts.passed += 1;
        else if (outcome === 'FAIL') counts.failed += 1;
        else counts.notExecuted += 1;
      };
      const point: ResumePoint = {
        vessel: runtimeVessel, componentCode: visit.code, componentName, component: `${visit.code} (${componentName})`, location: '',
        pageOf: (spare) => pageText(spare, inventory), seed: setting.mode === 'LIMITED' ? setting.seed : undefined,
        selected: selected.map((spare) => spare.partCode), index: 0,
      };
      let scrolled = false;
      let stopped = false;

      for (const [index, spare] of selected.entries()) {
        const check = evaluateStock(spare);
        const location = pageText(spare, inventory);
        const label = spareLabel(spare);
        if (check.expected) encountered.add(check.expected);
        const observed = `F. Spares (${location}) showed Part Code ${spare.partCode || '[blank]'} (${spare.partName || '[blank]'}) with ROB ${spare.rob || '[blank]'}, Min ${spare.min || '[blank]'} and Stock ${spare.stock ? `"${spare.stock}"` : '[blank]'}.`;
        if (check.passed) {
          verified.add(check.expected!);
          moduleOnly.delete(check.expected!);
          await componentObservedCheck(page, `Check Stock Status of ${label} for Component ${visit.code}`,
            `With ROB ${spare.rob} and Min ${spare.min}, Part Code ${spare.partCode} should show Stock "${check.expected}".`,
            { passed: true, actual: `${observed} This matches the rule.` }, { screenshot: 'failure' });
          settle(spare, 'PASS');
          continue;
        }

        // Show the row's page with Stock in view so the screenshot is evidence of the displayed value.
        try {
          if (spare.page > 0 && view) await components.goToLinkedSparesPage(view, spare.page);
          scrolled = await components.revealSpareGridColumn(/^Stock$/i, view?.list) || scrolled;
        } catch (error) {
          diagnostics.push(`Component ${visit.code}; spare ${label}; show Stock for evidence: ${errorText(error)}`);
        }
        if (!check.expected) {
          await componentObservedCheck(page, `Check Stock Status of ${label} for Component ${visit.code}`,
            `Part Code ${spare.partCode} should show numeric ROB and Min values and the Stock Status they correspond to.`,
            { passed: false, actual: `${observed} Difference: ${check.difference}.` });
          settle(spare, 'FAIL');
          failures.push(`Component ${visit.code}; spare ${label} (${location}): ${check.difference}.`);
          continue;
        }

        await componentObservedCheck(page, `Read Stock Status of ${label} for Component ${visit.code} in Components → F. Spares`,
          `Components → F. Spares should display the Stock Status of Part Code ${spare.partCode}; with ROB ${spare.rob} and Min ${spare.min} the CMP-143 rule expects "${check.expected}". A different status is cross-checked in the separate PMS → Spares module.`,
          { passed: true, actual: `${observed} This differs from the expected "${check.expected}"; the Components mismatch is recorded and Part Code ${spare.partCode} is checked in the separate PMS → Spares module.` });

        // Progress saved before leaving Components, so validation resumes with the next spare of this same sample.
        Object.assign(point, { location, index });
        const record = await crossVerify(point, spare, check.expected);
        mismatches.push(record);
        const moduleText = record.moduleStatus !== undefined
          ? `The same Part Code was verified under Vessel ${point.vessel} in the separate PMS → Spares module, where Stock Status was ${record.moduleStatus || 'blank'} (ROB ${record.moduleRob || 'blank'}, Min ${record.moduleMin || 'blank'}).`
          : `It could not be verified in the separate PMS → Spares module because ${record.reason}.`;
        const verdict = record.result === 'PASS'
          ? 'The spare validation PASSED based on the Spares module. Note: The Components module displays a different Stock Status.'
          : record.moduleStatus === undefined
            ? 'The Components mismatch remains unresolved, so the spare validation FAILED.'
            : statusKey(record.moduleStatus) !== statusKey(check.expected)
              ? `Neither module displayed the expected ${check.expected}, so the spare validation FAILED.`
              : `The Spares module showed the expected Stock Status, but its ${record.stockValueIssue} shown in Components, so the spare validation FAILED.`;
        record.note = verdict;
        await componentObservedCheck(page, `Stock Status result of ${label} for Component ${visit.code}`,
          `Part Code ${spare.partCode} should display Stock Status ${check.expected} based on ROB ${spare.rob} and Minimum Level ${spare.min}. If Components displays a different status, the separate Spares module should be checked.`,
          { passed: record.result === 'PASS', actual: `Part Code ${spare.partCode} showed Stock Status ${spare.stock.trim() || 'blank'} in Components → F. Spares (${location}). ${moduleText} ${verdict}` },
          { screenshot: 'failure' });
        if (record.result === 'PASS') {
          if (!verified.has(check.expected)) moduleOnly.add(check.expected);
          verified.add(check.expected);
        }
        else failures.push(`Component ${visit.code}; spare ${label} (${location}): Components showed ${spare.stock.trim() ? `"${spare.stock.trim()}"` : 'no value'} instead of "${check.expected}"; ${record.moduleStatus !== undefined ? `PMS → Spares showed "${record.moduleStatus}"${record.stockValueIssue ? ` with ${record.stockValueIssue}` : ''}` : `not verified in PMS → Spares because ${record.reason}`}.`);
        // An unresolved mismatch whose PMS → Spares row was never read is reported as FAIL but is not a completed validation.
        settle(spare, record.result, record.moduleStatus !== undefined);

        const rest = selected.slice(index + 1);
        try {
          const resumed = await resume(point, walk, rest[0], rest.length);
          view = resumed.view;
          scrolled = false;
        } catch (error) {
          diagnostics.push(`Component ${visit.code}; return to Components after ${label}: ${errorText(error)}`);
          diagnostics.push(`Saved resume point: ${JSON.stringify({ ...point, pageOf: undefined, next: rest[0]?.partCode, nextPage: rest[0] && pageText(rest[0], inventory) })}`);
          failures.push(`Component ${visit.code}: Components could not be restored after checking ${label} in the PMS → Spares module, so ${rest.length} remaining selected spare(s) and the rest of the component tree were not validated.`);
          for (const skipped of rest) {
            settle(skipped, 'NOT EXECUTED');
            await componentNotExecutedStep(`Check Stock Status of ${spareLabel(skipped)} for Component ${visit.code}`,
              `Part Code ${skipped.partCode} should show the Stock Status matching ROB ${skipped.rob} and Min ${skipped.min}.`,
              `Components could not be restored after the PMS → Spares check of ${label}, so this selected spare was not reached.`);
          }
          stopped = true;
          break;
        }
      }

      tally.passed += counts.passed;
      tally.failed += counts.failed;
      tally.notExecuted += counts.notExecuted;
      const listed = setting.mode === 'LIMITED'
        ? selected.map((spare) => `${spare.partCode} ${outcomes.get(spare.partCode) ?? 'NOT EXECUTED'}`)
        : selected.filter((spare) => outcomes.get(spare.partCode) !== 'PASS').map((spare) => `${spare.partCode} ${outcomes.get(spare.partCode) ?? 'NOT EXECUTED'}`);
      componentLines.push(`Component ${visit.code} (${componentName}): ${available.length} unique Part Code(s) from ${inventory.rowsRead} row(s) on ${inventory.totalPages} page(s); selected ${selected.length}`
        + `${read.draw.excluded ? ` (${read.draw.excluded} already selected for an earlier component were excluded)` : ''}`
        + `${read.componentSeed === undefined ? '' : ` (component seed ${read.componentSeed})`}; passed ${counts.passed}, failed ${counts.failed}, not executed ${counts.notExecuted}`
        + `${listed.length ? ` — ${setting.mode === 'LIMITED' ? 'selected' : 'not passed'}: ${listed.join(', ')}` : ''}`);
      if (stopped) {
        stoppedAfter = visit.code;
        return 'stopped' as const;
      }
      if (scrolled) await components.revealSpareGridColumn(/^Part Code$/i, view?.list).catch(() => false);
      if (view) {
        await components.collapseLinkedSpares(view).catch(async (error) => {
          diagnostics.push(`Component ${visit.code}; collapse F. Spares: ${errorText(error)}`);
          await page.keyboard.press('Escape').catch(() => undefined);
        });
      }
      // Stop the tree walk as soon as the test-case target is met.
      if (targetReached(budget)) {
        budget.reachedAt = visit.code;
        return 'target reached' as const;
      }
      return undefined;
    }, maxComponents);

    // An unreadable remainder of the tree is missing coverage, never a pass.
    if (search.incomplete) failures.push(`The component tree could not be read to its end: ${search.incomplete}. Components after that point and their spares were not checked.`);
    if (!tally.available && !failures.length) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, 'a child component has spare rows with ROB, Min and Stock');
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }

    const notExecuted = `${tally.notExecuted}${tally.unknownNotExecuted ? ` (plus the spares of ${tally.unknownNotExecuted} component(s) whose count was not displayed)` : ''}`;
    const stopReason = stopReasonText(budget, search, componentLimit, stoppedAfter
      ? `Components could not be restored after Component ${stoppedAfter}, so the tree walk stopped there with ${budget.validated} unique spare(s) validated; later components were not inspected.`
      : undefined);
    const treeCoverage = `The traversal stopped because ${stopReason}`;
    const verifiedText = allConditions.filter((item) => verified.has(item))
      .map((item) => (moduleOnly.has(item) ? `${item} (confirmed only in the separate PMS → Spares module)` : item)).join(', ') || 'none';
    const resolved = mismatches.filter((item) => item.result === 'PASS');
    const unresolved = mismatches.filter((item) => item.result !== 'PASS');
    const finalResult = failures.length ? 'FAIL' : 'PASS';
    const summary = [
      'Test Case: CMP-143',
      ...samplingLines(setting, 'every spare is validated'),
      componentLimitLine(componentLimit),
      `Vessel: ${[...new Set(search.visited.map((visit) => visit.identity.vesselName).filter((name) => name && name !== '—'))].join(', ') || vessel}`,
      ...spareTargetLines(budget, tally.failed, stopReason),
      `Scope: ${setting.mode === 'ALL' ? 'every unique Part Code on' : `up to ${setting.limit} randomly selected unique Part Codes in total for this test case, drawn from`} every F. Spares page of each inspected child component; a Part Code linked to several components is checked only once in this test case.`,
      `Components inspected: ${search.visited.length} (${tally.checkedComponents} child component(s) checked for spares; top-level groups are not checked).`,
      `Components containing spares: ${tally.withSpares}`,
      `Total available spares: ${tally.available} unique Part Code(s) (from ${tally.rowsRead} row(s) read)`,
      `Selected spares: ${tally.selected}`,
      `Validated spares: ${tally.passed + tally.failed}; passed: ${tally.passed}; failed: ${tally.failed}; not executed: ${notExecuted}`,
      `Spares verified in the separate PMS → Spares module: ${tally.moduleVerified}`,
      `Components Stock Status mismatches: ${mismatches.length}; resolved by the separate PMS → Spares module: ${resolved.length}; unresolved: ${unresolved.length}`,
      ...mismatches.map((item) => `  ${item.result.padEnd(4)} Component ${item.component} — ${item.spare}, ${item.location}: expected "${item.expected}"; Components → F. Spares "${item.componentsStatus || 'blank'}" (ROB ${item.rob}, Min ${item.min}); `
        + `PMS → Spares ${item.moduleStatus !== undefined ? `"${item.moduleStatus || 'blank'}" (ROB ${item.moduleRob || 'blank'}, Min ${item.moduleMin || 'blank'})` : `not read — ${item.reason}`}. ${item.note ?? ''}`),
      `Pagination: ${tally.pagesRead} F. Spares page(s) read; ${tally.multiPage} component(s) had more than one page and every page was read before selection.`,
      `Stock conditions verified (at least one passing spare): ${verifiedText}`,
      `Stock conditions not present in the selected spares: ${allConditions.filter((item) => !encountered.has(item)).join(', ') || 'none'}`,
      `Screenshot evidence: each mismatched spare has screenshots of its Components → F. Spares row and of the PMS → Spares search result with Stock shown; every failed check has its own screenshot.`,
      `Final result: ${finalResult}`,
      '',
      ...componentLines,
    ].join('\n');
    await test.info().attach('CMP-143 stock coverage summary', { body: summary, contentType: 'text/plain' });

    const mismatchText = mismatches.length
      ? ` Components showed a different Stock Status for ${mismatches.length} spare(s): ${resolved.length} confirmed by the separate PMS → Spares module (${resolved.map((item) => `${item.spare}: Components ${item.componentsStatus || 'blank'}, Spares ${item.moduleStatus}`).join('; ') || 'none'}), ${unresolved.length} unresolved${unresolved.length ? ` (${unresolved.map((item) => `${item.spare}: Components ${item.componentsStatus || 'blank'}, Spares ${item.moduleStatus ?? 'not verified'}, expected ${item.expected}`).join('; ')})` : ''}.`
      : ' Components showed the expected Stock Status for every validated spare.';
    await componentValidationStep(page, step('Verify the Stock Status of every selected spare',
      `${modeText}: every selected spare should show OK when ROB is above Min, At Min when equal, and Low when below, in Components → F. Spares or, where Components differs, in the separate PMS → Spares module; no spare may fail or remain unchecked.`), async () => {
      expect(failures, [...failures, '', 'Technical details:', ...diagnostics].join('\n')).toEqual([]);
    }, { actual: () => `${modeText}: ${tally.passed + tally.failed} of ${tally.selected} selected spare(s) across ${tally.withSpares} component(s) were checked on ${tally.pagesRead} F. Spares page(s) — ${tally.passed} passed, ${tally.failed} failed, ${notExecuted} not executed; ${budget.validated} unique spare(s) counted toward the ${budget.limit === undefined ? 'test case (no target in ALL mode)' : `target of ${budget.limit}`}.${mismatchText} `
      + `Verified: ${verifiedText}. Not present in the selected spares: ${allConditions.filter((item) => !encountered.has(item)).join(', ') || 'none'}. ${treeCoverage}` });
  });

  test('CMP-144 - Open spare location breakdown', componentScenario(
    'For an inspected spare offering View in Location, the sum of all Storage Locations quantities should equal that spare\'s displayed ROB.'), async () => {
    test.setTimeout(45 * 60_000);
    const { maxComponents } = await prepareRun('CMP-144');
    const mismatches: string[] = [];
    const observations: string[] = [];
    let spareCount = 0;
    const componentCodes = new Set<string>();
    const search = await searchComponentTree(page, components, async (visit) => {
      if (visit.depth === 0) return undefined;
      const full = await readFullList(visit);
      if (!full.spares.length) return undefined;
      const eligible = await action(`Inspect F. Spares Location links for Component ${visit.code}`,
        `Component ${visit.code} (${visit.identity.name}) should remain selected, F. Spares should finish loading, and every page should be checked for actual View or View (n) links in the Location column after exact Part Code and Part Name identities are captured.`,
        () => components.discoverSparesWithLocationView(full.view),
        (value) => `Component ${visit.code} (${visit.identity.name}) remained selected and its loaded F. Spares pages contained ${value.length} eligible spare(s): ${value.map((spare) => `${spareLabel(spare)} with ROB ${spare.rob || '[missing]'} and Location ${spare.viewLabel}`).join('; ') || 'none'}.`);
      if (!eligible.length) {
        await closeFullList(full);
        return undefined;
      }
      for (const spare of eligible) {
        componentCodes.add(visit.code);
        spareCount += 1;
        try {
          const breakdown = await action(`Open Storage Locations for spare ${spareLabel(spare)}`,
            `Clicking ${spare.viewLabel} in Location should render the indicated number of storage-location entries for ${spareLabel(spare)}, with each location name and quantity available so their sum can be compared with displayed ROB ${spare.rob || '[missing]'}.`,
            () => components.openSpareLocationBreakdown(spare, full.view?.list, full.view),
            (value) => {
              const calculated = value.locations.map((item) => numberFrom(item.quantity)).reduce((sum, quantity) => sum + quantity, 0);
              return `Component ${visit.code}; spare ${spareLabel(spare)}; ${value.viewLabel} rendered ${value.locations.length} location(s): ${value.locations.map((item) => `${item.location}: ${item.quantity}`).join('; ')}; calculated sum ${calculated}; displayed ROB ${spare.rob || '[missing]'}; popup Total ROB ${value.totalRob || '[missing]'}.`;
            });
          const quantities = breakdown.locations.map((item) => numberFrom(item.quantity));
          const rob = numberFrom(spare.rob);
          const calculated = quantities.reduce((sum, quantity) => sum + quantity, 0);
          observations.push(`Component ${visit.code}; spare ${spareLabel(spare)}; Location link ${breakdown.viewLabel}; locations ${breakdown.locations.map((item) => `${item.location}=${item.quantity}`).join(', ')}; calculated total ${calculated}; displayed ROB ${spare.rob}; popup Total ROB ${breakdown.totalRob || '[missing]'}.`);
          if (!quantities.length || quantities.some((value) => !Number.isFinite(value)) || !Number.isFinite(rob) || calculated !== rob) {
            mismatches.push(observations.at(-1)!);
          }
        } catch (error) {
          mismatches.push(`Component ${visit.code}; spare ${spareLabel(spare)}; Storage Locations could not be fully observed (${error instanceof Error ? error.message : String(error)}).`);
          await page.keyboard.press('Escape').catch(() => undefined);
        }
      }
      await closeFullList(full);
      return 'eligible spare checked' as const;
    }, maxComponents);
    if (!spareCount) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, 'a linked spare displays View in the Location column');
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }
    await componentValidationStep(page, step('Compare every location sum with displayed ROB',
      'Each calculated location sum should equal the selected spare\'s ROB shown in F. Spares.'), async () => {
      expect(mismatches, mismatches.join('\n')).toEqual([]);
      return { components: componentCodes.size, spares: spareCount };
    }, { actual: (value) => `${value.components} component(s) and ${value.spares} spare location breakdown(s) were checked; every calculated location sum equalled its displayed ROB. ${observations.join(' ')}` });
  });
  test('CMP-145 - Expand or paginate a long spare list', componentScenario(
    'Next should display the next spare page, Previous should restore the first page, Show All should expose every unique spare, and Collapse should restore the initial limited list.'), async () => {
    test.setTimeout(30 * 60_000);
    const { maxComponents } = await prepareRun('CMP-145');
    const search = await searchComponentTree(page, components, async (visit) => {
      if (visit.depth === 0) return undefined;
      const initial = await components.readLoadedLinkedSpares();
      const controls = await components.readLinkedSparesControls();
      if (!controls.showAll) return undefined;
      const view = await action(`Click ${controls.showAll} on Component ${visit.code}`,
        `The expanded F. Spares list should expose pagination when ${visit.code} has multiple spare pages.`,
        () => components.showAllLinkedSpares(),
        (value) => `${value.label} expanded F. Spares ${value.mode === 'dialog' ? 'in a popup' : 'inside the component details'}.`);
      const pagination = await components.readLinkedSparesPage(view);
      if (pagination && pagination.totalPages > 1) return { initial, controls, view, pagination };
      await action(`Collapse F. Spares for unsuitable Component ${visit.code}`,
        'A component without multiple spare pages should return to its limited list before the search continues.',
        () => components.collapseLinkedSpares(view),
        (label) => `${label} restored the limited list; this component did not provide multiple spare pages.`);
      return undefined;
    }, maxComponents);
    if (!search.match) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, 'F. Spares displays Show All and a Page X of Y control with more than one page');
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }
    const { visit, result } = search.match;
    const initialKeys = result.initial.spares.map(keyOf);
    const firstPage = result.pagination;
    const firstPageKeys = firstPage.spares.map(keyOf);
    const secondPage = await action('Click the Next arrow in F. Spares',
      `Pagination should change from ${firstPage.label} to Page 2 of ${firstPage.totalPages}, and a different set of spare records should be displayed.`,
      () => components.navigateLinkedSparesPage(result.view, 'next'),
      (value) => `${value.label} displayed ${value.spares.length} spare(s): ${value.spares.map((spare) => spare.partCode).join(', ')}.`);
    expect(secondPage.currentPage).toBe(2);
    expect(secondPage.spares.map(keyOf)).not.toEqual(firstPageKeys);

    const returnedPage = await action('Click the Previous arrow in F. Spares',
      `Pagination should return to ${firstPage.label} with the original first-page spare records.`,
      () => components.navigateLinkedSparesPage(result.view, 'previous'),
      (value) => `${value.label} displayed the original ${value.spares.length} spare(s): ${value.spares.map((spare) => spare.partCode).join(', ')}.`);
    expect(returnedPage.currentPage).toBe(1);
    expect(returnedPage.spares.map(keyOf)).toEqual(firstPageKeys);

    const expanded = await action('Read every F. Spares pagination page',
      `All ${firstPage.totalPages} pages should be accessible, with no duplicate or missing spare records.`,
      () => components.readSparesAcrossPages(result.view.list, result.view.scope),
      (value) => `${value.pageLabels.join(', ')} exposed ${value.spares.length} unique spare record(s).`);
    const expandedKeys = expanded.spares.map(keyOf);
    const statedTotal = Number(result.view.label.match(/\((\d+)\s+(?:total|spares?)\)/i)?.[1] ?? Number.NaN);
    expect(new Set(expandedKeys).size, 'Show All should not duplicate spare records').toBe(expandedKeys.length);
    if (Number.isFinite(statedTotal)) expect(expandedKeys.length, 'Show All should display the stated complete spare count').toBe(statedTotal);
    expect(expandedKeys.length, 'Show All should display additional spare records').toBeGreaterThan(initialKeys.length);
    for (const key of initialKeys) expect(expandedKeys).toContain(key);
    const collapseLabel = await action('Click Collapse', 'The spare list should return to its original limited view.',
      () => components.collapseLinkedSpares(result.view), (label) => `${label} closed the expanded list.`);
    await componentValidationStep(page, step('Verify the original limited spare list was restored',
      `F. Spares should again show the original ${initialKeys.length} unique record(s) after Collapse.`), async () => {
      const collapsed = await components.readLoadedLinkedSpares();
      expect(collapsed.spares.map(keyOf)).toEqual(initialKeys);
      expect((await components.readLinkedSparesControls()).showAll).toBe(result.controls.showAll);
      return collapsed.spares;
    }, { actual: (spares) => `Component ${visit.code}: ${firstPage.label} showed ${firstPageKeys.length} spare(s), Next showed ${secondPage.label} with different records, Previous restored ${returnedPage.label} and the original records, all ${expanded.pageLabels.length} pages contained ${expandedKeys.length} unique spare(s), and ${collapseLabel} restored the original ${spares.length}-record limited view.` });
  });

  test('CMP-146 - Open Spares for a component with no linked parts', componentScenario(
    `The first component without linked spare rows should display "${emptyMessage}" in F. Spares.`), async () => {
    test.setTimeout(30 * 60_000);
    const { maxComponents } = await prepareRun('CMP-146');
    const search = await searchComponentTree(page, components, async (visit) => {
      if (visit.depth === 0) return undefined;
      const state = await components.readLoadedLinkedSpares();
      return !state.spares.length && state.emptyMessage ? state : undefined;
    }, maxComponents);
    if (!search.match) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, 'a component has no linked spare rows');
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }
    const { visit, result } = search.match;
    await componentValidationStep(page, step(`Verify the F. Spares empty state for Component ${visit.code}`,
      `Component ${visit.code} (${visit.identity.name}) should show no spare rows and the message "${emptyMessage}".`), async () => {
      expect(result.spares).toEqual([]);
      expect(normalizedMessage(result.emptyMessage).startsWith(normalizedMessage(emptyMessage))).toBe(true);
      return result.emptyMessage;
    }, { actual: (message) => `Component ${visit.code} (${visit.identity.name}) in ${visit.identity.vesselName} displayed no spare rows and showed "${message}".` });
  });


  /*
  test.skip('CMP-147 - Deferred spare scenario', componentScenario('CMP-147 remains intentionally deferred and is not executed.'), async () => {});
  test.skip('CMP-148 - Deferred spare scenario', componentScenario('CMP-148 remains intentionally deferred and is not executed.'), async () => {});
*/
  });
