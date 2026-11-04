import fs from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { ComponentFormPage } from '../../pages/ComponentFormPage';
import type { ComponentsPage, SelectedComponentIdentity } from '../../pages/ComponentsPage';
import { attachFailureScreenshot, componentActionStep, componentObservedCheck, componentScenario, componentValidationStep, ScenarioPlan, type PlannedStep } from '../../utils/componentValidationEvidence';
import { getComponentsWorkbook, loadImportedExpectedComponentData, normalizeExpectedText } from '../../utils/componentsExpectedData';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { recordMissingTreePrerequisite, searchComponentTree } from '../../utils/componentTreeSearch';

type FleetDetails = { fleetCode: string; fleetName: string; vesselName: string; modelCode: string };
type FleetEdit = { fleetCode: string; fleetName: string; modelCode: string };
type KnownComponent = { code: string; name: string; fleetCode: string; fleetName: string };

const vessel = config.vesselName;
const sectionB = 'B. Fleet Component Information';
// Values written by CMP-166 start with this marker; such a component no longer
// holds its workbook Fleet values, so it is never chosen as known data again.
const editMarker = 'CMP166-';
// Replacement workers in one run share the run-scoped authentication file, so the
// component chosen by the first worker is reopened instead of choosing another.
const selectionFile = process.env.COMPONENTS_AUTH_STATE_PATH ? `${process.env.COMPONENTS_AUTH_STATE_PATH}.fleet-cmp165-166.json` : undefined;

const step = (title: string, expected: string) => `${title}\nExpected: ${expected}\nActual: Recorded after the validation completes.`;
const shown = (value: string) => (value ? `"${value}"` : 'blank');
const fleetText = (details: FleetEdit) => `Fleet Equipment Code ${shown(details.fleetCode)}, Fleet Component Name ${shown(details.fleetName)}, Model Code ${shown(details.modelCode)}`;

