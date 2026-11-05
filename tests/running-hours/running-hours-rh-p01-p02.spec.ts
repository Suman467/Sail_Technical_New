import { test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { RunningHoursPage, type RunningHoursGridRow } from '../../pages/RunningHoursPage';
import { TechnicalPage } from '../../pages/TechnicalPage';
import {
  attachFailureScreenshot,
  componentActionStep,
  componentNotExecutedStep,
  componentObservedCheck,
  componentScenario,
  componentValidationStep,
} from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { routes } from '../../utils/routes';

type Outcome = { checks: number; failures: string[]; diagnostics: string[] };
type CheckResult = { passed: boolean; actual: string };
type SectionC = { counterType: string; counterSource: string; runningHours: string; lastUpdated: string };

const sectionC = 'C. Running Hours & Condition Monitoring';
const vesselCount = config.runningHoursVesselCount;
const componentsPerVessel = config.runningHoursComponentsPerVessel;
const step = (title: string, expected: string, actual: string) => `${title}\nExpected: ${expected}\nActual: ${actual}`;

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const isBlank = (value: string) => ['', '-', '—'].includes(clean(value));
const shown = (value: string) => (isBlank(value) ? '<blank>' : clean(value));
const months: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Parses "2,000 hrs" or "2000.00" and keeps the displayed precision. */
const hours = (value: string): { value: number; decimals: number } | undefined => {
  const text = clean(value).replace(/,/g, '').replace(/\s*hrs?$/i, '');
  if (isBlank(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? { value: parsed, decimals: (text.split('.')[1] ?? '').length } : undefined;
};

/** Reduces "30-Apr-2025 05:30" (Running Hours) and "30-04-2025" (Section C) to YYYY-MM-DD. */
const dateOf = (value: string): string => {
  const text = clean(value);
  if (isBlank(text)) return '';
  const named = text.match(/\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/);
  if (named && months[named[2].toLowerCase()]) return `${named[3]}-${months[named[2].toLowerCase()]}-${named[1].padStart(2, '0')}`;
  const dayFirst = text.match(/\b(\d{2})-(\d{2})-(\d{4})\b/);
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  return text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? text;
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

test.describe('Running Hours RH-P01 and RH-P02', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;

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
    evidence = false,
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
    screenshot: 'always' | 'failure' = 'failure',
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

  test('RH-P01 - Default vessel, Running Hours table loading and dynamic component search', componentScenario(
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

  test('RH-P02 - Running Hours values match Components Section C across vessels and components', componentScenario(
    `For ${componentsPerVessel} components in each of ${vesselCount} vessels, the component found by searching Running Hours should open in Components for the same vessel, and its Running Hours and Last Updated values under ${sectionC} should match the Running Hours table.`,
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
          `Under ${sectionC}, Component ${code} should show Running Hours "${shown(rhRow.row.runningHours)}" and Last Updated date "${dateOf(rhRow.row.lastUpdated) || '<blank>'}", matching Running Hours.`,
          async () => {
            await page.getByTestId('component-running-hours-grid').scrollIntoViewIfNeeded();
            const read = (field: string) => components.readSelectedComponentDetail({ section: sectionC, label: field });
            const details: SectionC = {
              counterType: await read('RH Counter Type'),
              counterSource: await read('RH Counter Source'),
              runningHours: await read('Running Hours'),
              lastUpdated: await read('Last Updated'),
            };
            // Section C shows two decimals; Running Hours shows its own precision, so compare at that precision.
            const listed = hours(rhRow.row.runningHours);
            const detail = hours(details.runningHours);
            const hoursMatch = listed === undefined || detail === undefined
              ? listed === undefined && detail === undefined
              : Number(detail.value.toFixed(listed.decimals)) === listed.value;
            const dateMatch = dateOf(details.lastUpdated) === dateOf(rhRow.row.lastUpdated);
            compared.push(`${code} (${vessel})`);
            return {
              passed: hoursMatch && dateMatch,
              actual: `${sectionC} showed Running Hours "${shown(details.runningHours)}" (${hoursMatch ? 'matches' : 'does NOT match'} Running Hours "${shown(rhRow.row.runningHours)}") `
                + `and Last Updated "${shown(details.lastUpdated)}" (${dateMatch ? 'matches' : 'does NOT match'} the Running Hours date "${shown(rhRow.row.lastUpdated)}"); `
                + `RH Counter Type "${shown(details.counterType)}", RH Counter Source "${shown(details.counterSource)}".`,
            };
          }, 'always');
      }
    }

    await finish(outcome,
      'Verify all Running Hours and Section C comparisons',
      `Every compared component should have the same vessel, identity, Running Hours and Last Updated date in Running Hours and Components.`,
      `All ${outcome.checks} RH-P02 checks passed; ${compared.length} component(s) matched between Running Hours and ${sectionC}: ${compared.join(', ')}.`);
  });

});
