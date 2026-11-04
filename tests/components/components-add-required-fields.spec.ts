import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentFormPage } from '../../pages/ComponentFormPage';
import { ComponentsPage, type SelectedComponentIdentity } from '../../pages/ComponentsPage';
import { componentActionStep, componentScenario, componentValidationStep } from '../../utils/componentValidationEvidence';
import { trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

const step = (title: string, expected: string, actual: string, status?: 'NOT RUN') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}${status ? `\nStatus: ${status}` : ''}`;
/** A validation step whose Actual Result is recorded from the observed values once it completes. */
const validation = (title: string, expected: string) => `${title}\nExpected: ${expected}\nActual: Recorded after the validation completes.`;
const sectionA = 'A. Component Information';
const identityText = (identity: SelectedComponentIdentity) => `${identity.code} (${identity.name}) in Vessel ${identity.vesselName}`;

test.describe('Components add and required fields', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let parentCode: string;
  let category: string;
  let department: string;
  const vessel = config.vesselA;
  const runId = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  // Draft-only data: never saved or looked up in the register, so no tree search is needed.
  const draftData = (id: string) => {
    const caseNumber = id.replace(/^CMP-?/, '');
    const token = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
    return { code: `AT${caseNumber}-${token}`, name: `Test CMP${caseNumber} ${token}` };
  };
  // Register-checked data: required when the code is saved or its absence is asserted.
  const unique = async (id: string) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const data = draftData(id);
      if (await components.exactComponentCount(data.code) === 0) return data;
    }
    throw new Error(`Unable to generate a unique component code for ${id}`);
  };

  /** Records one UI action with its observed result and a screenshot of the resulting screen. */
  const act = <T>(title: string, expected: string, body: () => Promise<T>, actual: (value: T) => string) =>
    componentActionStep(title, expected, body, actual, { page });

  test.beforeAll(async ({ browser }) => {
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    parentCode = config.cmp008ParentCode;
    await components.searchAndSelectComponentByCode(parentCode);
    category = await components.readSelectedComponentDetail({ section: sectionA, label: 'Component Category' });
    department = await components.readSelectedComponentDetail({ section: sectionA, label: 'Equipment / System Department' });
    if (!department) department = config.componentDepartment;
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // Unsaved Add form shared by consecutive required-field scenarios (CMP-036..045).
  // Each scenario sets every required field explicitly, so no state leaks between them.
  // After a failure Playwright restarts the worker, which resets this to a fresh form.
  let draft: ComponentFormPage | undefined;

  test.afterEach(async () => {
    draft = undefined;
    await restoreComponentsPage(page, components, vessel);
  });

  /** Opens a fresh Add form under the configured parent, discarding any open draft. */
  const open = async (purpose = ''): Promise<ComponentFormPage> => act(
    `Select Parent ${parentCode} and open Add Component${purpose}`,
    `Parent ${parentCode} should open in Vessel ${vessel} and the Add Component form should open beneath it.`,
    async () => {
      draft = undefined;
      if (await page.getByText('A. Component Information', { exact: true }).isVisible().catch(() => false)
        && await page.getByRole('button', { name: /back|cancel/i }).first().isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /back|cancel/i }).first().click();
      }
      await components.clearComponentSearch();
      await components.selectVessel(vessel);
      const parent = await components.searchAndSelectComponentByCode(parentCode);
      const form = await components.openComponentForAdd();
      return { parent, form };
    },
    ({ parent }) => `Parent ${identityText(parent)} was selected and the Add Component form opened.`,
  ).then(({ form }) => form);

  /** Reuses the open unsaved Add form, or opens one if none is displayed. */
  const draftForm = async (): Promise<ComponentFormPage> => {
    if (!draft || !(await draft.isAddFormOpen())) draft = await open();
    return draft;
  };
  const back = (form: ComponentFormPage, what: string) => act(`Click Back on the ${what}`, `The ${what} should close without saving and the Components register should be shown.`,
    () => form.back(), () => `The ${what} closed and the Components register was shown.`);
  const required = (data: { code: string; name: string }, overrides = {}) => ({
    parentCode, code: data.code, name: data.name, category, department, isParent: 'No' as const, isActive: 'Yes' as const, ...overrides,
  });
  const track = (data: { code: string; name: string }, testCaseId: string) => trackCreatedComponent({ ...data, vessel, parentCode, sourceSpec: 'components-add-required-fields.spec.ts', testCaseId, runId, createdAt: new Date().toISOString() });
  /** Searches the saved component and counts how many records use its code. */
  const readCreated = async (data: { code: string; name: string }, testCaseId: string) => {
    // saveValid() has already confirmed the UI save; persist the exact identity
    // before register validation so an interrupted/failed assertion remains cleanable.
    await track(data, testCaseId);
    return act(`Search for Component ${data.code} and count its records`, `Exactly one Component ${data.code} (${data.name}) should be found in Vessel ${vessel}.`,
      async () => {
        await components.selectVessel(vessel);
        const identity = await components.searchAndSelectComponentByCode(data.code);
        return { identity, count: await components.exactComponentCount(data.code) };
      },
      (state) => `Component Details showed ${identityText(state.identity)}; the register held ${state.count} record(s) with Code ${data.code}.`);
  };
  const expectCreated = (state: { identity: SelectedComponentIdentity; count: number }, data: { code: string; name: string }) => {
    expect(state.identity).toEqual({ code: data.code, name: data.name, vesselName: vessel });
    expect(state.count).toBe(1);
  };

  test('CMP-029 - Select parent and open Add Component', componentScenario('Opening Add Component from a selected parent should show that parent and propose a child code.'), async () => {
    const form = await open();
    const addContext = await act('Read the Parent Component Code and proposed Component Code', `The Add form should show Parent ${parentCode} and a proposed child code.`,
      () => form.expectAddContext(parentCode), (state) => `The Add form showed Parent ${state.parentCode} and proposed Component Code "${state.proposedCode}".`);
    await back(form, 'Add Component form');
    await componentValidationStep(page, validation('Verify the Add form context', `The form should show Parent ${parentCode} and a non-empty proposed child code.`), async () => {
      expect(addContext.parentCode).toBe(parentCode);
      expect(addContext.proposedCode.trim()).not.toBe('');
    }, { actual: () => `The form showed Parent ${addContext.parentCode} and proposed child code "${addContext.proposedCode}".` });
  });

  test('CMP-030 - Create with required fields only', componentScenario('A component saved with only the required fields should be created once beneath the selected parent.'), async () => {
    const data = await unique('CMP030');
    const form = await open();
    await form.fillRequired(required(data));
    await form.saveValid();
    const saved = await readCreated(data, 'CMP-030');
    await componentValidationStep(page, validation(`Verify Component ${data.code} was created once`, `Exactly one Component ${data.code} (${data.name}) should be saved under ${parentCode} in ${vessel}.`), async () => {
      expectCreated(saved, data);
    }, { actual: () => `Exactly one Component ${identityText(saved.identity)} was saved under ${parentCode}.` });
  });

  test('CMP-031 - Create with all supported optional fields', componentScenario('A component saved with every supported optional field should show each entered value after it is reopened.'), async () => {
    const data = await unique('CMP031');
    // The date fields are DD-MM-YYYY text inputs, as a user types them.
    const optional = { Model: `MODEL-${data.code.slice(-6)}`, 'Serial No.': `SER-${data.code.slice(-6)}`, 'Drawing No': `DRW-${data.code.slice(-6)}`, Location: 'Isolated Test Location', Rating: '100 kW', 'Notes / Technical Information': `Automated optional fields ${data.code}`, 'Installation Date': '10-01-2026', 'Commissioned Date': '11-01-2026' };
    const entries = Object.entries(optional);
    const form = await open();
    await form.fillRequired(required(data));
    await act('Enter the optional field values', 'Each optional field should hold its entered value before Save.',
      () => form.fillOptional(optional), () => `Entered ${entries.map(([label, value]) => `${label} "${value}"`).join(', ')}.`);
    await form.saveValid();
    const saved = await readCreated(data, 'CMP-031');
    const shown = await act(`Read the optional values saved on Component ${data.code}`, 'The details panel should show each optional value that was entered.',
      async () => Object.fromEntries(await Promise.all(entries.map(async ([label]) => [label, await components.readSelectedComponentDetail({ section: sectionA, label })] as const))),
      (values) => `The details panel showed ${entries.map(([label]) => `${label} "${values[label]}"`).join(', ')}.`);
    await componentValidationStep(page, validation(`Verify the optional values of Component ${data.code}`, 'Every entered optional value should persist after reopening.'), async () => {
      expectCreated(saved, data);
      expect(entries.filter(([label, value]) => !shown[label]?.includes(value)).map(([label, value]) => `${label}: entered "${value}", shown "${shown[label]}"`), 'Optional values that did not persist').toEqual([]);
    }, { actual: () => `Component ${data.code} was created once and showed every entered optional value after reopening.` });
  });

  test('CMP-032 - Is Parent Yes allows blank department', componentScenario('A grouping component with Is Parent Yes should save without an Equipment / System Department.'), async () => {
    const data = await unique('CMP032');
    const form = await open();
    await form.fillRequired(required(data, { isParent: 'Yes', department: '' }));
    await form.saveValid();
    const saved = await readCreated(data, 'CMP-032');
    const shownDepartment = await act(`Read the Equipment / System Department of Component ${data.code}`, 'The details panel should show the department saved for the parent component.',
      () => components.readSelectedComponentDetail({ section: sectionA, label: 'Equipment / System Department' }), (value) => `The details panel showed Equipment / System Department "${value}".`);
    await componentValidationStep(page, validation(`Verify parent Component ${data.code} saved without a department`, 'A grouping component with Is Parent Yes should save without a department.'), async () => {
      expectCreated(saved, data);
    }, { actual: () => `Parent Component ${data.code} saved once with Is Parent Yes and no department selected; the details panel showed department "${shownDepartment}".` });
  });

  test('CMP-033 - Create with Is Active No', componentScenario('A component saved with Is Active No should be created once and show Is Active No.'), async () => {
    const data = await unique('CMP033');
    const form = await open();
    await form.fillRequired(required(data, { isActive: 'No' }));
    await form.saveValid();
    const saved = await readCreated(data, 'CMP-033');
    const active = await act(`Read Is Active of Component ${data.code}`, 'The details panel should show Is Active No.',
      () => components.readSelectedComponentDetail({ section: 'B. Fleet Component Information', label: 'Is Active' }), (value) => `The details panel showed Is Active ${value}.`);
    await componentValidationStep(page, validation(`Verify Component ${data.code} saved as inactive`, 'Is Active No should persist and the component should remain available in the register.'), async () => {
      expectCreated(saved, data);
      expect(active).toBe('No');
    }, { actual: () => `Component ${data.code} was saved once and showed Is Active ${active}.` });
  });

  test('CMP-034 - Correct a missing required field and save', componentScenario('A Save with a missing Component Name should be blocked; after the name is entered, the component should save once.'), async () => {
    const data = await unique('CMP034');
    const form = await open();
    await form.fillRequired(required(data, { name: '' }));
    const feedback = await form.expectSaveBlocked('Component Name');
    await form.fillRequired({ name: data.name });
    await form.saveValid();
    const saved = await readCreated(data, 'CMP-034');
    await componentValidationStep(page, validation(`Verify the corrected Component ${data.code} was created once`, 'The first Save should be blocked, and after correction exactly one component should be saved.'), async () => {
      expectCreated(saved, data);
    }, { actual: () => `The first Save was blocked with "${feedback}"; after Component Name "${data.name}" was entered, ${data.code} was saved once.` });
  });

  test('CMP-035 - Abandon draft and start a fresh Add session', componentScenario('A fresh Add Component form opened after abandoning a draft should not keep the abandoned code or name.'), async () => {
    const data = draftData('CMP035');
    const first = await open();
    await first.fillRequired(required(data));
    await back(first, 'draft Add Component form');
    const form = await open(' again');
    const reopened = await act('Read Component Code and Name in the new Add form', `The new form should not hold ${data.code} or "${data.name}".`,
      async () => ({ code: await form.value('Component Code', 'input-component-code'), name: await form.value('Component Name', 'input-component-name') }),
      (state) => `The new form held Component Code "${state.code}" and Component Name "${state.name}".`);
    draft = form; // pristine form reused by CMP-036
    await componentValidationStep(page, validation('Verify the abandoned values were not kept', `The reopened form should not retain ${data.code} or ${data.name}.`), async () => {
      expect(reopened.code).not.toBe(data.code);
      expect(reopened.name).not.toBe(data.name);
    }, { actual: () => `The reopened form held Code "${reopened.code}" and Name "${reopened.name}", not the abandoned ${data.code} or "${data.name}".` });
  });

  test('CMP-036 - Save with all mandatory fields empty', componentScenario('Save with every mandatory field empty should be blocked with required-field feedback.'), async () => {
    const form = await draftForm();
    await form.fillRequired({ parentCode: '', code: '', name: '', department: '' });
    const feedback = await form.expectSaveBlocked('Mandatory fields');
    await componentValidationStep(page, validation('Verify Save was blocked', 'Save should remain blocked with required-field feedback.'), async () => feedback,
      { actual: (shown) => `Save was blocked, no component was saved, and the application displayed "${shown}".` });
  });

  for (const scenario of [
    { id: 'CMP-037', title: 'Omit Parent Component Code', omitted: 'parentCode', label: 'Parent Component Code' },
    { id: 'CMP-038', title: 'Omit Component Code', omitted: 'code', label: 'Component Code' },
    { id: 'CMP-039', title: 'Omit Component Name', omitted: 'name', label: 'Component Name' },
    { id: 'CMP-040', title: 'Omit Component Category', omitted: 'category', label: 'Component Category' },
    { id: 'CMP-041', title: 'Omit department while Is Parent No', omitted: 'department', label: 'Equipment / System Department' },
  ]) test(`${scenario.id} - ${scenario.title}`, componentScenario(`Save without ${scenario.label} should be blocked with ${scenario.label} feedback, and no component should be saved.`), async () => {
    const data = draftData(scenario.id);
    if (scenario.id === 'CMP-038') {
      const { original, form } = await act(`Search for Component ${parentCode} and open Edit Component`, `Component ${parentCode} should open in the Edit form.`,
        async () => {
          await components.clearComponentSearch();
          await components.selectVessel(vessel);
          const found = await components.searchAndSelectComponentByCode(parentCode);
          return { original: found, form: await components.openComponentForEdit(parentCode) };
        },
        (state) => `Component ${identityText(state.original)} opened in the Edit form.`);
      const cleared = await act('Clear Component Code', 'Component Code should stay empty before Save.',
        async () => ({ empty: await form.clearRequiredText('Component Code', 'input-component-code'), value: await form.value('Component Code', 'input-component-code') }),
        (state) => (state.empty ? 'Component Code stayed empty.' : `Component Code could not stay empty after five attempts; the Edit form put back "${state.value}".`));
      if (!cleared.empty) throw new Error(`Observed Application Result: Component Code could not remain empty after five normal UI attempts; the Edit form regenerated ${cleared.value}. Save was not clicked.`);
      const feedback = await form.expectSaveBlocked('Component Code', undefined, 'edit');
      await back(form, 'Edit Component form');
      const after = await act(`Search for Component ${original.code} and count its records`, `Component ${original.code} should be unchanged and still the only record with that code.`,
        async () => {
          await components.selectVessel(vessel);
          return { identity: await components.searchAndSelectComponentByCode(original.code), count: await components.exactComponentCount(original.code) };
        },
        (state) => `Component Details showed ${identityText(state.identity)}; the register held ${state.count} record(s) with Code ${original.code}.`);
      await componentValidationStep(page, validation('Verify the empty Component Code was rejected', `The empty Component Code should be rejected and ${original.code} should remain unchanged.`), async () => {
        expect(after.identity).toEqual(original);
        expect(after.count).toBe(1);
      }, { actual: () => `Save was blocked with "${feedback}"; Component ${identityText(after.identity)} was unchanged and the only record with that code.` });
      return;
    }
    const form = await draftForm();
    const values = required(data) as Record<string, string>;
    values[scenario.omitted] = '';
    await form.fillRequired(values);
    const feedback = await form.expectSaveBlocked(scenario.label);
    await componentValidationStep(page, validation(`Verify Save was blocked without ${scenario.label}`, `${scenario.label} validation should block creation of ${data.code}.`), async () => feedback,
      { actual: (shown) => `Save was blocked, no component was saved, and the application displayed "${shown}".` });
  });

  test('CMP-042 - Submit create request without Is Active', async () => {
    const form = await draftForm();
    const supported = await form.canOmitIsActive();
    if (!supported) {
      await test.step(step('Assess approved UI support for omitting Is Active', 'The UI must allow Is Active to be omitted before server rejection can be tested.', 'The approved form always supplies Is Active and exposes no blank value; server-omission validation was not automated.', 'NOT RUN'), async () => {});
      test.skip(true, 'The approved UI cannot omit Is Active; API bypass was explicitly prohibited.');
    }
  });

  test('CMP-043 - Reject whitespace-only required text fields', componentScenario('Required text fields holding only spaces should be treated as missing and block Save.'), async () => {
    const data = draftData('CMP043');
    const form = await draftForm();
    await form.fillRequired(required(data, { parentCode: '   ', code: '   ', name: '   ' }));
    const feedback = await form.expectSaveBlocked('Whitespace-only fields');
    await componentValidationStep(page, validation('Verify whitespace-only values were rejected', 'Whitespace-only required fields should be treated as missing and no component should be created.'), async () => feedback,
      { actual: (shown) => `Save was blocked, no component was saved, and the application displayed "${shown}".` });
  });

  test('CMP-044 - Department becomes required after Is Parent changes to No', componentScenario('Changing Is Parent from Yes to No with no department selected should make Equipment / System Department required and block Save.'), async () => {
    const data = draftData('CMP044');
    const form = await draftForm();
    await form.fillRequired(required(data, { isParent: 'Yes', department: '' }));
    await form.fillRequired({ isParent: 'No' });
    const feedback = await form.expectSaveBlocked('Equipment / System Department');
    await componentValidationStep(page, validation('Verify department became required', `Department should become mandatory and block ${data.code}.`), async () => feedback,
      { actual: (shown) => `After Is Parent changed to No, Save was blocked and the application displayed "${shown}".` });
  });

  test('CMP-045 - Back without saving creates no component', componentScenario('Leaving a filled Add form with Back should save nothing.'), async () => {
    const data = draftData('CMP045');
    const form = await draftForm();
    await form.fillRequired(required(data));
    await back(form, 'filled Add Component form');
    draft = undefined;
    const count = await act(`Search for Component ${data.code}`, `No component with Code ${data.code} should exist.`,
      () => components.exactComponentCount(data.code), (found) => `The register held ${found} record(s) with Code ${data.code}.`);
    await componentValidationStep(page, validation(`Verify ${data.code} was not created`, 'Back should discard the draft and create no matching record.'), async () => {
      expect(count).toBe(0);
    }, { actual: () => `Back discarded ${data.code}; the register held no record with that code.` });
  });

  test('CMP-046 - Repeated Save creates at most one component', componentScenario('Clicking Save several times quickly should create at most one component and at most one successful save response.'), async () => {
    const data = await unique('CMP046');
    const form = await open();
    await form.fillRequired(required(data));
    const responses = await act(`Click Save repeatedly for Component ${data.code}`, 'The application should accept at most one of the repeated Save clicks.',
      () => form.saveRepeatedly(), (statuses) => `The repeated Save clicks produced ${statuses.length} save response(s): ${statuses.length ? statuses.map((status) => `HTTP ${status}`).join(', ') : 'none'}.`);
    const count = await act(`Search for Component ${data.code} and count its records`, `No more than one Component ${data.code} should exist in Vessel ${vessel}.`,
      async () => { await components.selectVessel(vessel); return components.exactComponentCount(data.code); },
      (found) => `The register held ${found} record(s) with Code ${data.code}.`);
    if (count === 1) await track(data, 'CMP-046');
    const successful = responses.filter((status) => status >= 200 && status < 300).length;
    await componentValidationStep(page, validation('Verify no duplicate component was created', 'No more than one component should be created and no more than one Save response should succeed.'), async () => {
      expect(count).toBeLessThanOrEqual(1);
      expect(successful).toBeLessThanOrEqual(1);
    }, { actual: () => `Repeated Save produced ${successful} successful response(s) and ${count} record(s) with Code ${data.code}.` });
  });
});