test.describe('CMP-165 to CMP-166 - Fleet Component Information', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  /** The one saved component shared by both scenarios, with its workbook Fleet values. */
  let selected: (SelectedComponentIdentity & { known: KnownComponent }) | undefined;
  /** Why no component could be selected; both scenarios are then NOT EXECUTED. */
  let unavailable = '';

  const label = () => `${selected!.code} (${selected!.name})`;

  /** Expands Section B, waits for its Fleet fields, and positions the details-panel scroller for evidence. */
  const revealFleetSection = async (): Promise<void> => {
    const detailsPanel = page.getByTestId('B7');
    await expect(detailsPanel.getByTestId('B7.1'), 'The selected Component details should finish loading').toBeVisible();
    const heading = detailsPanel.getByText(sectionB, { exact: true }).filter({ visible: true }).last();
    await expect(heading, 'Section B - Fleet Component Information should be displayed').toBeVisible({ timeout: 10_000 });
    const fields = ['Fleet Equipment Code', 'Fleet Component Name', 'Model Code', 'Vessel Name']
      .map((field) => detailsPanel.getByText(field, { exact: true }).filter({ visible: true }).last());
    if (!(await fields[0].isVisible().catch(() => false))) await heading.click();
    for (const field of fields) await expect(field, 'Section B should finish loading all Fleet fields').toBeVisible({ timeout: 10_000 });
    await heading.evaluate((node) => {
      let parent = node.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
          const offset = node.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
          parent.scrollTo({ top: Math.max(0, offset - 16), behavior: 'auto' });
          return;
        }
        parent = parent.parentElement;
      }
      node.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
    await heading.scrollIntoViewIfNeeded();
    await expect(heading, 'Section B heading should remain visible for screenshot evidence').toBeInViewport();
  };

  const readFleetDetails = async (): Promise<FleetDetails> => {
    await revealFleetSection();
    const read = (fieldLabel: string) => components.readSelectedComponentDetail({ section: sectionB, label: fieldLabel }).then(normalizeExpectedText);
    const details = {
      fleetCode: await read('Fleet Equipment Code'),
      fleetName: await read('Fleet Component Name'),
      vesselName: await read('Vessel Name'),
      modelCode: await read('Model Code'),
    };
    await revealFleetSection();
    return details;
  };

  const readFleetForm = async (form: ComponentFormPage): Promise<FleetEdit> => ({
    fleetCode: normalizeExpectedText(await form.controlValue('Fleet Equipment Code')),
    fleetName: normalizeExpectedText(await form.controlValue('Fleet Component Name')),
    modelCode: normalizeExpectedText(await form.controlValue('Model Code')),
  });

  /** Opens the shared component by code and confirms the register shows the same identity. */
  const openSelected = async (): Promise<SelectedComponentIdentity> => {
    const identity = await components.searchAndSelectComponentByCode(selected!.code);
    if (identity.code !== selected!.code || identity.name !== selected!.name || identity.vesselName !== vessel) {
      throw new Error(`Observed Application Result: Component Details showed Code ${identity.code}, Name ${identity.name}, Vessel ${identity.vesselName} instead of the selected Component ${label()} in Vessel ${vessel}.`);
    }
    await revealFleetSection();
    return identity;
  };

  const refreshAndOpen = async (): Promise<SelectedComponentIdentity> => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await components.expectToBeOnPage();
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    return openSelected();
  };

  const run = <T>(plan: ScenarioPlan, planned: PlannedStep, body: () => Promise<T>, actual: (value: T) => string): Promise<T> => {
    plan.begin(planned.title);
    return componentActionStep(planned.title, planned.expected, body, actual, { page });
  };

  /** Selects one saved component whose Fleet values are known from the imported Components workbook. */
  const selectKnownComponent = async (): Promise<void> => {
    let known: Map<string, KnownComponent>;
    try {
      const data = loadImportedExpectedComponentData(getComponentsWorkbook(), vessel);
      const counts = new Map<string, number>();
      for (const record of data.records) {
        const code = normalizeExpectedText(record['Component Code']);
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      known = new Map(data.records
        .map((record) => ({
          code: normalizeExpectedText(record['Component Code']),
          name: normalizeExpectedText(record['Component Name']),
          fleetCode: normalizeExpectedText(record['Fleet Equipment Code']),
          fleetName: normalizeExpectedText(record['Fleet Equipment Name']),
        }))
        // A code listed twice in the workbook has no single known record.
        .filter((record) => record.fleetCode && record.fleetName && counts.get(record.code) === 1)
        .map((record) => [record.code, record]));
    } catch (error) {
      unavailable = `the known Fleet data for Vessel ${vessel} could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
      await componentObservedCheck(page, 'Load the known Fleet data imported into the vessel', `The Components workbook imported into Vessel ${vessel} should provide known Fleet Equipment Code and Fleet Component Name values.`, { passed: false, actual: `No known data was available; ${unavailable}` });
      return;
    }

    const previouslyEdited: string[] = [];
    const search = await searchComponentTree(page, components, async (visit) => {
      const record = known.get(visit.identity.code);
      if (!record || record.name !== visit.identity.name || visit.identity.vesselName !== vessel) return undefined;
      const details = await readFleetDetails();
      if ([details.fleetCode, details.fleetName, details.modelCode].some((value) => value.startsWith(editMarker))) {
        previouslyEdited.push(visit.identity.code);
        return undefined;
      }
      return record;
    }, Infinity);

    if (!search.match) {
      unavailable = await recordMissingTreePrerequisite(page, search, vessel,
        `a saved component that displays Section B and has known Fleet Equipment Code and Fleet Component Name values in the imported Components workbook, not previously edited by CMP-166${previouslyEdited.length ? ` (skipped as previously edited: ${previouslyEdited.join(', ')})` : ''}`);
      return;
    }
    selected = { ...search.match.visit.identity, known: search.match.result };
    await componentObservedCheck(page, 'Record the dynamically selected component',
      'One saved component with Section B and known Fleet data should be selected from the Components tree and reused by CMP-165 and CMP-166.',
      { passed: true, actual: `Selected Vessel: ${selected.vesselName}; Selected Component Code: ${selected.code}; Selected Component Name: ${selected.name}. Known Fleet Equipment Code "${selected.known.fleetCode}" and Fleet Component Name "${selected.known.fleetName}" from the imported Components workbook. ${search.visited.length} component(s) were inspected in the tree${previouslyEdited.length ? `; skipped ${previouslyEdited.join(', ')} because CMP-166 had already changed ${previouslyEdited.length === 1 ? 'its' : 'their'} Fleet values in an earlier run` : ''}.` });
    if (selectionFile) await fs.writeFile(selectionFile, JSON.stringify(selected), 'utf8');
  };

  /** A replacement worker reopens the component the first worker selected in this run. */
  const reopenSavedSelection = async (): Promise<boolean> => {
    if (!selectionFile) return false;
    const saved = await fs.readFile(selectionFile, 'utf8').then((text) => JSON.parse(text) as NonNullable<typeof selected>).catch(() => undefined);
    if (!saved) return false;
    selected = saved;
    await componentActionStep(`Reopen Component ${saved.code} selected earlier in this run`,
      `The component already selected for CMP-165 and CMP-166, ${saved.code} (${saved.name}) in Vessel ${vessel}, should open again so both scenarios use the same component.`,
      openSelected,
      (identity) => `Selected Vessel: ${identity.vesselName}; Selected Component Code: ${identity.code}; Selected Component Name: ${identity.name}. The same component selected earlier in this run was reopened.`,
      { page });
    return true;
  };

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(10 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    if (!(await reopenSavedSelection())) await selectKnownComponent();
    if (selected) testInfo.annotations.push({ type: 'components-selected-shared-component', description: `${selected.code} | ${selected.name} | ${selected.vesselName}` });
  });

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    await restoreComponentsPage(page, components, vessel);
  });
  test.afterAll(async () => context?.close());

  test('CMP-165 - View Fleet Information and Vessel Name', componentScenario('Section B - Fleet Component Information of the selected saved component should show the Fleet Equipment Code, Fleet Component Name and Vessel Name known for that component, and still show them for the same component and vessel after a refresh.'), async () => {
    test.setTimeout(5 * 60_000);
    test.skip(!selected, `NOT EXECUTED: ${unavailable || 'no component was selected during the shared setup.'}`);
    const known = selected!.known;
    const failures: string[] = [];
    const steps = {
      open: { title: `Open Component ${selected!.code} in the Components tree`, expected: `Component ${label()} should open in Vessel ${vessel}.` },
      read: { title: 'Read Section B - Fleet Component Information', expected: `Section B of ${label()} should display its Fleet Equipment Code, Fleet Component Name and Vessel Name.` },
      refresh: { title: `Refresh Components and reopen Component ${selected!.code}`, expected: `After a browser refresh, Vessel ${vessel} should be selected and the same Component ${label()} should open.` },
      reread: { title: 'Read Section B again after refresh', expected: `Section B of ${label()} should display its Fleet values after the refresh.` },
      verify: { title: 'Verify the Fleet Information after refresh matches the known data', expected: `After refresh, Section B of ${label()} should still show Fleet Equipment Code "${known.fleetCode}", Fleet Component Name "${known.fleetName}" and Vessel Name "${vessel}".` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    const compare = async (details: FleetDetails, moment: string) => {
      for (const [field, expected, observed] of [
        ['Fleet Equipment Code', known.fleetCode, details.fleetCode],
        ['Fleet Component Name', known.fleetName, details.fleetName],
        ['Vessel Name', vessel, details.vesselName],
      ] as const) {
        const passed = observed === expected;
        if (!passed) failures.push(`${moment}, ${field} was ${shown(observed)} instead of "${expected}"`);
        await componentObservedCheck(page, `Compare ${field} ${moment} with the known data`,
          `${field} of ${label()} should be "${expected}"${field === 'Vessel Name' ? ', the vessel the component belongs to' : ', as imported from the Components workbook'}.`,
          { passed, actual: `Section B displayed ${field} ${shown(observed)}${passed ? ', matching the known data' : `; the known value is "${expected}"`}.` },
          { screenshot: 'failure' });
      }
    };

    await plan.run(async () => {
      await run(plan, steps.open, openSelected, (identity) => `Component ${identity.code} (${identity.name}) opened in Vessel ${identity.vesselName}.`);
      const before = await run(plan, steps.read, readFleetDetails, (details) => `Section B displayed Fleet Equipment Code ${shown(details.fleetCode)}, Fleet Component Name ${shown(details.fleetName)} and Vessel Name ${shown(details.vesselName)}.`);
      await compare(before, 'before refresh');
      await run(plan, steps.refresh, refreshAndOpen, (identity) => `After refresh, Component ${identity.code} (${identity.name}) opened in Vessel ${identity.vesselName}, the same component as before.`);
      const after = await run(plan, steps.reread, readFleetDetails, (details) => `After refresh, Section B displayed Fleet Equipment Code ${shown(details.fleetCode)}, Fleet Component Name ${shown(details.fleetName)} and Vessel Name ${shown(details.vesselName)}.`);
      await compare(after, 'after refresh');
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        expect(failures, `Observed Application Result: ${failures.join('; ')}.`).toEqual([]);
        return after;
      }, { actual: (details) => `Before and after refresh, Component ${label()} showed Fleet Equipment Code "${details.fleetCode}", Fleet Component Name "${details.fleetName}" and Vessel Name "${details.vesselName}", all matching the known data.` });
    });
  });

  test('CMP-166 - Edit Fleet Information', componentScenario('Editing Fleet Equipment Code, Fleet Component Name and Model Code of the selected saved component should save all three values, keep them after a refresh and reopen, and keep the component in the same vessel.'), async () => {
    test.setTimeout(6 * 60_000);
    test.skip(!selected, `NOT EXECUTED: ${unavailable || 'no component was selected during the shared setup.'}`);
    const token = Date.now().toString(36).toUpperCase().slice(-6);
    const updated: FleetEdit = { fleetCode: `${editMarker}${token}`, fleetName: `${editMarker}Fleet ${token}`, modelCode: `${editMarker}MC-${token}` };
    const steps = {
      open: { title: `Open Component ${selected!.code} in the Components tree`, expected: `Component ${label()}, the same component used by CMP-165, should open in Vessel ${vessel}.` },
      edit: { title: `Click Edit for Component ${selected!.code}`, expected: `The Edit Component form for ${label()} should finish loading with its saved Fleet values.` },
      enter: { title: 'Enter new Fleet Equipment Code, Fleet Component Name and Model Code', expected: `The form should hold ${fleetText(updated)} before Save.` },
      save: { title: `Click Save for Component ${selected!.code}`, expected: `The application should save ${label()} with the new Fleet values and return a successful response.` },
      refresh: { title: `Refresh Components and reopen Component ${selected!.code}`, expected: `After a browser refresh, Vessel ${vessel} should be selected and the same Component ${label()} should open.` },
      details: { title: 'Read Section B after refresh', expected: `Section B of ${label()} should display its Fleet Equipment Code, Fleet Component Name, Model Code and Vessel Name after the refresh.` },
      reopen: { title: `Reopen the Edit form for Component ${selected!.code}`, expected: `The Edit form of ${label()} should open again and display its saved Fleet values.` },
      verify: { title: 'Verify the edited Fleet values persisted for the same component and vessel', expected: `After refresh and reopen, ${label()} in Vessel ${vessel} should keep ${fleetText(updated)} in Section B and in the Edit form.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));

    await plan.run(async () => {
      await run(plan, steps.open, openSelected, (identity) => `Component ${identity.code} (${identity.name}) opened in Vessel ${identity.vesselName}.`);
      const { form, original } = await run(plan, steps.edit, async () => {
        const opened = await components.openSelectedComponentForEdit();
        await opened.expectEditReady(selected!.code);
        return { form: opened, original: await readFleetForm(opened) };
      }, ({ original }) => `The Edit form loaded for ${label()} with original ${fleetText(original)}.`);
      await run(plan, steps.enter, async () => {
        await form.fillOptional({ 'Fleet Equipment Code': updated.fleetCode, 'Fleet Component Name': updated.fleetName, 'Model Code': updated.modelCode });
        return readFleetForm(form);
      }, (entered) => `The form held ${fleetText(entered)} (originally ${fleetText(original)}).`);
      const { sent } = await run(plan, steps.save, async () => {
        // The Save request shows which of the entered Fleet values the form actually submitted.
        const request = page.waitForRequest((candidate) => candidate.url().includes('/technical/api/components') && candidate.method() !== 'GET' && (candidate.postData() ?? '').includes(selected!.code));
        const outcome = await form.submitForConflict();
        if (outcome.status < 200 || outcome.status >= 300) {
          throw new Error(`Observed Application Result: Save returned HTTP ${outcome.status} with "${outcome.responseMessage || outcome.uiMessage}" instead of a successful response.`);
        }
        const body = await request.then((saved) => JSON.parse(saved.postData() ?? '{}') as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
        const submitted = { fleetCode: 'fleetEquipmentCode', fleetName: 'fleetEquipmentName', modelCode: 'modelCode' } as const;
        const omitted = (['fleetCode', 'fleetName', 'modelCode'] as const).filter((key) => body[submitted[key]] !== updated[key]);
        return { outcome, sent: { omitted } };
      }, ({ outcome }) => `Save returned HTTP ${outcome.status}; the application displayed "${outcome.uiMessage}"${outcome.responseMessage ? ` and responded "${outcome.responseMessage}"` : ''}.`);
      const fieldName = { fleetCode: 'Fleet Equipment Code', fleetName: 'Fleet Component Name', modelCode: 'Model Code' } as const;
      const compareSaved = async (values: FleetEdit, where: string) => {
        for (const key of ['fleetCode', 'fleetName', 'modelCode'] as const) {
          const passed = values[key] === updated[key];
          await componentObservedCheck(page, `Compare ${fieldName[key]} in ${where} with the saved value`,
            `${where[0].toUpperCase()}${where.slice(1)} of ${label()} should show the saved ${fieldName[key]} "${updated[key]}".`,
            { passed, actual: `${where[0].toUpperCase()}${where.slice(1)} showed ${fieldName[key]} ${shown(values[key])}${passed ? ', matching the saved value' : `; the value entered and saved was "${updated[key]}"`}.` },
            { screenshot: 'failure' });
        }
      };
      const identity = await run(plan, steps.refresh, refreshAndOpen, (opened) => `After refresh, Component ${opened.code} (${opened.name}) opened in Vessel ${opened.vesselName}, the same component as before.`);
      const details = await run(plan, steps.details, readFleetDetails, (shownDetails) => `Section B displayed ${fleetText(shownDetails)} and Vessel Name ${shown(shownDetails.vesselName)}.`);
      await compareSaved(details, 'Section B after refresh');
      const reopened = await run(plan, steps.reopen, async () => {
        const reopenedForm = await components.openSelectedComponentForEdit();
        await reopenedForm.expectEditReady(selected!.code);
        const values = await readFleetForm(reopenedForm);
        await reopenedForm.back();
        return values;
      }, (values) => `The reopened Edit form held ${fleetText(values)}.`);
      await compareSaved(reopened, 'the reopened Edit form');
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const differences = [
          ...(['fleetCode', 'fleetName', 'modelCode'] as const).flatMap((key) => [
            details[key] === updated[key] ? [] : [`Section B showed ${shown(details[key])} instead of "${updated[key]}"`],
            reopened[key] === updated[key] ? [] : [`the Edit form showed ${shown(reopened[key])} instead of "${updated[key]}"`],
          ].flat()),
          ...(details.vesselName === vessel ? [] : [`Section B showed Vessel Name ${shown(details.vesselName)} instead of "${vessel}"`]),
          ...(identity.code === selected!.code && identity.name === selected!.name ? [] : [`the reopened component was ${identity.code} (${identity.name})`]),
        ];
        const notSubmitted = sent.omitted.filter((key) => differences.some((difference) => difference.includes(`"${updated[key]}"`)));
        expect(differences, `Observed Application Result: ${differences.join('; ')}.${notSubmitted.length ? ` The Save submitted by the Edit form did not include the entered ${notSubmitted.map((key) => fieldName[key]).join(' and ')}, although the form displayed them before Save.` : ''}`).toEqual([]);
        return details;
      }, { actual: (persisted) => `After refresh and reopen, Component ${label()} in Vessel ${persisted.vesselName} kept ${fleetText(persisted)} in Section B and in the Edit form (originally ${fleetText(original)}).` });
    });
  });
});
