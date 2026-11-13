import { test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { RunningHoursPage, type RunningHoursGridRow, type RunningHoursInheritedChild } from '../../pages/RunningHoursPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import {
  attachFailureScreenshot,
  attachRunningHoursComparison,
  componentActionStep,
  componentNotExecutedStep,
  componentObservedCheck,
  componentScenario,
  componentValidationStep,
} from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { routes } from '../../utils/routes';
import { normalizeRunningHours } from '../../utils/runningHoursValidation';

type Outcome = { checks: number; failures: string[]; diagnostics: string[] };
type CheckResult = { passed: boolean; actual: string };
type SectionC = { counterType: string; counterSource: string; runningHours: string };
type DynamicRhPair = {
  vessel: string;
  master: RunningHoursGridRow;
  masterHours: number;
  masterLastUpdated: string;
  inheritedIndicator: string;
  inheritedDetails: string;
  updateDate: string;
};

const sectionC = 'C. Running Hours & Condition Monitoring';
const vesselCount = config.runningHoursVesselCount;
const componentsPerVessel = config.runningHoursComponentsPerVessel;
const rhUpdateCasesOnly = process.argv
  .map((argument) => argument.replaceAll('\\', '/').replace(/^\.\//, ''))
  .some((argument) => argument.endsWith('/tests/running-hours/pms-running-hours-set-total-add-delta-validation.spec.ts')
    || argument === 'tests/running-hours/pms-running-hours-set-total-add-delta-validation.spec.ts');
const step = (title: string, expected: string, actual: string) => `${title}\nExpected: ${expected}\nActual: ${actual}`;

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const isBlank = (value: string) => ['', '-', '—'].includes(clean(value));
const shown = (value: string) => (isBlank(value) ? '<blank>' : clean(value));
/** Parses numeric Running Hours values such as "2,000 hrs" and "2000.00". */
const hours = normalizeRunningHours;
const dateOnly = (value: string): string => {
  const text = clean(value);
  const namedMonths: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const named = text.match(/\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/);
  if (named && namedMonths[named[2].toLowerCase()]) return `${named[3]}-${namedMonths[named[2].toLowerCase()]}-${named[1].padStart(2, '0')}`;
  const dayFirst = text.match(/\b(\d{2})-(\d{2})-(\d{4})\b/);
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  return text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
};
const addCalendarDays = (isoDate: string, days: number): string => {
  const [year, month, day] = isoDate.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
};
const localToday = (): string => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
/** States a thrown check in business language; the raw error is kept for Technical Details. */
const observedFailure = (error: unknown): string => {
  const first = (error instanceof Error ? error.message : String(error))
    .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const message = first.replace(/^(?:Error|TimeoutError):\s*/i, '').replace(/[.:]+$/, '');
  return message && !/locator|getBy|expect\(|waitFor|Timeout \d+ms|\.ts:\d/i.test(message)
    ? `Not observed: ${message}.`
    : 'The expected application state did not appear within the allowed time, so no result was observed for this check.';
};

/** Evenly spaced picks across the loaded rows, so components come from the whole table. */
const spreadPick = <T>(items: T[], count: number): T[] => {
  if (items.length <= count) return [...items];
  if (count === 1) return [items[Math.floor(items.length / 2)]];
  return Array.from({ length: count }, (_, index) => items[Math.round((index * (items.length - 1)) / (count - 1))]);
};

test.describe('PMS Running Hours validation', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  const positiveBoundaryReservedCodes = new Set<string>();

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(5 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
  });

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    // Return to the Components page without changing any Running Hours data.
    await restoreComponentsPage(page, components);
  });

  test.afterAll(async () => context?.close());

  const newOutcome = (): Outcome => ({ checks: 0, failures: [], diagnostics: [] });

  /**
   * Records one business action. A failed action is reported FAIL with its own
   * observation and does not stop the scenario; the caller decides which later
   * steps depend on it.
   */
  const act = async <T>(
    outcome: Outcome,
    title: string,
    expected: string,
    body: () => Promise<T>,
    actual: (value: T) => string,
    evidence = true,
  ): Promise<T | undefined> => {
    outcome.checks += 1;
    try {
      return await componentActionStep(title, expected, body, actual, evidence ? { page } : undefined);
    } catch (error) {
      outcome.failures.push(title);
      outcome.diagnostics.push(`${title}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  /** Records one observed comparison as PASS or FAIL and lets the scenario continue. */
  const check = async (
    outcome: Outcome,
    title: string,
    expected: string,
    evaluate: () => Promise<CheckResult>,
    screenshot: 'always' | 'failure' = 'always',
  ): Promise<boolean> => {
    outcome.checks += 1;
    let result: CheckResult;
    try {
      result = await evaluate();
    } catch (error) {
      result = { passed: false, actual: observedFailure(error) };
      outcome.diagnostics.push(`${title}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await componentObservedCheck(page, title, expected, result, { screenshot });
    if (!result.passed) outcome.failures.push(title);
    return result.passed;
  };

  /** The scenario's overall validation: fails with every unmet check named, after all checks ran. */
  const finish = (outcome: Outcome, title: string, expected: string, passedActual: string) =>
    componentValidationStep(page, step(title, expected, 'Recorded after the validation completes.'), async () => {
      if (outcome.failures.length) {
        throw new Error(
          `Observed Application Result:\n${outcome.failures.length} of ${outcome.checks} checks did not meet their expected result: ${outcome.failures.join('; ')}.\n\n`
          + `Diagnostics:\n${outcome.diagnostics.join('\n') || 'Each failed check recorded its observed values in its own step.'}`,
        );
      }
    }, { actual: () => passedActual });

  const openRunningHours = async (): Promise<RunningHoursPage> => {
    const runningHours = await new TechnicalPage(page).goToRunningHours();
    await runningHours.waitForScreen();
    return runningHours;
  };

  // Shared with RH-N07: use the persisted per-vessel setting in PMS Admin,
  // rather than the informational status displayed on Running Hours.
  const openAdminRhValidationSettings = async (vessel: string): Promise<RunningHoursPage> => {
    await new TechnicalPage(page).openAdmin();
    await page.getByText('Master Data', { exact: true }).filter({ visible: true }).first().click();
    await page.getByText('Lead Time & Grace', { exact: true }).filter({ visible: true }).first().click();
    const search = page.getByPlaceholder(/search by vessel/i).filter({ visible: true }).first();
    if (await search.count()) await search.fill(vessel);
    const settings = new RunningHoursPage(page);
    await settings.adminRhValidationState(vessel);
    return settings;
  };

  const inheritedCount = (value: string) => Number(clean(value).replace(/[^\d.-]/g, '')) || 0;
  /**
   * Resolves the vessels to test: the configured RH vessels first, then other
   * vessels from the application's list only when fewer than the configured count.
   */
  const resolveVessels = async (outcome: Outcome, runningHours: RunningHoursPage): Promise<string[]> => {
    let vessels: string[] = [];
    await check(outcome,
      `Resolve ${vesselCount} vessels to test`,
      `${vesselCount} different vessels should be available in the Running Hours vessel list, starting with the configured vessels ${config.runningHoursVessels.join(', ')}.`,
      async () => {
        const options = await runningHours.vesselOptions();
        const configured = config.runningHoursVessels.slice(0, vesselCount);
        const added = options.filter((name) => !configured.includes(name) && name !== config.emptyVessel)
          .slice(0, Math.max(0, vesselCount - configured.length));
        vessels = [...configured, ...added];
        const missing = configured.filter((name) => !options.includes(name));
        return {
          passed: !missing.length && vessels.length === vesselCount,
          actual: `Vessels to test: ${vessels.map((name) => `Vessel ${name}`).join(', ')}${added.length ? ` (${added.join(', ')} added from the application's vessel list)` : ''}.`
            + `${missing.length ? ` Not offered in the Running Hours vessel list: ${missing.join(', ')}.` : ''}`
            + `${vessels.length < vesselCount ? ` Only ${vessels.length} of ${vesselCount} vessels were available.` : ''}`,
        };
      });
    return vessels;
  };

  /** Selects a vessel in Running Hours, or records that it was already selected without selecting it again. */
  const ensureRunningHoursVessel = async (outcome: Outcome, runningHours: RunningHoursPage, vessel: string, suffix: string): Promise<boolean> => {
    const current = await runningHours.selectedVesselName().catch(() => '');
    if (current === vessel) {
      return check(outcome,
        `Confirm Vessel ${vessel} is selected in Running Hours${suffix}`,
        `Running Hours should show Vessel ${vessel}.`,
        async () => ({ passed: true, actual: `Running Hours already showed Vessel ${vessel}; it was not selected again.` }));
    }
    const selected = await act(outcome,
      `Select Vessel ${vessel} in Running Hours${suffix}`,
      `Running Hours should switch from Vessel ${current || '<none>'} to Vessel ${vessel} and show that vessel's Running Hours data.`,
      async () => (await runningHours.selectVesselAndWaitForData(vessel)) ?? { requested: false },
      ({ requested }) => `Vessel ${vessel} was selected in Running Hours; ${requested
        ? 'the application requested its Running Hours data and the request succeeded.'
        : 'the application reused the Running Hours data it had already loaded for this vessel in this session.'}`);
    return selected !== undefined;
  };

  if (!rhUpdateCasesOnly) test('RH-P01 - Default vessel, Running Hours table loading and dynamic component search', componentScenario(
    `Running Hours should open with a valid default vessel and its table fully loaded. For each of ${vesselCount} vessels, selecting the vessel should load its Running Hours table, a component-name search should list exactly the matching components, and clearing the search should restore the full list.`,
  ), async () => {
    test.setTimeout(15 * 60_000);
    const outcome = newOutcome();

    const runningHours = await act(outcome,
      'Open PMS → Running Hours',
      'The Running Hours page should open from the PMS menu in the existing authenticated session.',
      openRunningHours,
      () => 'The Running Hours page opened from the PMS menu without another login.',
      true);
    if (!runningHours) {
      for (const vessel of config.runningHoursVessels.slice(0, vesselCount)) {
        await componentNotExecutedStep(`Vessel ${vessel} table loading and search`, `Vessel ${vessel} should load and be searchable in Running Hours.`, 'Running Hours did not open, so this vessel could not be tested.');
      }
      await finish(outcome, 'Verify all Running Hours vessel and search checks', 'Every RH-P01 check should pass.', '');
      return;
    }

    let defaultVessel = '';
    await check(outcome,
      'Verify the default vessel selection in Running Hours',
      config.runningHoursDefaultVessel
        ? `Running Hours should open with the configured default Vessel ${config.runningHoursDefaultVessel} selected.`
        : 'Running Hours should open with a vessel already selected, and that vessel should be one offered in the vessel list.',
      async () => {
        defaultVessel = await runningHours.selectedVesselName();
        const options = await runningHours.vesselOptions();
        const listed = options.includes(defaultVessel);
        const matchesConfigured = !config.runningHoursDefaultVessel || defaultVessel === config.runningHoursDefaultVessel;
        return {
          passed: listed && matchesConfigured,
          actual: `Running Hours opened with Vessel ${defaultVessel} selected; it ${listed ? 'is' : 'is NOT'} one of the ${options.length} vessels in the list`
            + `${config.runningHoursDefaultVessel ? ` and ${matchesConfigured ? 'matches' : 'does NOT match'} the configured default ${config.runningHoursDefaultVessel}` : ''}.`,
        };
      }, 'always');

    await check(outcome,
      `Verify the Running Hours table loads for default Vessel ${defaultVessel || '<unknown>'}`,
      'The Running Hours table should finish loading and display one row for every component counted in its footer.',
      async () => {
        const count = await runningHours.readComponentCount();
        const rows = await runningHours.readAllRows();
        return {
          passed: count.shown === count.total && rows.length === count.shown,
          actual: `The footer showed "${count.text}" and the table displayed ${rows.length} component row(s) for Vessel ${defaultVessel}.`,
        };
      });

    const vessels = await resolveVessels(outcome, runningHours);
    for (const vessel of vessels) {
      if (!(await ensureRunningHoursVessel(outcome, runningHours, vessel, ''))) {
        await componentNotExecutedStep(`Vessel ${vessel} table loading and component search`, `The Running Hours table for Vessel ${vessel} should load and be searchable.`, `Vessel ${vessel} could not be selected, so its table and search were not tested.`);
        continue;
      }

      let rows: RunningHoursGridRow[] = [];
      let total = 0;
      await check(outcome,
        `Verify the Running Hours table loads for Vessel ${vessel}`,
        `The Running Hours table for Vessel ${vessel} should finish loading and display one row for every component counted in its footer.`,
        async () => {
          const count = await runningHours.readComponentCount();
          rows = await runningHours.readAllRows();
          total = count.total;
          return {
            passed: count.shown === count.total && rows.length === count.shown,
            actual: `The footer showed "${count.text}" and the table displayed ${rows.length} component row(s) for Vessel ${vessel}.`,
          };
        });

      // The search term comes from this vessel's own data: the first word of a
      // component name, so the expected matches can be counted from the table.
      const target = rows[Math.floor(rows.length / 2)];
      const firstWord = target ? clean(target.componentName).split(' ')[0] : '';
      const term = firstWord.length >= 3 ? firstWord : target ? clean(target.componentName) : '';
      const expectedCodes = rows
        .filter((row) => row.componentName.toLowerCase().includes(term.toLowerCase()))
        .map((row) => row.componentCode)
        .sort();
      if (!target) {
        await check(outcome,
          `Search Running Hours components in Vessel ${vessel}`,
          `Vessel ${vessel} should list at least one Running Hours component whose name can be searched.`,
          async () => ({ passed: false, actual: `Vessel ${vessel} listed no Running Hours components, so no component name was available to search.` }));
        continue;
      }
      await check(outcome,
        `Search Running Hours for "${term}" in Vessel ${vessel}`,
        `Searching "${term}" should list exactly the ${expectedCodes.length} component(s) of Vessel ${vessel} whose name contains it (${expectedCodes.join(', ')}), including ${target.componentCode} (${clean(target.componentName)}).`,
        async () => {
          const result = await runningHours.searchComponents(term);
          const codes = result.rows.map((row) => row.componentCode).sort();
          const unexpected = codes.filter((code) => !expectedCodes.includes(code));
          const missing = expectedCodes.filter((code) => !codes.includes(code));
          return {
            passed: !unexpected.length && !missing.length && result.shown === expectedCodes.length && result.total === total,
            actual: `The footer showed "${result.text}" and the table listed ${codes.length} component(s): ${result.rows.map((row) => `${row.componentCode} (${clean(row.componentName)})`).join(', ') || 'none'}.`
              + `${missing.length ? ` Missing matches: ${missing.join(', ')}.` : ''}${unexpected.length ? ` Unexpected rows: ${unexpected.join(', ')}.` : ''}`,
          };
        }, 'always');

      await check(outcome,
        `Clear the Running Hours search in Vessel ${vessel}`,
        `Clearing the search should restore all ${total} Running Hours component(s) of Vessel ${vessel}.`,
        async () => {
          const count = await runningHours.clearComponentSearch();
          const restored = await runningHours.readAllRows();
          return {
            passed: count.shown === total && count.total === total && restored.length === total,
            actual: `After clearing the search the footer showed "${count.text}" and the table displayed ${restored.length} component row(s).`,
          };
        });
    }

    await finish(outcome,
      'Verify all Running Hours vessel and search checks',
      `The default vessel, table loading for ${vesselCount} vessels, and the dynamic component searches should all match the application data.`,
      `All ${outcome.checks} RH-P01 checks passed: default Vessel ${defaultVessel} was valid and loaded, and ${vessels.map((name) => `Vessel ${name}`).join(', ')} each loaded and filtered correctly by component name.`);
  });

  if (!rhUpdateCasesOnly) test('RH-P02 - Running Hours values match Components Section C across vessels and components', componentScenario(
    `For ${componentsPerVessel} components in each of ${vesselCount} vessels, the component found by searching Running Hours should open in Components for the same vessel, and its numeric Running Hours value under ${sectionC} should match the Running Hours table. Last Updated dates are outside this comparison.`,
  ), async () => {
    test.setTimeout(45 * 60_000);
    const outcome = newOutcome();
    const compared: string[] = [];

    let runningHours = await act(outcome,
      'Open PMS → Running Hours',
      'The Running Hours page should open from the PMS menu in the existing authenticated session.',
      openRunningHours,
      () => 'The Running Hours page opened from the PMS menu without another login.');
    const vessels = runningHours ? await resolveVessels(outcome, runningHours) : [];
    if (!runningHours) {
      await componentNotExecutedStep('Compare Running Hours with Components Section C', `Running Hours values should match ${sectionC}.`, 'Running Hours did not open, so no component could be compared.');
    }

    for (const vessel of vessels) {
      if (!runningHours) break;
      // The previous vessel's last comparison ends on Components; choose this
      // vessel's components from Running Hours, not from the Components selector.
      if (!page.url().includes(routes.runningHours)) {
        runningHours = await act(outcome,
          `Open PMS → Running Hours to choose components for Vessel ${vessel}`,
          'The Running Hours page should open from the PMS menu.',
          openRunningHours,
          () => 'The Running Hours page opened from the PMS menu.') ?? runningHours;
      }
      if (!(await ensureRunningHoursVessel(outcome, runningHours, vessel, ' to choose components'))) {
        await componentNotExecutedStep(`Compare ${componentsPerVessel} components in Vessel ${vessel}`, `${componentsPerVessel} components of Vessel ${vessel} should match ${sectionC}.`, `Vessel ${vessel} could not be selected, so its components were not compared.`);
        continue;
      }
      let picked: RunningHoursGridRow[] = [];
      await check(outcome,
        `Choose ${componentsPerVessel} components from the Running Hours table for Vessel ${vessel}`,
        `Vessel ${vessel} should list at least ${componentsPerVessel} different Running Hours components to compare.`,
        async () => {
          await runningHours!.clearComponentSearch();
          const rows = await runningHours!.readAllRows();
          picked = spreadPick(rows.filter((row) => row.componentCode && row.componentName), componentsPerVessel);
          return {
            passed: picked.length === componentsPerVessel,
            actual: `Vessel ${vessel} listed ${rows.length} Running Hours component(s); selected ${picked.map((row) => `${row.componentCode} (${clean(row.componentName)})`).join(', ') || 'none'}.`,
          };
        });

      for (const target of picked) {
        const code = target.componentCode;
        const name = clean(target.componentName);
        const label = `${code} in Vessel ${vessel}`;

        // Each comparison starts from Running Hours, as a user would.
        runningHours = await act(outcome,
          `Open PMS → Running Hours for ${label}`,
          `The Running Hours page should open with Vessel ${vessel} still selected.`,
          async () => {
            const opened = await openRunningHours();
            if (await opened.selectedVesselName() !== vessel) await opened.selectVesselAndWaitForData(vessel);
            return opened;
          },
          () => `The Running Hours page opened with Vessel ${vessel} selected.`) ?? runningHours;

        const rhRow = await act(outcome,
          `Search Running Hours for ${label}`,
          `Searching "${name}" in Vessel ${vessel} should list Component ${code}.`,
          async () => {
            const result = await runningHours!.searchComponents(name);
            const row = result.rows.find((item) => item.componentCode === code);
            if (!row) throw new Error(`Component ${code} (${name}) was not listed by the Running Hours search for "${name}" in Vessel ${vessel}`);
            return { row, text: result.text };
          },
          ({ row, text }) => `The search showed "${text}" and listed ${row.componentCode} (${clean(row.componentName)}) with Running Hours "${shown(row.runningHours)}", Last Updated "${shown(row.lastUpdated)}" and Inherited RH "${shown(row.inheritedRh)}".`);
        const remaining = [
          'Open Components', 'Verify the Components vessel', 'Search and expand the Components tree', 'Verify the component identity', `Compare ${sectionC}`,
        ];
        if (!rhRow) {
          for (const item of remaining) await componentNotExecutedStep(`${item} for ${label}`, `${item} for Component ${code}.`, `The Running Hours search for ${code} failed, so this comparison could not continue.`);
          continue;
        }

        const opened = await act(outcome,
          `Open PMS → Components for ${label}`,
          'The Components page should open from the PMS menu in the same session.',
          async () => {
            const technical = new TechnicalPage(page);
            const componentsPage = await technical.goToComponents();
            await componentsPage.expectTreeLoaded();
            return componentsPage.currentVesselName();
          },
          (componentsVessel) => `The Components page opened from the PMS menu and showed Vessel ${componentsVessel}.`);
        if (opened === undefined) {
          for (const item of remaining.slice(1)) await componentNotExecutedStep(`${item} for ${label}`, `${item} for Component ${code}.`, 'The Components page did not open, so this comparison could not continue.');
          continue;
        }

        const sameVessel = await check(outcome,
          `Verify Components shows the same Vessel ${vessel} for ${code}`,
          `After leaving Running Hours on Vessel ${vessel}, Components should show the same Vessel ${vessel}.`,
          async () => ({
            passed: opened === vessel,
            actual: `Running Hours used Vessel ${vessel}; Components showed Vessel ${opened}.`,
          }));
        if (!sameVessel) {
          // The vessel mismatch is already a failure; select the vessel so the
          // remaining comparisons for this component can still be observed.
          const switched = await act(outcome,
            `Select Vessel ${vessel} in Components for ${code}`,
            `Components should switch to Vessel ${vessel} so Component ${code} can be compared.`,
            () => components.selectVessel(vessel),
            () => `Vessel ${vessel} was selected in Components and its component tree loaded.`);
          if (switched === undefined) {
            for (const item of remaining.slice(2)) await componentNotExecutedStep(`${item} for ${label}`, `${item} for Component ${code}.`, `Components could not show Vessel ${vessel}, so this comparison could not continue.`);
            continue;
          }
        }

        const identity = await act(outcome,
          `Search and expand the Components tree for ${label}`,
          `Searching the Components tree for ${code} should expand its parent hierarchy and open Component ${code}.`,
          () => components.searchAndSelectComponentByCode(code),
          (selected) => `The tree search for ${code} expanded to and opened Component ${selected.code} (${selected.name}) in Vessel ${selected.vesselName}.`);
        if (!identity) {
          for (const item of remaining.slice(3)) await componentNotExecutedStep(`${item} for ${label}`, `${item} for Component ${code}.`, `Component ${code} could not be opened in Components, so this comparison could not continue.`);
          continue;
        }

        await check(outcome,
          `Verify the component identity for ${label}`,
          `Components should show Component Code ${code}, Component Name "${name}" and Vessel ${vessel}, as listed in Running Hours.`,
          async () => ({
            passed: identity.code === code && clean(identity.name) === name && identity.vesselName === vessel,
            actual: `Components showed Component Code ${identity.code}, Component Name "${identity.name}" and Vessel ${identity.vesselName}; Running Hours listed ${code} "${name}" in Vessel ${vessel}.`,
          }));

        await check(outcome,
          `Compare ${sectionC} for ${label}`,
          `Under ${sectionC}, Component ${code} should show the same numeric Running Hours value (${shown(rhRow.row.runningHours)}) as the Running Hours table.`,
          async () => {
            await page.getByTestId('component-running-hours-grid').scrollIntoViewIfNeeded();
            const read = (field: string) => components.readSelectedComponentDetail({ section: sectionC, label: field });
            const details: SectionC = {
              counterType: await read('RH Counter Type'),
              counterSource: await read('RH Counter Source'),
              runningHours: await read('Running Hours'),
            };
            const listed = hours(rhRow.row.runningHours);
            const detail = hours(details.runningHours);
            const hoursMatch = listed === detail;
            compared.push(`${code} (${vessel})`);
            return {
              passed: hoursMatch,
              actual: `${sectionC} showed numeric Running Hours ${detail ?? '<blank>'} from displayed value "${shown(details.runningHours)}"; `
                + `the Running Hours table showed numeric Running Hours ${listed ?? '<blank>'} from displayed value "${shown(rhRow.row.runningHours)}" (${hoursMatch ? 'matches' : 'does NOT match'}). `
                + `RH Counter Type "${shown(details.counterType)}", RH Counter Source "${shown(details.counterSource)}".`,
            };
          }, 'always');
      }
    }

    await finish(outcome,
      'Verify all Running Hours and Section C comparisons',
      `Every compared component should have the same vessel, identity and numeric Running Hours value in Running Hours and Components; Last Updated dates are not compared.`,
      `All ${outcome.checks} RH-P02 checks passed; ${compared.length} component(s) had matching numeric Running Hours values between Running Hours and ${sectionC}: ${compared.join(', ')}.`);
  });

  const today = (): string => {
    const value = new Date();
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  };
  const daysAfter = (date: string, days: number): string => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };

  /** Searches each authorized vessel and each inherited-indicator row once, in displayed order. */
  const locateDynamicPair = async (outcome: Outcome, action: 'Set Total' | 'Add Delta'): Promise<DynamicRhPair | undefined> => {
    let runningHours = await openRunningHours();
    const offered = await runningHours.vesselOptions();
    const authorized = config.runningHoursVessels.filter((vessel) => offered.includes(vessel));
    const latestSafeDate = today();

    for (const vessel of authorized) {
      if (!(await ensureRunningHoursVessel(outcome, runningHours, vessel, ` while searching for an eligible ${action} candidate`))) continue;
      await runningHours.clearComponentSearch();
      const candidates = (await runningHours.readAllRows()).filter((row) => inheritedCount(row.inheritedRh) > 0);
      await act(outcome,
        `Inspect Inherited RH candidates in Vessel ${vessel}`,
        `Vessel ${vessel} should be checked once for rows with a nonempty Inherited RH indicator.`,
        async () => candidates.length,
        (count) => `Vessel ${vessel} contained ${count} row(s) with a nonempty Inherited RH indicator; the indicator was treated as relationship metadata, not as a Running Hours value.`);

      for (const candidate of candidates) {
        let rejection = '';
        let inheritedDetails: { indicator: string; details: string } | undefined;
        const masterHours = hours(candidate.runningHours);
        const masterDate = dateOnly(candidate.lastUpdated);
        if (masterHours === undefined) rejection = `MASTER Running Hours "${shown(candidate.runningHours)}" was not numeric.`;
        else if (!masterDate) rejection = `Last Updated "${shown(candidate.lastUpdated)}" was not a usable date.`;
        const updateDate = masterDate ? daysAfter(masterDate, 1) : '';
        if (!rejection && updateDate > latestSafeDate) rejection = `Last Updated ${masterDate} leaves no valid update date: ${updateDate} must be no later than ${latestSafeDate}.`;

        if (!rejection) {
          try {
            inheritedDetails = await runningHours.inspectInheritedDetails(candidate);
            if (!inheritedDetails.details) rejection = 'The clickable Inherited RH indicator opened without relationship information.';
          } catch (error) {
            rejection = observedFailure(error);
          }
        }

        if (!rejection) {
          const availability = await runningHours.inspectUpdateAvailability(candidate, action);
          if (!availability.available) rejection = availability.reason;
        }

        await act(outcome,
          `${rejection ? 'Skip' : 'Select'} candidate ${candidate.componentCode} (${candidate.componentName}) in Vessel ${vessel}`,
          `The candidate should be a numeric MASTER with a confirmed INHERITED child, a safe date and available ${action} controls.`,
          async () => rejection,
          (reason) => reason
            ? `Candidate ${candidate.componentCode} was rejected: ${reason}`
            : `Selected ${candidate.componentCode} (${candidate.componentName}) at ${masterHours} RH; clickable Inherited RH indicator "${inheritedDetails!.indicator}" opened relationship information, and ${action} is available.`);
        if (!rejection && inheritedDetails && masterHours !== undefined) {
          return {
            vessel, master: candidate,
            masterHours, masterLastUpdated: candidate.lastUpdated,
            inheritedIndicator: inheritedDetails.indicator,
            inheritedDetails: inheritedDetails.details,
            updateDate,
          };
        }
      }
      runningHours = await openRunningHours();
    }
    return undefined;
  };

  const runRhUpdate = async (id: 'RH-P03' | 'RH-P04', action: 'Set Total' | 'Add Delta') => {
    const outcome = newOutcome();
    const pair = await locateDynamicPair(outcome, action);
    if (!pair) {
      test.skip(true, `All authorized test vessels (${config.runningHoursVessels.join(', ')}) were checked, but none exposed an eligible writable MASTER with a confirmed linked INHERITED component for ${action}.`);
      return;
    }
    const targetMaster = pair.masterHours + 20;
    let runningHours = await openRunningHours();
    await ensureRunningHoursVessel(outcome, runningHours, pair.vessel, ` to execute ${id}`);
    await runningHours.clearComponentSearch();
    const beforeMaster = (await runningHours.readAllRows()).find((row) => row.componentCode === pair.master.componentCode);
    const beforeInherited = beforeMaster ? await runningHours.inspectInheritedDetails(beforeMaster) : undefined;
    const baselineVerified = await check(outcome,
      `Verify dynamic Running Hours and inherited baseline for ${id}`,
      `The independently selected row should still show ${pair.masterHours} RH with its clickable Inherited RH information available.`,
      async () => ({
        passed: hours(beforeMaster?.runningHours ?? '') === pair.masterHours
          && Boolean(beforeInherited?.details),
        actual: `Vessel ${pair.vessel}: ${pair.master.componentCode} showed ${shown(beforeMaster?.runningHours ?? '')}; Inherited RH indicator "${shown(beforeInherited?.indicator ?? '')}" opened relationship information in Running Hours.`,
      }), 'always');
    if (!baselineVerified || !beforeMaster) {
      await componentNotExecutedStep(`Update ${pair.master.componentCode} with ${action}`, `The update should start only from the independently verified dynamic baseline.`, 'The captured baseline changed before Save, so no mutation was attempted.');
      await finish(outcome, `Verify ${id} ${action}`, 'The dynamic Running Hours value and inherited information should persist after refresh.', '');
      return;
    }

    runningHours = await openRunningHours();
    await ensureRunningHoursVessel(outcome, runningHours, pair.vessel, ` to submit ${action}`);
    await runningHours.clearComponentSearch();
    const row = (await runningHours.readAllRows()).find((item) => item.componentCode === pair.master.componentCode)!;
    const controls = await act(outcome,
      `Open Settings for dynamic MASTER ${pair.master.componentCode}`,
      `The Settings action should open for the selected writable MASTER.`,
      () => runningHours.openUpdateControls(row),
      ({ tooltip }) => `The Settings tooltip displayed "${tooltip}" and the controls opened.`, true);
    if (!controls) {
      await componentNotExecutedStep(`Submit ${action}`, `${action} should update the MASTER.`, 'Settings became unavailable after selection, so no mutation was attempted.');
      await finish(outcome, `Verify ${id} ${action}`, 'The dynamic Running Hours value and inherited information should persist after refresh.', '');
      return;
    }
    const input = action === 'Set Total' ? targetMaster : 20;
    const update = await act(outcome,
      `Select ${action}, enter ${input} RH dated ${pair.updateDate} and save`,
      `${action} should increase MASTER ${pair.master.componentCode} from ${pair.masterHours} RH to ${targetMaster} RH.`,
      () => runningHours.submitUpdate(action, input, pair.updateDate),
      ({ feedback }) => `The application responded: "${feedback}".`, true);
    if (!update) {
      runningHours = await openRunningHours();
      await ensureRunningHoursVessel(outcome, runningHours, pair.vessel, ' to verify the uncertain Save outcome');
      await runningHours.refreshAndRestoreVessel(pair.vessel);
      const observed = (await runningHours.readAllRows()).find((item) => item.componentCode === pair.master.componentCode);
      await componentNotExecutedStep('Continue with later mutations', 'No further mutation should occur until the uncertain Save state is verified.', `After refresh, MASTER ${pair.master.componentCode} showed ${shown(observed?.runningHours ?? '')}; the scenario stopped without switching candidates. No restoration was attempted because the UI does not support lowering Running Hours.`);
      await finish(outcome, `Verify ${id} ${action}`, 'The Save result should be known before any later mutation.', '');
      return;
    }

    runningHours = await openRunningHours();
    await ensureRunningHoursVessel(outcome, runningHours, pair.vessel, ' before mandatory refresh');
    await runningHours.refreshAndRestoreVessel(pair.vessel);
    const refreshedMaster = (await runningHours.readAllRows()).find((item) => item.componentCode === pair.master.componentCode);
    const refreshedInherited = refreshedMaster ? await runningHours.inspectInheritedDetails(refreshedMaster) : undefined;
    await attachRunningHoursComparison(`${id} Before-and-After Comparison`, [
      { field: 'Vessel', initial: pair.vessel, entered: '—', final: pair.vessel },
      { field: 'Component', initial: `${pair.master.componentName} (${pair.master.componentCode})`, entered: '—', final: refreshedMaster ? `${refreshedMaster.componentName} (${refreshedMaster.componentCode})` : '<not found>' },
      { field: 'MASTER RH', initial: String(pair.masterHours), entered: action === 'Set Total' ? String(targetMaster) : `Add Delta ${input}`, final: refreshedMaster?.runningHours ?? '<not found>' },
      { field: 'Inherited RH', initial: pair.inheritedIndicator, entered: '—', final: refreshedInherited?.indicator ?? '<not available>' },
      { field: 'Reading date', initial: pair.masterLastUpdated || '<not displayed>', entered: pair.updateDate, final: refreshedMaster?.lastUpdated || '<not displayed>' },
      { field: 'Update mode', initial: '—', entered: action, final: action },
    ]);
    await check(outcome,
      `Refresh and verify dynamic Running Hours and inherited information for ${id}`,
      `After refresh, ${pair.master.componentCode} should show ${targetMaster} RH and its clickable Inherited RH information should remain available.`,
      async () => ({
        passed: hours(refreshedMaster?.runningHours ?? '') === targetMaster && Boolean(refreshedInherited?.details),
        actual: `After refresh and reselecting Vessel ${pair.vessel}, ${pair.master.componentCode} showed ${shown(refreshedMaster?.runningHours ?? '')}; Inherited RH indicator "${shown(refreshedInherited?.indicator ?? '')}" opened relationship information.`,
      }), 'always');

    await finish(outcome,
      `Verify ${id} ${action} and inherited information after refresh`,
      `${action} should increase the selected row by 20 RH after refresh and retain its inherited relationship information. No restoration should be attempted because the UI does not support lowering Running Hours.`,
      `${id} passed for Vessel ${pair.vessel}: ${pair.master.componentCode} changed from ${pair.masterHours} to ${targetMaster} RH and retained its Inherited RH information after refresh; no restoration was attempted.`);
  };

  test('RH-P03 - Set Total and validate inherited Running Hours', componentScenario(
    'Across authorized vessels, select the first eligible row with inherited data, Set Total from its runtime baseline M to M + 20, and verify the updated value and inherited information after refresh without attempting UI restoration.',
  ), async () => {
    test.setTimeout(45 * 60_000);
    await runRhUpdate('RH-P03', 'Set Total');
  });

  test('RH-P04 - Add Delta and validate inherited Running Hours', componentScenario(
    'Independently select an eligible row with inherited data, Add Delta 20 to its runtime baseline M, and verify the updated value and inherited information after refresh without attempting UI restoration.',
  ), async () => {
    test.setTimeout(45 * 60_000);
    await runRhUpdate('RH-P04', 'Add Delta');
  });

  type PositiveBoundaryCandidate = {
    vessel: string;
    row: RunningHoursGridRow;
    master: number;
    baselineDate: string;
    targetDate: string;
    inheritedIndicator: string;
    inheritedDetails: string;
    hasInherited: boolean;
    historyBefore: string;
    rate: number;
  };

  const findPositiveBoundaryCandidate = async (
    outcome: Outcome,
    id: 'RH-P05' | 'RH-P06' | 'RH-P07',
    days: number,
    requireExactRate: boolean,
  ): Promise<PositiveBoundaryCandidate | undefined> => {
    let runningHours = await openRunningHours();
    const offered = await runningHours.vesselOptions();
    const authorized = config.runningHoursVessels.filter((vessel) => offered.includes(vessel));
    for (const vessel of authorized) {
      await ensureRunningHoursVessel(outcome, runningHours, vessel, ` while selecting an independent ${id} baseline`);
      await runningHours.clearComponentSearch();
      const rows = (await runningHours.readAllRows()).sort((first, second) =>
        Number(inheritedCount(second.inheritedRh) > 0) - Number(inheritedCount(first.inheritedRh) > 0));
      for (const row of rows) {
        if (positiveBoundaryReservedCodes.has(row.componentCode)) continue;
        const master = hours(row.runningHours);
        const baselineDate = dateOnly(row.lastUpdated);
    if (master === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(baselineDate)) continue;
        const targetDate = addCalendarDays(baselineDate, days);
        if (targetDate > localToday()) continue;
        const availability = await runningHours.inspectUpdateAvailability(row, 'Set Total');
        if (!availability.available) continue;
        const hasInherited = inheritedCount(row.inheritedRh) > 0;
        const inherited = hasInherited
          ? await runningHours.inspectInheritedDetails(row).catch(() => undefined)
          : { indicator: 'Not applicable', details: 'The selected MASTER has no linked inherited RH.' };
        if (hasInherited && !inherited?.details) continue;
        const historyBefore = await runningHours.successfulUpdateHistorySignature(row.componentCode);
        positiveBoundaryReservedCodes.add(row.componentCode);
        await check(outcome,
          `${id} select independent MASTER baseline`,
          `An eligible MASTER with its own numeric RH, Last Updated date, and linked inherited information should be selected from an authorized vessel${requireExactRate ? "; the 25 RH/day limit will then be confirmed from the application's validation response" : ''}.`,
          async () => ({
            passed: true,
            actual: `Vessel ${vessel}; ${row.componentName} (${row.componentCode}); category ${row.componentCategory}; MASTER ${row.runningHours}; Last Updated ${row.lastUpdated}; inherited indicator ${inherited!.indicator}; table Update Rate ${row.rateLimit || '<not displayed>'}; successful history captured.`,
          }), 'always');
        return {
          vessel, row, master, baselineDate, targetDate,
          inheritedIndicator: inherited!.indicator,
          inheritedDetails: inherited!.details,
          hasInherited,
          historyBefore,
          rate: 0,
        };
      }
      runningHours = await openRunningHours();
    }
    return undefined;
  };

  const runBoundaryUpdate = async (id: 'RH-P05' | 'RH-P06', days: 1 | 2, increase: 25 | 50) => {
    const outcome = newOutcome();
    let runningHours = await openRunningHours();
    await check(outcome, `${id} verify RH Validation is enabled`, 'Running Hours rate validation should be ON before testing the configured boundary.',
      async () => {
        const state = await runningHours.rhValidationState();
        return { passed: state === 'ON', actual: `RH Validation displayed ${state}.` };
      }, 'always');
    const candidate = await findPositiveBoundaryCandidate(outcome, id, days, true);
    test.skip(!candidate, `BLOCKED — no independent MASTER in authorized vessels had numeric RH, a parseable Last Updated date at least ${days} day(s) before today, linked inherited information, and Set Total access.`);
    const selected = candidate!;
    const entered = selected.master + increase;
    await check(outcome, `${id} calculate exact rate-limit boundary`, `The input should be calculated only from the selected row as M + ${increase} on D + ${days} calendar day(s).`,
      async () => ({ passed: selected.targetDate <= localToday(), actual: `M=${selected.master}; D=${selected.baselineDate}; entered MASTER=${entered}; entered date=${selected.targetDate}; future date: ${selected.targetDate > localToday() ? 'yes' : 'no'}. The configured 25 RH/day limit will be confirmed from the application's validation response before the valid Save.` }), 'always');

    runningHours = await openRunningHours();
    await ensureRunningHoursVessel(outcome, runningHours, selected.vessel, ` to execute ${id}`);
    await runningHours.clearComponentSearch();
    const current = (await runningHours.readAllRows()).find((row) => row.componentCode === selected.row.componentCode);
    if (!current || hours(current.runningHours) !== selected.master || dateOnly(current.lastUpdated) !== selected.baselineDate) {
      await componentNotExecutedStep(`${id} Save`, 'The update should use the freshly captured M and D from the same row.', 'The selected baseline changed before the popup opened, so no Save was attempted.');
      await finish(outcome, `${id} final result`, 'The exact configured boundary should be tested only from a stable runtime baseline.', '');
      return;
    }
    const rejected = await act(outcome, `${id} confirm configured 25 RH/day limit`, `The application should reject M + ${increase + 1} on D + ${days} and state that the maximum is ${increase} hours at 25 hours/day; this validation must not save data.`,
      () => runningHours.attemptRejectedUpdate(current, 'Set Total', String(entered + 1), selected.targetDate, {
        expectedApplicationValidation: new RegExp(`Increase of ${increase + 1} hours exceeds maximum allowed of ${increase} hours[\\s\\S]*25 hours/day`, 'i'),
        beforeSave: async (state) => componentObservedCheck(page, `${id} rate-limit confirmation values before Save`, `The popup should show the one-hour-over-boundary reading and calculated date before the validation attempt.`, {
          passed: state.actualFieldValue === String(entered + 1) && state.selectedDate === selected.targetDate,
          actual: `Old value ${state.oldValue}; entered ${state.actualFieldValue}; date ${state.selectedDate}; Save enabled: ${state.saveEnabled ? 'yes' : 'no'}; Save not yet clicked.`,
        }, { screenshot: 'always' }),
      }),
      (result) => `Save enabled/clicked: ${result.saveEnabled ? 'yes' : 'no'}/${result.saveClicked ? 'yes' : 'no'}; application validation: "${result.applicationValidation || '<none>'}".`, true);
    const limitConfirmed = Boolean(rejected?.applicationValidation
      && new RegExp(`maximum allowed of ${increase} hours[\\s\\S]*25 hours/day`, 'i').test(rejected.applicationValidation));
    await check(outcome, `${id} verify rate-limit confirmation`, `The visible application validation should confirm a ${increase}-hour maximum for ${days} day(s), calculated at 25 hours/day.`,
      async () => ({ passed: limitConfirmed, actual: `Observed validation: "${rejected?.applicationValidation || '<none>'}".` }), 'always');
    if (!limitConfirmed) {
      await finish(outcome, `${id} final result`, `The valid boundary Save should run only after the application confirms its configured 25 RH/day limit.`, 'The application did not provide evidence confirming the required 25 RH/day boundary, so the valid Save was not attempted.');
      return;
    }

    await runningHours.refreshAndRestoreVessel(selected.vessel);
    const stable = (await runningHours.readAllRows()).find((row) => row.componentCode === selected.row.componentCode);
    await check(outcome, `${id} verify baseline unchanged after rate confirmation`, `The rejected confirmation attempt should leave M and D unchanged before the valid boundary Save.`, async () => ({
      passed: hours(stable?.runningHours ?? '') === selected.master && dateOnly(stable?.lastUpdated ?? '') === selected.baselineDate,
      actual: `MASTER before/after confirmation ${selected.master}/${stable?.runningHours ?? '<not found>'}; Last Updated before/after ${selected.row.lastUpdated}/${stable?.lastUpdated ?? '<not found>'}.`,
    }), 'always');
    if (!stable || hours(stable.runningHours) !== selected.master || dateOnly(stable.lastUpdated) !== selected.baselineDate) {
      await componentNotExecutedStep(`${id} valid boundary Save`, 'The valid boundary should use the same unchanged baseline after the rejected confirmation attempt.', 'The baseline changed, so no potentially unsafe write was attempted.');
      await finish(outcome, `${id} final result`, `The exact ${increase} RH boundary should be saved only from a stable baseline.`, 'The baseline changed after rate confirmation; the valid Save was not attempted.');
      return;
    }
    selected.rate = 25;
    await act(outcome, `${id} open Update RH popup`, 'The selected row should open its Update RH popup from Running Hours Overview.',
      () => runningHours.openUpdateControls(stable), ({ tooltip }) => `The ${tooltip} popup opened for ${stable.componentName} (${stable.componentCode}).`, true);
    const save = await act(outcome, `${id} enter boundary reading and click Save once`, `Set Total ${entered} dated ${selected.targetDate} should be accepted at exactly ${selected.rate} RH/day.`,
      () => runningHours.submitUpdate('Set Total', entered, selected.targetDate, { beforeSave: async (state) => {
        await componentObservedCheck(page, `${id} values immediately before Save`, 'The popup should show Set Total, the calculated reading, and calculated calendar date before one Save.', {
          passed: state.enteredValue === String(entered) && state.selectedDate === selected.targetDate,
          actual: `Old value ${state.oldValue}; mode ${state.updateMode}; entered ${state.enteredValue}; date ${state.selectedDate}; Save not yet clicked.`,
        }, { screenshot: 'always' });
      } }),
      (result) => `Save enabled/clicked: ${result.saveEnabled ? 'yes' : 'no'}/${result.saveClicked ? 'yes' : 'no'}; dialog closed: ${result.dialogClosed ? 'yes' : 'no'}; response: "${result.feedback}"; HTTP status: ${result.responseStatus ?? '<not captured>'}; request completed: ${result.requestCompleted ? 'yes' : 'no'}.`, true);
    if (!save) {
      await finish(outcome, `${id} final result`, `The system should accept the exact ${increase} RH over ${days} day boundary and persist it.`, '');
      return;
    }

    await runningHours.refreshAndRestoreVessel(selected.vessel);
    const finalRow = (await runningHours.readAllRows()).find((row) => row.componentCode === selected.row.componentCode);
    const inheritedAfter = finalRow && selected.hasInherited
      ? await runningHours.inspectInheritedDetails(finalRow)
      : finalRow ? { indicator: 'Not applicable', details: 'The selected MASTER has no linked inherited RH.' } : undefined;
    const historyAfter = await runningHours.successfulUpdateHistorySignature(selected.row.componentCode);
    await attachRunningHoursComparison(`${id} Before-and-After Comparison`, [
      { field: 'Vessel', initial: selected.vessel, entered: '—', final: selected.vessel },
      { field: 'Component', initial: `${selected.row.componentName} (${selected.row.componentCode})`, entered: '—', final: finalRow ? `${finalRow.componentName} (${finalRow.componentCode})` : '<not found>' },
      { field: 'MASTER RH', initial: String(selected.master), entered: String(entered), final: finalRow?.runningHours ?? '<not found>' },
      { field: 'Inherited RH', initial: selected.inheritedIndicator, entered: '—', final: inheritedAfter?.indicator ?? '<not available>' },
      { field: 'Last Updated', initial: selected.row.lastUpdated, entered: selected.targetDate, final: finalRow?.lastUpdated ?? '<not found>' },
      { field: 'Update Mode', initial: '—', entered: 'Set Total', final: 'Set Total' },
      { field: 'History', initial: selected.historyBefore || '<empty>', entered: '—', final: historyAfter || '<empty>' },
    ]);
    await check(outcome, `${id} verify persisted boundary update`, `After refresh, MASTER should be ${entered}, Last Updated should be ${selected.targetDate}, inherited relationship information should remain valid, and successful history should record the update.`,
      async () => ({
        passed: hours(finalRow?.runningHours ?? '') === entered
          && dateOnly(finalRow?.lastUpdated ?? '') === selected.targetDate
          && Boolean(inheritedAfter?.details)
          && historyAfter !== selected.historyBefore,
        actual: `After refresh, MASTER ${finalRow?.runningHours ?? '<not found>'}; Last Updated ${finalRow?.lastUpdated ?? '<not found>'}; inherited indicator ${inheritedAfter?.indicator ?? '<not available>'}; inherited relationship available: ${inheritedAfter?.details ? 'yes' : 'no'}; successful history changed: ${historyAfter !== selected.historyBefore ? 'yes' : 'no'}.`,
      }), 'always');
    await finish(outcome, `${id} compare expected and actual boundary result`,
      `The application should accept exactly ${increase} RH over ${days} calendar day(s) at 25 RH/day and persist the calculated reading/date without corrupting inherited information.`,
      `${id} used Vessel ${selected.vessel}, ${selected.row.componentName} (${selected.row.componentCode}), from ${selected.master} RH dated ${selected.baselineDate} to ${entered} RH dated ${selected.targetDate}. The application response was "${save.feedback}"; final MASTER was ${finalRow?.runningHours ?? '<not found>'}, final Last Updated was ${finalRow?.lastUpdated ?? '<not found>'}, and successful history changed: ${historyAfter !== selected.historyBefore ? 'yes' : 'no'}.`);
  };

  test('RH-P05 - Exact Daily Running Hours Limit', componentScenario(
    'The system should accept an increase of exactly 25 Running Hours over one calendar day when the selected component displays a 25 RH/day limit.',
  ), async () => {
    test.setTimeout(30 * 60_000);
    await runBoundaryUpdate('RH-P05', 1, 25);
  });

  test('RH-P06 - Multiple-Day Running Hours Limit', componentScenario(
    'The system should accept an increase of exactly 50 Running Hours over two calendar days when the selected component displays a 25 RH/day limit.',
  ), async () => {
    test.setTimeout(30 * 60_000);
    await runBoundaryUpdate('RH-P06', 2, 50);
  });

  test('RH-P07 - Equal Running Hours Reading', componentScenario(
    'Submitting the current Running Hours reading should not create any additional effective Running Hours increase.',
  ), async () => {
    test.setTimeout(30 * 60_000);
    const outcome = newOutcome();
    const selected = await findPositiveBoundaryCandidate(outcome, 'RH-P07', 0, false);
    test.skip(!selected, 'BLOCKED — no independent MASTER in the authorized vessels had numeric RH, a parseable Last Updated date, linked inherited information, and Set Total access.');
    const candidate = selected!;
    let runningHours = await openRunningHours();
    await ensureRunningHoursVessel(outcome, runningHours, candidate.vessel, ' to execute RH-P07');
    await runningHours.clearComponentSearch();
    const current = (await runningHours.readAllRows()).find((row) => row.componentCode === candidate.row.componentCode);
    if (!current || hours(current.runningHours) !== candidate.master || dateOnly(current.lastUpdated) !== candidate.baselineDate) {
      await componentNotExecutedStep('RH-P07 identical reading submission', 'The identical reading should use the freshly captured M and D from the same row.', 'The selected baseline changed before the popup opened, so no submission was attempted.');
      await finish(outcome, 'RH-P07 final result', 'The no-op behavior should be tested only from a stable baseline.', '');
      return;
    }
    const attempt = await act(outcome, 'RH-P07 enter equal Set Total reading', 'The popup should use Set Total M on the same baseline date D and either safely prevent or accept one no-op submission.',
      () => runningHours.attemptRejectedUpdate(current, 'Set Total', String(candidate.master), candidate.baselineDate, {
        beforeSave: async (state) => componentObservedCheck(page, 'RH-P07 values immediately before the no-op action', 'The popup should show the unchanged MASTER and baseline date before Save is assessed.', {
          passed: state.actualFieldValue === String(candidate.master) && state.selectedDate === candidate.baselineDate,
          actual: `Old value ${state.oldValue}; entered ${state.actualFieldValue}; date ${state.selectedDate}; Save enabled: ${state.saveEnabled ? 'yes' : 'no'}; Save not yet clicked.`,
        }, { screenshot: 'always' }),
      }),
      (result) => `Save enabled/clicked: ${result.saveEnabled ? 'yes' : 'no'}/${result.saveClicked ? 'yes' : 'no'}; application response: "${result.applicationValidation || result.feedback || '<none>'}"; no-op behavior: ${result.saveClicked ? 'submitted once' : 'submission prevented'}.`, true);
    await runningHours.refreshAndRestoreVessel(candidate.vessel);
    const finalRow = (await runningHours.readAllRows()).find((row) => row.componentCode === candidate.row.componentCode);
    const inheritedAfter = finalRow && candidate.hasInherited
      ? await runningHours.inspectInheritedDetails(finalRow)
      : finalRow ? { indicator: 'Not applicable', details: 'The selected MASTER has no linked inherited RH.' } : undefined;
    const historyAfter = await runningHours.successfulUpdateHistorySignature(candidate.row.componentCode);
    await attachRunningHoursComparison('RH-P07 Before-and-After Comparison', [
      { field: 'Vessel', initial: candidate.vessel, entered: '—', final: candidate.vessel },
      { field: 'Component', initial: `${candidate.row.componentName} (${candidate.row.componentCode})`, entered: '—', final: finalRow ? `${finalRow.componentName} (${finalRow.componentCode})` : '<not found>' },
      { field: 'MASTER RH', initial: String(candidate.master), entered: String(candidate.master), final: finalRow?.runningHours ?? '<not found>' },
      { field: 'Inherited RH', initial: candidate.inheritedIndicator, entered: '—', final: inheritedAfter?.indicator ?? '<not available>' },
      { field: 'Last Updated', initial: candidate.row.lastUpdated, entered: candidate.baselineDate, final: finalRow?.lastUpdated ?? '<not found>' },
      { field: 'Update Mode', initial: '—', entered: 'Set Total', final: 'Set Total' },
      { field: 'History', initial: candidate.historyBefore || '<empty>', entered: '—', final: historyAfter || '<empty>' },
    ]);
    await check(outcome, 'RH-P07 verify no effective Running Hours change', 'MASTER and inherited RH should remain unchanged; any no-op history behavior should be documented without assuming it must change or remain unchanged.',
      async () => ({
        passed: hours(finalRow?.runningHours ?? '') === candidate.master
          && inheritedAfter?.indicator === candidate.inheritedIndicator,
        actual: `MASTER before/after ${candidate.master}/${finalRow?.runningHours ?? '<not found>'}; inherited indicator before/after ${candidate.inheritedIndicator}/${inheritedAfter?.indicator ?? '<not available>'}; Last Updated before/after ${candidate.row.lastUpdated}/${finalRow?.lastUpdated ?? '<not found>'}; successful history changed: ${historyAfter !== candidate.historyBefore ? 'yes' : 'no'}; response: "${attempt?.applicationValidation || attempt?.feedback || '<none>'}".`,
      }), 'always');
    await finish(outcome, 'RH-P07 compare expected and actual equal-reading result',
      'The identical Set Total should cause no effective MASTER or inherited RH change, whether Save is disabled or accepted as a no-op.',
      `RH-P07 used Vessel ${candidate.vessel}, ${candidate.row.componentName} (${candidate.row.componentCode}), and entered the unchanged ${candidate.master} RH dated ${candidate.baselineDate}. Save was ${attempt?.saveClicked ? 'clicked once' : 'not enabled or not clicked'}; final MASTER was ${finalRow?.runningHours ?? '<not found>'}; history changed: ${historyAfter !== candidate.historyBefore ? 'yes' : 'no'}.`);
  });

  type PropagationCandidate = {
    vessel: string;
    master: RunningHoursGridRow;
    child: RunningHoursInheritedChild;
    linkedCodes: Set<string>;
    unrelated: RunningHoursGridRow[];
    masterRh: number;
    childRh: number;
    updateDate: string;
    masterHistory: string;
    childHistory: string;
    unrelatedHistory: Map<string, string>;
  };

  const locatePropagationCandidate = async (outcome: Outcome, id: 'RH-P08' | 'RH-P09'): Promise<PropagationCandidate | undefined> => {
    let runningHours = await openRunningHours();
    const offered = await runningHours.vesselOptions();
    for (const vessel of config.runningHoursVessels.filter((name) => offered.includes(name))) {
      await ensureRunningHoursVessel(outcome, runningHours, vessel, ` while selecting ${id} inheritance data`);
      await runningHours.clearComponentSearch();
      const rows = await runningHours.readAllRows();
      for (const master of rows.filter((row) => inheritedCount(row.inheritedRh) > 0)) {
        const masterRh = hours(master.runningHours);
        const baselineDate = dateOnly(master.lastUpdated);
        const updateDate = baselineDate ? addCalendarDays(baselineDate, 1) : '';
        if (masterRh === undefined || !baselineDate || updateDate > localToday()) continue;
        const inherited = await runningHours.inspectInheritedDetails(master).catch(() => undefined);
        if (!inherited?.details) continue;
        const linked = inherited.children.filter((child) => child.rhCounterType.toUpperCase() === 'INHERITED');
        const child = linked.find((item) => hours(item.currentCumulativeRH) !== undefined);
        if (!child) continue;
        const linkedCodes = new Set(linked.map((item) => item.componentCode));
        const unrelated = rows.filter((row) => row.componentCode !== master.componentCode
          && !linkedCodes.has(row.componentCode)
          && hours(row.runningHours) !== undefined).slice(0, 3);
        if (id === 'RH-P09' && unrelated.length < 3) continue;
        if (!(await runningHours.inspectUpdateAvailability(master, 'Set Total')).available) continue;
        const masterHistory = await runningHours.successfulUpdateHistorySignature(master.componentCode);
        const childHistory = await runningHours.successfulUpdateHistorySignature(child.componentCode);
        const unrelatedHistory = new Map<string, string>();
        for (const row of unrelated) unrelatedHistory.set(row.componentCode, await runningHours.successfulUpdateHistorySignature(row.componentCode));
        await check(outcome, `${id} select MASTER, linked INHERITED and control components`,
          `The test should select a writable MASTER, one child explicitly listed in its inheritance details${id === 'RH-P09' ? ', and three rows not listed in that relationship' : ''}.`, async () => ({
            passed: true,
            actual: `Vessel ${vessel}; MASTER ${master.componentName} (${master.componentCode}) ${master.runningHours}; linked INHERITED ${child.name} (${child.componentCode}) ${child.currentCumulativeRH}; Last Updated ${master.lastUpdated}; unrelated: ${unrelated.map((row) => `${row.componentName} (${row.componentCode}) ${row.runningHours}`).join(', ') || 'not required'}.`,
          }), 'always');
        return { vessel, master, child, linkedCodes, unrelated, masterRh, childRh: hours(child.currentCumulativeRH)!, updateDate, masterHistory, childHistory, unrelatedHistory };
      }
      runningHours = await openRunningHours();
    }
    return undefined;
  };

  const runPropagation = async (id: 'RH-P08' | 'RH-P09', delta: 20 | 10) => {
    const outcome = newOutcome();
    let runningHours = await openRunningHours();
    await check(outcome, `${id} verify RH Validation is enabled`, 'RH Validation should be ON before the propagation update.', async () => {
      const state = await runningHours.rhValidationState();
      return { passed: state === 'ON', actual: `RH Validation displayed ${state}.` };
    });
    const selected = await locatePropagationCandidate(outcome, id);
    test.skip(!selected, `BLOCKED — authorized vessels did not expose a safe writable MASTER with a resolvable linked INHERITED row${id === 'RH-P09' ? ' and three unrelated numeric rows' : ''}.`);
    const candidate = selected!;
    const targetMaster = candidate.masterRh + delta;
    const targetChild = candidate.childRh + delta;
    runningHours = await openRunningHours();
    await ensureRunningHoursVessel(outcome, runningHours, candidate.vessel, ` to execute ${id}`);
    await runningHours.clearComponentSearch();
    const freshRows = await runningHours.readAllRows();
    const masterBefore = freshRows.find((row) => row.componentCode === candidate.master.componentCode);
    const inheritedBefore = masterBefore ? await runningHours.inspectInheritedDetails(masterBefore) : undefined;
    const childBefore = inheritedBefore?.children.find((item) => item.componentCode === candidate.child.componentCode);
    const stable = hours(masterBefore?.runningHours ?? '') === candidate.masterRh
      && hours(childBefore?.currentCumulativeRH ?? '') === candidate.childRh
      && dateOnly(masterBefore?.lastUpdated ?? '') === dateOnly(candidate.master.lastUpdated);
    await check(outcome, `${id} verify fresh propagation baseline`, 'MASTER, linked INHERITED, and recorded controls should retain their captured pre-Save values.', async () => ({
      passed: stable,
      actual: `MASTER ${candidate.masterRh}/${masterBefore?.runningHours ?? '<not found>'}; INHERITED ${candidate.childRh}/${childBefore?.currentCumulativeRH ?? '<not found>'}; update date ${candidate.updateDate}.`,
    }));
    if (!stable || !masterBefore) {
      await componentNotExecutedStep(`${id} Save`, 'Save should occur only from the freshly verified baseline.', 'The baseline changed, so no write was attempted.');
      await finish(outcome, `${id} final result`, 'Propagation should be tested from a stable baseline.', '');
      return;
    }
    await act(outcome, `${id} open MASTER Update RH popup`, 'The selected MASTER row should open its Update RH controls.',
      () => runningHours.openUpdateControls(masterBefore), ({ tooltip }) => `${tooltip} opened for ${masterBefore.componentName} (${masterBefore.componentCode}).`, true);
    const saved = await act(outcome, `${id} enter Set Total and Save once`, `Set Total ${targetMaster} dated ${candidate.updateDate} should increase MASTER and its linked child by ${delta} RH.`,
      () => runningHours.submitUpdate('Set Total', targetMaster, candidate.updateDate, { beforeSave: async (state) => componentObservedCheck(page, `${id} values immediately before Save`, 'The popup should show the calculated Set Total and valid date before one Save.', {
        passed: state.enteredValue === String(targetMaster) && state.selectedDate === candidate.updateDate,
        actual: `Old value ${state.oldValue}; entered ${state.enteredValue}; date ${state.selectedDate}; Save not yet clicked.`,
      }, { screenshot: 'always' }) }),
      (result) => `Save enabled/clicked yes/yes; dialog closed ${result.dialogClosed ? 'yes' : 'no'}; response "${result.feedback}"; HTTP ${result.responseStatus ?? '<not captured>'}.`, true);
    if (!saved) {
      await finish(outcome, `${id} final result`, 'The Save outcome must be confirmed before persistence checks.', '');
      return;
    }
    await runningHours.refreshAndRestoreVessel(candidate.vessel);
    const finalRows = await runningHours.readAllRows();
    const masterAfter = finalRows.find((row) => row.componentCode === candidate.master.componentCode);
    const inheritedAfter = masterAfter ? await runningHours.inspectInheritedDetails(masterAfter) : undefined;
    const childAfter = inheritedAfter?.children.find((item) => item.componentCode === candidate.child.componentCode);
    const unrelatedAfter = candidate.unrelated.map((before) => ({ before, after: finalRows.find((row) => row.componentCode === before.componentCode) }));
    const masterHistoryAfter = await runningHours.successfulUpdateHistorySignature(candidate.master.componentCode);
    const childHistoryAfter = await runningHours.successfulUpdateHistorySignature(candidate.child.componentCode);
    const unrelatedHistoryAfter = new Map<string, string>();
    for (const row of candidate.unrelated) unrelatedHistoryAfter.set(row.componentCode, await runningHours.successfulUpdateHistorySignature(row.componentCode));
    await attachRunningHoursComparison(`${id} Before-and-After Comparison`, [
      { field: 'Vessel', initial: candidate.vessel, entered: '—', final: candidate.vessel },
      { field: 'MASTER', initial: `${candidate.master.componentName} (${candidate.master.componentCode}) ${candidate.masterRh}`, entered: String(targetMaster), final: masterAfter?.runningHours ?? '<not found>' },
      { field: 'INHERITED', initial: `${candidate.child.name} (${candidate.child.componentCode}) ${candidate.childRh}`, entered: `Expected ${targetChild}`, final: childAfter?.currentCumulativeRH ?? '<not found>' },
      ...unrelatedAfter.map(({ before, after }) => ({ field: `Unrelated ${before.componentCode}`, initial: `${before.runningHours}; ${before.lastUpdated}`, entered: 'No change', final: `${after?.runningHours ?? '<not found>'}; ${after?.lastUpdated ?? '<not found>'}` })),
      { field: 'MASTER history', initial: candidate.masterHistory || '<empty>', entered: 'Successful update expected', final: masterHistoryAfter || '<empty>' },
      { field: 'INHERITED history', initial: candidate.childHistory || '<empty>', entered: 'Propagation evidence', final: childHistoryAfter || '<empty>' },
    ]);
    await check(outcome, `${id} verify persisted MASTER and INHERITED propagation`, `MASTER should equal ${targetMaster}; linked INHERITED should equal ${targetChild}, receiving only the ${delta} RH delta.`, async () => ({
      passed: hours(masterAfter?.runningHours ?? '') === targetMaster && hours(childAfter?.currentCumulativeRH ?? '') === targetChild,
      actual: `After refresh MASTER ${masterAfter?.runningHours ?? '<not found>'}; linked INHERITED ${childAfter?.currentCumulativeRH ?? '<not found>'}; expected ${targetMaster} and ${targetChild}. MASTER history changed: ${masterHistoryAfter !== candidate.masterHistory ? 'yes' : 'no'}; child history changed: ${childHistoryAfter !== candidate.childHistory ? 'yes' : 'no'}.`,
    }));
    if (id === 'RH-P09') await check(outcome, 'RH-P09 verify unrelated components remain unchanged', 'All three unrelated rows should retain RH, Last Updated, and successful history.', async () => {
      const changed = unrelatedAfter.filter(({ before, after }) => hours(after?.runningHours ?? '') !== hours(before.runningHours)
        || after?.lastUpdated !== before.lastUpdated
        || unrelatedHistoryAfter.get(before.componentCode) !== candidate.unrelatedHistory.get(before.componentCode));
      return { passed: changed.length === 0, actual: unrelatedAfter.map(({ before, after }) => `${before.componentName} (${before.componentCode}): RH ${before.runningHours}/${after?.runningHours ?? '<not found>'}; date ${before.lastUpdated}/${after?.lastUpdated ?? '<not found>'}; history changed ${unrelatedHistoryAfter.get(before.componentCode) !== candidate.unrelatedHistory.get(before.componentCode) ? 'yes' : 'no'}`).join('; ') };
    });
    await finish(outcome, `${id} compare expected and actual propagation`,
      `The MASTER and linked INHERITED should each increase by ${delta} RH${id === 'RH-P09' ? ', while every unrelated control remains unchanged' : ''}.`,
      `${id} used Vessel ${candidate.vessel}; MASTER ${candidate.master.componentName} (${candidate.master.componentCode}) ${candidate.masterRh} → ${masterAfter?.runningHours ?? '<not found>'}; linked INHERITED ${candidate.child.name} (${candidate.child.componentCode}) ${candidate.childRh} → ${childAfter?.currentCumulativeRH ?? '<not found>'}; application response "${saved.feedback}"${id === 'RH-P09' ? `; unrelated controls verified: ${candidate.unrelated.map((row) => `${row.componentName} (${row.componentCode})`).join(', ')}` : ''}.`);
  };

  test('RH-P08 - Propagate MASTER Increase', componentScenario('Increasing a MASTER by 20 RH should increase its explicitly linked INHERITED component by exactly 20 RH and persist both values.'), async () => {
    test.setTimeout(45 * 60_000);
    await runPropagation('RH-P08', 20);
  });

  test('RH-P09 - Keep Unrelated Components Unchanged', componentScenario('Increasing a MASTER by 10 RH should propagate exactly 10 RH to its linked INHERITED component without changing three unrelated components, their dates, or histories.'), async () => {
    test.setTimeout(45 * 60_000);
    await runPropagation('RH-P09', 10);
  });

  test('RH-P16 - Rate Validation Disabled', componentScenario(
    'When RH Validation is deliberately disabled for an approved vessel, one otherwise-valid positive MASTER increase above the confirmed daily rate should be accepted, propagated to its linked INHERITED component, persisted in history, and RH Validation must then be restored to ON.',
  ), async () => {
    test.setTimeout(30 * 60_000);
    const outcome = newOutcome();
    let vessel = '';
    let master: RunningHoursGridRow | undefined;
    let child: RunningHoursInheritedChild | undefined;
    let masterRh = 0;
    let childRh = 0;
    let updateDate = '';
    let rate = 0;
    let entered = 0;
    let historyBefore = '';
    let saveResult = '';
    let masterAfter: RunningHoursGridRow | undefined;
    let childAfter: RunningHoursInheritedChild | undefined;
    let historyAfter = '';
    let originalState: 'ON' | 'OFF' | '<not read>' = '<not read>';
    let finalState: 'ON' | 'OFF' | '<not verified>' = '<not verified>';
    let restorationError: unknown;

    try {
      let runningHours = await openRunningHours();
      const offered = await runningHours.vesselOptions();
      candidateSearch:
      for (const candidateVessel of config.runningHoursVessels.filter((name) => offered.includes(name))) {
        await ensureRunningHoursVessel(outcome, runningHours, candidateVessel, ' while selecting RH-P16 data');
        await runningHours.clearComponentSearch();
        for (const row of await runningHours.readAllRows()) {
          const baseline = hours(row.runningHours);
          const baselineDate = dateOnly(row.lastUpdated);
          const nextDate = baselineDate ? addCalendarDays(baselineDate, 1) : '';
          if (baseline === undefined || !baselineDate || nextDate > localToday() || inheritedCount(row.inheritedRh) <= 0) continue;
          if (!(await runningHours.inspectUpdateAvailability(row, 'Set Total')).available) continue;
          const inherited = await runningHours.inspectInheritedDetails(row).catch(() => undefined);
          const linked = inherited?.children.find((item) => item.rhCounterType.toUpperCase() === 'INHERITED'
            && hours(item.currentCumulativeRH) !== undefined);
          if (!linked) continue;
          vessel = candidateVessel;
          master = row;
          child = linked;
          masterRh = baseline;
          childRh = hours(linked.currentCumulativeRH)!;
          updateDate = nextDate;
          break candidateSearch;
        }
        runningHours = await openRunningHours();
      }
      test.skip(!master || !child, 'BLOCKED — no writable MASTER with a linked INHERITED component and a valid one-day update interval was available in the authorized vessels.');

      await check(outcome, 'RH-P16 select vessel, MASTER and linked INHERITED component',
        'An authorized vessel should provide a writable MASTER, its explicitly linked INHERITED component, numeric baselines and a non-future date one day after Last Updated.', async () => ({
          passed: Boolean(vessel && master && child && updateDate),
          actual: `Vessel ${vessel}; MASTER ${master!.componentName} (${master!.componentCode}) ${masterRh} RH, Last Updated ${master!.lastUpdated}; linked INHERITED ${child!.name} (${child!.componentCode}) ${childRh} RH; planned date ${updateDate}; displayed table rate ${master!.rateLimit || '<not displayed>'}.`,
        }), 'always');

      historyBefore = await runningHours.successfulUpdateHistorySignature(master!.componentCode);
      // History navigation rebuilds the virtual grid; resolve the selected
      // component again by its stable code instead of reusing its old row index.
      runningHours = await openRunningHours();
      await ensureRunningHoursVessel(outcome, runningHours, vessel, ' before confirming the RH-P16 rate policy');
      const probeRow = (await runningHours.readAllRows()).find((row) => row.componentCode === master!.componentCode);
      if (!probeRow) {
        await componentNotExecutedStep('RH-P16 rate-policy probe', 'The selected component should remain available by code after History is closed.', `Component ${master!.componentCode} was not found, so no Save was attempted.`);
        outcome.failures.push('RH-P16 re-resolve selected component before rate-policy probe');
        await finish(outcome, 'RH-P16 final result', 'The selected component must remain available before any controlled write.', '');
        return;
      }
      const rateProbe = await runningHours.attemptRejectedUpdate(probeRow, 'Set Total', String(masterRh + 26), updateDate, {
        expectedApplicationValidation: /maximum allowed[\s\S]*hours\/day/i,
        beforeSave: async (state) => componentObservedCheck(page, 'RH-P16 confirm rate-policy probe before Save',
          'With RH Validation still ON, an otherwise-valid one-day increase above the configured rate should expose the application policy without changing data.', {
            passed: state.actualFieldValue === String(masterRh + 26) && state.selectedDate === updateDate,
            actual: `Vessel ${vessel}; MASTER ${master!.componentName} (${master!.componentCode}); Old Value ${state.oldValue}; probe value ${state.actualFieldValue}; date ${state.selectedDate}; RH Validation ON; Save clicked once to obtain the policy response.`,
          }, { screenshot: 'always' }),
      });
      const rateMatch = rateProbe.applicationValidation.match(/(?:×|x)\s*(\d+(?:\.\d+)?)\s*hours\/day/i)
        ?? rateProbe.applicationValidation.match(/maximum allowed of\s*(\d+(?:\.\d+)?)\s*hours/i);
      rate = rateMatch ? Number(rateMatch[1]) : 0;
      await check(outcome, 'RH-P16 read the applicable rate limit from the application',
        'The enabled policy should state its actual hourly limit in the visible validation response.', async () => ({
          passed: rate > 0,
          actual: `Application validation: "${rateProbe.applicationValidation || '<none>'}"; parsed configured rate: ${rate || '<not available>'} RH/day.`,
        }), 'always');
      // attemptRejectedUpdate deliberately preserves its popup for evidence.
      // Close it only after the visible policy response has been recorded so
      // its modal overlay cannot intercept the subsequent Admin navigation.
      const probeDialog = page.getByRole('dialog').filter({ visible: true }).last();
      if (await probeDialog.count()) {
        const cancel = probeDialog.getByRole('button', { name: /^(?:cancel|close)$/i }).filter({ visible: true }).first();
        if (await cancel.count()) await cancel.click();
        else await page.keyboard.press('Escape');
        await probeDialog.waitFor({ state: 'hidden' });
      }
      if (!rate) {
        await componentNotExecutedStep('RH-P16 disable validation and save above-rate update', 'The controlled update should run only after the application confirms its rate.', 'No configured rate could be read, so RH Validation was not changed and no update was submitted.');
        await finish(outcome, 'RH-P16 final result', 'The active rate must be confirmed before the controlled configuration change.', '');
        return;
      }
      entered = masterRh + Math.ceil(rate) + 5;

      const admin = await openAdminRhValidationSettings(vessel);
      originalState = await admin.adminRhValidationState(vessel);
      await check(outcome, 'RH-P16 verify RH Validation initially ON in Admin',
        'The selected vessel must start with persisted RH Validation ON before the controlled change.', async () => ({
          passed: originalState === 'ON', actual: `PMS Admin displayed RH Validation ${originalState} for Vessel ${vessel}.`,
        }), 'always');
      if (originalState !== 'ON') {
        await componentNotExecutedStep('RH-P16 update', 'The test requires an approved fixture that starts with validation ON.', `Vessel ${vessel} started with RH Validation ${originalState}; no update was attempted.`);
        await finish(outcome, 'RH-P16 final result', 'RH Validation must start ON.', '');
        return;
      }
      await componentActionStep('RH-P16 disable RH Validation in Admin',
        'The existing RH-N07 Admin workflow should persist and verify RH Validation OFF for the selected vessel.', async () => {
          await admin.setAdminRhValidationState(vessel, 'OFF');
          return admin.adminRhValidationState(vessel);
        }, (state) => `Vessel ${vessel} persisted RH Validation ${state}. Configuration transition: ON → ${state}.`, { page });

      runningHours = await openRunningHours();
      await ensureRunningHoursVessel(outcome, runningHours, vessel, ' after disabling RH Validation');
      const offState = await runningHours.rhValidationState();
      await check(outcome, 'RH-P16 verify Running Hours displays validation OFF',
        'Running Hours should display the selected vessel with RH Validation OFF before data entry.', async () => ({
          passed: offState === 'OFF', actual: `Running Hours displayed RH Validation ${offState} for Vessel ${vessel}.`,
        }), 'always');
      const fresh = (await runningHours.readAllRows()).find((row) => row.componentCode === master!.componentCode);
      const freshInherited = fresh ? await runningHours.inspectInheritedDetails(fresh) : undefined;
      const freshChild = freshInherited?.children.find((item) => item.componentCode === child!.componentCode);
      const stable = hours(fresh?.runningHours ?? '') === masterRh && hours(freshChild?.currentCumulativeRH ?? '') === childRh;
      await check(outcome, 'RH-P16 verify fresh baseline while validation is OFF',
        'The MASTER and linked INHERITED baselines must remain unchanged before the single above-rate Save.', async () => ({
          passed: stable,
          actual: `MASTER expected/observed ${masterRh}/${fresh?.runningHours ?? '<not found>'}; INHERITED expected/observed ${childRh}/${freshChild?.currentCumulativeRH ?? '<not found>'}; entered Set Total will be ${entered}, an increase of ${entered - masterRh} above the ${rate} RH/day limit.`,
        }), 'always');
      if (!stable || !fresh) {
        await componentNotExecutedStep('RH-P16 Save', 'Save should occur only from a stable, freshly verified baseline.', 'The baseline changed, so no write was attempted.');
        await finish(outcome, 'RH-P16 final result', 'The controlled Save requires a stable baseline.', '');
        return;
      }

      await runningHours.openUpdateControls(fresh);
      const responses: string[] = [];
      const failures: string[] = [];
      const consoleErrors: string[] = [];
      const responseListener = async (response: import('@playwright/test').Response) => {
        if (/\/technical\/api\/running-hours\//i.test(response.url()) && ['POST', 'PUT', 'PATCH'].includes(response.request().method())) {
          responses.push(`${response.request().method()} ${new URL(response.url()).pathname} HTTP ${response.status()}: ${(await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)}`);
        }
      };
      const failedListener = (request: import('@playwright/test').Request) => {
        if (/\/technical\/api\/running-hours\//i.test(request.url())) failures.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText || 'unknown network failure'}`);
      };
      const consoleListener = (message: import('@playwright/test').ConsoleMessage) => { if (message.type() === 'error') consoleErrors.push(message.text()); };
      page.on('response', responseListener);
      page.on('requestfailed', failedListener);
      page.on('console', consoleListener);
      try {
        const saved = await componentActionStep('RH-P16 enter above-rate Set Total and click Save once',
          `With RH Validation OFF, Set Total ${entered} dated ${updateDate} should accept the positive ${entered - masterRh} RH increase, which exceeds ${rate} RH/day.`,
          () => runningHours.submitUpdate('Set Total', entered, updateDate, {
            responseTimeoutMs: 120_000,
            beforeSave: async (state) => componentObservedCheck(page, 'RH-P16 above-rate values immediately before Save',
              'The popup should show the calculated above-rate Set Total and valid date while RH Validation is confirmed OFF.', {
                passed: state.enteredValue === String(entered) && state.selectedDate === updateDate,
                actual: `Vessel ${vessel}; MASTER ${master!.componentName} (${master!.componentCode}); linked INHERITED ${child!.name} (${child!.componentCode}); Old Value ${state.oldValue}; entered ${state.enteredValue}; date ${state.selectedDate}; increase ${entered - masterRh}; configured rate ${rate} RH/day; RH Validation OFF; Save not yet clicked.`,
              }, { screenshot: 'always' }),
          }),
          (result) => `Save clicked once; dialog closed ${result.dialogClosed ? 'yes' : 'no'}; UI response "${result.feedback}"; HTTP ${result.responseStatus ?? '<not captured>'}; request completed ${result.requestCompleted ? 'yes' : 'no'}.`, { page });
        saveResult = `UI response "${saved.feedback}"; HTTP ${saved.responseStatus ?? '<not captured>'}; requests ${responses.join(' | ') || '<none captured>'}; network failures ${failures.join(' | ') || '<none>'}; console errors ${consoleErrors.join(' | ') || '<none>'}.`;
      } catch (error) {
        saveResult = `Save did not complete successfully: ${error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error)}; requests ${responses.join(' | ') || '<none captured>'}; network failures ${failures.join(' | ') || '<none>'}; console errors ${consoleErrors.join(' | ') || '<none>'}.`;
        outcome.failures.push('RH-P16 enter above-rate Set Total and click Save once');
        outcome.diagnostics.push(saveResult);
      } finally {
        page.off('response', responseListener);
        page.off('requestfailed', failedListener);
        page.off('console', consoleListener);
      }

      await runningHours.refreshAndRestoreVessel(vessel);
      masterAfter = (await runningHours.readAllRows()).find((row) => row.componentCode === master!.componentCode);
      const inheritedAfter = masterAfter ? await runningHours.inspectInheritedDetails(masterAfter) : undefined;
      childAfter = inheritedAfter?.children.find((item) => item.componentCode === child!.componentCode);
      historyAfter = await runningHours.successfulUpdateHistorySignature(master!.componentCode);
      await attachRunningHoursComparison('RH-P16 Before-and-After Comparison', [
        { field: 'Vessel / RH Validation', initial: `${vessel}; ON`, entered: 'OFF during update', final: 'Restoration verified separately' },
        { field: `MASTER ${master!.componentCode}`, initial: String(masterRh), entered: String(entered), final: masterAfter?.runningHours ?? '<not found>' },
        { field: `INHERITED ${child!.componentCode}`, initial: String(childRh), entered: `Expected ${childRh + (entered - masterRh)}`, final: childAfter?.currentCumulativeRH ?? '<not found>' },
        { field: 'Successful history', initial: historyBefore || '<empty>', entered: 'Accepted update expected', final: historyAfter || '<empty>' },
      ]);
      await check(outcome, 'RH-P16 verify persisted MASTER, INHERITED and history',
        `After refresh, MASTER should be ${entered}, linked INHERITED should be ${childRh + (entered - masterRh)}, and successful-update history should change.`, async () => ({
          passed: hours(masterAfter?.runningHours ?? '') === entered
            && hours(childAfter?.currentCumulativeRH ?? '') === childRh + (entered - masterRh)
            && historyAfter !== historyBefore,
          actual: `MASTER ${masterRh} → ${masterAfter?.runningHours ?? '<not found>'}; INHERITED ${childRh} → ${childAfter?.currentCumulativeRH ?? '<not found>'}; history changed ${historyAfter !== historyBefore ? 'yes' : 'no'}; ${saveResult}`,
        }), 'always');
    } finally {
      if (vessel && originalState === 'ON') {
        try {
          const admin = await openAdminRhValidationSettings(vessel);
          await admin.setAdminRhValidationState(vessel, 'ON');
          finalState = await admin.adminRhValidationState(vessel);
          await componentObservedCheck(page, 'RH-P16 restore and verify RH Validation ON',
            'The selected vessel must finish with persisted RH Validation ON regardless of the scenario outcome.', {
              passed: finalState === 'ON',
              actual: `Vessel ${vessel}; RH Validation transition ON → OFF → ${finalState}; restoration persisted and was re-read in PMS Admin.`,
            }, { screenshot: 'always' });
          if (finalState !== 'ON') throw new Error(`Vessel ${vessel} remained RH Validation ${finalState}`);
        } catch (error) {
          restorationError = error;
          finalState = '<not verified>';
        }
      }
    }
    if (restorationError) {
      outcome.failures.push('RH-P16 restore and verify RH Validation ON');
      outcome.diagnostics.push(`Restoration failed for Vessel ${vessel}: ${restorationError instanceof Error ? restorationError.message : String(restorationError)}`);
    }
    await finish(outcome, 'RH-P16 verify above-rate update and mandatory restoration',
      'The above-rate positive update should persist for the MASTER and linked INHERITED component, history should record it, and RH Validation must finish ON.',
      `Vessel ${vessel}; MASTER ${master?.componentName} (${master?.componentCode}) ${masterRh} → ${masterAfter?.runningHours ?? '<not found>'}; INHERITED ${child?.name} (${child?.componentCode}) ${childRh} → ${childAfter?.currentCumulativeRH ?? '<not found>'}; rate ${rate} RH/day; entered increase ${entered - masterRh}; history changed ${historyAfter !== historyBefore ? 'yes' : 'no'}; RH Validation ON → OFF → ${finalState}; ${saveResult}`);
  });

});
