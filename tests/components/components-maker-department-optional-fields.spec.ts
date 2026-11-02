import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentFormPage } from '../../pages/ComponentFormPage';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { attachFailureScreenshot, componentScenario, componentValidationStep } from '../../utils/componentValidationEvidence';
import { readTrackedComponents, trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

type Data = { code: string; name: string };
const step = (title: string, expected: string, actual: string, status?: 'FAIL' | 'NOT RUN') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}${status ? `\nStatus: ${status}` : ''}`;

test.describe('Components maker, department, and optional information', () => {
  test.setTimeout(5 * 60_000);
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let parentCode: string;
  let category: string;
  let department: string;
  let selectedComponentSource: 'reused' | 'newly created';
  const vessel = config.vesselA;
  let selectedComponent: Data;
  const recordedComponent: Data = {
    get code() { return selectedComponent?.code ?? 'dynamically selected component'; },
    get name() { return selectedComponent?.name ?? 'selected at runtime'; },
  };
  const runId = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;

  const data = (id: string): Data => {
    const number = id.replace('CMP-', '');
    const token = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
    return { code: `AT${number}-${token}`, name: `Test CMP${number} ${token}` };
  };

  const required = (record: Data, overrides = {}) => ({
    parentCode, code: record.code, name: record.name, category, department,
    isParent: 'No' as const, isActive: 'Yes' as const, ...overrides,
  });

  const openAdd = async (): Promise<ComponentFormPage> => {
    await components.clearComponentSearch();
    await components.selectVessel(vessel);
    await components.searchAndSelectComponentByCode(parentCode);
    return components.openComponentForAdd();
  };

  /** saveValid() performs the single reload; this verifies and restores its resulting register state. */
  const restoreAfterSuccessfulSave = async (record: Data): Promise<void> => {
    await test.step(step(
      `Refresh Components after saving ${record.code}`,
      `After the successful Save, the refreshed Components page should remain authenticated, restore Vessel ${vessel}, finish loading its tree, and clear stale search state.`,
      `The successful Save reload completed, the authenticated Components page remained available, Vessel ${vessel} was restored, its tree finished loading, and stale search state was cleared.`,
    ), async () => {
      await components.expectToBeOnPage();
      await components.selectVessel(vessel);
      await components.expectVesselSelected(vessel);
      await components.expectTreeLoaded();
      await components.clearComponentSearch();
    });
  };

  const saveEdit = async (form: ComponentFormPage, record: Data): Promise<void> => {
    await form.saveValid();
    await restoreAfterSuccessfulSave(record);
  };

  const detail = (label: string, section = 'A. Component Information') =>
    components.readSelectedComponentDetail({ section, label });

  const makerOptions = async (form: ComponentFormPage) => {
    const options = await form.availableSelectOptions('Maker');
    expect(options.length, 'At least two configured Maker values are required for CMP-062 through CMP-064').toBeGreaterThanOrEqual(2);
    return options;
  };

  const blankDetail = (value: string): string => value.trim().replace(/^[—–-]$/, '');

  const openSelectedExistingComponent = async (): Promise<ComponentFormPage> => {
    await components.clearComponentSearch();
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    const identity = await components.searchAndSelectComponentByCode(selectedComponent.code);
    expect(identity.code).toBe(selectedComponent.code);
    expect(identity.name).toBe(selectedComponent.name);
    expect(identity.vesselName).toBe(vessel);
    await components.searchAndSelectComponentByCode(selectedComponent.code);
    const form = await components.openSelectedComponentForEdit();
    await form.expectEditReady(selectedComponent.code);
    return form;
  };
  const openRecordedComponent = openSelectedExistingComponent;

  const differentMaker = async (form: ComponentFormPage, current: string) => {
    const options = await makerOptions(form);
    const normalizedCurrent = current.replace(/^select maker\s*/i, '').trim();
    const preferred = ['MKR-000136', 'MKR-000171'];
    const option = preferred.map((code) => options.find((candidate) => candidate.value === code))
      .find((candidate) => candidate && candidate.text !== normalizedCurrent)
      ?? options.find((candidate) => candidate.text !== normalizedCurrent);
    expect(option, `A Maker different from "${normalizedCurrent || 'blank'}" should be available`).toBeTruthy();
    return option!;
  };

  const selectEligibleExistingComponent = async (): Promise<Data | undefined> => {
    const candidates = (await readTrackedComponents())
      .filter((record) => record.vessel === vessel && (record.cleanupStatus === undefined || record.cleanupStatus === 'pending'))
      .sort((first, second) => first.code.localeCompare(second.code));

    for (const candidate of candidates) {
      try {
        await components.clearComponentSearch();
        const identity = await components.searchAndSelectComponentByCode(candidate.code);
        if (identity.name !== candidate.name || identity.vesselName !== vessel) continue;
        const form = await components.openSelectedComponentForEdit();
        await form.expectEditReady(candidate.code);
        expect(await form.controlValue('Component Name', 'input-component-name')).toBe(candidate.name);
        await form.back();
        return { code: identity.code, name: identity.name };
      } catch {
        await restoreComponentsPage(page, components, vessel).catch(() => undefined);
      }
    }

    // The cleanup ledger can legitimately contain no pending records after a
    // manual cleanup. In that case, use the visible Components search with
    // approved test-name markers, then validate every returned identity.
    const fixtureCandidates: Data[] = [];
    for (const term of ['AAAA', 'AUTO', 'Test CMP']) {
      const rows = await components.searchTree(term);
      fixtureCandidates.push(...rows.filter((candidate) =>
        candidate.code.length >= 6
          && /^(?:AAAA|AUTO|Test CMP)/i.test(candidate.name)));
      await components.clearComponentSearch();
      if (fixtureCandidates.length) break;
    }
    for (const candidate of fixtureCandidates) {
      try {
        const identity = await components.searchAndSelectComponentByCode(candidate.code);
        if (identity.name !== candidate.name || identity.vesselName !== vessel) continue;
        const form = await components.openSelectedComponentForEdit();
        await form.expectEditReady(candidate.code);
        expect(await form.controlValue('Component Name', 'input-component-name')).toBe(candidate.name);
        await form.back();
        return { code: identity.code, name: identity.name };
      } catch {
        await restoreComponentsPage(page, components, vessel).catch(() => undefined);
      }
    }
    return undefined;
  };

  const createReusableComponent = async (): Promise<Data> => {
    const record = data('CMP-062');
    expect(await components.exactComponentCountFullyLoaded(record.code)).toBe(0);
    const form = await openAdd();
    await form.fillRequired(required(record));
    await form.saveValid();
    await trackCreatedComponent({
      ...record,
      vessel,
      parentCode,
      sourceSpec: 'components-maker-department-optional-fields.spec.ts',
      testCaseId: 'CMP-062-CMP-073 shared preparation',
      runId,
      createdAt: new Date().toISOString(),
    });
    await restoreAfterSuccessfulSave(record);

    // The Create request has already succeeded and is tracked. Recover only
    // this exact identity; never issue a second Create request if lookup lags.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const identity = await components.searchAndSelectComponentByCode(record.code);
        expect(identity).toMatchObject({ code: record.code, name: record.name, vesselName: vessel });
        const reopened = await components.openSelectedComponentForEdit();
        await reopened.expectEditReady(record.code);
        expect(await reopened.controlValue('Component Name', 'input-component-name')).toBe(record.name);
        await reopened.back();
        return record;
      } catch (error) {
        lastError = error;
        await restoreComponentsPage(page, components, vessel).catch(() => undefined);
      }
    }
    throw new Error(`Created and tracked Component ${record.code} (${record.name}), but its exact identity could not be reopened after three recovery attempts. No additional component was created.`, { cause: lastError });
  };

  const runExistingYesNoPhases = async (
    label: 'Criticality' | 'Condition Based' | 'Class Item',
    afterVerify?: (value: 'Yes' | 'No') => Promise<void>,
  ): Promise<void> => {
    await componentValidationStep(page, step(
      `Verify ${label} Yes and No on existing component ${recordedComponent.code}`,
      `${label} should persist as Yes after the first Save and reopen, then persist as No after the second Save and reopen.`,
      `${recordedComponent.code} retained ${label} Yes and then No in the two independent phases.`,
    ), async () => {
      const failures: unknown[] = [];
      const observations: Array<{ value: 'Yes' | 'No'; original: string; entered: string; observed: string }> = [];
      for (const value of ['Yes', 'No'] as const) {
        try {
          const observation = await test.step(step(
          `Set ${label} to ${value} on existing component ${recordedComponent.code}`,
          `${label} should show ${value} before Save and remain ${value} after one refresh and reopening the same component.`,
          `${recordedComponent.code} reopened with ${label} ${value}.`,
          ), async () => {
            let form = await openRecordedComponent();
            const original = await form.controlValue(label);
            await form.setYesNo(label, undefined, value);
            const entered = await form.controlValue(label);
            expect(entered).toBe(value);
            await saveEdit(form, recordedComponent);
            form = await openRecordedComponent();
            const observed = await form.controlValue(label);
            await form.back();
            expect(observed).toBe(value);
            await afterVerify?.(value);
            return { value, original, entered, observed };
          });
          observations.push(observation);
        } catch (error) {
          failures.push(error);
          await restoreComponentsPage(page, components, vessel).catch(() => undefined);
        }
      }
      if (failures.length) throw failures[0];
      return observations;
    }, { actual: (observations) => observations.map(({ value, original, entered, observed }) => `${label} ${value} phase: original "${original}", entered "${entered}", observed after reopen "${observed}".`).join('\n') });
  };

  test.beforeAll(async ({ browser }, testInfo) => {
    // A failed test causes Playwright to start a replacement worker. Give that
    // worker's saved-authentication recovery the same allowance as the suite so
    // a slow Components reload does not skip the remaining independent cases.
    testInfo.setTimeout(5 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await test.step(step(
      `Initial setup - Select Vessel ${vessel}`,
      `The shared Components session should select Vessel ${vessel} once.`,
      `The shared Components session selected Vessel ${vessel}.`,
    ), async () => components.selectVessel(vessel));
    await test.step(step(
      `Initial setup - Verify component tree for Vessel ${vessel}`,
      `The component tree for Vessel ${vessel} should be ready before the scenarios begin.`,
      `The component tree for Vessel ${vessel} finished loading.`,
    ), async () => components.expectTreeLoaded());
    const visibleRows = await components.readExpandedTreeRows();
    const liveParent = visibleRows.find((row) => !/^AT\d{3}-/i.test(row.code));
    expect(liveParent, `Vessel ${vessel} should expose at least one live component parent`).toBeTruthy();
    parentCode = liveParent!.code;
    category = 'Ship General';
    department = config.componentDepartment;
    await test.step(step(
      `Initial setup - Select one eligible existing automation component`,
      `The suite should reuse one eligible existing automation component in Vessel ${vessel}; if none exists, it should create and track exactly one valid fallback, then reuse the same identity for CMP-062 through CMP-073.`,
      `One safe automation component was prepared through the UI and its exact code, name, vessel, editability, and preparation source were captured for all twelve scenarios.`,
    ), async () => {
      const existing = await selectEligibleExistingComponent();
      selectedComponentSource = existing ? 'reused' : 'newly created';
      selectedComponent = existing ?? await createReusableComponent();
      await test.step(step(
        `Record selected Component ${selectedComponent.code} (${selectedComponent.name})`,
        `The reusable component identity should contain its exact Component Code, Name, Vessel ${vessel}, and whether it was reused or newly created.`,
        `The suite ${selectedComponentSource === 'reused' ? 'reused' : 'newly created and tracked'} Component ${selectedComponent.code} (${selectedComponent.name}) in Vessel ${vessel}; its exact identity and editable form were verified through the UI.`,
      ), async () => {});
      testInfo.annotations.push({
        type: 'components-selected-shared-component',
        description: `${selectedComponent.code} | ${selectedComponent.name} | ${vessel} | ${selectedComponentSource}`,
      });
    });
  });

  test.afterEach(async () => {
    await attachFailureScreenshot(page, test.info());
    await restoreComponentsPage(page, components, vessel);
  });
  test.afterAll(async () => context?.close());

  test('CMP-062 - Maker selection automatically populates Maker Code', componentScenario(`Selecting a configured Maker on existing component ${recordedComponent.code} should automatically populate its dependent Maker Code, and the pair should persist after Save, refresh, and reopen.`), async () => {
    await componentValidationStep(page, step(`Select Maker on existing component ${recordedComponent.code}`, `A configured Maker should populate its paired Maker Code and both values should persist after Save, refresh, and reopen.`, `The existing component retained the selected Maker and paired Maker Code after reopening.`), async () => {
      const form = await openRecordedComponent();
      const originalMaker = (await form.controlValue('Maker')).trim();
      const originalCode = await form.controlValue('Maker Code');
      const maker = await differentMaker(form, originalMaker);
      await test.step(step(`Select Maker "${maker.text}" on ${recordedComponent.code}`, `Existing component ${recordedComponent.code} should accept Maker "${maker.text}" and automatically populate its paired Maker Code.`, `The component originally showed Maker "${originalMaker}" and Maker Code "${originalCode}"; Maker "${maker.text}" was selected.`), () => form.selectMasterValue('Maker', undefined, maker.value));
      await expect.poll(() => form.controlValue('Maker Code'), { message: 'Maker Code should populate after Maker selection' }).not.toBe('');
      const attemptedCode = await form.controlValue('Maker Code');
      await test.step(step(`Verify automatic Maker Code before Save`, 'Maker Code should contain the code paired with the selected Maker.', `Maker Code automatically changed from "${originalCode}" to "${attemptedCode}".`), async () => expect(attemptedCode).not.toBe(originalCode));
      await saveEdit(form, recordedComponent);
      await components.searchAndSelectComponentByCode(recordedComponent.code);
      const actualMaker = await detail('Maker');
      const actualCode = await detail('Maker Code');
      expect(actualMaker).toContain(maker.text);
      expect(actualCode).toContain(attemptedCode);
      return { originalMaker, originalCode, attemptedMaker: maker.text, attemptedCode, actualMaker, actualCode };
    }, { actual: ({ originalMaker, originalCode, attemptedMaker, attemptedCode, actualMaker, actualCode }) => `Existing component ${recordedComponent.code} originally had Maker "${originalMaker}" and Maker Code "${originalCode}". The test attempted Maker "${attemptedMaker}" with auto-populated code "${attemptedCode}"; after Save, refresh, and reopen, the application showed Maker "${actualMaker}" and Maker Code "${actualCode}".` });
  });

  test('CMP-063 - Change Maker and preserve paired Maker Code', componentScenario(`Changing Maker on existing component ${recordedComponent.code} should replace the dependent Maker Code and the new pair should remain after Save, refresh, and reopen.`), async () => {
    await componentValidationStep(page, step(`Change Maker on existing component ${recordedComponent.code}`, `A different configured Maker should replace Maker Code and the changed pair should persist after Save, refresh, and reopen.`, `The existing component retained the changed Maker and paired Maker Code after reopening.`), async () => {
      const form = await openRecordedComponent();
      const originalMaker = (await form.controlValue('Maker')).trim();
      const originalCode = await form.controlValue('Maker Code');
      const next = await differentMaker(form, originalMaker);
      await test.step(step(`Choose replacement Maker "${next.text}"`, `The Maker picker should replace "${originalMaker}" with "${next.text}".`, `The Maker picker displayed "${next.text}".`), () => form.selectMasterValue('Maker', undefined, next.value));
      await expect.poll(() => form.controlValue('Maker Code')).not.toBe('');
      const attemptedCode = await form.controlValue('Maker Code');
      await test.step(step(`Change Maker from "${originalMaker}" to "${next.text}"`, `Maker should change to "${next.text}" and Maker Code should change from "${originalCode}" to the paired code.`, `Maker changed to "${next.text}" and Maker Code changed to "${attemptedCode}" before Save.`), async () => expect(attemptedCode).not.toBe(originalCode));
      await saveEdit(form, recordedComponent);
      await components.searchAndSelectComponentByCode(recordedComponent.code);
      const actualMaker = await detail('Maker');
      const actualCode = await detail('Maker Code');
      expect(actualMaker).toContain(next.text);
      expect(actualCode).toContain(attemptedCode);
      return { originalMaker, originalCode, attemptedMaker: next.text, attemptedCode, actualMaker, actualCode };
    }, { actual: ({ originalMaker, originalCode, attemptedMaker, attemptedCode, actualMaker, actualCode }) => `Existing component ${recordedComponent.code} originally had Maker "${originalMaker}" and Maker Code "${originalCode}". The test changed them to "${attemptedMaker}" and "${attemptedCode}"; after reopening, the application showed Maker "${actualMaker}" and Maker Code "${actualCode}".` });
  });

  test('CMP-064 - Clear optional Maker and Maker Code', componentScenario(`Clearing Maker on existing component ${recordedComponent.code} with the adjacent clear control should also clear Maker Code, and both fields should remain blank after Save, refresh, and reopen.`), async () => {
    await componentValidationStep(page, step(`Clear Maker on existing component ${recordedComponent.code}`, `The adjacent × control should clear Maker and Maker Code, and both blanks should persist after Save, refresh, and reopen.`, `The existing component reopened with Maker and Maker Code blank.`), async () => {
      let form = await openRecordedComponent();
      let originalMaker = (await form.controlValue('Maker')).trim();
      let originalCode = await form.controlValue('Maker Code');
      if (/^select maker/i.test(originalMaker) || originalCode === '') {
        const setupMaker = await differentMaker(form, originalMaker);
        await test.step(step(`Prepare ${recordedComponent.code} with Maker "${setupMaker.text}"`, `Because the existing component starts blank, it should accept a Maker so the independent clear scenario has a populated value to clear.`, `Maker "${setupMaker.text}" was selected for the clear scenario.`), () => form.selectMasterValue('Maker', undefined, setupMaker.value));
        await expect.poll(() => form.controlValue('Maker Code')).not.toBe('');
        await saveEdit(form, recordedComponent);
        form = await openRecordedComponent();
        originalMaker = (await form.controlValue('Maker')).trim();
        originalCode = await form.controlValue('Maker Code');
      }
      const cleared = await form.clearOptionalSelect('Maker');
      await test.step(step(`Clear Maker with the adjacent × control`, 'Maker should display "Select maker" and its dependent Maker Code should become blank before Save.', `Maker changed from "${originalMaker}" to "${cleared.value}" and Maker Code changed from "${originalCode}" to "${cleared.dependentValue}".`), async () => {
        expect(cleared.value).toContain('Select maker');
        expect(cleared.dependentValue).toBe('');
      });
      await saveEdit(form, recordedComponent);
      await components.searchAndSelectComponentByCode(recordedComponent.code);
      const actualMaker = blankDetail(await detail('Maker'));
      const actualCode = blankDetail(await detail('Maker Code'));
      expect(actualMaker).toBe('');
      expect(actualCode).toBe('');
      return { originalMaker, originalCode, actualMaker, actualCode };
    }, { actual: ({ originalMaker, originalCode, actualMaker, actualCode }) => `Existing component ${recordedComponent.code} had Maker "${originalMaker}" and Maker Code "${originalCode}" before clearing. After Save, refresh, and reopen, the application showed Maker "${actualMaker || 'blank'}" and Maker Code "${actualCode || 'blank'}".` });
  });

  test('CMP-065 - Maker Code cannot be edited independently', componentScenario(`Maker Code on existing component ${recordedComponent.code} should remain controlled by Maker selection and should not allow independent user editing.`), async () => {
    await componentValidationStep(page, step(`Attempt independent Maker Code edit on existing component ${recordedComponent.code}`, `Maker Code should remain controlled by Maker and reject independent editing.`, `Maker Code was read-only when the existing component was opened for editing.`), async () => {
      const form = await openRecordedComponent();
      const code = await form.controlValue('Maker Code');
      const editable = await form.controlIsEditable('Maker Code');
      await test.step(step('Check Maker Code editability', 'The Maker Code control should reject direct editing, as shown in the manual workflow.', `Maker Code displayed "${code}" and was ${editable ? 'editable' : 'read-only'}.`), async () => expect(editable).toBe(false));
      await form.back();
      return { code, editable };
    }, { actual: ({ code, editable }) => `On existing component ${recordedComponent.code}, Maker Code displayed "${code}" and the application exposed it as ${editable ? 'editable' : 'read-only'}, without creating or saving another component.` });
  });

  test('CMP-066 - Save every allowed Department with valid Category', componentScenario('Every enabled Department master value should persist in turn on the dynamically selected existing component while its valid Category remains unchanged.'), async () => {
    await componentValidationStep(page, step(`Save every allowed Department on existing component ${recordedComponent.code}`, 'Every enabled Department should persist in turn while the existing valid Component Category remains unchanged.', `${recordedComponent.code} retained every allowed Department in turn and preserved its Component Category.`), async () => {
      let probe = await openRecordedComponent();
      const departments = await probe.availableSelectOptions('Equipment / System Department', 'select-eqpt-system-dept');
      const existingCategory = await probe.controlValue('Component Category', 'select-component-category');
      await probe.back();
      expect(departments.length, 'At least one allowed Department is required').toBeGreaterThan(0);
      const failures: unknown[] = [];
      for (const option of departments) {
        try {
          await test.step(step(`Save Department "${option.text}" on ${recordedComponent.code}`, `Department "${option.text}" should persist after Save, one refresh, and reopen while Category remains "${existingCategory}".`, `${recordedComponent.code} reopened with Department "${option.text}" and Category "${existingCategory}".`), async () => {
            let form = await openRecordedComponent();
            await form.selectMasterValue('Equipment / System Department', 'select-eqpt-system-dept', option.value);
            expect(await form.controlValue('Equipment / System Department', 'select-eqpt-system-dept')).toBe(option.value);
            await saveEdit(form, recordedComponent);
            form = await openRecordedComponent();
            const observedDepartment = await form.controlValue('Equipment / System Department', 'select-eqpt-system-dept');
            const observedCategory = await form.controlValue('Component Category', 'select-component-category');
            await form.back();
            expect(observedDepartment).toBe(option.value);
            expect(observedCategory).toBe(existingCategory);
          });
        } catch (error) {
          failures.push(error);
          await restoreComponentsPage(page, components, vessel).catch(() => undefined);
        }
      }
      if (failures.length) throw failures[0];
      return { departmentCount: departments.length, existingCategory };
    }, { actual: ({ departmentCount, existingCategory }) => `${departmentCount} enabled Department values were saved and reopened on ${recordedComponent.code}; Component Category remained "${existingCategory}" throughout.` });
  });

  test('CMP-067 - Criticality Yes and No persist and filter correctly', componentScenario('Criticality should persist as Yes and No in turn, and the corresponding register filter should include the component only in the matching view.'), async () => {
    await runExistingYesNoPhases('Criticality', async (value) => {
      const filter = value === 'Yes' ? 'Critical Only' : 'Non-Critical';
      await test.step(step(`Apply the ${filter} filter for ${recordedComponent.code}`, `The ${filter} view should include ${recordedComponent.code} after saving Criticality ${value}.`, `The ${filter} view included ${recordedComponent.code}.`), async () => {
        await components.applyCriticalFilter(filter); expect(await components.treeContainsCode(recordedComponent.code)).toBe(true);
      });
      await components.resetTreeFilters();
    });
  });

  test('CMP-068 - Condition Based Yes and No persist', componentScenario('Condition Based should persist correctly after saving Yes and then No on the same component.'), async () => {
    await runExistingYesNoPhases('Condition Based');
  });

  test('CMP-069 - Class Item Yes and No persist', componentScenario('Class Item should persist correctly after saving Yes and then No on the same component.'), async () => {
    await runExistingYesNoPhases('Class Item');
  });

  test('CMP-070 - Installation and Commissioned dates persist', componentScenario('Valid Installation and Commissioned dates should reopen on the same calendar dates without timezone shift or formatting corruption.'), async () => {
    const dates = { 'Installation Date': '2026-09-10', 'Commissioned Date': '2026-09-11' };
    await componentValidationStep(page, step(`Save dates on existing component ${recordedComponent.code}`, `Installation Date ${dates['Installation Date']} and Commissioned Date ${dates['Commissioned Date']} should remain exact after Save, one refresh, and reopen.`, `${recordedComponent.code} reopened with both entered dates unchanged.`), async () => {
      let form = await openRecordedComponent();
      const originalInstallation = await form.controlValue('Installation Date', 'input-installation-date');
      const originalCommissioned = await form.controlValue('Commissioned Date', 'input-commissioned-date');
      await form.fillOptional(dates);
      expect(await form.controlValue('Installation Date', 'input-installation-date')).toBe(dates['Installation Date']);
      expect(await form.controlValue('Commissioned Date', 'input-commissioned-date')).toBe(dates['Commissioned Date']);
      await saveEdit(form, recordedComponent);
      form = await openRecordedComponent();
      const actualInstallation = await form.controlValue('Installation Date', 'input-installation-date');
      const actualCommissioned = await form.controlValue('Commissioned Date', 'input-commissioned-date');
      await form.back();
      expect(actualInstallation).toBe(dates['Installation Date']);
      expect(actualCommissioned).toBe(dates['Commissioned Date']);
      return { originalInstallation, originalCommissioned, actualInstallation, actualCommissioned };
    }, { actual: ({ originalInstallation, originalCommissioned, actualInstallation, actualCommissioned }) => `The original dates were Installation "${originalInstallation}" and Commissioned "${originalCommissioned}". After entering "${dates['Installation Date']}" and "${dates['Commissioned Date']}", saving, refreshing once, and reopening, the application displayed "${actualInstallation}" and "${actualCommissioned}".` });
  });

  test('CMP-071 - Multiline Notes preserve line breaks', componentScenario('Multiline Notes / Technical Information should persist exactly, including line breaks.'), async () => {
    const notes = 'Main Engine Inspection\nOil pressure checked.\nCooling system inspected.\nNext maintenance scheduled.';
    await componentValidationStep(page, step(`Save multiline Notes on existing component ${recordedComponent.code}`, 'The complete four-line Notes text should persist exactly with all line breaks.', `${recordedComponent.code} reopened with the exact four-line Notes text.`), async () => {
      let form = await openRecordedComponent();
      const original = await form.controlValue('Notes / Technical Information', 'input-notes');
      await form.fillOptional({ 'Notes / Technical Information': notes });
      expect(await form.controlValue('Notes / Technical Information', 'input-notes')).toBe(notes);
      await saveEdit(form, recordedComponent);
      form = await openRecordedComponent();
      const observed = await form.controlValue('Notes / Technical Information', 'input-notes');
      await form.back();
      expect(observed).toBe(notes);
      return { original, observed };
    }, { actual: ({ original, observed }) => `Notes originally contained:\n${original}\n\nAfter Save, one refresh, and reopening ${recordedComponent.code}, Notes contained:\n${observed}` });
  });

  test('CMP-072 - Supported punctuation and Unicode persist', componentScenario('Supported punctuation and Unicode characters should persist exactly in optional text fields.'), async () => {
    const notes = 'Inspection: OK! @#$% & (Test-01)\nTemperature: 35°C; Pressure: 5.5 bar.\nहिंदी परीक्षण — Français — 日本語\nSpecial characters: / \\ [ ] { } : ; " \' ? !';
    await componentValidationStep(page, step(`Save punctuation and Unicode Notes on existing component ${recordedComponent.code}`, 'The complete Notes text should persist with every punctuation mark, Unicode character, space, and line break unchanged.', `${recordedComponent.code} reopened with the exact punctuation and Unicode Notes text.`), async () => {
      let form = await openRecordedComponent();
      const original = await form.controlValue('Notes / Technical Information', 'input-notes');
      await form.fillOptional({ 'Notes / Technical Information': notes });
      expect(await form.controlValue('Notes / Technical Information', 'input-notes')).toBe(notes);
      await saveEdit(form, recordedComponent);
      form = await openRecordedComponent();
      const observed = await form.controlValue('Notes / Technical Information', 'input-notes');
      await form.back();
      expect(observed).toBe(notes);
      return { original, observed };
    }, { actual: ({ original, observed }) => `Notes originally contained:\n${original}\n\nAfter Save, one refresh, and reopening ${recordedComponent.code}, Notes contained:\n${observed}` });
  });

  test('CMP-073 - Clear saved optional information', componentScenario('Cleared optional values should remain blank after save, refresh, and reopen.'), async () => {
    const initial = { Model: 'CMP073 model', 'Serial No.': 'CMP073 serial', 'Drawing No': 'CMP073 drawing', Location: 'CMP073 location', Rating: '73 kW', 'Notes / Technical Information': 'CMP073 notes', 'Installation Date': '2026-03-10', 'Commissioned Date': '2026-03-11' };
    await componentValidationStep(page, step(
      `Populate and clear optional information on shared component ${recordedComponent.code}`,
      'The eight scenario-specific optional fields should first persist with their test values, then remain blank after they are cleared, saved, refreshed once, and reopened; unrelated master data should remain untouched.',
      `${recordedComponent.code} retained the eight test values, then reopened with those same eight optional fields blank without changing unrelated master data.`,
    ), async () => {
      let form = await openRecordedComponent();
      const original = Object.fromEntries(await Promise.all(Object.keys(initial).map(async (label) => [label, await form.controlValue(label, label === 'Notes / Technical Information' ? 'input-notes' : undefined)])));
      await test.step(step(
        `Enter optional information on ${recordedComponent.code}`,
        'All eight configured optional values should be displayed before Save while required and master-data fields remain unchanged.',
        'The shared component displayed the configured model, serial number, drawing number, location, rating, Notes, Installation Date, and Commissioned Date before Save.',
      ), async () => {
        await form.fillOptional(initial);
        for (const [label, value] of Object.entries(initial)) expect(await form.controlValue(label, label === 'Notes / Technical Information' ? 'input-notes' : undefined)).toBe(value);
      });
      await saveEdit(form, recordedComponent);
      form = await openRecordedComponent();
      for (const [label, value] of Object.entries(initial)) expect(await form.controlValue(label, label === 'Notes / Technical Information' ? 'input-notes' : undefined)).toBe(value);

      const cleared = Object.fromEntries(Object.keys(initial).map((key) => [key, '']));
      await test.step(step(
        `Clear the eight optional fields on ${recordedComponent.code}`,
        'Every scenario-populated optional field should accept an empty value before Save without clearing unrelated information or master data.',
        'The Edit form showed the eight scenario-specific optional fields blank before Save; no unrelated field was edited.',
      ), async () => {
        await form.fillOptional(cleared);
        for (const label of Object.keys(initial)) expect(await form.controlValue(label, label === 'Notes / Technical Information' ? 'input-notes' : undefined)).toBe('');
      });
      await saveEdit(form, recordedComponent);
      form = await openRecordedComponent();
      const observed = Object.fromEntries(await Promise.all(Object.keys(initial).map(async (label) => [label, await form.controlValue(label, label === 'Notes / Technical Information' ? 'input-notes' : undefined)])));
      await form.back();
      for (const value of Object.values(observed)) expect(value).toBe('');
      return { original, observed };
    }, { actual: ({ original, observed }) => `On shared component ${recordedComponent.code}, the original optional values were ${JSON.stringify(original)}. After populating, saving, reopening, clearing only those eight fields, saving, refreshing once, and reopening again, the application showed ${JSON.stringify(observed)}.` });
  });
});
