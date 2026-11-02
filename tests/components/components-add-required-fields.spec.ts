import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentFormPage } from '../../pages/ComponentFormPage';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { componentValidationStep } from '../../utils/componentValidationEvidence';
import { trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

const step = (title: string, expected: string, actual: string, status?: 'NOT RUN') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}${status ? `\nStatus: ${status}` : ''}`;

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

  test.beforeAll(async ({ browser }) => {
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    parentCode = config.cmp008ParentCode;
    await components.searchAndSelectComponentByCode(parentCode);
    category = await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Component Category' });
    department = await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Equipment / System Department' });
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
  const open = async (): Promise<ComponentFormPage> => {
    draft = undefined;
    if (await page.getByText('A. Component Information', { exact: true }).isVisible().catch(() => false)
      && await page.getByRole('button', { name: /back|cancel/i }).first().isVisible().catch(() => false)) {
      await page.getByRole('button', { name: /back|cancel/i }).first().click();
    }
    await components.clearComponentSearch();
    await components.selectVessel(vessel);
    await components.searchAndSelectComponentByCode(parentCode);
    return components.openComponentForAdd();
  };
  /** Reuses the open unsaved Add form, or opens one if none is displayed. */
  const draftForm = async (): Promise<ComponentFormPage> => {
    if (!draft || !(await draft.isAddFormOpen())) draft = await open();
    return draft;
  };
  const required = (data: { code: string; name: string }, overrides = {}) => ({
    parentCode, code: data.code, name: data.name, category, department, isParent: 'No' as const, isActive: 'Yes' as const, ...overrides,
  });
  const verifyCreated = async (data: { code: string; name: string }) => {
    // saveValid() has already confirmed the UI save; persist the exact identity
    // before register validation so an interrupted/failed assertion remains cleanable.
    await trackCreatedComponent({ ...data, vessel, parentCode, sourceSpec: 'components-add-required-fields.spec.ts', testCaseId: `CMP-${data.code.slice(2, 5)}`, runId, createdAt: new Date().toISOString() });
    await components.selectVessel(vessel);
    const identity = await components.searchAndSelectComponentByCode(data.code);
    expect(identity).toEqual({ code: data.code, name: data.name, vesselName: vessel });
    expect(await components.exactComponentCount(data.code)).toBe(1);
  };

  test('CMP-029 - Select parent and open Add Component', async () => {
    await componentValidationStep(page, step(`Open Add Component under Parent ${parentCode}`, `The form should show Parent ${parentCode} and a proposed child code.`, `The form showed Parent ${parentCode} and a non-empty proposed child code.`), async () => {
      const form = await open();
      await form.expectAddContext(parentCode);
      await form.back();
    });
  });

  test('CMP-030 - Create with required fields only', async () => {
    const data = await unique('CMP030');
    await componentValidationStep(page, step(`Create Component ${data.code} (${data.name}) with required fields`, `Exactly one component should be saved under ${parentCode} in ${vessel}.`, `Exactly one Component ${data.code} (${data.name}) was saved under ${parentCode} in ${vessel}.`), async () => {
      const form = await open(); await form.fillRequired(required(data)); await form.saveValid(); await verifyCreated(data);
    });
  });

  test('CMP-031 - Create with all supported optional fields', async () => {
    const data = await unique('CMP031');
    const optional = { Model: `MODEL-${data.code.slice(-6)}`, 'Serial No.': `SER-${data.code.slice(-6)}`, 'Drawing No': `DRW-${data.code.slice(-6)}`, Location: 'Isolated Test Location', Rating: '100 kW', 'Notes / Technical Information': `Automated optional fields ${data.code}`, 'Installation Date': '2026-01-10', 'Commissioned Date': '2026-01-11' };
    await componentValidationStep(page, step(`Create Component ${data.code} (${data.name}) with optional fields`, 'All supported optional values should persist after reopening.', `Component ${data.code} was reopened with its configured optional values.`), async () => {
      const form = await open(); await form.fillRequired(required(data)); await form.fillOptional(optional); await form.saveValid(); await verifyCreated(data);
      for (const [label, value] of Object.entries(optional)) expect(await components.readSelectedComponentDetail({ section: 'A. Component Information', label })).toContain(value);
    });
  });

  test('CMP-032 - Is Parent Yes allows blank department', async () => {
    const data = await unique('CMP032');
    await componentValidationStep(page, step(`Create parent Component ${data.code} with blank department`, 'A grouping component with Is Parent Yes should save without a department.', `Parent Component ${data.code} saved successfully with no department.`), async () => {
      const form = await open(); await form.fillRequired(required(data, { isParent: 'Yes', department: '' })); await form.saveValid(); await verifyCreated(data);
    });
  });

  test('CMP-033 - Create with Is Active No', async () => {
    const data = await unique('CMP033');
    await componentValidationStep(page, step(`Create inactive Component ${data.code}`, 'Is Active No should persist with the applicable register visibility.', `Component ${data.code} persisted with Is Active No and remained available in the applicable view.`), async () => {
      const form = await open(); await form.fillRequired(required(data, { isActive: 'No' })); await form.saveValid(); await verifyCreated(data);
      expect(await components.readSelectedComponentDetail({ section: 'B. Fleet Component Information', label: 'Is Active' })).toBe('No');
    });
  });

  test('CMP-034 - Correct a missing required field and save', async () => {
    const data = await unique('CMP034');
    await componentValidationStep(page, step(`Correct missing Component Name for ${data.code}`, 'The first save should be blocked, then correction should allow one valid save.', `Component Name validation appeared, cleared after correction, and ${data.code} saved once.`), async () => {
      const form = await open(); await form.fillRequired(required(data, { name: '' })); await form.expectSaveBlocked('Component Name'); await form.fillRequired({ name: data.name }); await form.saveValid(); await verifyCreated(data);
    });
  });

  test('CMP-035 - Abandon draft and start a fresh Add session', async () => {
    const data = draftData('CMP035');
    await componentValidationStep(page, step(`Abandon draft Component ${data.code} and reopen Add`, 'The new Add form should not retain the abandoned code or name.', `The reopened form did not retain ${data.code} or ${data.name}.`), async () => {
      let form = await open(); await form.fillRequired(required(data)); await form.back(); form = await open(); expect(await form.value('Component Code', 'input-component-code')).not.toBe(data.code); expect(await form.value('Component Name', 'input-component-name')).not.toBe(data.name); draft = form; // pristine form reused by CMP-036
    });
  });

  test('CMP-036 - Save with all mandatory fields empty', async () => {
    await componentValidationStep(page, step('Save Add Component with mandatory fields empty', 'Save should remain blocked with required-field feedback.', 'Save remained blocked and required-field feedback was displayed.'), async () => { const form = await draftForm(); await form.fillRequired({ parentCode: '', code: '', name: '', department: '' }); await form.expectSaveBlocked('Mandatory fields'); });
  });

  for (const scenario of [
    { id: 'CMP-037', title: 'Omit Parent Component Code', omitted: 'parentCode', label: 'Parent Component Code' },
    { id: 'CMP-038', title: 'Omit Component Code', omitted: 'code', label: 'Component Code' },
    { id: 'CMP-039', title: 'Omit Component Name', omitted: 'name', label: 'Component Name' },
    { id: 'CMP-040', title: 'Omit Component Category', omitted: 'category', label: 'Component Category' },
    { id: 'CMP-041', title: 'Omit department while Is Parent No', omitted: 'department', label: 'Equipment / System Department' },
  ]) test(`${scenario.id} - ${scenario.title}`, async () => {
    const data = draftData(scenario.id);
    if (scenario.id === 'CMP-038') {
      await components.clearComponentSearch();
      await components.selectVessel(vessel);
      const original = await components.searchAndSelectComponentByCode(parentCode);
      const form = await components.openComponentForEdit(parentCode);
      await componentValidationStep(page, step(
        `Omit Component Code while editing existing Component ${original.code}`,
        'The empty Component Code should be rejected, the Edit form should remain open, and no update request should succeed.',
        `Mandatory validation rejected the empty code for ${original.code}; the existing Component remained unchanged.`,
      ), async () => {
        const codeRemainedEmpty = await form.clearRequiredText('Component Code', 'input-component-code');
        if (!codeRemainedEmpty) {
          const regeneratedCode = await form.value('Component Code', 'input-component-code');
          throw new Error(`Component Code could not remain empty after five normal UI attempts; the Edit form regenerated ${regeneratedCode}. Save was not clicked.`);
        }
        await form.expectSaveBlocked('Component Code', undefined, 'edit');
      });
      await form.back();
      await components.selectVessel(vessel);
      expect(await components.searchAndSelectComponentByCode(original.code)).toEqual(original);
      expect(await components.exactComponentCount(original.code)).toBe(1);
      return;
    }
    await componentValidationStep(page, step(`${scenario.title} for draft ${data.code}`, `${scenario.label} validation should block creation.`, `${scenario.label} validation blocked creation of ${data.code}.`), async () => {
      const form = await draftForm();
      const values = required(data) as Record<string, string>;
      values[scenario.omitted] = '';
      await form.fillRequired(values);
      await form.expectSaveBlocked(scenario.label);
    });
  });

  test('CMP-042 - Submit create request without Is Active', async () => {
    const form = await draftForm();
    const supported = await form.canOmitIsActive();
    if (!supported) {
      await test.step(step('Assess approved UI support for omitting Is Active', 'The UI must allow Is Active to be omitted before server rejection can be tested.', 'The approved form always supplies Is Active and exposes no blank value; server-omission validation was not automated.', 'NOT RUN'), async () => {});
      test.skip(true, 'The approved UI cannot omit Is Active; API bypass was explicitly prohibited.');
    }
  });

  test('CMP-043 - Reject whitespace-only required text fields', async () => {
    const data = draftData('CMP043');
    await componentValidationStep(page, step(`Reject whitespace-only values for draft ${data.code}`, 'Whitespace-only required fields should be treated as missing.', 'Whitespace-only required fields were rejected and no component was created.'), async () => { const form = await draftForm(); await form.fillRequired(required(data, { parentCode: '   ', code: '   ', name: '   ' })); await form.expectSaveBlocked('Whitespace-only fields'); });
  });

  test('CMP-044 - Department becomes required after Is Parent changes to No', async () => {
    const data = draftData('CMP044');
    await componentValidationStep(page, step(`Toggle Is Parent Yes to No for draft ${data.code}`, 'Department should become mandatory and block Save.', `Department became mandatory and blocked ${data.code}.`), async () => { const form = await draftForm(); await form.fillRequired(required(data, { isParent: 'Yes', department: '' })); await form.fillRequired({ isParent: 'No' }); await form.expectSaveBlocked('Equipment / System Department'); });
  });

  test('CMP-045 - Back without saving creates no component', async () => {
    const data = draftData('CMP045');
    await componentValidationStep(page, step(`Cancel draft Component ${data.code}`, 'Back should discard the draft and create no matching record.', `Back discarded ${data.code}; no matching component was created.`), async () => { const form = await draftForm(); await form.fillRequired(required(data)); await form.back(); draft = undefined; expect(await components.exactComponentCount(data.code)).toBe(0); });
  });

  test('CMP-046 - Repeated Save creates at most one component', async () => {
    const data = await unique('CMP046');
    await componentValidationStep(page, step(`Repeat Save while creating Component ${data.code}`, 'At most one component should be created and completed responses should remain consistent.', `Repeated Save produced no duplicate Component ${data.code} and no more than one successful create response.`), async () => { const form = await open(); await form.fillRequired(required(data)); const responses = await form.saveRepeatedly(); await components.selectVessel(vessel); const count = await components.exactComponentCount(data.code); expect(count).toBeLessThanOrEqual(1); expect(responses.filter((status) => status >= 200 && status < 300).length).toBeLessThanOrEqual(1); if (count === 1) await trackCreatedComponent({ ...data, vessel, parentCode, sourceSpec: 'components-add-required-fields.spec.ts', testCaseId: 'CMP-046', runId, createdAt: new Date().toISOString() }); });
  });
});
