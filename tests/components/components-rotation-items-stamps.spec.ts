import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ComponentFormPage } from '../../pages/ComponentFormPage';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { LoginPage } from '../../pages/LoginPage';
import { RotationItemMasterPage, type RotationItemRow } from '../../pages/RotationItemMasterPage';
import { attachFailureScreenshot, COMPONENT_VALIDATION_SCREENSHOT_PREFIX, componentActionStep, componentScenario, componentValidationStep, ScenarioPlan, type PlannedStep } from '../../utils/componentValidationEvidence';
import { readTrackedComponents, trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

type Identity = { code: string; name: string; parentCode: string };
type SavedRotation = { rotationalItem: string; stamp: string };
const sourceSpec = 'components-rotation-items-stamps.spec.ts';
const parentLabel = '8 Ship Common Systems';
const mandatoryStampMessage = 'Stamp is mandatory when Rotational Item is Yes.';
const step = (title: string, expected: string, actual: string) => `${title}\nExpected: ${expected}\nActual: ${actual}`;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * True when a displayed stamp contains the complete unique stamp name as a
 * whole token, so "Test Stamp_001" never matches "Test Stamp_0010".
 */
const showsStamp = (displayed: string, stampName: string) =>
  new RegExp(`(?:^|[^\\w])${escapeRegExp(stampName)}(?:$|[^\\w])`).test(displayed);
const noStamp = (displayed: string) => ['', '-', '—'].includes(displayed.trim());
const shown = (value: string) => value.trim() || '<blank>';

test.describe('Components CMP-109 to CMP-120 - Rotation Items and Stamps', () => {
  test.setTimeout(5 * 60_000);
  let browserInstance: Browser;
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let secondaryContext: BrowserContext | undefined;
  let common: Identity;
  const vessel = config.vesselA;
  // Replacement workers in one run share the run-scoped authentication file,
  // so its name identifies the component created by this run.
  const runId = `cmp-rotation-${path.basename(process.env.COMPONENTS_AUTH_STATE_PATH ?? `worker-${process.ppid}`).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;
  const label = (target = common) => `${target.code} (${target.name})`;

  /** Selects a component after the page has been (re)loaded and reads its saved rotation values. */
  const selectComponent = async (target = common, targetComponents = components): Promise<SavedRotation> => {
    await targetComponents.expectToBeOnPage();
    await targetComponents.selectVessel(vessel);
    await targetComponents.expectTreeLoaded();
    const identity = await targetComponents.searchAndSelectComponentByCode(target.code);
    expect(identity, `Component ${target.code} should open with its saved identity in Vessel ${vessel}`)
      .toEqual({ code: target.code, name: target.name, vesselName: vessel });
    return targetComponents.readSelectedRotationItem();
  };

  const openStep = (target = common): PlannedStep => ({
    title: `Refresh Components and open Component ${target.code}`,
    expected: `After a browser refresh, Vessel ${vessel} should remain selected and Component ${label(target)} should open with its saved Rotational Item and Stamp.`,
  });
  const refreshAndOpen = async (plan: ScenarioPlan, target = common, targetComponents = components, targetPage = page): Promise<SavedRotation> => {
    const { title, expected } = openStep(target);
    plan.begin(title);
    return componentActionStep(title, expected, async () => {
      await targetPage.reload({ waitUntil: 'domcontentloaded' });
      return selectComponent(target, targetComponents);
    }, (state) => `Component ${label(target)} opened in Vessel ${vessel} with Rotational Item "${state.rotationalItem}" and Stamp "${shown(state.stamp)}".`);
  };

  const editStep = (target = common): PlannedStep => ({
    title: `Click Edit for Component ${target.code}`,
    expected: `The Edit Component form for ${target.code} should finish loading with its saved values.`,
  });
  const openEdit = async (plan: ScenarioPlan, target = common, targetComponents = components, planned = editStep(target)): Promise<ComponentFormPage> => {
    const { title, expected } = planned;
    plan.begin(title);
    return componentActionStep(title, expected, async () => {
      const form = await targetComponents.openSelectedComponentForEdit();
      await form.expectEditReady(target.code);
      return { form, state: await form.readRotationItemState() };
    }, ({ state }) => `The Edit form loaded for ${target.code} with Rotational Item "${state.rotationalItem}" and Stamp "${state.stamp}".`).then(({ form }) => form);
  };

  const rotationalStep = (value: 'Yes' | 'No', target = common): PlannedStep => ({
    title: `Set Rotational Item to ${value}${target === common ? '' : ` for ${target.code}`}`,
    expected: value === 'Yes'
      ? 'Rotational Item should show Yes and the Stamp dropdown should become available.'
      : 'Rotational Item should show No and the Stamp dropdown should become unavailable.',
  });
  const setRotational = async (plan: ScenarioPlan, form: ComponentFormPage, value: 'Yes' | 'No', target = common) => {
    const { title, expected } = rotationalStep(value, target);
    plan.begin(title);
    return componentActionStep(title, expected, () => form.setRotationalItem(value),
      (state) => `Rotational Item showed "${state.rotationalItem}"; Stamp showed "${state.stamp}" and was ${state.stampDisabled ? 'disabled' : 'enabled'}.`);
  };

  const selectStampStep = (purpose: string, target = common): PlannedStep => ({
    title: `Select ${purpose}${target === common ? '' : ` for ${target.code}`}`,
    expected: `The Stamp dropdown should keep the selected ${purpose} before Save.`,
  });
  const selectStamp = async (plan: ScenarioPlan, form: ComponentFormPage, stampName: string, purpose: string, target = common) => {
    const { title, expected } = selectStampStep(purpose, target);
    plan.begin(title);
    return componentActionStep(title, expected, () => form.selectStamp(stampName),
      (selected) => `The Stamp dropdown showed "${selected.label}" (unique stamp ${selected.name}).`);
  };

  const saveStep = (target = common): PlannedStep => ({
    title: `Click Save for Component ${target.code} (${target.name})`,
    expected: `The application should save Component ${target.code} once and return a successful response.`,
  });
  const save = async (plan: ScenarioPlan, form: ComponentFormPage): Promise<void> => {
    plan.begin(saveStep().title);
    await form.saveValid();
  };

  const reopenStep = (): PlannedStep => ({
    title: `Reopen Component ${common.code} after Save`,
    expected: `After Save the register should reload in Vessel ${vessel} and reopen Component ${label()} with its saved Rotational Item and Stamp.`,
  });
  const reopenAfterSave = async (plan: ScenarioPlan): Promise<SavedRotation> => {
    const { title, expected } = reopenStep();
    plan.begin(title);
    return componentActionStep(title, expected, () => selectComponent(),
      (state) => `After Save, Component ${label()} showed Rotational Item "${state.rotationalItem}" and Stamp "${shown(state.stamp)}".`, { page });
  };

  const closeStep = (): PlannedStep => ({
    title: `Close the Edit form for ${common.code} without saving`,
    expected: 'The Edit form should close through Back and return to the Components register without saving.',
  });
  const closeWithoutSave = async (plan: ScenarioPlan, form: ComponentFormPage): Promise<void> => {
    const { title, expected } = closeStep();
    plan.begin(title);
    await componentActionStep(title, expected, () => form.back(),
      () => `Back closed the Edit form for ${common.code} and the Components register was displayed; Save was not clicked.`);
  };

  const masterStep = (purpose: string): PlannedStep => ({
    title: `Read stamp statuses in Rotation Item Master List (${purpose})`,
    expected: `The Rotation Item Master List for Vessel ${vessel} should list each stamp with its current status and Installed On component.`,
  });
  /** Reads the real stamp statuses in a separate tab of the same authenticated session. */
  const readMaster = async (plan: ScenarioPlan, purpose: string, describe: (rows: RotationItemRow[]) => string): Promise<RotationItemRow[]> => {
    const { title, expected } = masterStep(purpose);
    plan.begin(title);
    const masterTab = await context.newPage();
    try {
      return await componentActionStep(title, expected, async () => {
        const master = new RotationItemMasterPage(masterTab);
        await master.openForVessel(vessel);
        return master.readStamps();
      }, describe, { page: masterTab });
    } finally {
      await masterTab.close();
    }
  };
  const statusOf = (rows: RotationItemRow[], stampName: string) => rows.find((row) => row.stamp === stampName);
  /**
   * Finds stamps whose Rotation Item Master List status is exactly `status`
   * and that the live Stamp dropdown also offers, matched by unique Stamp No.
   * (the option value). Throws a missing-prerequisite error when none qualify.
   */
  const eligibleStamps = (rows: RotationItemRow[], offered: Array<{ value: string; text: string }>, status: 'Spare' | 'In Store') => {
    const inMaster = rows.filter((row) => row.status === status).map((row) => row.stamp);
    const eligible = offered.filter((option) => inMaster.includes(option.value));
    if (!eligible.length) {
      throw new Error(`Missing prerequisite: no stamp with status ${status} in the Rotation Item Master List for Vessel ${vessel} is offered in the Stamp dropdown. ${status} stamps in the master list: ${inMaster.join(', ') || 'none'}; dropdown offered: ${offered.map((option) => option.value).join(', ') || 'none'}`);
    }
    return { inMaster, eligible };
  };
  const describeStatus = (rows: RotationItemRow[], ...stamps: string[]) => stamps
    .map((stamp) => {
      const row = statusOf(rows, stamp);
      return row ? `${stamp} is "${row.status}"${row.installedOn && row.installedOn !== '-' ? ` on ${row.installedOn}` : ''}` : `${stamp} is not listed`;
    }).join('; ');

  const replacementStep = (): PlannedStep => ({
    title: `Open Replace for ${common.code} and read the replacement choices`,
    expected: 'The Replace popup should list the stamps that can replace the installed one, without the installed stamp itself.',
  });
  const readReplacementChoices = async (plan: ScenarioPlan) => {
    const { title, expected } = replacementStep();
    plan.begin(title);
    return componentActionStep(title, expected, async () => {
      const dialog = await components.openStampReplacement();
      const choices = await components.readStampReplacementChoices(dialog);
      await test.info().attach(`${COMPONENT_VALIDATION_SCREENSHOT_PREFIX}${title}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await components.closeStampReplacement(dialog);
      return choices;
    }, (choices) => `The Replace popup listed ${choices.length} stamp(s): ${choices.map((choice) => `${choice.stamp} (${choice.status})`).join(', ') || 'none'}; it was closed without a change.`);
  };

  const checkStep = async <T>(plan: ScenarioPlan, planned: PlannedStep, body: () => Promise<T>, actual: (value: T) => string): Promise<T> => {
    plan.begin(planned.title);
    return componentActionStep(planned.title, planned.expected, body, actual, { page });
  };

  /** The scenario's single overall validation; the report uses it as the test case result. */
  const verify = async <T>(plan: ScenarioPlan, planned: PlannedStep, body: () => Promise<T>, actual: (value: T) => string): Promise<T> => {
    plan.begin(planned.title);
    return componentValidationStep(page, step(planned.title, planned.expected, 'Recorded after the validation completes.'), body, { actual });
  };

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(5 * 60_000);
    browserInstance = browser;
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    const vesselChanged = await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    await test.step(step(
      vesselChanged ? `Initial setup - Select Vessel ${vessel}` : `Initial setup - Confirm Vessel ${vessel} is selected`,
      `The authenticated Components page should show Vessel ${vessel} with its component tree loaded.`,
      vesselChanged
        ? `Vessel ${vessel} was selected and its component tree loaded without using Expand All.`
        : `Vessel ${vessel} was already selected when Components opened; its component tree loaded without using Expand All.`,
    ), async () => {});

    // A replacement worker in the same run reuses this run's component.
    const tracked = (await readTrackedComponents()).find((item) => item.sourceSpec === sourceSpec
      && item.runId === runId && item.vessel === vessel && item.cleanupStatus === 'pending');
    if (tracked) {
      common = { code: tracked.code, name: tracked.name, parentCode: tracked.parentCode };
      await componentActionStep(
        `Initial setup - Reopen this run's rotation automation Component ${common.code}`,
        `Component ${label()}, created earlier in this run, should still exist in Vessel ${vessel}.`,
        () => components.searchAndSelectComponentByCode(common.code),
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
    common = { code: `ATROT-${id}`, name: `Rotation Stamp Automation ${id}`, parentCode: parent.code };
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
      parentCode: common.parentCode,
      code: common.code,
      name: common.name,
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
    const optional = { Model: 'Rotation-Test-Model', 'Drawing No': 'ROT-DWG-001', 'Notes / Technical Information': 'Automation-owned component for Rotation Item and Stamp validation. Retained for manual cleanup.' };
    await componentActionStep(
      'Initial setup - Enter Model, Drawing No., Notes, Criticality and Condition Based',
      `The form should retain Model "${optional.Model}", Drawing No. "${optional['Drawing No']}", the technical note, and Criticality and Condition Based No.`,
      async () => {
        await form.fillOptional(optional);
        await form.setYesNo('Criticality', 'select-criticality-field', 'No');
        await form.setYesNo('Condition Based', 'select-condition-based', 'No');
        return form.readRotationItemState();
      },
      (state) => `The form retained Model "${optional.Model}", Drawing No. "${optional['Drawing No']}", the note, and Criticality/Condition Based No; Rotational Item stayed "${state.rotationalItem}".`,
    );
    await form.saveValid();
    await trackCreatedComponent({ ...common, vessel, sourceSpec, testCaseId: 'CMP-109-CMP-115', runId, createdAt: new Date().toISOString() });
    await componentActionStep(
      `Initial setup - Refresh and verify Component ${common.code} under ${parent.code}`,
      `After refresh, exactly one Component ${label()} should exist in Vessel ${vessel} directly under ${parent.code} (${parent.name}).`,
      async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const state = await selectComponent();
        const rows = await components.readExpandedTreeRows();
        const index = rows.findIndex((row) => row.code === common.code);
        expect(index, `Component ${common.code} should be shown in the tree`).toBeGreaterThanOrEqual(0);
        let parentIndex = index - 1;
        while (parentIndex >= 0 && rows[parentIndex].depth >= rows[index].depth) parentIndex -= 1;
        expect(rows[parentIndex]?.code, `Component ${common.code} should be shown directly under ${parent.code}`).toBe(parent.code);
        const count = await components.exactComponentCount(common.code);
        expect(count, `Exactly one Component ${common.code} should exist`).toBe(1);
        return { state, count };
      },
      ({ state, count }) => `After refresh, ${count} Component ${label()} was shown directly under ${parent.code} in Vessel ${vessel}, with Rotational Item "${state.rotationalItem}" and Stamp "${shown(state.stamp)}".`,
    );
    testInfo.annotations.push({ type: 'runtime-component', description: `${common.code} | ${common.name} | ${vessel} | Parent ${common.parentCode} | Maker ${maker} | Category Ship General` });
  });

  test.afterEach(async () => {
    await attachFailureScreenshot(page, test.info());
    await restoreComponentsPage(page, components, vessel);
  });
  test.afterAll(async () => Promise.allSettled([secondaryContext?.close(), context?.close()]));

  test('CMP-109 - Save Rotational Item as No', componentScenario('When Rotational Item is No, the Stamp dropdown should be disabled and unavailable for selection.'), async () => {
    const check: PlannedStep = { title: 'Verify Stamp is unavailable while Rotational Item is No', expected: 'With Rotational Item No, the Stamp dropdown should be disabled and should not accept a selection.' };
    const plan = new ScenarioPlan([openStep(), editStep(), rotationalStep('No'), check, closeStep()]);
    await plan.run(async () => {
      await refreshAndOpen(plan);
      const form = await openEdit(plan);
      const state = await setRotational(plan, form, 'No');
      await verify(plan, check, async () => {
        expect(state.stampDisabled, 'Stamp should be disabled when Rotational Item is No').toBe(true);
        return state;
      }, (value) => `Rotational Item showed "${value.rotationalItem}"; Stamp showed "${value.stamp}" and was disabled.`);
      await closeWithoutSave(plan, form);
    });
  });

  test('CMP-110 - Fit an available Spare stamp', componentScenario('One Spare stamp should persist on the component after Save and refresh, the stamp should become Installed on it, only one component should exist, and the installed stamp should not be offered as a replacement.'), async () => {
    const pick: PlannedStep = { title: 'Choose a Spare stamp offered in the Stamp dropdown', expected: 'The Stamp dropdown should offer at least one stamp whose status is Spare in the Rotation Item Master List.' };
    const saved: PlannedStep = { title: 'Verify the selected stamp was saved on the component', expected: 'After Save and refresh, Rotational Item should be Yes, the saved Stamp should contain the complete unique stamp name, and exactly one component should exist.' };
    const check: PlannedStep = { title: 'Verify the Spare stamp is installed and no longer offered', expected: 'The stamp should persist on the component, show Installed on it in the Rotation Item Master List, and be absent from the Replace choices.' };
    const plan = new ScenarioPlan([openStep(), editStep(), rotationalStep('Yes'), masterStep('before fitting'), pick, selectStampStep('the Spare stamp'), saveStep(), reopenStep(), saved, masterStep('after fitting'), replacementStep(), check]);
    await plan.run(async () => {
      await refreshAndOpen(plan);
      const form = await openEdit(plan);
      await setRotational(plan, form, 'Yes');
      const before = await readMaster(plan, 'before fitting', (rows) => `Spare: ${rows.filter((row) => row.status === 'Spare').map((row) => row.stamp).join(', ') || 'none'}; In Store: ${rows.filter((row) => row.status === 'In Store').map((row) => row.stamp).join(', ') || 'none'}.`);
      const candidate = await checkStep(plan, pick, async () => {
        const offered = await form.availableStamps();
        const { inMaster, eligible } = eligibleStamps(before, offered, 'Spare');
        return { spare: eligible[0], offered: offered.length, inMaster, eligible };
      }, (value) => `Spare in the master list: ${value.inMaster.join(', ')}; ${value.eligible.length} of them offered among ${value.offered} dropdown stamp(s). ${value.spare.value} ("${value.spare.text}") was chosen.`);
      const selected = await selectStamp(plan, form, candidate.spare.value, 'the Spare stamp');
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      const count = await checkStep(plan, saved, async () => {
        expect(after.rotationalItem, 'Rotational Item should persist as Yes').toBe('Yes');
        expect(showsStamp(after.stamp, selected.name), `The saved Stamp should contain ${selected.name}`).toBe(true);
        const matches = await components.exactComponentCount(common.code);
        expect(matches, `Exactly one Component ${common.code} should exist`).toBe(1);
        return matches;
      }, (matches) => `Saved Stamp "${after.stamp}" contains ${selected.name} (selected label "${selected.label}"); Rotational Item is "${after.rotationalItem}" and ${matches} component matched ${common.code}.`);
      const master = await readMaster(plan, 'after fitting', (rows) => `${describeStatus(rows, selected.name)}.`);
      const choices = await readReplacementChoices(plan);
      await verify(plan, check, async () => {
        const row = statusOf(master, selected.name);
        expect(row?.status, `${selected.name} should be Installed`).toBe('Installed');
        expect(row?.installedOn ?? '', `${selected.name} should be installed on ${common.code}`).toContain(common.code);
        expect(choices.length, 'The Replace popup should list replacement stamps').toBeGreaterThan(0);
        expect(choices.map((choice) => choice.stamp), `Installed stamp ${selected.name} should not be offered as a replacement`).not.toContain(selected.name);
        return row!;
      }, (row) => `${selected.name} persisted on ${common.code} as "${after.stamp}" (${count} component), is "${row.status}" on ${row.installedOn}, and was not among the ${choices.length} replacement choices.`);
    });
  });

  test('CMP-111 - Fit an In Store stamp', componentScenario('A stamp whose status is In Store should persist on the component, become Installed on it, release the previously fitted stamp, and be absent from the replacement choices.'), async () => {
    const pick: PlannedStep = { title: 'Choose an In Store stamp offered in the Stamp dropdown', expected: 'One stamp whose status is exactly In Store in the Rotation Item Master List should also be offered in the Stamp dropdown, matched by its unique Stamp No.' };
    const saved: PlannedStep = { title: 'Verify the In Store stamp was saved on the component', expected: 'After Save and refresh, the saved Stamp should contain the complete unique In Store stamp name and exactly one component should exist.' };
    const check: PlannedStep = { title: 'Verify the In Store stamp is installed and no longer offered', expected: 'The In Store stamp should be Installed on this component only, the previously installed stamp should be released (no longer Installed), and the new stamp should be absent from the Replace choices.' };
    const plan = new ScenarioPlan([openStep(), editStep(), rotationalStep('Yes'), masterStep('before fitting'), pick, selectStampStep('the In Store stamp'), saveStep(), reopenStep(), saved, masterStep('after fitting'), replacementStep(), check]);
    await plan.run(async () => {
      const previous = await refreshAndOpen(plan);
      const form = await openEdit(plan);
      await setRotational(plan, form, 'Yes');
      const before = await readMaster(plan, 'before fitting', (rows) => `In Store stamps: ${rows.filter((row) => row.status === 'In Store').map((row) => row.stamp).join(', ') || 'none'}.`);
      const candidate = await checkStep(plan, pick, async () => {
        // Dropdown labels combine number and name ("Test Stamp_003 — Stamp -3");
        // the option value is the unique Stamp No., so match on that only.
        const offered = await form.availableStamps();
        const { inMaster, eligible } = eligibleStamps(before, offered, 'In Store');
        return { option: eligible[0], inMaster, eligible };
      }, ({ option, inMaster, eligible }) => `In Store in the master list: ${inMaster.join(', ')}; offered in the dropdown: ${eligible.map((item) => item.value).join(', ')}. ${option.value} was chosen; its dropdown label is "${option.text}".`);
      const selected = await selectStamp(plan, form, candidate.option.value, 'the In Store stamp');
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      const count = await checkStep(plan, saved, async () => {
        expect(showsStamp(after.stamp, selected.name), `The saved Stamp should contain ${selected.name}`).toBe(true);
        const matches = await components.exactComponentCount(common.code);
        expect(matches, `Exactly one Component ${common.code} should exist`).toBe(1);
        return matches;
      }, (matches) => `Saved Stamp "${after.stamp}" contains ${selected.name}; ${matches} component matched ${common.code}.`);
      const previousStamp = noStamp(previous.stamp) ? '' : previous.stamp;
      const master = await readMaster(plan, 'after fitting', (rows) => `${describeStatus(rows, selected.name, ...(previousStamp ? [previousStamp] : []))}.`);
      const choices = await readReplacementChoices(plan);
      await verify(plan, check, async () => {
        const row = statusOf(master, selected.name);
        expect(row?.status, `${selected.name} should be Installed`).toBe('Installed');
        expect(row?.installedOn ?? '', `${selected.name} should be installed on ${common.code}`).toContain(common.code);
        expect(master.filter((item) => item.stamp === selected.name), `${selected.name} should be assigned once`).toHaveLength(1);
        if (previousStamp) expect(statusOf(master, previousStamp)?.status, `Previous stamp ${previousStamp} should no longer be Installed`).not.toBe('Installed');
        expect(choices.length, 'The Replace popup should list replacement stamps').toBeGreaterThan(0);
        expect(choices.map((choice) => choice.stamp), `Installed stamp ${selected.name} should not be offered as a replacement`).not.toContain(selected.name);
        return row!;
      }, (row) => `In Store stamp ${selected.name} persisted on ${common.code} as "${after.stamp}" (${count} component) and is "${row.status}" on ${row.installedOn}; ${previousStamp ? `previously installed stamp ${describeStatus(master, previousStamp)}, so it was released; ` : 'no stamp was installed before this scenario, so there was no stamp to release; '}it was not among the ${choices.length} replacement choices.`);
    });
  });

  test('CMP-112 - Save without changing installed Stamp', componentScenario('Editing another field and saving should keep the installed stamp unchanged, without a duplicate-stamp error, and persist the edited field.'), async () => {
    const model: PlannedStep = { title: 'Change Model without changing Stamp', expected: 'The Model field should keep the new value while the Stamp dropdown keeps the installed stamp.' };
    const reread: PlannedStep = { title: `Reopen the Edit form for ${common.code} and read Model`, expected: 'The reopened Edit form should show the new Model value.' };
    const check: PlannedStep = { title: 'Verify the Model change saved and the Stamp is unchanged', expected: 'The installed Stamp should be unchanged after Save, Save should succeed without a duplicate-stamp error, and the new Model should persist.' };
    const plan = new ScenarioPlan([openStep(), editStep(), model, saveStep(), reopenStep(), reread, closeStep(), check]);
    await plan.run(async () => {
      const before = await refreshAndOpen(plan);
      const form = await openEdit(plan);
      const newModel = `Rotation-Edited-${common.code.slice(-6)}`;
      const oldModel = await checkStep(plan, model, async () => {
        const current = await form.controlValue('Model', 'input-model');
        await form.fillOptional({ Model: newModel });
        return { current, stamp: (await form.readRotationItemState()).stamp };
      }, (value) => `Model changed from "${value.current}" to "${newModel}"; the Stamp dropdown still showed "${value.stamp}".`);
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      plan.begin(reread.title);
      const reopened = await componentActionStep(reread.title, reread.expected, async () => {
        const edit = await components.openSelectedComponentForEdit();
        await edit.expectEditReady(common.code);
        return { edit, model: await edit.controlValue('Model', 'input-model') };
      }, (value) => `The reopened Edit form showed Model "${value.model}".`);
      await closeWithoutSave(plan, reopened.edit);
      await verify(plan, check, async () => {
        expect(after.stamp, 'The installed Stamp should be unchanged').toBe(before.stamp);
        expect(reopened.model, 'The new Model should persist').toBe(newModel);
        return after;
      }, (value) => `Save succeeded without a duplicate-stamp error; Stamp stayed "${value.stamp}" (before: "${before.stamp}") and Model changed from "${oldModel.current}" to "${reopened.model}".`);
    });
  });

  test('CMP-113 - Replace an installed Stamp', componentScenario('Replacing the installed stamp with a different available stamp should persist the replacement, make it Installed on the component, and release the previous stamp so it can be chosen again.'), async () => {
    const pick: PlannedStep = { title: 'Choose a different available replacement stamp', expected: 'The Stamp dropdown should offer at least one stamp other than the installed one with status Spare or In Store.' };
    const saved: PlannedStep = { title: 'Verify the replacement stamp was saved on the component', expected: 'After Save and refresh, the saved Stamp should contain the complete unique replacement stamp name.' };
    const check: PlannedStep = { title: 'Verify the replacement is installed and the previous stamp was released', expected: 'The replacement should be Installed on the component, the previous stamp should no longer be Installed, and the Replace choices should offer the previous stamp but not the replacement.' };
    const plan = new ScenarioPlan([openStep(), editStep(), rotationalStep('Yes'), masterStep('before replacing'), pick, selectStampStep('the replacement stamp'), saveStep(), reopenStep(), saved, masterStep('after replacing'), replacementStep(), check]);
    await plan.run(async () => {
      const before = await refreshAndOpen(plan);
      const form = await openEdit(plan);
      await setRotational(plan, form, 'Yes');
      const previousStamp = before.stamp.trim();
      const master = await readMaster(plan, 'before replacing', (rows) => `${describeStatus(rows, previousStamp)}.`);
      const candidate = await checkStep(plan, pick, async () => {
        expect(noStamp(previousStamp), `CMP-113 requires the stamp installed by CMP-111; the component showed "${shown(previousStamp)}"`).toBe(false);
        const offered = await form.availableStamps();
        // Prefer a Spare stamp: a released stamp returns as Spare, so using an
        // In Store stamp here would consume the In Store test data CMP-111 needs.
        const candidates = offered.filter((option) => option.value !== previousStamp);
        const replacement = candidates.find((option) => statusOf(master, option.value)?.status === 'Spare')
          ?? candidates.find((option) => statusOf(master, option.value)?.status === 'In Store');
        if (!replacement) {
          throw new Error(`Missing prerequisite: no stamp other than ${previousStamp} with status Spare or In Store in the Rotation Item Master List is offered in the Stamp dropdown`);
        }
        return replacement;
      }, (option) => `Installed stamp is ${previousStamp}; ${option.value} ("${option.text}") with status ${statusOf(master, option.value)?.status} was chosen as the replacement.`);
      const selected = await selectStamp(plan, form, candidate.value, 'the replacement stamp');
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      await checkStep(plan, saved, async () => {
        expect(showsStamp(after.stamp, selected.name), `The saved Stamp should contain ${selected.name}`).toBe(true);
        return after;
      }, (value) => `Saved Stamp changed from "${previousStamp}" to "${value.stamp}", which contains ${selected.name}.`);
      const afterMaster = await readMaster(plan, 'after replacing', (rows) => `${describeStatus(rows, selected.name, previousStamp)}.`);
      const choices = await readReplacementChoices(plan);
      await verify(plan, check, async () => {
        expect(statusOf(afterMaster, selected.name)?.status, `${selected.name} should be Installed`).toBe('Installed');
        expect(statusOf(afterMaster, selected.name)?.installedOn ?? '', `${selected.name} should be installed on ${common.code}`).toContain(common.code);
        expect(statusOf(afterMaster, previousStamp)?.status, `Previous stamp ${previousStamp} should no longer be Installed`).not.toBe('Installed');
        const offered = choices.map((choice) => choice.stamp);
        expect(offered, `Released stamp ${previousStamp} should be offered again`).toContain(previousStamp);
        expect(offered, `Installed replacement ${selected.name} should not be offered`).not.toContain(selected.name);
        return afterMaster;
      }, (rows) => `Stamp changed from ${previousStamp} to "${after.stamp}". ${describeStatus(rows, selected.name, previousStamp)}. The ${choices.length} Replace choices included ${previousStamp} and excluded ${selected.name}.`);
    });
  });

  test('CMP-114 - Change Rotational Item from Yes to No', componentScenario('Saving Rotational Item as No should persist No after refresh, leave the component without a stamp, and release the previous stamp in the Rotation Item Master List.'), async () => {
    const dependency: PlannedStep = { title: 'Confirm the component has Rotational Item Yes with an installed stamp', expected: 'The component should show Rotational Item Yes and the stamp installed by CMP-113 before this scenario changes it.' };
    const saved: PlannedStep = { title: 'Verify Rotational Item No saved without a stamp', expected: 'After Save and refresh, Rotational Item should be No and the component should show no stamp.' };
    const offeredAgain: PlannedStep = { title: 'Check the previous stamp is offered again in the Stamp dropdown', expected: 'With Rotational Item set to Yes in an unsaved Edit form, the previous stamp should be offered for selection.' };
    const check: PlannedStep = { title: 'Verify the previous stamp was released', expected: 'Rotational Item No should persist with no stamp, the previous stamp should no longer be Installed, and it should be selectable again.' };
    const editAgain: PlannedStep = { title: `Click Edit again for Component ${common.code}`, expected: `The Edit Component form for ${common.code} should open again with Rotational Item No.` };
    const tryYes: PlannedStep = { title: 'Set Rotational Item to Yes without saving', expected: 'Rotational Item should show Yes in the unsaved form so the Stamp dropdown lists the stamps that can be fitted.' };
    const plan = new ScenarioPlan([openStep(), dependency, editStep(), rotationalStep('No'), saveStep(), reopenStep(), saved, masterStep('after release'), editAgain, tryYes, offeredAgain, closeStep(), check]);
    await plan.run(async () => {
      const before = await refreshAndOpen(plan);
      await checkStep(plan, dependency, async () => {
        expect(before.rotationalItem, `CMP-114 requires Rotational Item Yes from CMP-113; the component showed "${before.rotationalItem}"`).toBe('Yes');
        expect(noStamp(before.stamp), 'CMP-114 requires an installed stamp from CMP-113').toBe(false);
      }, () => `The component showed Rotational Item "${before.rotationalItem}" with stamp ${before.stamp}.`);
      const previousStamp = before.stamp.trim();
      const form = await openEdit(plan);
      await setRotational(plan, form, 'No');
      await save(plan, form);
      const after = await reopenAfterSave(plan);
      await checkStep(plan, saved, async () => {
        expect(after.rotationalItem, 'Rotational Item should persist as No').toBe('No');
        expect(noStamp(after.stamp), `The component should show no stamp; it showed "${shown(after.stamp)}"`).toBe(true);
      }, () => `After refresh Rotational Item was "${after.rotationalItem}" and Stamp was "${shown(after.stamp)}".`);
      const master = await readMaster(plan, 'after release', (rows) => `${describeStatus(rows, previousStamp)}.`);
      const verifyForm = await openEdit(plan, common, components, editAgain);
      plan.begin(tryYes.title);
      await componentActionStep(tryYes.title, tryYes.expected, () => verifyForm.setRotationalItem('Yes'),
        (state) => `Rotational Item showed "${state.rotationalItem}" (not saved); Stamp was ${state.stampDisabled ? 'disabled' : 'enabled'}.`);
      const offered = await checkStep(plan, offeredAgain, () => verifyForm.availableStamps(),
        (options) => `The dropdown offered ${options.length} stamp(s)${options.some((option) => option.value === previousStamp) ? `, including ${previousStamp}` : `; ${previousStamp} was not offered`}.`);
      await closeWithoutSave(plan, verifyForm);
      await verify(plan, check, async () => {
        expect(statusOf(master, previousStamp)?.status, `Previous stamp ${previousStamp} should no longer be Installed`).not.toBe('Installed');
        expect(offered.map((option) => option.value), `Previous stamp ${previousStamp} should be selectable again`).toContain(previousStamp);
        return master;
      }, (rows) => `Rotational Item No persisted with Stamp "${shown(after.stamp)}"; ${describeStatus(rows, previousStamp)} and it was offered again in the Stamp dropdown.`);
    });
  });

  test('CMP-115 - Reject Rotational Item Yes without Stamp', componentScenario(`Saving Rotational Item Yes without a stamp should be rejected with "${mandatoryStampMessage}" and the saved component should stay unchanged.`), async () => {
    const clear: PlannedStep = { title: 'Leave Stamp unselected', expected: 'The Stamp dropdown should show no selected stamp.' };
    const submit: PlannedStep = { title: 'Click Save and capture the application response', expected: `Save should be rejected and the application should display "${mandatoryStampMessage}".` };
    const rejected: PlannedStep = { title: 'Verify Save was rejected without saving', expected: 'Save should not succeed and the Edit form should stay open with the validation message.' };
    const persisted: PlannedStep = { title: `Reopen ${common.code} and verify the saved values are unchanged`, expected: 'After the rejected Save, Rotational Item and Stamp should be the same as before the attempt.' };
    const message: PlannedStep = { title: 'Verify the mandatory-stamp message', expected: `Save should be rejected with the exact message "${mandatoryStampMessage}" and the saved component should stay unchanged.` };
    const plan = new ScenarioPlan([openStep(), editStep(), rotationalStep('Yes'), clear, submit, rejected, closeStep(), persisted, message]);
    await plan.run(async () => {
      const before = await refreshAndOpen(plan);
      const form = await openEdit(plan);
      await setRotational(plan, form, 'Yes');
      await checkStep(plan, clear, async () => {
        await form.clearStamp();
        return form.readRotationItemState();
      }, (state) => `The Stamp dropdown showed "${state.stamp}"; no stamp was selected.`);
      plan.begin(submit.title);
      const outcome = await form.submitForValidation({ feedbackPattern: /Stamp is mandatory when Rotational Item is Yes/i, expected: submit.expected });
      await checkStep(plan, rejected, async () => {
        expect(outcome.succeeded, 'Save without a stamp should be rejected').toBe(false);
        expect(outcome.formRemainedOpen, 'The Edit form should stay open after the rejected Save').toBe(true);
        return outcome;
      }, (value) => `Save was rejected${value.status ? ` with HTTP ${value.status}` : ' before any save request was sent'}; the Edit form stayed open and displayed "${value.feedback}".`);
      await closeWithoutSave(plan, form);
      const after = await checkStep(plan, persisted, async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const reopened = await selectComponent();
        expect(reopened, 'Rotational Item and Stamp should be unchanged').toEqual(before);
        return reopened;
      }, (reopened) => `Before the attempt the component showed Rotational Item "${before.rotationalItem}" and Stamp "${shown(before.stamp)}"; after reopen it showed "${reopened.rotationalItem}" and "${shown(reopened.stamp)}".`);
      await verify(plan, message, async () => {
        // The notification also shows a "Validation Error" heading; the exact
        // requirement applies to the message element itself.
        const messages = outcome.feedback.split(' | ').map((text) => text.trim());
        expect(messages, `The application should display "${mandatoryStampMessage}"`).toContain(mandatoryStampMessage);
        return messages;
      }, (messages) => `Save was rejected with "${messages.join(' | ')}"; the component still showed Rotational Item "${after.rotationalItem}" and Stamp "${shown(after.stamp)}".`);
    });
  });

  test('CMP-120 - Two components claim the same Stamp simultaneously', componentScenario('When two users save the same available stamp on two different components at the same time, exactly one Save should succeed, the other should be rejected with 500: {"error":"Failed to update component"}, and the stamp should end up on only one component.'), async () => {
    const partner: PlannedStep = { title: `Find a second component for the concurrent Save in Vessel ${vessel}`, expected: `An existing automation-owned component in Vessel ${vessel}, different from ${common.code} and without an installed stamp, should be reused; only if none exists should one new tracked component be created and verified as unique.` };
    const signIn: PlannedStep = { title: 'Sign in as the second user in a separate browser session', expected: 'The second automation user should sign in separately and open Components for the same vessel.' };
    const shared: PlannedStep = { title: 'Choose one Spare stamp offered to both users', expected: 'Both Edit forms should offer the same stamp with status Spare in the Rotation Item Master List.' };
    const concurrent: PlannedStep = { title: 'Both users click Save at the same time', expected: 'Both Save requests should be sent together and each should return a response.' };
    const responses: PlannedStep = { title: 'Verify exactly one Save succeeded', expected: 'One Save should succeed and the other should be rejected with 500: {"error":"Failed to update component"}.' };
    const finalStep: PlannedStep = { title: 'Refresh both components and read their stamps', expected: 'After refresh, both users should see the saved stamp values of their components.' };
    const masterAfter = masterStep('after concurrent Save');
    const check: PlannedStep = { title: 'Verify the stamp is assigned to only one component', expected: 'Exactly one Save should succeed, the other should be rejected with the expected response, the stamp should be Installed only on the winning component, and the rejected component should be unchanged.' };
    const user2 = config.automationUser2Username;
    const openB: PlannedStep = { title: `Second user opens the second component`, expected: `${user2} should open the second component in Vessel ${vessel} with its saved Rotational Item and Stamp.` };
    const editB: PlannedStep = { title: 'Second user clicks Edit for the second component', expected: 'The Edit Component form for the second component should finish loading for the second user.' };
    const rotationalB: PlannedStep = { title: 'Second user sets Rotational Item to Yes', expected: 'Rotational Item should show Yes and the Stamp dropdown should become available for the second user.' };
    const selectA: PlannedStep = { title: 'Primary user selects the shared stamp', expected: `The Stamp dropdown for ${common.code} should keep the shared stamp before Save.` };
    const selectB: PlannedStep = { title: 'Second user selects the shared stamp', expected: 'The Stamp dropdown for the second component should keep the same shared stamp before Save.' };
    let second: Identity = { code: '<second component>', name: '', parentCode: '' };
    const plan = new ScenarioPlan([partner, signIn, openStep(), editStep(), rotationalStep('Yes'), openB, editB, rotationalB, masterStep('before concurrent Save'), shared, selectA, selectB, concurrent, responses, finalStep, masterAfter, check]);
    await plan.run(async () => {
      const selection = await checkStep(plan, partner, async () => {
        const skipped: string[] = [];
        const candidates = (await readTrackedComponents())
          .filter((item) => item.vessel === vessel && item.cleanupStatus === 'pending' && item.code !== common.code)
          .sort((first, next) => next.createdAt.localeCompare(first.createdAt));
        // Reuse an existing automation-owned component without an installed
        // stamp, so the scenario never alters another component's stamp.
        for (const candidate of candidates) {
          try {
            const found = await components.searchAndSelectComponentByCode(candidate.code);
            if (found.name !== candidate.name || found.vesselName !== vessel) { skipped.push(`${candidate.code} (identity differs)`); continue; }
            const state = await components.readSelectedRotationItem();
            if (!noStamp(state.stamp)) { skipped.push(`${candidate.code} (stamp ${state.stamp} installed)`); continue; }
            return { target: { code: candidate.code, name: candidate.name, parentCode: candidate.parentCode }, reused: true, skipped };
          } catch {
            skipped.push(`${candidate.code} (not found in Vessel ${vessel})`);
            await restoreComponentsPage(page, components, vessel);
          }
        }
        // None is suitable: create exactly one tracked component under the same parent.
        const id = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
        const created: Identity = { code: `ATROT-${id}`, name: `Rotation Concurrency Automation ${id}`, parentCode: common.parentCode };
        await page.reload({ waitUntil: 'domcontentloaded' });
        await components.expectToBeOnPage();
        await components.selectVessel(vessel);
        await components.searchAndSelectComponentByCode(created.parentCode);
        const form = await components.openComponentForAdd();
        await form.expectAddContext(created.parentCode);
        await page.waitForLoadState('networkidle');
        await form.fillRequired({ parentCode: created.parentCode, code: created.code, name: created.name, category: 'Ship General', department: config.componentDepartment, isParent: 'No', isActive: 'Yes', actorLabel: 'the primary automation user' });
        const makers = await form.availableSelectOptions('Maker');
        expect(makers.length, 'At least one configured Maker should be available').toBeGreaterThan(0);
        await form.selectMasterValue('Maker', undefined, makers[0].value);
        await form.saveValid();
        await trackCreatedComponent({ ...created, vessel, sourceSpec, testCaseId: 'CMP-120', runId, createdAt: new Date().toISOString() });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await selectComponent(created);
        expect(await components.exactComponentCount(created.code), `Exactly one Component ${created.code} should exist`).toBe(1);
        return { target: created, reused: false, skipped };
      }, ({ target, reused, skipped }) => reused
        ? `Reused existing automation-owned Component ${target.code} (${target.name}) in Vessel ${vessel}; it had no installed stamp.${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`
        : `No suitable existing component was available${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}; created Component ${target.code} (${target.name}) under ${target.parentCode}, tracked it for manual cleanup, and confirmed exactly one exists after refresh.`);
      second = selection.target;
      const secondTarget = second;
      plan.begin(signIn.title);
      const sessionB = await componentActionStep(signIn.title, signIn.expected, async () => {
        expect(config.automationUser2Username.toLowerCase(), 'The second user must differ from the primary user').not.toBe(config.username.toLowerCase());
        secondaryContext = await browserInstance.newContext({ baseURL: config.baseUrl, viewport: null });
        const pageB = await secondaryContext.newPage();
        const loginB = new LoginPage(pageB);
        await loginB.open();
        const dashboardB = await loginB.loginForPms(config.automationUser2Username, config.automationUser2Password, config.domain);
        const componentsB = await dashboardB.goToTechnical().then((technical) => technical.goToComponents());
        await componentsB.selectVessel(vessel);
        return { pageB, componentsB };
      }, () => `User ${config.automationUser2Username} signed in in a separate browser session and opened Components for Vessel ${vessel}.`);
      // Both users prepare their own component; only the Save itself is simultaneous.
      const beforeA = await refreshAndOpen(plan);
      const formA = await openEdit(plan);
      await setRotational(plan, formA, 'Yes');
      plan.begin(openB.title);
      const beforeB = await componentActionStep(openB.title, openB.expected, async () => {
        await sessionB.pageB.reload({ waitUntil: 'domcontentloaded' });
        return selectComponent(secondTarget, sessionB.componentsB);
      }, (state) => `User ${config.automationUser2Username} opened ${label(secondTarget)} with Rotational Item "${state.rotationalItem}" and Stamp "${shown(state.stamp)}".`);
      plan.begin(editB.title);
      const formB = await componentActionStep(editB.title, editB.expected, async () => {
        const opened = await sessionB.componentsB.openSelectedComponentForEdit();
        await opened.expectEditReady(secondTarget.code);
        return opened;
      }, () => `User ${config.automationUser2Username} opened the Edit form for ${secondTarget.code}.`);
      plan.begin(rotationalB.title);
      await componentActionStep(rotationalB.title, rotationalB.expected, () => formB.setRotationalItem('Yes'),
        (state) => `For ${secondTarget.code}, Rotational Item showed "${state.rotationalItem}" and Stamp was ${state.stampDisabled ? 'disabled' : 'enabled'}.`);
      const master = await readMaster(plan, 'before concurrent Save', (rows) => `Spare: ${rows.filter((row) => row.status === 'Spare').map((row) => row.stamp).join(', ') || 'none'}.`);
      const stamp = await checkStep(plan, shared, async () => {
        const [optionsA, optionsB] = [await formA.availableStamps(), await formB.availableStamps()];
        const offeredToBoth = optionsA.filter((option) => optionsB.some((other) => other.value === option.value));
        return eligibleStamps(master, offeredToBoth, 'Spare').eligible[0].value;
      }, (value) => `Spare stamp ${value} was offered to both users.`);
      plan.begin(selectA.title);
      await componentActionStep(selectA.title, selectA.expected, () => formA.selectStamp(stamp),
        (selected) => `For ${common.code}, the Stamp dropdown showed "${selected.label}".`);
      plan.begin(selectB.title);
      await componentActionStep(selectB.title, selectB.expected, () => formB.selectStamp(stamp),
        (selected) => `For ${secondTarget.code}, the Stamp dropdown showed "${selected.label}".`);
      plan.begin(concurrent.title);
      const outcomes = await componentActionStep(concurrent.title, concurrent.expected, async () => {
        const results = await Promise.all([formA.submitForConflict(), formB.submitForConflict()]);
        await test.info().attach(`${COMPONENT_VALIDATION_SCREENSHOT_PREFIX}${concurrent.title}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
        await test.info().attach(`${COMPONENT_VALIDATION_SCREENSHOT_PREFIX}${concurrent.title}`, { body: await sessionB.pageB.screenshot({ fullPage: true }), contentType: 'image/png' });
        return results;
      }, (results) => `${common.code} (primary user) received HTTP ${results[0].status}${results[0].responseMessage ? ` "${results[0].responseMessage}"` : ''}; ${secondTarget.code} (${config.automationUser2Username}) received HTTP ${results[1].status}${results[1].responseMessage ? ` "${results[1].responseMessage}"` : ''}. Save started ${Math.abs(results[0].saveInitiatedAt - results[1].saveInitiatedAt)} ms apart.`);
      await checkStep(plan, responses, async () => {
        const successes = outcomes.filter((item) => item.status >= 200 && item.status < 300);
        const failures = outcomes.filter((item) => item.status < 200 || item.status >= 300);
        expect(successes, 'Exactly one Save should succeed').toHaveLength(1);
        expect(failures, 'Exactly one Save should be rejected').toHaveLength(1);
        // Compare the raw server body, not the message extracted from it.
        expect(failures[0].status, 'The rejected Save should return HTTP 500').toBe(500);
        let body: unknown = failures[0].responseBody;
        try { body = JSON.parse(failures[0].responseBody); } catch { /* non-JSON bodies are compared as text */ }
        expect(body, 'The rejected Save should return {"error":"Failed to update component"}').toEqual({ error: 'Failed to update component' });
        return failures[0];
      }, (failure) => `One Save succeeded and the other returned HTTP ${failure.status} with body ${failure.responseBody}.`);
      plan.begin(finalStep.title);
      const finals = await componentActionStep(finalStep.title, finalStep.expected, async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const finalA = await selectComponent(common, components);
        await sessionB.pageB.reload({ waitUntil: 'domcontentloaded' });
        const finalB = await selectComponent(secondTarget, sessionB.componentsB);
        return { finalA, finalB };
      }, ({ finalA, finalB }) => `${common.code} showed Stamp "${shown(finalA.stamp)}"; ${secondTarget.code} showed Stamp "${shown(finalB.stamp)}".`);
      const afterMaster = await readMaster(plan, 'after concurrent Save', (rows) => `${describeStatus(rows, stamp)}.`);
      await verify(plan, check, async () => {
        const holders = [finals.finalA, finals.finalB].filter((state) => showsStamp(state.stamp, stamp));
        expect(holders, `Stamp ${stamp} should be assigned to exactly one component`).toHaveLength(1);
        const aWon = outcomes[0].status >= 200 && outcomes[0].status < 300;
        const winner = aWon ? { target: common, status: outcomes[0].status, after: finals.finalA } : { target: secondTarget, status: outcomes[1].status, after: finals.finalB };
        const loser = aWon ? { target: secondTarget, status: outcomes[1].status, before: beforeB, after: finals.finalB } : { target: common, status: outcomes[0].status, before: beforeA, after: finals.finalA };
        expect(showsStamp(winner.after.stamp, stamp), `The winning component ${winner.target.code} should hold ${stamp}`).toBe(true);
        expect(loser.after, `The rejected component ${loser.target.code} should be unchanged`).toEqual(loser.before);
        const rows = afterMaster.filter((row) => row.stamp === stamp);
        expect(rows, `${stamp} should be listed once in the Rotation Item Master List`).toHaveLength(1);
        expect(rows[0].status, `${stamp} should be Installed`).toBe('Installed');
        expect(rows[0].installedOn, `${stamp} should be installed on ${winner.target.code}`).toContain(winner.target.code);
        return { winner, loser, row: rows[0] };
      }, ({ winner, loser, row }) => `${winner.target.code} won with HTTP ${winner.status} and holds ${stamp}; ${loser.target.code} was rejected with HTTP ${loser.status} and stayed Rotational Item "${loser.after.rotationalItem}", Stamp "${shown(loser.after.stamp)}" as before. The Rotation Item Master List shows ${stamp} "${row.status}" once, on ${row.installedOn}.`);
    });
  });
});
