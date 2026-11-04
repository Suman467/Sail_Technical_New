import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentFormPage, type RunningHoursFormState } from '../../pages/ComponentFormPage';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { attachFailureScreenshot, componentActionStep, componentScenario, componentValidationStep, ScenarioPlan, type PlannedStep } from '../../utils/componentValidationEvidence';
import { readTrackedComponents, trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

type SuiteComponent = { code: string; name: string; parentCode: string };
type DetailState = { counterType: string; counterSource: string; runningHours: string; lastUpdated: string };

const sourceSpec = 'components-running-hours-condition-monitoring.spec.ts';
const parentLabel = '8 Ship Common Systems';
const sectionC = 'C. Running Hours & Condition Monitoring';
const sourceMessage = 'Component Save Failed | Select a MASTER component as the RH Counter Source.';
const step = (title: string, expected: string, actual: string, status?: 'NOT RUN') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}${status ? `\nStatus: ${status}` : ''}`;
const isBlank = (value: string) => ['', '-', '—'].includes(value.trim());
const shown = (value: string) => value.trim() || '<blank>';
const numberValue = (value: string) => Number(value.replaceAll(',', '').replace(/[^\d.-]/g, ''));
const dateOnly = (value: string) => {
  const iso = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  // The application displays and accepts dates day-first (DD-MM-YYYY).
  const dayFirst = value.match(/\b(\d{2})-(\d{2})-(\d{4})\b/);
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value.trim()
    : [parsed.getFullYear(), String(parsed.getMonth() + 1).padStart(2, '0'), String(parsed.getDate()).padStart(2, '0')].join('-');
};

test.describe('Components CMP-093 to CMP-108 - Running Hours and Condition Monitoring', () => {
  test.setTimeout(5 * 60_000);
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let selected: SuiteComponent;
  const vessel = config.vesselA;
  // Every replacement worker in one Playwright run shares the run-scoped
  // authentication file, so its name identifies this run's tracked component.
  const runId = `cmp-rh-${path.basename(process.env.COMPONENTS_AUTH_STATE_PATH ?? `worker-${process.ppid}`).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;

  const label = () => `${selected.code} (${selected.name})`;

  const readDetails = async (): Promise<DetailState> => {
    const grid = page.getByTestId('component-running-hours-grid');
    await grid.scrollIntoViewIfNeeded();
    const read = (field: string) => components.readSelectedComponentDetail({ section: sectionC, label: field });
    return {
      counterType: await read('RH Counter Type'),
      counterSource: await read('RH Counter Source'),
      runningHours: await read('Running Hours'),
      lastUpdated: await read('Last Updated'),
    };
  };

  const describeDetails = (state: DetailState) =>
    `RH Counter Type "${shown(state.counterType)}", RH Counter Source "${shown(state.counterSource)}", Running Hours "${shown(state.runningHours)}", Last Updated "${shown(state.lastUpdated)}"`;

  const describeForm = (state: RunningHoursFormState) =>
    `RH Counter Type "${shown(state.counterType)}", RH Counter Source "${shown(state.counterSource)}", Running Hours "${shown(state.runningHours)}", Date "${shown(state.readingDate)}"`;

  /** Selects the suite component after the page has been (re)loaded. */
  const selectComponent = async (): Promise<DetailState> => {
    await components.expectToBeOnPage();
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    const identity = await components.searchAndSelectComponentByCode(selected.code);
    expect(identity, `Component ${selected.code} should open with its saved identity in Vessel ${vessel}`)
      .toEqual({ code: selected.code, name: selected.name, vesselName: vessel });
    return readDetails();
  };

  const openStep = (): PlannedStep => ({
    title: `Refresh Components and open Component ${selected.code}`,
    expected: `After a browser refresh, Vessel ${vessel} should remain selected and Component ${label()} should open with Section C showing its saved Running Hours values.`,
  });
  const refreshAndOpen = async (plan: ScenarioPlan): Promise<DetailState> => {
    const { title, expected } = openStep();
    plan.begin(title);
    return componentActionStep(title, expected, async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      return selectComponent();
    }, (state) => `After refresh, Vessel ${vessel} opened Component ${label()}; Section C displayed ${describeDetails(state)}.`);
  };

  const editStep = (): PlannedStep => ({
    title: `Click Edit and open Section C for Component ${selected.code}`,
    expected: `The Edit Component form for ${selected.code} should finish loading and show the Section C Running Hours controls.`,
  });
  const openEdit = async (plan: ScenarioPlan): Promise<{ form: ComponentFormPage; state: RunningHoursFormState }> => {
    const { title, expected } = editStep();
    plan.begin(title);
    return componentActionStep(title, expected, async () => {
      const form = await components.openSelectedComponentForEdit();
      await form.expectEditReady(selected.code);
      return { form, state: await form.readRunningHoursState() };
    }, ({ state }) => `The Edit form loaded for ${selected.code}; Section C showed ${describeForm(state)}.`);
  };

  const typeStep = (type: string, from?: string): PlannedStep => ({
    title: `Change RH Counter Type to ${type}`,
    expected: `RH Counter Type should change${from ? ` from ${from}` : ''} to ${type} and stay selected in the Edit form.`,
  });
  const changeType = async (plan: ScenarioPlan, form: ComponentFormPage, type: 'Master' | 'Inherited' | 'Not RH Driven', from?: string) => {
    const { title, expected } = typeStep(type === 'Not RH Driven' ? 'None' : type, from);
    plan.begin(title);
    return componentActionStep(title, expected, () => form.setRhCounterType(type),
      (value) => `RH Counter Type now displayed "${value.type}" and RH Counter Source displayed "${shown(value.source)}".`);
  };

  const saveStep = (): PlannedStep => ({
    title: `Click Save for Component ${selected.code} (${selected.name})`,
    expected: `The application should save Component ${selected.code} once and return a successful response.`,
  });
  const save = async (plan: ScenarioPlan, form: ComponentFormPage): Promise<void> => {
    plan.begin(saveStep().title);
    await form.saveValid();
  };

  const closeStep = (): PlannedStep => ({
    title: `Close the Edit form for ${selected.code} without saving`,
    expected: 'The Edit form should close through Back and return to the Components register without saving the attempted change.',
  });
  const closeWithoutSave = async (plan: ScenarioPlan, form: ComponentFormPage): Promise<void> => {
    const { title, expected } = closeStep();
    plan.begin(title);
    await componentActionStep(title, expected, () => form.back(),
      () => `Back closed the Edit form for ${selected.code} and the Components register was displayed; Save was not clicked.`);
  };

  const requireStep = (type: string, dependency: string): PlannedStep => ({
    title: `Confirm the starting RH Counter Type is ${type}`,
    expected: `The Edit form should show RH Counter Type ${type}, saved by ${dependency}, before this scenario changes it.`,
  });
  const requireType = async (plan: ScenarioPlan, state: RunningHoursFormState, type: string, dependency: string): Promise<void> => {
    const { title, expected } = requireStep(type, dependency);
    plan.begin(title);
    await componentActionStep(title, expected, async () => {
      expect(state.counterType, `This scenario depends on ${dependency}; the Edit form showed RH Counter Type "${shown(state.counterType)}" instead of ${type}`).toBe(type);
    }, () => `The Edit form showed RH Counter Type "${state.counterType}" as required.`);
  };

  const reopenStep = (): PlannedStep => ({
    title: `Reopen Component ${selected.code} after Save`,
    expected: `After Save the register should reload in Vessel ${vessel} and reopen Component ${label()} with its saved Section C values.`,
  });
  const reopenAfterSave = async (plan: ScenarioPlan): Promise<DetailState> => {
    const { title, expected } = reopenStep();
    plan.begin(title);
    return componentActionStep(title, expected, () => selectComponent(),
      (state) => `After Save, Vessel ${vessel} reopened Component ${label()}; Section C displayed ${describeDetails(state)}.`, { page });
  };

  /** An intermediate check listed in the step table, with a screenshot of the observed screen. */
  const checkStep = async <T>(plan: ScenarioPlan, planned: PlannedStep, body: () => Promise<T>, actual: (value: T) => string): Promise<T> => {
    plan.begin(planned.title);
    return componentActionStep(planned.title, planned.expected, body, actual, { page });
  };

  /** The scenario's single overall validation; the report uses it as the test case result. */
  const verify = async <T>(plan: ScenarioPlan, planned: PlannedStep, body: () => Promise<T>, actual: (value: T) => string): Promise<T> => {
    plan.begin(planned.title);
    return componentValidationStep(page, step(planned.title, planned.expected, 'Recorded after the validation completes.'), body, { actual });
  };

  const applicationDate = () => page.evaluate(() => {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  });

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(5 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    const vesselChanged = await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    await test.step(step(
      vesselChanged ? `Initial setup - Select Vessel ${vessel}` : `Initial setup - Confirm Vessel ${vessel} is selected`,
      `The authenticated Components page should show Vessel ${vessel} with its collapsed component tree loaded.`,
      vesselChanged
        ? `Vessel ${vessel} was selected and its component tree loaded without using Expand All.`
        : `Vessel ${vessel} was already selected when Components opened; its component tree loaded without using Expand All.`,
    ), async () => {});

    // A replacement worker in the same run reuses the component created by the
    // first worker instead of creating another one.
    const tracked = (await readTrackedComponents()).find((item) => item.sourceSpec === sourceSpec
      && item.runId === runId && item.vessel === vessel && item.cleanupStatus === 'pending');
    if (tracked) {
      selected = { code: tracked.code, name: tracked.name, parentCode: tracked.parentCode };
      await componentActionStep(
        `Initial setup - Reopen this run's RH automation Component ${selected.code}`,
        `Component ${selected.code} (${selected.name}), created earlier in this run, should still exist in Vessel ${vessel}.`,
        () => components.searchAndSelectComponentByCode(selected.code),
        (identity) => `Component ${identity.code} (${identity.name}) was reopened in Vessel ${identity.vesselName}; no additional component was created.`,
      );
      return;
    }

    const parent = await componentActionStep(
      `Initial setup - Locate ${parentLabel} in Vessel ${vessel}`,
      `Searching the Components tree should show ${parentLabel} as a top-level component in Vessel ${vessel}.`,
      async () => {
        const rows = await components.searchTree(parentLabel);
        const match = rows.find((row) => row.rawText.trim() === parentLabel || `${row.code} ${row.name}`.trim() === parentLabel);
        expect(match, `${parentLabel} should be shown in the Components tree for Vessel ${vessel}`).toBeTruthy();
        return match!;
      },
      (row) => `The tree showed Component ${row.code} (${row.name}) at the top level of Vessel ${vessel}.`,
    );
    await componentActionStep(
      `Initial setup - Select parent Component ${parent.code} (${parent.name})`,
      `Only parent Component ${parent.code} should be selected and its details opened; Expand All should not be used.`,
      () => components.searchAndSelectComponentByCode(parent.code),
      (identity) => `Parent Component ${identity.code} ("${identity.name}") was selected and its details opened in Vessel ${vessel}.`,
    );

    const id = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    selected = { code: `ATRH-${id}`, name: `RH Monitoring Automation ${id}`, parentCode: parent.code };
    const form = await componentActionStep(
      `Initial setup - Open Add Component under ${parent.code}`,
      `The Add Component form should open and finish loading with Parent Component Code ${parent.code}.`,
      async () => {
        const opened = await components.openComponentForAdd();
        await opened.expectAddContext(parent.code);
        await page.waitForLoadState('networkidle');
        return opened;
      },
      () => `The Add Component form opened with Parent Component Code ${parent.code}.`,
    );
    await form.fillRequired({
      parentCode: selected.parentCode,
      code: selected.code,
      name: selected.name,
      category: 'Ship General',
      department: config.componentDepartment,
      isParent: 'No',
      isActive: 'Yes',
      actorLabel: 'the primary automation user',
    });
    const maker = await componentActionStep(
      'Initial setup - Select a configured Maker',
      'The Maker picker should list configured makers and keep the selected Maker on the form.',
      async () => {
        const makers = await form.availableSelectOptions('Maker');
        expect(makers.length, 'At least one configured Maker should be available').toBeGreaterThan(0);
        return form.selectMasterValue('Maker', undefined, makers[0].value);
      },
      (value) => `Maker "${value}" was selected from the configured Maker list.`,
    );
    const optional = { Model: 'RH-Test-Model', 'Drawing No': 'RH-DWG-001', 'Notes / Technical Information': 'Dummy technical information for Running Hours automation testing' };
    await componentActionStep(
      'Initial setup - Enter Model, Drawing No. and Notes / Technical Information',
      `The form should retain Model "${optional.Model}", Drawing No. "${optional['Drawing No']}" and the Running Hours technical note.`,
      () => form.fillOptional(optional),
      () => `The form retained Model "${optional.Model}", Drawing No. "${optional['Drawing No']}" and Notes "${optional['Notes / Technical Information']}".`,
    );
    await componentActionStep(
      'Initial setup - Set Criticality and Condition Based to No',
      'Criticality and Condition Based should both show No before Save.',
      async () => {
        await form.setYesNo('Criticality', 'select-criticality-field', 'No');
        await form.setYesNo('Condition Based', 'select-condition-based', 'No');
        return form.readRunningHoursState();
      },
      (state) => `Criticality and Condition Based both showed No; Section C kept its default ${describeForm(state)}.`,
    );
    await form.saveValid();
    await trackCreatedComponent({ ...selected, vessel, sourceSpec, testCaseId: 'CMP-093-CMP-108', runId, createdAt: new Date().toISOString() });
    await componentActionStep(
      `Initial setup - Refresh and verify Component ${selected.code} under ${parent.code}`,
      `After refresh, Component ${label()} should exist in Vessel ${vessel} as a direct child of ${parent.code} (${parent.name}).`,
      async () => {
        const state = await selectComponent();
        const rows = await components.readExpandedTreeRows();
        const index = rows.findIndex((row) => row.code === selected.code);
        expect(index, `Component ${selected.code} should be shown in the tree`).toBeGreaterThanOrEqual(0);
        let parentIndex = index - 1;
        while (parentIndex >= 0 && rows[parentIndex].depth >= rows[index].depth) parentIndex -= 1;
        const shownParent = rows[parentIndex]?.code ?? '<none>';
        expect(shownParent, `Component ${selected.code} should be shown directly under ${parent.code}`).toBe(parent.code);
        return { state, shownParent };
      },
      ({ state, shownParent }) => `After refresh, Component ${label()} was shown directly under ${shownParent} (${parent.name}) in Vessel ${vessel}; Section C displayed ${describeDetails(state)}.`,
    );
    testInfo.annotations.push({ type: 'runtime-component', description: `${selected.code} | ${selected.name} | ${vessel} | Parent ${selected.parentCode} | Maker ${maker} | Category Ship General` });
  });

  test.afterEach(async () => {
    await attachFailureScreenshot(page, test.info());
    await restoreComponentsPage(page, components, vessel);
  });
  test.afterAll(async () => context?.close());

  test('CMP-093 - Verify default RH Counter values', componentScenario('A newly created component should show RH Counter Type "Not RH Driven" and a blank (or "-") RH Counter Source in Section C.'), async () => {
    const check: PlannedStep = {
      title: `Verify the default Section C values of ${selected.code}`,
      expected: 'RH Counter Type should be "Not RH Driven" and RH Counter Source should be blank or "-".',
    };
    const plan = new ScenarioPlan([openStep(), check]);
    await plan.run(async () => {
      const state = await refreshAndOpen(plan);
      await verify(plan, check, async () => {
        expect(state.counterType, 'RH Counter Type should default to Not RH Driven').toBe('Not RH Driven');
        expect(isBlank(state.counterSource), `RH Counter Source should be blank or a dash; it displayed "${shown(state.counterSource)}"`).toBe(true);
        return state;
      }, (value) => `Component ${selected.code} displayed RH Counter Type "${value.counterType}" and RH Counter Source "${shown(value.counterSource)}".`);
    });
  });

  test('CMP-094 - Save RH Counter Type as Master', componentScenario('After changing RH Counter Type from None to Master and saving, the reopened component should show RH Counter Type "Master" and RH Counter Source "Self".'), async () => {
    const check: PlannedStep = {
      title: `Reopen ${selected.code} and verify Master was saved`,
      expected: 'After Save and reopen, RH Counter Type should be "Master" and RH Counter Source should be "Self".',
    };
    const plan = new ScenarioPlan([openStep(), editStep(), requireStep('None', 'component creation'), typeStep('Master', 'None'), saveStep(), reopenStep(), check]);
    await plan.run(async () => {
      await refreshAndOpen(plan);
      const { form, state } = await openEdit(plan);
      await requireType(plan, state, 'None', 'component creation');
      await changeType(plan, form, 'Master', 'None');
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      await verify(plan, check, async () => {
        expect(after.counterType, 'RH Counter Type should persist as Master').toBe('Master');
        // The application capitalises this system value differently in the form
        // ("SELF") and the details grid; the business value is Self.
        expect(after.counterSource, 'RH Counter Source should display Self').toMatch(/^self$/i);
        return after;
      }, (after) => `After Save and reopen, ${selected.code} displayed ${describeDetails(after)}.`);
    });
  });

  test('CMP-095 - Save Inherited with same-vessel Master', componentScenario('Changing Master to Inherited with a same-vessel Master source should save; after reopen RH Counter Type should be "Inherited" and RH Counter Source should display "Parent Component".'), async () => {
    const pick: PlannedStep = {
      title: 'Select an RH Counter Source from the Master components offered',
      expected: `The source picker should list Master components of Vessel ${vessel}, and the chosen Master should be shown as the RH Counter Source.`,
    };
    const check: PlannedStep = {
      title: `Reopen ${selected.code} and verify Inherited was saved`,
      expected: 'After Save and reopen, RH Counter Type should be "Inherited" and RH Counter Source should display "Parent Component".',
    };
    const plan = new ScenarioPlan([openStep(), editStep(), requireStep('Master', 'CMP-094'), typeStep('Inherited', 'Master'), pick, saveStep(), reopenStep(), check]);
    await plan.run(async () => {
      await refreshAndOpen(plan);
      const { form, state } = await openEdit(plan);
      await requireType(plan, state, 'Master', 'CMP-094');
      await changeType(plan, form, 'Inherited', 'Master');
      plan.begin(pick.title);
      const source = await componentActionStep(pick.title, pick.expected, () => form.selectRhCounterSource(selected.code),
        (value) => `The picker offered ${value.offered} Master component(s); Master ${value.code}${value.name ? ` (${value.name})` : ''} was selected and RH Counter Source displayed "${value.displayed}".`);
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      await verify(plan, check, async () => {
        expect(after.counterType, 'RH Counter Type should persist as Inherited').toBe('Inherited');
        expect(after.counterSource, `RH Counter Source should display Parent Component (selected source was ${source.code})`).toBe('Parent Component');
        return after;
      }, (after) => `Selected source Master ${source.code}${source.name ? ` (${source.name})` : ''}. After Save and reopen, ${selected.code} displayed ${describeDetails(after)}.`);
    });
  });

  test('CMP-097 - Change Inherited to Not RH Driven', componentScenario('Changing RH Counter Type from Inherited to None and saving should show "Not RH Driven" with a blank (or "-") RH Counter Source after reopen.'), async () => {
    const check: PlannedStep = {
      title: `Reopen ${selected.code} and verify Not RH Driven was saved`,
      expected: 'After Save and reopen, RH Counter Type should be "Not RH Driven" and RH Counter Source should be blank or "-".',
    };
    const plan = new ScenarioPlan([openStep(), editStep(), requireStep('Inherited', 'CMP-095'), typeStep('None', 'Inherited'), saveStep(), reopenStep(), check]);
    await plan.run(async () => {
      await refreshAndOpen(plan);
      const { form, state } = await openEdit(plan);
      await requireType(plan, state, 'Inherited', 'CMP-095');
      await changeType(plan, form, 'Not RH Driven', 'Inherited');
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      await verify(plan, check, async () => {
        expect(after.counterType, 'RH Counter Type should persist as Not RH Driven').toBe('Not RH Driven');
        expect(isBlank(after.counterSource), `RH Counter Source should be blank or a dash; it displayed "${shown(after.counterSource)}"`).toBe(true);
        return after;
      }, (after) => `After Save and reopen, ${selected.code} displayed ${describeDetails(after)}.`);
    });
  });

  test('CMP-099 - Update Running Hours', componentScenario('Saving Running Hours 1000 with the current application-local date should show Running Hours 1000 and the same date after reopen.'), async () => {
    const enter: PlannedStep = {
      title: 'Enter Running Hours 1000 and the current date',
      expected: 'Running Hours should retain 1000 and the date field should retain the current application-local date before Save.',
    };
    const check: PlannedStep = {
      title: `Reopen ${selected.code} and verify Running Hours 1000 was saved`,
      expected: 'After Save and reopen, Running Hours should be 1000 and Last Updated should match the entered date.',
    };
    const plan = new ScenarioPlan([openStep(), editStep(), enter, saveStep(), reopenStep(), check]);
    await plan.run(async () => {
      await refreshAndOpen(plan);
      const { form } = await openEdit(plan);
      const enteredDate = await applicationDate();
      plan.begin(enter.title);
      const entered = await componentActionStep(enter.title, enter.expected, async () => {
        const value = await form.setRunningHours('1000', enteredDate);
        expect(numberValue(value.runningHours), 'Running Hours should show 1000 before Save').toBe(1000);
        expect(dateOnly(value.readingDate), `The date field should show the current date ${enteredDate} before Save`).toBe(enteredDate);
        return value;
      }, (value) => `Running Hours retained "${value.runningHours}" and the date field retained ${value.readingDate}.`);
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      await verify(plan, check, async () => {
        expect(numberValue(after.runningHours), 'Running Hours should persist as 1000').toBe(1000);
        expect(dateOnly(after.lastUpdated), 'Last Updated should match the entered date').toBe(enteredDate);
        return after;
      }, (after) => `Entered 1000 on ${entered.readingDate}. After Save and reopen, ${selected.code} displayed ${describeDetails(after)}.`);
    });
  });

  test('CMP-100 - Reject Inherited without source', componentScenario(`Saving RH Counter Type "Inherited" without an RH Counter Source should be rejected with "${sourceMessage}" and the saved configuration should stay unchanged.`), async () => {
    const leave: PlannedStep = {
      title: 'Leave RH Counter Source unselected',
      expected: 'RH Counter Source should show no selected Master component.',
    };
    const submit: PlannedStep = { title: 'Click Save and capture the application response', expected: 'Clicking Save with Inherited and no RH Counter Source should produce an application response or message, which is recorded for the rejection and message checks.' };
    const rejected: PlannedStep = {
      title: 'Verify Save was rejected without saving',
      expected: 'Save should not succeed, no successful save response should be returned, and the Edit form should stay open with the validation message.',
    };
    const persisted: PlannedStep = {
      title: `Reopen ${selected.code} and verify the invalid configuration was not saved`,
      expected: 'After the rejected Save, the reopened component should keep the RH Counter Type and RH Counter Source it had before the attempt.',
    };
    const message: PlannedStep = {
      title: 'Verify the rejection message matches the requirement',
      expected: `Saving Inherited without an RH Counter Source should be rejected with "${sourceMessage}" and the saved configuration should stay unchanged.`,
    };
    const plan = new ScenarioPlan([openStep(), editStep(), typeStep('Inherited'), leave, submit, rejected, closeStep(), persisted, message]);
    await plan.run(async () => {
      const before = await refreshAndOpen(plan);
      const { form } = await openEdit(plan);
      await changeType(plan, form, 'Inherited');
      plan.begin(leave.title);
      await componentActionStep(leave.title, leave.expected, async () => {
        const state = await form.readRunningHoursState();
        expect(state.counterSource, 'No RH Counter Source should be selected').toMatch(/^(?:|select source\.*)$/i);
        return state;
      }, (state) => `RH Counter Source displayed "${shown(state.counterSource)}"; no Master component was selected.`);
      plan.begin(submit.title);
      const outcome = await form.submitForValidation({ feedbackPattern: /RH Counter Source From Master/i, expected: submit.expected });
      await checkStep(plan, rejected, async () => {
        expect(outcome.succeeded, 'Save without an RH Counter Source should be rejected').toBe(false);
        expect(outcome.formRemainedOpen, 'The Edit form should stay open after the rejected Save').toBe(true);
        return outcome;
      }, (value) => `Save was rejected${value.status ? ` with HTTP ${value.status}` : ' before any save request was sent'}; the Edit form stayed open and displayed "${value.feedback}".`);
      await closeWithoutSave(plan, form);
      // Persistence is checked before the exact wording, so a message-text
      // difference cannot hide whether invalid data was saved.
      const after = await checkStep(plan, persisted, async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const reopened = await selectComponent();
        expect(reopened.counterType, 'RH Counter Type should be unchanged').toBe(before.counterType);
        expect(reopened.counterSource, 'RH Counter Source should be unchanged').toBe(before.counterSource);
        return reopened;
      }, (reopened) => `Before the attempt ${selected.code} showed RH Counter Type "${before.counterType}" and RH Counter Source "${shown(before.counterSource)}"; after reopen it showed "${reopened.counterType}" and "${shown(reopened.counterSource)}".`);
      await verify(plan, message, async () => {
        expect(outcome.feedback, `The rejection message should read "${sourceMessage}"`).toContain(sourceMessage);
        return outcome;
      }, (value) => `Save was rejected with "${value.feedback}", and after reopen ${selected.code} still showed RH Counter Type "${after.counterType}" and RH Counter Source "${shown(after.counterSource)}".`);
    });
  });

  for (const scenario of [
    { id: 'CMP-104', type: 'Master' as const, display: 'Master', name: 'Submit Master with Inherited source' },
    { id: 'CMP-105', type: 'Not RH Driven' as const, display: 'None', name: 'Submit Not RH Driven with Inherited source' },
  ]) {
    test(`${scenario.id} - ${scenario.name}`, componentScenario(`With RH Counter Type "${scenario.display}" selected, RH Counter Source should not accept typed text or offer an inherited Master source.`), async () => {
      const attempt: PlannedStep = {
        title: `Attempt to enter an inherited RH Counter Source while ${scenario.display} is selected`,
        expected: `Clicking and typing in RH Counter Source should neither open the Master source picker nor change the source while ${scenario.display} is selected.`,
      };
      const check: PlannedStep = {
        title: `Verify RH Counter Source stayed locked for ${scenario.display}`,
        expected: `RH Counter Source should remain read-only and keep the value the application assigned for ${scenario.display}.`,
      };
      const plan = new ScenarioPlan([openStep(), editStep(), typeStep(scenario.display), attempt, check, closeStep()]);
      await plan.run(async () => {
        await refreshAndOpen(plan);
        const { form } = await openEdit(plan);
        await changeType(plan, form, scenario.type);
        plan.begin(attempt.title);
        const result = await componentActionStep(attempt.title, attempt.expected, () => form.attemptRhCounterSourceEntry('355001001'),
          (value) => `RH Counter Source was a ${value.control}; clicking it ${value.pickerOpened ? 'opened' : 'did not open'} the Master source picker, and after typing "355001001" it displayed "${shown(value.after)}" (before: "${shown(value.before)}").`);
        await verify(plan, check, async () => {
          expect(result.pickerOpened, 'The Master source picker should not open').toBe(false);
          expect(result.readOnly, 'RH Counter Source should be read-only').toBe(true);
          expect(result.after, 'RH Counter Source should keep its assigned value').toBe(result.before);
          return result;
        }, (value) => `With ${scenario.display} selected, RH Counter Source stayed "${shown(value.after)}" as a ${value.control}; the typed source was not accepted and no picker opened.`);
        await closeWithoutSave(plan, form);
      });
    });
  }

  test('CMP-107 - Submit Running Hours below current reading', componentScenario('Saving Running Hours 555 below the latest 1000 reading should be rejected with a message naming 555, 1000 and the date 1000 was recorded, and 1000 should remain saved.'), async () => {
    // CMP-107 sets up its own 1000 baseline through Edit and Save when the
    // component does not already show it, so it does not depend on CMP-099.
    const baselineEdit: PlannedStep = { ...editStep(), title: `Click Edit to enter the baseline reading for Component ${selected.code}` };
    const baselineEnter: PlannedStep = {
      title: 'Enter baseline Running Hours 1000 and the current date',
      expected: 'Running Hours should retain 1000 and the date field should retain the current application-local date before Save.',
    };
    const baselineSave: PlannedStep = { ...saveStep(), title: `Click Save for the baseline reading of Component ${selected.code}` };
    const baselineReopen: PlannedStep = { ...reopenStep(), title: `Reopen Component ${selected.code} after saving the baseline reading` };
    const baselineSteps = [baselineEdit, baselineEnter, baselineSave, baselineReopen];
    const baselineStep: PlannedStep = {
      title: 'Confirm the latest saved Running Hours reading is 1000',
      expected: 'Section C should show Running Hours 1000 with its recorded date before the lower reading is attempted.',
    };
    const enter: PlannedStep = {
      title: 'Enter Running Hours 555 and the current date',
      expected: 'Running Hours should retain 555 and the date field should retain the current application-local date before Save.',
    };
    const submit: PlannedStep = { title: 'Click Save and capture the application response', expected: 'Clicking Save with the lower reading 555 should produce an application response or message, which is recorded for the rejection check.' };
    const rejected: PlannedStep = {
      title: 'Verify the lower reading was rejected with a message naming both readings and the date',
      expected: 'Save should not succeed; the message should name 555 RH, 1000 RH and the date 1000 was recorded, for example "Current Reading (555 RH) cannot be lower than the latest Running Hours value (1000 RH recorded on YYYY-MM-DD). Correct the reading before continuing."',
    };
    const check: PlannedStep = {
      title: `Reopen ${selected.code} and verify Running Hours 1000 is unchanged`,
      expected: 'The 555 reading should have been rejected with a message naming 555 RH, 1000 RH and the date 1000 was recorded, and after reopen Running Hours should still be 1000 with its original recorded date.',
    };
    const plan = new ScenarioPlan([openStep(), ...baselineSteps, baselineStep, editStep(), enter, submit, rejected, closeStep(), check]);
    await plan.run(async () => {
      let before = await refreshAndOpen(plan);
      if (numberValue(before.runningHours) === 1000) {
        // The baseline is already saved; the setup actions are not needed.
        for (const item of baselineSteps) plan.begin(item.title);
      } else {
        plan.begin(baselineEdit.title);
        const baselineForm = await componentActionStep(baselineEdit.title, baselineEdit.expected, async () => {
          const opened = await components.openSelectedComponentForEdit();
          await opened.expectEditReady(selected.code);
          return { form: opened, state: await opened.readRunningHoursState() };
        }, ({ state }) => `Section C showed Running Hours "${shown(before.runningHours)}", so the Edit form was opened to enter the 1000 baseline; it showed ${describeForm(state)}.`);
        const baselineDate = await applicationDate();
        plan.begin(baselineEnter.title);
        await componentActionStep(baselineEnter.title, baselineEnter.expected, async () => {
          const value = await baselineForm.form.setRunningHours('1000', baselineDate);
          expect(numberValue(value.runningHours), 'Running Hours should show 1000 before Save').toBe(1000);
          expect(dateOnly(value.readingDate), `The date field should show the current date ${baselineDate} before Save`).toBe(baselineDate);
          return value;
        }, (value) => `Running Hours retained "${value.runningHours}" and the date field retained ${value.readingDate}.`);
        plan.begin(baselineSave.title);
        await baselineForm.form.saveValid();
        plan.begin(baselineReopen.title);
        before = await componentActionStep(baselineReopen.title, baselineReopen.expected, () => selectComponent(),
          (state) => `After Save, Vessel ${vessel} reopened Component ${label()}; Section C displayed ${describeDetails(state)}.`, { page });
      }
      plan.begin(baselineStep.title);
      const recordedDate = await componentActionStep(baselineStep.title, baselineStep.expected, async () => {
        expect(numberValue(before.runningHours), `Section C should show the 1000 baseline before the lower reading; it showed "${shown(before.runningHours)}"`).toBe(1000);
        return dateOnly(before.lastUpdated);
      }, (value) => `Section C showed Running Hours "${before.runningHours}" recorded on ${value}.`, { page });
      const { form } = await openEdit(plan);
      plan.begin(enter.title);
      const entered = await componentActionStep(enter.title, enter.expected, async () => form.setRunningHours('555', await applicationDate()),
        (value) => `Running Hours retained "${value.runningHours}" and the date field retained ${value.readingDate}.`);
      plan.begin(submit.title);
      const outcome = await form.submitForValidation({ feedbackPattern: /cannot be lower than/i, expected: submit.expected });
      await checkStep(plan, rejected, async () => {
        expect(outcome.succeeded, 'Save of a lower reading should be rejected').toBe(false);
        expect(outcome.feedback, 'The message should name the attempted reading').toContain('555');
        expect(outcome.feedback, 'The message should name the previous reading').toContain('1000');
        expect(outcome.feedback, `The message should name the date ${recordedDate} the previous reading was recorded`).toContain(recordedDate);
        return outcome;
      }, (value) => `Submitting ${entered.runningHours} on ${entered.readingDate} was rejected${value.status ? ` with HTTP ${value.status}` : ' without a successful save'}; the application displayed "${value.feedback}".`);
      await closeWithoutSave(plan, form);
      await verify(plan, check, async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const after = await selectComponent();
        expect(numberValue(after.runningHours), 'Running Hours should remain 1000').toBe(1000);
        expect(dateOnly(after.lastUpdated), 'The recorded date should be unchanged').toBe(recordedDate);
        return after;
      }, (after) => `The 555 reading was rejected with "${outcome.feedback}"; after reopen ${selected.code} still displayed Running Hours "${after.runningHours}" with Last Updated "${after.lastUpdated}".`);
    });
  });

  test('CMP-108 - Submit unknown RH Counter Type', componentScenario('RH Counter Type should offer only its supported values and should not accept an unknown value typed by the user.'), async () => {
    const attempt: PlannedStep = {
      title: 'Attempt to type the unsupported RH Counter Type "Unknown"',
      expected: 'Typing "Unknown" into RH Counter Type should not create or select an unsupported value.',
    };
    const check: PlannedStep = {
      title: 'Verify RH Counter Type allows only supported values',
      expected: 'RH Counter Type should be a fixed choice list offering only None, Master and Inherited, and should keep its previous value.',
    };
    const plan = new ScenarioPlan([openStep(), editStep(), attempt, check, closeStep()]);
    await plan.run(async () => {
      await refreshAndOpen(plan);
      const { form } = await openEdit(plan);
      plan.begin(attempt.title);
      const result = await componentActionStep(attempt.title, attempt.expected, () => form.attemptUnsupportedRhCounterType('Unknown'),
        (value) => `RH Counter Type was a ${value.control}; after typing "Unknown" it displayed "${value.after}" (before: "${value.before}").`);
      await verify(plan, check, async () => {
        expect(result.control, 'RH Counter Type should be a fixed choice list').toBe('fixed choice list');
        expect(result.options.filter((option) => !['None', 'Master', 'Inherited'].includes(option)), 'Only supported RH Counter Types should be offered').toEqual([]);
        expect(result.after, 'RH Counter Type should keep its previous value').toBe(result.before);
        return result;
      }, (value) => `RH Counter Type offered only ${value.options.join(', ')} and kept "${value.after}" after "Unknown" was typed.`);
      await closeWithoutSave(plan, form);
    });
  });
});
