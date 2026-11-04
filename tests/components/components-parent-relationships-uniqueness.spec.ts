import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentFormPage } from '../../pages/ComponentFormPage';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { LoginPage } from '../../pages/LoginPage';
import { attachFailureScreenshot, componentActionStep, componentValidationStep, componentScenario } from '../../utils/componentValidationEvidence';
import { trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { routes } from '../../utils/routes';

type ComponentData = { code: string; name: string };
/** Wording the application uses to reject a value that another component on the vessel already holds. */
const duplicateFeedback = /already (?:exists|registered|in use)|duplicate|conflict|must be unique|enter a unique/i;
type VesselFixture = { vessel: string; parentCode: string; category: string; department: string };

const step = (title: string, expected: string, actual: string, status?: 'NOT RUN' | 'FAIL') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}${status ? `\nStatus: ${status}` : ''}`;

const recordStep = async (title: string, expected: string, actual: string, status?: 'FAIL'): Promise<void> => {
  await test.step(step(title, expected, actual, status), async () => {});
};

const notExecuted = async (title: string, expected: string, reason: string): Promise<void> => {
  await test.step(step(title, expected, `NOT EXECUTED because ${reason}.`, 'NOT RUN'), async () => {});
};

test.describe('Components parent relationships and uniqueness', () => {
  test.setTimeout(3 * 60_000);

  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let vesselA: VesselFixture;
  let secondParentA: VesselFixture | undefined;
  let vesselB: VesselFixture | undefined;
  // Vessel A child created by this worker (normally by CMP-047) and reused by CMP-048..051.
  // Reset when a failure restarts the worker, so every test can still run on its own.
  let owned: ComponentData | undefined;
  let recordScenarioSteps = false;
  const runId = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;

  /** Records the uniqueness search that precedes each generated code. */
  const recordUnusedCode = (code: string, vessel: string): Promise<void> => recordStep(
    `Confirm Component Code ${code} is not yet used in Vessel ${vessel}`,
    `A search of Vessel ${vessel} should find no existing component with Code ${code}, so the scenario starts from a known state.`,
    `The search of Vessel ${vessel} found 0 components with Code ${code}.`,
  );

  const isUnused = async (code: string, vessel: string): Promise<boolean> => {
    try {
      // Search narrows the register to the requested code. Expand only the
      // filtered ancestry needed to prove presence or absence; never traverse
      // the complete vessel hierarchy while preparing unique runtime data.
      return await components.exactComponentCount(code) === 0;
    } catch (error) {
      await recordStep(
        `Search Vessel ${vessel} for Component Code ${code}`,
        `The Components search should return the components in Vessel ${vessel} that use Code ${code}, so the scenario can prepare unused test data.`,
        `The search for Code ${code} in Vessel ${vessel} could not be completed, so the scenario could not prepare its test data.`,
        'FAIL',
      );
      throw error;
    }
  };

  const unique = async (id: string, vessel: string, name?: string): Promise<ComponentData> => {
    await selectVessel(vessel);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
      const number = id.replace('CMP-', '');
      const data = { code: `AT${number}-${token}`, name: name ?? `Test CMP${number} ${token}` };
      if (await isUnused(data.code, vessel)) {
        await recordUnusedCode(data.code, vessel);
        return data;
      }
    }
    throw new Error(`Unable to generate a unique component code for ${id} in ${vessel}.`);
  };

  const uniqueChildSfiCode = async (vessel: string, parentCode: string): Promise<string> => {
    await selectVessel(vessel);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const suffix = String(100 + (Number.parseInt(randomUUID().slice(0, 8), 16) % 900));
      const code = `${parentCode}.${suffix}`;
      if (await isUnused(code, vessel)) {
        await recordUnusedCode(code, vessel);
        return code;
      }
    }
    throw new Error(`Unable to generate an unused child SFI code beneath ${parentCode} in Vessel ${vessel}.`);
  };

  const uniqueNineDigitSfiCode = async (vessel: string): Promise<string> => {
    await selectVessel(vessel);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(100_000_000 + (Number.parseInt(randomUUID().slice(0, 8), 16) % 900_000_000));
      if (await isUnused(code, vessel)) {
        await recordUnusedCode(code, vessel);
        return code;
      }
    }
    throw new Error(`Unable to generate an unused nine-digit SFI code in Vessel ${vessel}.`);
  };

  const selectVessel = async (vessel: string): Promise<void> => {
    await components.clearComponentSearch();
    let changed = await components.selectVessel(vessel);
    try {
      await components.expectTreeLoaded();
    } catch {
      const alternateVessel = vessel === config.vesselB ? config.vesselA : config.vesselB;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await components.expectToBeOnPage();
      await components.selectVessel(alternateVessel);
      await components.expectTreeLoaded();
      changed = await components.selectVessel(vessel) || changed;
      await components.expectTreeLoaded();
    }
    if (changed && recordScenarioSteps) {
      await recordStep(
        `Select Vessel ${vessel} in the Components register`,
        `The Components register should load the component tree for Vessel ${vessel}.`,
        `Vessel ${vessel} was selected and its component tree finished loading.`,
      );
    }
  };

  /** saveValid() already reloads the page to prove persistence; only re-establish the vessel tree. */
  const afterSave = async (vessel: string, purpose = ''): Promise<void> => {
    await test.step(step(
      `Refresh the Components register for Vessel ${vessel}${purpose ? ` ${purpose}` : ''}`,
      `After Save, the Components register should reopen and finish loading Vessel ${vessel}.`,
      `The Components register reopened and Vessel ${vessel} finished loading after Save.`,
    ), async () => {
      await components.expectToBeOnPage();
      await components.selectVessel(vessel);
      await components.expectTreeLoaded();
    });
  };

  const discoverParentFixture = async (
    vessel: string,
    excludedCodes: string[] = [],
    preferredCode?: string,
  ): Promise<VesselFixture> => {
    await selectVessel(vessel);
    const rejected: string[] = [];
    const probe = async (parentCode: string): Promise<VesselFixture | undefined> => {
      try {
        const identity = await components.searchAndSelectComponentByCode(parentCode);
        expect(identity.code, `The parent lookup should select exact Component ${parentCode}`).toBe(parentCode);
        expect(identity.vesselName, `Parent ${parentCode} should belong to Vessel ${vessel}`).toBe(vessel);
        const category = await components.readSelectedComponentDetail({
          section: 'A. Component Information',
          label: 'Component Category',
        });
        const form = await components.openComponentForAdd();
        await form.expectAddContext(parentCode);
        await form.back();
        return {
          vessel,
          parentCode,
          category: category || 'Ship General',
          department: config.componentDepartment,
        };
      } catch (error) {
        rejected.push(`${parentCode}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        if (await page.getByRole('button', { name: /back|cancel/i }).first().isVisible().catch(() => false)) {
          await page.getByRole('button', { name: /back|cancel/i }).first().click();
        }
        await selectVessel(vessel);
        return undefined;
      }
    };

    if (preferredCode && !excludedCodes.some((excluded) =>
      preferredCode === excluded || preferredCode.startsWith(`${excluded}.`))) {
      const preferredFixture = await probe(preferredCode);
      if (preferredFixture) return preferredFixture;
    }

    // The collapsed register already exposes its top-level components. Probe
    // those candidates directly and let searchAndSelectComponentByCode expand
    // only a candidate's filtered ancestry when it is actually needed.
    const visibleCodes = (await components.readExpandedTreeRows())
      .map((row) => row.code)
    const candidateRoots = [...new Set(visibleCodes
      .filter((code) => code !== preferredCode)
      .filter((code) => !/^AT\d{3}-/i.test(code))
      .filter((code) => !excludedCodes.some((excluded) =>
        code === excluded || code.startsWith(`${excluded}.`))))];
    expect(candidateRoots.length, `Vessel ${vessel} should expose tree components to probe in Add Component`).toBeGreaterThan(0);

    for (const rootCode of candidateRoots) {
      // A top-level SFI category can open Add Component even when it is not a
      // persisted component accepted by the API as a parent. Expand only this
      // root, try its actual direct children first, and stop at the first valid
      // fixture instead of expanding every root and descendant in the vessel.
      const directChildren = await components.directChildCodes(rootCode);
      for (const parentCode of directChildren.filter((code) =>
        !excludedCodes.some((excluded) => code === excluded || code.startsWith(`${excluded}.`)))) {
        const fixture = await probe(parentCode);
        if (fixture) return fixture;
      }
    }
    throw new Error(`No Vessel ${vessel} tree component was accepted as Add Component parent. Probed: ${rejected.join('; ')}`);
  };

  const required = (fixture: VesselFixture, data: ComponentData) => ({
    parentCode: fixture.parentCode,
    code: data.code,
    name: data.name,
    category: fixture.category,
    department: fixture.department,
    isParent: 'No' as const,
    isActive: 'Yes' as const,
  });

  const openAdd = async (fixture: VesselFixture, purpose = ''): Promise<ComponentFormPage> => {
    await selectVessel(fixture.vessel);
    return test.step(step(
      `Select Parent ${fixture.parentCode} and open Add Component in Vessel ${fixture.vessel}${purpose ? ` ${purpose}` : ''}`,
      `Parent ${fixture.parentCode} should be selectable and the Add Component form should open in Vessel ${fixture.vessel}.`,
      `Parent ${fixture.parentCode} was selected and the Add Component form opened in Vessel ${fixture.vessel}.`,
    ), async () => {
      await components.searchAndSelectComponentByCode(fixture.parentCode);
      return components.openComponentForAdd();
    });
  };

  const openEdit = async (fixture: VesselFixture, code: string): Promise<ComponentFormPage> => {
    await selectVessel(fixture.vessel);
    return test.step(step(
      `Search for Component ${code} and open Edit Component in Vessel ${fixture.vessel}`,
      `Component ${code} should be found in Vessel ${fixture.vessel} and open with its saved values.`,
      `Component ${code} was found and its Edit Component form opened with saved values.`,
    ), async () => components.openComponentForEdit(code));
  };

  const create = async (fixture: VesselFixture, data: ComponentData, testCaseId: string): Promise<void> => {
    const form = await openAdd(fixture);
    await form.fillRequired(required(fixture, data));
    fixture.category = await form.selectedOptionText('Component Category', 'select-component-category');
    fixture.department = await form.selectedOptionText('Equipment / System Department', 'select-eqpt-system-dept');
    await form.saveValid();
    // Persist immediately after the successful response so later UI assertions
    // cannot strand a disposable component outside cleanup tracking.
    await trackCreatedComponent({ ...data, vessel: fixture.vessel, parentCode: fixture.parentCode, sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId, runId, createdAt: new Date().toISOString() });
  };

  /** Returns this worker's vessel A automation component, creating one only when none exists yet. */
  const ownedComponent = async (testCaseId: string): Promise<ComponentData> => {
    if (owned) return owned;
    const data = await unique(testCaseId, vesselA.vessel);
    await create(vesselA, data, testCaseId);
    owned = data;
    return data;
  };

  const expectIdentity = async (fixture: VesselFixture, data: ComponentData, parentCode = fixture.parentCode, purpose = ''): Promise<void> => {
    await test.step(step(
      `Search for ${data.code} and verify its saved values in Vessel ${fixture.vessel}${purpose ? ` ${purpose}` : ''}`,
      `Exactly one Component ${data.code} (${data.name}) should exist beneath Parent ${parentCode} with Category ${fixture.category} and Department ${fixture.department}.`,
      `Exactly one Component ${data.code} (${data.name}) was found beneath Parent ${parentCode} with Category ${fixture.category} and Department ${fixture.department}.`,
    ), async () => {
      const identity = await components.searchAndSelectComponentByCode(data.code);
      expect(identity).toEqual({ code: data.code, name: data.name, vesselName: fixture.vessel });
      expect(await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Parent Component Code' })).toContain(parentCode);
      expect(await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Component Category' })).toContain(fixture.category);
      expect(await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Equipment / System Department' })).toContain(fixture.department);
      expect(await components.exactComponentCount(data.code)).toBe(1);
    });
  };

  /**
   * Searches a component by its own code and reads the tree path the search reveals. The row directly
   * above it at the next shallower level is its parent in the tree. Searching the parent's code instead
   * would hide any child whose own text does not contain that code.
   */
  const treePlacement = (code: string) => componentActionStep(
    `Search for ${code} and read its position in the component tree`,
    `The tree should show ${code} beneath the parent it is saved under.`,
    async () => {
      await components.clearComponentSearch();
      await components.searchAndSelectComponentByCode(code);
      const rows = await components.readExpandedTreeRows();
      const index = rows.findIndex((row) => row.code === code);
      const path: string[] = [];
      for (let row = index, depth = index >= 0 ? rows[index].depth : -1; row >= 0 && depth >= 0; row -= 1) {
        if (rows[row].depth === depth) { path.unshift(rows[row].code); depth -= 1; }
      }
      return { shown: index >= 0, parent: path.length > 1 ? path[path.length - 2] : undefined, path };
    },
    (placement) => (placement.shown
      ? `The tree showed ${code} directly beneath ${placement.parent ?? 'no parent'} (path ${placement.path.join(' > ')}).`
      : `The search for ${code} did not show it in the tree.`),
    { page },
  );

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(3 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await test.step(step(
      `Initial setup - Select Vessel ${config.vesselA}`,
      `The shared Components session should select Vessel ${config.vesselA} once before the suite scenarios begin.`,
      `The shared Components session selected Vessel ${config.vesselA}.`,
    ), async () => {
      await components.clearComponentSearch();
      await components.selectVessel(config.vesselA);
    });
    await test.step(step(
      `Initial setup - Verify component tree for Vessel ${config.vesselA}`,
      `The component tree for Vessel ${config.vesselA} should finish loading before the suite scenarios begin.`,
      `The component tree for Vessel ${config.vesselA} finished loading and was ready for the suite.`,
    ), async () => components.expectTreeLoaded());
    vesselA = await discoverParentFixture(config.vesselA, [], config.cmp008ParentCode);
    recordScenarioSteps = true;
  });

  test.afterEach(async () => {
    await attachFailureScreenshot(page, test.info());
    await restoreComponentsPage(page, components, vesselA?.vessel ?? config.vesselA);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('CMP-047 - Save child with existing same-vessel parent', componentScenario("A new child component saved beneath an existing parent in the same vessel should be created exactly once, appear beneath that parent in the tree, and keep its code, name, category, and department."), async () => {
    const original = await unique('CMP-047', vesselA.vessel);
    await componentValidationStep(page, step(
      `Create ${original.code} (${original.name}) under Parent ${vesselA.parentCode} in Vessel ${vesselA.vessel}`,
      `Component ${original.code} (${original.name}) should save once beneath Parent ${vesselA.parentCode} in Vessel ${vesselA.vessel}, appear beneath that parent in the tree, and keep its category and department.`,
      `${original.code} saved once beneath ${vesselA.parentCode} in ${vesselA.vessel} with its configured category and department.`,
    ), async () => {
      await create(vesselA, original, 'CMP-047');
      owned = original;
      await afterSave(vesselA.vessel);
      await expectIdentity(vesselA, original);
      const rows = await components.readExpandedTreeRows();
      expect(rows.map((row) => row.code)).toContain(vesselA.parentCode);
      expect(rows.map((row) => row.code)).toContain(original.code);
    });
  });

  test('CMP-048 - Edit optional field without changing code/name', componentScenario("Changing only the optional Location field of an existing component should save without a duplicate-code or duplicate-name conflict; the component should keep its code, name, parent, and vessel and show the new Location."), async () => {
    const original = await ownedComponent('CMP-048');
    const optionalLocation = `CMP048 ${original.code}`;
    await componentValidationStep(page, step(
      `Edit Location only on ${original.code} without changing its code or name`,
      `Location "${optionalLocation}" should save on ${original.code} without a duplicate conflict; Code ${original.code}, Name "${original.name}", Parent ${vesselA.parentCode}, and Vessel ${vesselA.vessel} should remain unchanged.`,
      `${original.code} retained its identity and Parent ${vesselA.parentCode}; Location became "${optionalLocation}" and only one record remained.`,
    ), async () => {
      const form = await openEdit(vesselA, original.code);
      // Same code/name checks as before, but only after the Edit form has hydrated.
      await test.step(step(
        `Confirm the Edit form for ${original.code} has loaded its saved values`,
        `The Edit form should finish loading and show Code ${original.code} and Name "${original.name}" before any field is changed.`,
        `The Edit form finished loading with Code ${original.code} and Name "${original.name}".`,
      ), async () => {
        const saved = await form.expectEditReady(original.code);
        expect(saved.name, `The Edit form should show the saved Component Name "${original.name}"`).toBe(original.name);
      });
      try {
        await test.step(step(
          `Enter Location "${optionalLocation}" for Component ${original.code}`,
          `The Location field should retain "${optionalLocation}" before Save.`,
          `The Location field retained "${optionalLocation}" before Save.`,
        ), async () => form.editOptionalText('Location', optionalLocation));
      } catch (error) {
        const reason = `Location "${optionalLocation}" did not remain in the Edit form`;
        await notExecuted(`Click Save for edited Component ${original.code}`, 'Save should persist the Location change without altering the component identity.', reason);
        await notExecuted(`Refresh Vessel ${vesselA.vessel} after editing ${original.code}`, 'The Components register should reload the selected vessel after Save.', reason);
        await notExecuted(`Reopen ${original.code} and verify Location and identity`, `Component ${original.code} should retain its code, name, parent, vessel, uniqueness, and Location "${optionalLocation}".`, reason);
        throw error;
      }
      await form.saveValid();
      await afterSave(vesselA.vessel);
      await expectIdentity(vesselA, original);
      expect(await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Location' })).toContain(optionalLocation);
    });
  });

  test('CMP-049 - Create same component code on another vessel', componentScenario("The application should allow the same Component Code on a different vessel: the code should exist exactly once on each vessel with vessel-specific parent and fields, and the original component should remain unchanged."), async () => {
    const original = await ownedComponent('CMP-049');
    const fixtureB = vesselB ?? await discoverParentFixture(config.vesselB);
    vesselB = fixtureB;
    const copy = { code: original.code, name: `Test CMP049 ${randomUUID().slice(0, 4).toUpperCase()}` };
    await componentValidationStep(page, step(
      `Create Component Code ${copy.code} independently in Vessel ${fixtureB.vessel}`,
      `The same code should exist exactly once in each of ${vesselA.vessel} and ${fixtureB.vessel}, with vessel-specific parent and fields.`,
      `${copy.code} exists once under ${fixtureB.parentCode} in ${fixtureB.vessel}; the original remains once under ${vesselA.parentCode} in ${vesselA.vessel}.`,
    ), async () => {
      await selectVessel(fixtureB.vessel);
      expect(await components.exactComponentCount(copy.code)).toBe(0);
      await create(fixtureB, copy, 'CMP-049');
      await afterSave(fixtureB.vessel);
      await expectIdentity(fixtureB, copy);
      await selectVessel(vesselA.vessel);
      await expectIdentity(vesselA, original);
    });
  });

  test('CMP-050 - Create same component name on another vessel', componentScenario("The application should allow the same Component Name on a different vessel with a different code; the original component on the first vessel should remain unchanged."), async () => {
    const original = await ownedComponent('CMP-050');
    const fixtureB = vesselB ?? await discoverParentFixture(config.vesselB);
    vesselB = fixtureB;
    const copy = await unique('CMP-050', fixtureB.vessel, original.name);
    await componentValidationStep(page, step(
      `Create Component Name "${original.name}" with Code ${copy.code} in Vessel ${fixtureB.vessel}`,
      'The same name should be accepted on the other vessel with a distinct code and correct vessel-specific parent.',
      `${copy.code} (${copy.name}) saved once under ${fixtureB.parentCode}; ${original.code} remained unchanged in ${vesselA.vessel}.`,
    ), async () => {
      await create(fixtureB, copy, 'CMP-050');
      await afterSave(fixtureB.vessel);
      await expectIdentity(fixtureB, copy);
      await selectVessel(vesselA.vessel);
      await expectIdentity(vesselA, original);
    });
  });

  test('CMP-051 - Change parent to another valid same-vessel parent', componentScenario("Moving a component to another valid parent in the same vessel should save; the component should appear once beneath the new parent, no longer beneath the old parent, and keep its code, name, vessel, and other saved values."), async () => {
    const original = await ownedComponent('CMP-051');
    let secondParent: VesselFixture;
    try {
      secondParent = secondParentA ??= await componentActionStep(
        `Find a second valid parent for Component ${original.code} in Vessel ${vesselA.vessel}`,
        `Vessel ${vesselA.vessel} should provide a valid parent other than ${vesselA.parentCode} for the reassignment test.`,
        () => discoverParentFixture(config.vesselA, [vesselA.parentCode]),
        (found) => `Component ${found.parentCode} in Vessel ${found.vessel} opened Add Component and was chosen as the new parent.`,
        { page },
      );
    } catch (error) {
      const reason = 'a second valid same-vessel parent could not be prepared';
      await notExecuted(`Open Edit Component for ${original.code}`, `Component ${original.code} should open with Parent ${vesselA.parentCode}.`, reason);
      await notExecuted(`Enter the second Parent for ${original.code}`, 'The Parent Component Code field should retain the second valid same-vessel parent.', reason);
      await notExecuted(`Click Save for the parent change on ${original.code}`, 'Save should accept the valid same-vessel parent change.', reason);
      await notExecuted(`Refresh Vessel ${vesselA.vessel} after the parent change`, 'The Components register should reload the selected vessel after Save.', reason);
      await notExecuted(`Reopen ${original.code} and verify its hierarchy and uniqueness`, 'The component should appear once beneath the new parent and no longer beneath the old parent, with all other values unchanged.', reason);
      throw error;
    }
    const form = await openEdit(vesselA, original.code);
    if (!(await form.canChangeParent())) {
      await test.step(step(
        `Assess parent reassignment support for ${original.code}`,
        `Edit Component should allow Parent ${vesselA.parentCode} to change to ${secondParent.parentCode}.`,
        'The approved Edit Component UI renders Parent Component Code as read-only; parent reassignment was not attempted.',
        'NOT RUN',
      ), async () => {});
      await form.back();
      test.skip(true, 'Edit Component does not support changing Parent Component Code.');
    }

    await componentValidationStep(page, step(
      `Move ${original.code} from Parent ${vesselA.parentCode} to Parent ${secondParent.parentCode} in Vessel ${vesselA.vessel}`,
      `Component ${original.code} should move from Parent ${vesselA.parentCode} to Parent ${secondParent.parentCode} in Vessel ${vesselA.vessel} without changing its code, name, vessel, other saved fields, or uniqueness.`,
      'Recorded after the validation completes.',
    ), async () => {
      owned = undefined; // the record leaves vesselA.parentCode and must not be reused
      await form.changeParent(secondParent.parentCode);
      await form.saveValid();
      await afterSave(vesselA.vessel);
      await expectIdentity(vesselA, original, secondParent.parentCode);
      await trackCreatedComponent({ ...original, vessel: vesselA.vessel, parentCode: secondParent.parentCode, sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-051', runId, createdAt: new Date().toISOString() });
      const placement = await treePlacement(original.code);
      expect(placement.parent, `${original.code} should be a direct child of new Parent ${secondParent.parentCode}, not of old Parent ${vesselA.parentCode}`).toBe(secondParent.parentCode);
      return placement;
    }, {
      actual: (placement) => `After Save and refresh, ${original.code} (${original.name}) showed Parent Component Code ${secondParent.parentCode} in its details, and the tree showed it directly beneath ${placement.parent} (path ${placement.path.join(' > ')}), no longer beneath ${vesselA.parentCode}; it remained the only record with that code.`,
    });
  });

  test('CMP-052 - Create duplicate code on same vessel', componentScenario("Adding a component whose Component Code already exists on the same vessel should be rejected with a visible duplicate-code message; no second record should be created and the existing component should remain unchanged."), async () => {
    const existing = await ownedComponent('CMP-052');
    await selectVessel(vesselA.vessel);
    const duplicateDraft = { code: existing.code, name: `Test CMP052 ${randomUUID().slice(0, 4).toUpperCase()}` };

    await componentValidationStep(page, step(
      `Reject duplicate Component Code ${existing.code} in Vessel ${vesselA.vessel}`,
      `Saving a new component with existing Code ${existing.code} (new Name "${duplicateDraft.name}") should be rejected with a visible duplicate-code message; the existing ${existing.code} (${existing.name}) record should remain the only one with that code.`,
      `The application rejected duplicate Code ${existing.code} and the existing ${existing.name} record remained unchanged and unique.`,
    ), async () => {
      await expectIdentity(vesselA, existing, vesselA.parentCode, 'before the duplicate-code attempt');
      const form = await openAdd(vesselA, 'for the duplicate-code attempt');
      await form.fillRequired({ ...required(vesselA, duplicateDraft), actorLabel: 'the duplicate-code attempt' });
      const feedback = await form.expectSaveBlocked(
        'Duplicate Component Code',
        async () => trackCreatedComponent({
          ...duplicateDraft,
          vessel: vesselA.vessel,
          parentCode: vesselA.parentCode,
          sourceSpec: 'components-parent-relationships-uniqueness.spec.ts',
          testCaseId: 'CMP-052',
          runId,
          createdAt: new Date().toISOString(),
        }),
      );
      expect(feedback, 'Duplicate Component Code feedback should explain why Save was rejected').toMatch(duplicateFeedback);
      expect(feedback, 'The duplicate feedback should be about the Component Code').toMatch(/\bcode\b/i);
      await form.back();
      await selectVessel(vesselA.vessel);
      await expectIdentity(vesselA, existing, vesselA.parentCode, 'after the rejected duplicate-code attempt');
      return feedback;
    }, {
      actual: (feedback) => `Save was rejected and the application displayed: "${feedback}". After refresh, Component ${existing.code} (${existing.name}) was still the only record with that code in Vessel ${vesselA.vessel}.`,
    });
  });

  test('CMP-053 - Create duplicate name on same vessel', componentScenario("Adding a component whose Component Name already exists on the same vessel should be rejected with a visible duplicate-name message; no new record should be created."), async () => {
    const existing = await ownedComponent('CMP-053');
    const duplicateDraft = await unique('CMP-053', vesselA.vessel, existing.name);
    await componentValidationStep(page, step(
      `Reject duplicate Component Name "${existing.name}" in Vessel ${vesselA.vessel}`,
      `Saving new Code ${duplicateDraft.code} with existing Name "${existing.name}" should be rejected with a visible duplicate-name message, and no record ${duplicateDraft.code} should be created.`,
      `The application rejected duplicate Name "${existing.name}", displayed validation feedback, and retained only the existing ${existing.code} record.`,
    ), async () => {
      const form = await openAdd(vesselA);
      await form.fillRequired(required(vesselA, duplicateDraft));
      const feedback = await form.expectSaveBlocked('Duplicate Component Name', async () => trackCreatedComponent({
        ...duplicateDraft, vessel: vesselA.vessel, parentCode: vesselA.parentCode,
        sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-053', runId, createdAt: new Date().toISOString(),
      }));
      expect(feedback, 'Duplicate Component Name feedback should explain why Save was rejected').toMatch(duplicateFeedback);
      expect(feedback, 'The duplicate feedback should be about the Component Name').toMatch(/\bname\b/i);
      await form.back();
      await selectVessel(vesselA.vessel);
      await expectIdentity(vesselA, existing);
      expect(await components.exactComponentCount(duplicateDraft.code)).toBe(0);
      return feedback;
    }, {
      actual: (feedback) => `Save was rejected and the application displayed: "${feedback}". After refresh, Vessel ${vesselA.vessel} contained no Component ${duplicateDraft.code} and ${existing.code} (${existing.name}) was unchanged.`,
    });
  });

  test('CMP-054 - Edit code to another component code', componentScenario("Changing a component's code to a code already used by another component on the same vessel should be rejected with a visible duplicate-code message; both components should remain unchanged."), async () => {
    const original = await ownedComponent('CMP-054');
    const target = await unique('CMP-054', vesselA.vessel);
    await create(vesselA, target, 'CMP-054');
    await componentValidationStep(page, step(
      `Reject changing ${original.code} to existing Code ${target.code} in Vessel ${vesselA.vessel}`,
      `The application should reject changing Component ${original.code} to Code ${target.code}, which is already used by another component in Vessel ${vesselA.vessel}. Both existing components should remain unchanged.`,
      `The application displayed its duplicate-code validation for ${target.code}; Component ${original.code} and the existing ${target.code} component both remained unchanged.`,
    ), async () => {
      const form = await openEdit(vesselA, original.code);
      const requiredValues = await form.expectEditReady(original.code);
      await form.changeComponentCode(target.code);
      await form.expectRequiredValuesUnchanged(requiredValues);
      const outcome = await form.submitForValidation();
      if (outcome.succeeded) {
        await trackCreatedComponent({
          ...original, code: target.code, vessel: vesselA.vessel, parentCode: vesselA.parentCode,
          sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-054', runId, createdAt: new Date().toISOString(),
        });
        throw new Error([
          'Observed Application Result:',
          `The application accepted changing Component ${original.code} to duplicate Code ${target.code} with HTTP ${outcome.status}. Both existing components may now share the same code.`,
        ].join('\n'));
      }
      await test.step(step(
        `Validate the duplicate-code rejection for ${target.code}`,
        `The application should keep the Edit form open and explain that Component Code ${target.code} is already in use.`,
        `The Edit form remained open and the application displayed: "${outcome.feedback}"`,
      ), async () => {
        expect(outcome.formRemainedOpen, 'The Edit form should remain open after duplicate-code rejection').toBe(true);
        expect(outcome.feedback, 'Duplicate Component Code feedback should explain why Save was rejected').toMatch(/already exists|duplicate|conflict/i);
      });
      await form.back();
      await selectVessel(vesselA.vessel);
      await expectIdentity(vesselA, original);
      await expectIdentity(vesselA, target);
    });
  });

  test('CMP-055 - Edit name to another component name', componentScenario("Changing a component's name to a name already used by another component on the same vessel should be rejected with a visible duplicate-name message; both components should remain unchanged."), async () => {
    const original = await ownedComponent('CMP-055');
    const target = await unique('CMP-055', vesselA.vessel);
    await create(vesselA, target, 'CMP-055');
    await componentValidationStep(page, step(
      `Reject changing ${original.code} to existing Name "${target.name}" in Vessel ${vesselA.vessel}`,
      `The application should reject renaming ${original.code} to "${target.name}", which ${target.code} already uses in Vessel ${vesselA.vessel}, with a visible duplicate-name message; both components should remain unchanged.`,
      `The application rejected Name "${target.name}" on ${original.code}; both original records remained unchanged and unique.`,
    ), async () => {
      const form = await openEdit(vesselA, original.code);
      const requiredValues = await form.expectEditReady(original.code);
      expect(requiredValues.name).toBe(original.name);
      await form.changeComponentName(target.name);
      const outcome = await form.submitForValidation();
      if (outcome.succeeded) {
        await trackCreatedComponent({
          ...original, name: target.name, vessel: vesselA.vessel, parentCode: vesselA.parentCode,
          sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-055', runId, createdAt: new Date().toISOString(),
        });
        await afterSave(vesselA.vessel);
        const saved = await components.searchAndSelectComponentByCode(original.code);
        throw new Error(`Observed Application Result:\nThe application accepted duplicate Name "${saved.name}" for Component ${saved.code} in Vessel ${saved.vesselName} with HTTP ${outcome.status}.`);
      }
      await test.step(step(
        `Validate duplicate Name "${target.name}" for Component ${original.code}`,
        `The application should keep the Edit form open and explain that Component Name "${target.name}" is already used in Vessel ${vesselA.vessel}.`,
        `${outcome.formRemainedOpen ? 'The Edit form remained open' : 'The Edit form closed'} and the application displayed: "${outcome.feedback}"`,
      ), async () => {
        expect(outcome.succeeded, 'The duplicate Component Name update must not succeed').toBe(false);
        expect(outcome.formRemainedOpen, 'The Edit form should remain open after duplicate-name rejection').toBe(true);
        expect(outcome.feedback, 'Duplicate Component Name feedback should explain why Save was rejected').toMatch(/name.*already exists|duplicate.*name|unique name/i);
      });
      await form.back();
      await selectVessel(vesselA.vessel);
      await expectIdentity(vesselA, original);
      await expectIdentity(vesselA, target);
    });
  });

  test('CMP-056 - Enter invalid parent SFI format', componentScenario("Saving a component with a Parent Component Code that is not in a valid SFI format should be rejected with visible format guidance; no component should be created."), async () => {
    const draft = await unique('CMP-056', vesselA.vessel);
    const invalidParent = 'UAT-INVALID';
    await componentValidationStep(page, step(
      `Reject invalid Parent Component Code ${invalidParent} for ${draft.code} in Vessel ${vesselA.vessel}`,
      `Saving ${draft.code} with Parent Code ${invalidParent} should be rejected with visible SFI-format guidance, and no Component ${draft.code} should be created in Vessel ${vesselA.vessel}.`,
      `The application rejected Parent Code ${invalidParent}, displayed validation guidance, and did not create ${draft.code}.`,
    ), async () => {
      const form = await openAdd(vesselA);
      await form.fillRequired(required({ ...vesselA, parentCode: invalidParent }, draft));
      const feedback = await form.expectSaveBlocked('Invalid Parent Component Code', async () => trackCreatedComponent({
        ...draft, vessel: vesselA.vessel, parentCode: invalidParent,
        sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-056', runId, createdAt: new Date().toISOString(),
      }));
      expect(feedback).toMatch(/invalid|format|parent|exist/i);
      await form.back();
      await selectVessel(vesselA.vessel);
      expect(await components.exactComponentCount(draft.code)).toBe(0);
      return feedback;
    }, {
      actual: (feedback) => `Save was rejected for invalid Parent Code ${invalidParent} and the application displayed: "${feedback}". After refresh, Vessel ${vesselA.vessel} contained no Component ${draft.code}.`,
    });
  });

  test('CMP-057 - Use valid-format parent absent from vessel', componentScenario("Saving a component whose Parent Component Code has a valid format but does not exist on the vessel should be rejected with a visible message; no orphan component should be created."), async () => {
    const draft = await unique('CMP-057', vesselA.vessel);
    // Nine numeric digits are already exercised by CMP-059 as a supported SFI
    // component-code shape. Generate one in that shape and prove it is absent.
    const missingParent = await uniqueNineDigitSfiCode(vesselA.vessel);
    await recordStep(
      `Confirm absent Parent Code ${missingParent} uses a supported SFI format`,
      `Parent Code ${missingParent} should contain exactly nine numeric SFI digits and remain absent from Vessel ${vesselA.vessel}.`,
      `Parent Code ${missingParent} contained exactly nine numeric SFI digits and the exact vessel search found 0 matching components.`,
    );
    expect(missingParent).toMatch(/^\d{9}$/);
    await componentValidationStep(page, step(
      `Reject absent Parent Component Code ${missingParent} for ${draft.code} in Vessel ${vesselA.vessel}`,
      `Saving ${draft.code} with valid-format Parent Code ${missingParent}, which does not exist in Vessel ${vesselA.vessel}, should be rejected with a visible message, and no orphan Component ${draft.code} should be created.`,
      `The application rejected absent Parent ${missingParent} and did not create orphan Component ${draft.code}.`,
    ), async () => {
      const form = await openAdd(vesselA);
      await form.fillRequired(required({ ...vesselA, parentCode: missingParent }, draft));
      const feedback = await form.expectSaveBlocked('Absent Parent Component Code', async () => trackCreatedComponent({
        ...draft, vessel: vesselA.vessel, parentCode: missingParent,
        sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-057', runId, createdAt: new Date().toISOString(),
      }));
      await form.back();
      await selectVessel(vesselA.vessel);
      expect(await components.exactComponentCount(draft.code)).toBe(0);
      expect(feedback, 'The feedback should identify a missing parent, not a format problem').toMatch(/parent[^|]*(?:does not exist|doesn't exist|not found|cannot be found)|(?:does not exist|doesn't exist|not found)[^|]*parent/i);
      expect(feedback, 'A valid-format missing parent must not pass on SFI-format feedback').not.toMatch(/invalid\s+(?:sfi\s+)?format|format\s+(?:is\s+)?invalid|valid\s+sfi\s+format/i);
      return feedback;
    }, {
      actual: (feedback) => `Save was rejected for absent Parent Code ${missingParent} and the application displayed: "${feedback}". After refresh, Vessel ${vesselA.vessel} contained no Component ${draft.code}.`,
    });
  });

  test('CMP-058 - Use parent that exists only on another vessel', componentScenario("Saving a component on one vessel with a Parent Component Code that exists only on another vessel should be rejected with a visible message; no component should be created on the first vessel."), async () => {
    const baseFixtureB = vesselB ??= await discoverParentFixture(config.vesselB);
    const exclusiveIdentity = await unique('CMP-058', baseFixtureB.vessel);
    const exclusiveParent = { ...exclusiveIdentity, code: await uniqueChildSfiCode(baseFixtureB.vessel, baseFixtureB.parentCode) };
    const parentForm = await openAdd(baseFixtureB);
    await parentForm.fillRequired({ ...required(baseFixtureB, exclusiveParent), isParent: 'Yes', department: '' });
    await parentForm.saveValid();
    await trackCreatedComponent({ ...exclusiveParent, vessel: baseFixtureB.vessel, parentCode: baseFixtureB.parentCode, sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-058', runId, createdAt: new Date().toISOString() });
    const fixtureB = { ...baseFixtureB, parentCode: exclusiveParent.code };
    let draft: ComponentData;
    try {
      await test.step(step(
        `Confirm Parent ${fixtureB.parentCode} exists only in Vessel ${fixtureB.vessel}`,
        `Parent ${fixtureB.parentCode} should exist in ${fixtureB.vessel} and be absent from ${vesselA.vessel} before the cross-vessel Save.`,
        `Parent ${fixtureB.parentCode} existed in ${fixtureB.vessel} and no matching component existed in ${vesselA.vessel}.`,
      ), async () => {
        await selectVessel(vesselA.vessel);
        expect(await components.exactComponentCount(fixtureB.parentCode), `Parent ${fixtureB.parentCode} must not also exist in Vessel ${vesselA.vessel}`).toBe(0);
      });
      draft = await unique('CMP-058', vesselA.vessel);
    } catch (error) {
      const reason = `the vessel-exclusive Parent ${fixtureB.parentCode} could not be confirmed`;
      await notExecuted(`Open Add Component in Vessel ${vesselA.vessel} for the cross-vessel parent check`, `The Add Component form should open beneath Parent ${vesselA.parentCode} in Vessel ${vesselA.vessel}.`, reason);
      await notExecuted(`Enter Parent ${fixtureB.parentCode} on the Vessel ${vesselA.vessel} draft`, `The draft should be fully populated with the Vessel ${fixtureB.vessel}-only Parent ${fixtureB.parentCode} before Save.`, reason);
      await notExecuted('Click Save and capture cross-vessel parent validation', 'The application should reject the cross-vessel relationship with a readable message.', reason);
      await notExecuted(`Refresh Vessel ${vesselA.vessel} and verify no orphan component exists`, `The rejected draft should not appear in the Vessel ${vesselA.vessel} register.`, reason);
      throw error;
    }
    await componentValidationStep(page, step(
      `Reject Vessel ${fixtureB.vessel} Parent ${fixtureB.parentCode} for ${draft.code} in Vessel ${vesselA.vessel}`,
      `Saving ${draft.code} in Vessel ${vesselA.vessel} with Parent ${fixtureB.parentCode}, which exists only in Vessel ${fixtureB.vessel}, should be rejected with a visible message, and no Component ${draft.code} should be created in Vessel ${vesselA.vessel}.`,
      `The application rejected cross-vessel Parent ${fixtureB.parentCode} and did not create ${draft.code} in ${vesselA.vessel}.`,
    ), async () => {
      const form = await openAdd(vesselA);
      await form.fillRequired(required({ ...vesselA, parentCode: fixtureB.parentCode }, draft));
      const feedback = await form.expectSaveBlocked('Cross-vessel Parent Component Code', async () => trackCreatedComponent({
        ...draft, vessel: vesselA.vessel, parentCode: fixtureB.parentCode,
        sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-058', runId, createdAt: new Date().toISOString(),
      }));
      await form.back();
      await selectVessel(vesselA.vessel);
      expect(await components.exactComponentCount(draft.code)).toBe(0);
      expect(feedback, 'The feedback should identify that the parent is unavailable on the draft vessel').toMatch(/parent[^|]*(?:does not exist|doesn't exist|not found|cannot be found|vessel)|(?:does not exist|doesn't exist|not found|vessel)[^|]*parent/i);
      expect(feedback, 'A cross-vessel parent rejection must not pass on format feedback').not.toMatch(/invalid\s+(?:sfi\s+)?format|format\s+(?:is\s+)?invalid|valid\s+sfi\s+format/i);
      return feedback;
    }, {
      actual: (feedback) => `Save was rejected for cross-vessel Parent Code ${fixtureB.parentCode} and the application displayed: "${feedback}". After refresh, Vessel ${vesselA.vessel} contained no Component ${draft.code}.`,
    });
  });

  test('CMP-059 - Set component code equal to parent code', componentScenario("Setting a component's Parent Component Code to its own Component Code should be rejected with a message that identifies the self-parent relationship; the component should keep its original parent and name."), async () => {
    const identity = await unique('CMP-059', vesselA.vessel);
    const original = { ...identity, code: await uniqueNineDigitSfiCode(vesselA.vessel) };
    await create(vesselA, original, 'CMP-059');
    await componentValidationStep(page, step(
      `Reject setting Parent Component Code to the component's own Code ${original.code} in Vessel ${vesselA.vessel}`,
      `The application should reject Component ${original.code} as its own parent and preserve Parent ${vesselA.parentCode}, Name "${original.name}", and the original hierarchy.`,
      `The application rejected the self-parent edit for ${original.code}; Parent ${vesselA.parentCode}, Name "${original.name}", and the original record were preserved.`,
    ), async () => {
      const form = await openEdit(vesselA, original.code);
      const requiredValues = await form.expectEditReady(original.code);
      expect(requiredValues.name).toBe(original.name);
      await form.changeParent(original.code);
      const outcome = await form.submitForValidation();
      if (outcome.succeeded) {
        await trackCreatedComponent({
          ...original, vessel: vesselA.vessel, parentCode: original.code,
          sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-059', runId, createdAt: new Date().toISOString(),
        });
        await afterSave(vesselA.vessel);
        await components.searchAndSelectComponentByCode(original.code);
        const savedParent = await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Parent Component Code' });
        throw new Error(`Observed Application Result:\nThe application accepted Component ${original.code} with its own Code as Parent Component Code; the reopened record shows Parent ${savedParent}.`);
      }
      await test.step(step(
        `Validate self-parent rejection for Component ${original.code}`,
        `The application should identify that Component Code and Parent Component Code are both ${original.code}, rather than treating this only as a duplicate-code case.`,
        `${outcome.formRemainedOpen ? 'The Edit form remained open' : 'The Edit form closed'} and the application displayed: "${outcome.feedback}"`,
      ), async () => {
        expect(outcome.succeeded, 'The self-parent update must not succeed').toBe(false);
        expect(outcome.formRemainedOpen, 'The Edit form should remain open after self-parent rejection').toBe(true);
        expect(outcome.feedback, 'The message should specifically explain the self-parent relationship').toMatch(/cannot be its own parent|self[- ]?parent|code and parent component code are both/i);
      });
      await form.back();
      await selectVessel(vesselA.vessel);
      await expectIdentity(vesselA, original);
    });
  });

  test('CMP-060 - Set parent parent to a descendant', componentScenario("Moving a parent component beneath one of its own descendants should be rejected with a message that identifies the circular hierarchy; the original hierarchy should remain intact after refresh."), async () => {
    test.setTimeout(5 * 60_000);
    const hierarchyRoot = await discoverParentFixture(vesselA.vessel, [], '3');
    const parentIdentity = await unique('CMP-060', vesselA.vessel);
    // Append a supported three-digit child segment to the exact saved parent;
    // this stays valid even when the discovered root has multiple digits.
    const parentCode = await uniqueChildSfiCode(vesselA.vessel, hierarchyRoot.parentCode);
    const parentForm = await openAdd(hierarchyRoot);
    const hierarchyParent = { ...parentIdentity, code: parentCode };
    await parentForm.fillRequired({ ...required(hierarchyRoot, hierarchyParent), isParent: 'Yes' });
    await parentForm.saveValid();
    await trackCreatedComponent({ ...hierarchyParent, vessel: hierarchyRoot.vessel, parentCode: hierarchyRoot.parentCode, sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-060', runId, createdAt: new Date().toISOString() });
    await afterSave(vesselA.vessel, 'after creating the hierarchy parent');
    const childIdentity = await unique('CMP-060', vesselA.vessel);
    const childCode = await uniqueChildSfiCode(vesselA.vessel, hierarchyParent.code);
    const hierarchyFixture = { ...hierarchyRoot, parentCode: hierarchyParent.code };
    await selectVessel(vesselA.vessel);
    await components.searchAndSelectComponentByCode(hierarchyRoot.parentCode);
    expect(await components.directChildCodes(hierarchyRoot.parentCode)).toContain(hierarchyParent.code);
    await components.selectComponentByCode(hierarchyParent.code);
    const childForm = await components.openComponentForAdd();
    const child = { ...childIdentity, code: childCode };
    await childForm.fillRequired(required(hierarchyFixture, child));
    await childForm.saveValid();
    await trackCreatedComponent({ ...child, vessel: vesselA.vessel, parentCode: hierarchyParent.code, sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-060', runId, createdAt: new Date().toISOString() });
    await afterSave(vesselA.vessel, 'after creating the hierarchy descendant');
    await test.step(step(
      `Confirm Parent ${hierarchyParent.code} and descendant ${child.code} are saved before the circular edit`,
      `Parent ${hierarchyParent.code} should remain beneath ${hierarchyRoot.parentCode}, and ${child.code} should be its direct descendant before Edit begins.`,
      `Parent ${hierarchyParent.code} was visible beneath ${hierarchyRoot.parentCode}, and descendant ${child.code} was visible directly beneath it.`,
    ), async () => {
      await components.searchAndSelectComponentByCode(hierarchyRoot.parentCode);
      expect(await components.directChildCodes(hierarchyRoot.parentCode)).toContain(hierarchyParent.code);
      await components.selectComponentByCode(hierarchyParent.code);
      expect(await components.directChildCodes(hierarchyParent.code)).toContain(child.code);
      await components.searchAndSelectComponentByCode(child.code);
      expect(await components.readSelectedComponentIdentity()).toEqual({ code: child.code, name: child.name, vesselName: vesselA.vessel });
    });
    await componentValidationStep(page, step(
      `Reject moving Parent ${hierarchyParent.code} beneath descendant ${child.code} in Vessel ${vesselA.vessel}`,
      `The application should reject moving Parent ${hierarchyParent.code} beneath its own descendant ${child.code} with a circular-hierarchy message; after refresh ${hierarchyParent.code} should remain under ${hierarchyRoot.parentCode} with child ${child.code}.`,
      `The application rejected the circular relationship; ${hierarchyParent.code} remained under ${hierarchyRoot.parentCode} with descendant ${child.code}.`,
    ), async () => {
      await selectVessel(vesselA.vessel);
      await components.searchAndSelectComponentByCode(hierarchyRoot.parentCode);
      expect(await components.directChildCodes(hierarchyRoot.parentCode)).toContain(hierarchyParent.code);
      await components.selectComponentByCode(hierarchyParent.code);
      const form = await test.step(step(
        `Open Edit Component for Parent ${hierarchyParent.code}`,
        `Parent ${hierarchyParent.code} should open in Edit mode with its saved hierarchy values.`,
        `Parent ${hierarchyParent.code} opened in Edit mode with its saved hierarchy values.`,
      ), async () => components.openSelectedComponentForEdit());
      const requiredValues = await form.expectEditReady(hierarchyParent.code);
      expect(requiredValues.name).toBe(hierarchyParent.name);
      await form.changeParent(child.code);
      // The update request and its response are kept as evidence of what Save actually sent and received.
      const writes: Array<{ method: string; parentSent: string; status: number; body: string }> = [];
      const recordWrite = async (response: import('@playwright/test').Response) => {
        const request = response.request();
        if (!response.url().includes('/technical/api/components') || request.method() === 'GET') return;
        const payload = (() => { try { return request.postDataJSON() as Record<string, unknown>; } catch { return {}; } })();
        const parentSent = Object.entries(payload ?? {}).filter(([key]) => /parent/i.test(key) && !/^isParent$/i.test(key)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ');
        writes.push({ method: request.method(), parentSent: parentSent || 'no parent field', status: response.status(), body: (await response.text().catch(() => '')).slice(0, 600) });
      };
      page.on('response', recordWrite);
      const outcome = await form.submitForValidation({
        expected: `Clicking Save with descendant ${child.code} as the parent of ${hierarchyParent.code} should produce an application response or message, which is recorded for the circular-hierarchy check.`,
      }).finally(() => page.off('response', recordWrite));
      if (outcome.succeeded) {
        await test.info().attach('CMP-060 Save request and response', {
          contentType: 'text/plain',
          body: writes.map((write) => `${write.method} sent ${write.parentSent}; HTTP ${write.status}; response ${write.body || '(empty)'}`).join('\n') || 'No component write request was observed.',
        });
        await afterSave(vesselA.vessel);
        const saved = await componentActionStep(
          `Reopen Parent ${hierarchyParent.code} and read its saved parent`,
          `After refresh, Parent ${hierarchyParent.code} should still be saved beneath ${hierarchyRoot.parentCode}, because the circular move must not be applied.`,
          async () => {
            const identity = await components.searchAndSelectComponentByCode(hierarchyParent.code).catch(() => undefined);
            const parent = identity ? await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Parent Component Code' }) : undefined;
            return { found: Boolean(identity), parent };
          },
          (state) => (state.found ? `After refresh, ${hierarchyParent.code} showed Parent Component Code ${state.parent}.` : `After refresh, ${hierarchyParent.code} could not be found through an exact search.`),
          { page },
        );
        const accepted = writes.find((write) => write.status >= 200 && write.status < 300);
        const returnedParent = /"parentId"\s*:\s*("[^"]*"|null)/.exec(accepted?.body ?? '')?.[1];
        // The server may have stored the circular parent; cleanup must then know the record under it.
        await trackCreatedComponent({
          ...hierarchyParent, vessel: vesselA.vessel, parentCode: child.code,
          sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-060', runId, createdAt: new Date().toISOString(),
        });
        const shownAfter = !saved.found
          ? `after refresh ${hierarchyParent.code} could no longer be found by exact search`
          : `after refresh the details panel of ${hierarchyParent.code} showed Parent Component Code ${saved.parent}`;
        throw new Error(
          `Observed Application Result:\nSaving Parent ${hierarchyParent.code} with Parent Component Code ${child.code} (its own descendant) was not refused: Save returned HTTP ${outcome.status ?? 'success'}, the Edit form ${outcome.formRemainedOpen ? 'remained open' : 'closed'} and no circular-hierarchy message was shown. The request sent ${accepted?.parentSent ?? 'no observed parent value'} and the server's response reported parentId ${returnedParent ?? 'not present'}; ${shownAfter}.`,
        );
      }
      await test.step(step(
        `Validate circular relationship rejection for Parent ${hierarchyParent.code} and descendant ${child.code}`,
        `The application should explain that moving Parent ${hierarchyParent.code} beneath its descendant ${child.code} would create a circular hierarchy.`,
        `${outcome.formRemainedOpen ? 'The Edit form remained open' : 'The Edit form closed'} and the application displayed: "${outcome.feedback}"`,
      ), async () => {
        expect(outcome.succeeded, 'The circular parent update must not succeed').toBe(false);
        expect(outcome.formRemainedOpen, 'The Edit form should remain open after circular-hierarchy rejection').toBe(true);
        expect(outcome.feedback, 'The message should describe a circular or descendant relationship, not direct self-parenting').toMatch(/circular|cycle|descendant/i);
        expect(outcome.feedback, 'A parent-to-descendant test must not be reported as direct self-parenting').not.toMatch(/component code and parent component code are both|cannot be its own parent/i);
      });
      await form.back();
      await selectVessel(vesselA.vessel);
      await components.searchAndSelectComponentByCode(hierarchyRoot.parentCode);
      expect(await components.directChildCodes(hierarchyRoot.parentCode)).toContain(hierarchyParent.code);
      await components.selectComponentByCode(hierarchyParent.code);
      expect(await components.readSelectedComponentIdentity()).toEqual({
        code: hierarchyParent.code,
        name: hierarchyParent.name,
        vesselName: vesselA.vessel,
      });
      expect(await components.readSelectedComponentDetail({
        section: 'A. Component Information',
        label: 'Parent Component Code',
      })).toContain(hierarchyRoot.parentCode);
      expect(await components.directChildCodes(hierarchyParent.code)).toContain(child.code);
      expect(await components.directChildCodes(child.code)).not.toContain(hierarchyParent.code);
    });
  });

  test('CMP-061 - Create same vessel and code concurrently', componentScenario("When two users save the same Component Code on the same vessel at the same time, exactly one save should succeed and the other should receive a visible duplicate or conflict message, leaving exactly one component."), async ({ browser }) => {
    const data = await unique('CMP-061', vesselA.vessel);
    const userAData = { ...data, name: `${data.name} User A` };
    const userBData = { ...data, name: `${data.name} User B` };
    const userALabel = `User A (${config.username})`;
    const userBLabel = `User B (${config.automationUser2Username})`;
    const contextB = await browser.newContext({ baseURL: config.baseUrl, viewport: null });
    const contextA = context;
    const pageA = page;
    const pageB = await contextB.newPage();
    try {
      const loginB = new LoginPage(pageB);
      const componentsA = components;
      await test.step(step(
        `Confirm the existing authenticated Components session for ${userALabel}`,
        `${userALabel} should reuse the suite's authenticated primary browser context and remain on Components.`,
        `${userALabel} reused the suite's existing authenticated browser context and the Components page was available.`,
      ), async () => {
        expect(contextA).not.toBe(contextB);
        await componentsA.expectToBeOnPage();
      });
      const componentsB = await test.step(step(
        `Log in and open Components for ${userBLabel}`,
        `${userBLabel} should authenticate with a different configured account in a separate browser context and open PMS Components.`,
        `${userBLabel} logged in with separate configured credentials and opened PMS Components in the second browser context.`,
      ), async () => {
        expect(config.automationUser2Username.trim().toLowerCase(), 'User B must use a different configured username from User A')
          .not.toBe(config.username.trim().toLowerCase());
        await loginB.open();
        const dashboardB = await loginB.loginForPms(config.automationUser2Username, config.automationUser2Password, config.domain);
        const session = await dashboardB.goToTechnical().then((technical) => technical.goToComponents());
        await session.expectToBeOnPage();
        return session;
      });
      await test.step(step(
        `Select Vessel ${vesselA.vessel} in both user sessions`,
        `Both independent Components sessions should load the same Vessel ${vesselA.vessel}.`,
        `${userALabel} and ${userBLabel} both selected Vessel ${vesselA.vessel} and loaded its component tree.`,
      ), async () => Promise.all([
        componentsA.clearComponentSearch()
          .then(() => componentsA.selectVessel(vesselA.vessel))
          .then(() => componentsA.expectTreeLoaded()),
        componentsB.clearComponentSearch()
          .then(() => componentsB.selectVessel(vesselA.vessel))
          .then(() => componentsB.expectTreeLoaded()),
      ]));
      const { formA, formB, parentIdentityBefore } = await test.step(step(
        `Select Parent ${vesselA.parentCode} and open Add Component for both users`,
        `Both sessions should select Parent ${vesselA.parentCode} and open independent Add Component forms.`,
        `${userALabel} and ${userBLabel} selected Parent ${vesselA.parentCode} and opened independent Add Component forms.`,
      ), async () => {
        await Promise.all([
          componentsA.searchAndSelectComponentByCode(vesselA.parentCode),
          componentsB.searchAndSelectComponentByCode(vesselA.parentCode),
        ]);
        const parentIdentityBefore = await componentsA.readSelectedComponentIdentity();
        const [formA, formB] = await Promise.all([
          componentsA.openComponentForAdd(),
          componentsB.openComponentForAdd(),
        ]);
        return { formA, formB, parentIdentityBefore };
      });
      const requiredA = required(vesselA, userAData);
      const requiredB = required(vesselA, userBData);
      await test.step(step(
        `Prepare Code ${data.code} in both Add Component forms before either Save`,
        `Both users should enter the same Code ${data.code}, their user-specific names, Parent ${vesselA.parentCode}, and identical required master data before either Save begins.`,
        `Both independent Add Component forms were fully hydrated and ready with Code ${data.code}, Parent ${vesselA.parentCode}, and the configured master data before either Save began.`,
      ), async () => {
        await Promise.all([
          formA.fillRequired({ ...requiredA, actorLabel: userALabel }),
          formB.fillRequired({ ...requiredB, actorLabel: userBLabel }),
        ]);
        await Promise.all([
          formA.expectReadyForConcurrentSave({ ...requiredA, parentCode: vesselA.parentCode, code: data.code, name: userAData.name }),
          formB.expectReadyForConcurrentSave({ ...requiredB, parentCode: vesselA.parentCode, code: data.code, name: userBData.name }),
        ]);
      });

      const outcomes = await test.step(step(
        `Initiate both Save actions concurrently for Code ${data.code}`,
        `Both browser windows should initiate Save for Code ${data.code} before either response finishes.`,
        `Both browser windows initiated Save for Code ${data.code} through one coordinated concurrent action; each response is recorded separately below.`,
      ), async () => Promise.all([formA.submitForConflict(), formB.submitForConflict()]));
      await Promise.all([
        test.info().attach(`CMP-061 ${userALabel} UI result validation evidence`, { body: await pageA.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }),
        test.info().attach(`CMP-061 ${userBLabel} UI result validation evidence`, { body: await pageB.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }),
      ]);
      const successes = outcomes.filter(({ status }) => status >= 200 && status < 300);
      const rejected = outcomes.filter(({ status }) => status < 200 || status >= 300);
      const successfulIndex = outcomes.findIndex(({ status }) => status >= 200 && status < 300);
      // Every successful save created a record, so each one is tracked for manual cleanup.
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status < 200 || outcome.status >= 300) continue;
        const savedData = index === 0 ? userAData : userBData;
        await trackCreatedComponent({ ...savedData, vessel: vesselA.vessel, parentCode: vesselA.parentCode, sourceSpec: 'components-parent-relationships-uniqueness.spec.ts', testCaseId: 'CMP-061', runId, createdAt: new Date().toISOString() });
      }
      await recordStep(
        `Capture ${userALabel} Save result for Component ${data.code}`,
        `${userALabel} should receive either the successful creation result or a readable duplicate-code conflict from the concurrent Save.`,
        `${userALabel} received HTTP ${outcomes[0].status} with UI message "${outcomes[0].uiMessage}".`,
        outcomes[0].uiMessage ? undefined : 'FAIL',
      );
      await recordStep(
        `Capture ${userBLabel} Save result for Component ${data.code}`,
        `${userBLabel} should receive either the successful creation result or a readable duplicate-code conflict from the concurrent Save.`,
        `${userBLabel} received HTTP ${outcomes[1].status} with UI message "${outcomes[1].uiMessage}".`,
        outcomes[1].uiMessage ? undefined : 'FAIL',
      );

      const concurrent = Math.max(...outcomes.map(({ saveInitiatedAt }) => saveInitiatedAt)) <= Math.min(...outcomes.map(({ responseReceivedAt }) => responseReceivedAt));
      await recordStep(
        `Verify both Save actions for Code ${data.code} were concurrent`,
        `Both users' Save actions should be initiated before either Save response completes.`,
        `Both Save actions ${concurrent ? 'were initiated before either response completed' : 'were not proven to overlap'}.`,
        concurrent ? undefined : 'FAIL',
      );

      const matchingCount = await test.step(step(
        `Refresh Vessel ${vesselA.vessel} and search for Component Code ${data.code}`,
        `After both Save responses, the register should reload Vessel ${vesselA.vessel} and return the exact matches for Code ${data.code}.`,
        `The register reloaded Vessel ${vesselA.vessel} and the search for Code ${data.code} completed; the match count is reported in the next step.`,
      ), async () => {
        await pageA.goto(routes.componentPage, { waitUntil: 'domcontentloaded' });
        await componentsA.expectToBeOnPage();
        await componentsA.selectVessel(vesselA.vessel);
        await componentsA.expectTreeLoaded();
        return componentsA.exactComponentCount(data.code);
      });
      let relationshipResult = 'the saved component relationship was not verified because exactly one matching component was not present';
      if (matchingCount === 1 && successfulIndex >= 0) {
        const expectedSavedData = successfulIndex === 0 ? userAData : userBData;
        const savedIdentity = await componentsA.searchAndSelectComponentByCode(data.code);
        expect(savedIdentity).toEqual({ code: data.code, name: expectedSavedData.name, vesselName: vesselA.vessel });
        expect(await componentsA.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Parent Component Code' })).toContain(vesselA.parentCode);
        expect(await componentsA.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Component Category' })).toContain(vesselA.category);
        expect(await componentsA.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Equipment / System Department' })).toContain(vesselA.department);
        await componentsA.searchAndSelectComponentByCode(vesselA.parentCode);
        expect(await componentsA.readSelectedComponentIdentity()).toEqual(parentIdentityBefore);
        relationshipResult = `the saved component remained beneath Parent ${vesselA.parentCode} with the configured category and department, and Parent ${vesselA.parentCode} remained unchanged`;
      }
      await test.step(step(
        `Verify persisted Component ${data.code}, its relationship, and unaffected Parent ${vesselA.parentCode}`,
        `Exactly one Component ${data.code} should remain with the successful user's name, Parent ${vesselA.parentCode}, configured category and department; the parent record should remain unchanged.`,
        `The register contained ${matchingCount} exact match${matchingCount === 1 ? '' : 'es'} for ${data.code}; ${relationshipResult}.`,
        matchingCount === 1 ? undefined : 'FAIL',
      ), async () => {});
      const describeOutcome = (label: string, outcome: typeof outcomes[number]) => `${label}: HTTP ${outcome.status}; UI message: "${outcome.uiMessage}"${outcome.responseMessage && !outcome.uiMessage.includes(outcome.responseMessage) ? `; server message: "${outcome.responseMessage}"` : ''}`;
      const observed = `${describeOutcome(userALabel, outcomes[0])}. ${describeOutcome(userBLabel, outcomes[1])}. Both Save actions ${concurrent ? 'were initiated before either response completed' : 'were not proven to overlap'}. Vessel ${vesselA.vessel} used Code ${data.code}. After refresh, the register showed ${matchingCount} matching component${matchingCount === 1 ? '' : 's'}; ${relationshipResult}.`;

      await componentValidationStep(pageA, step(
        `Create Code ${data.code} concurrently in two sessions on Vessel ${vesselA.vessel}`,
        `Exactly one of the two simultaneous saves of Code ${data.code} in Vessel ${vesselA.vessel} should succeed; the other user should see a duplicate or conflict message, leaving exactly one Component ${data.code}.`,
        observed,
      ), async () => {
        const rejectedMessage = rejected[0]?.uiMessage ?? '';
        if (!concurrent || successes.length !== 1 || rejected.length !== 1 || !/already exists|duplicate|conflict|unique code/i.test(rejectedMessage) || matchingCount !== 1) {
          throw new Error(`Observed Application Result:\n${observed}`);
        }
      });
    } finally {
      await contextB.close();
    }
  });
});
