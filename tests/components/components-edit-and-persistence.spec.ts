import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ComponentFormPage } from '../../pages/ComponentFormPage';
import { ComponentsPage } from '../../pages/ComponentsPage';
import { LoginPage } from '../../pages/LoginPage';
import { attachFailureScreenshot, componentScenario, componentValidationStep } from '../../utils/componentValidationEvidence';
import { readTrackedComponents, trackCreatedComponent, updateTrackedComponentCleanup } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

type ComponentIdentity = { code: string; name: string };
type CreatedComponentIdentity = ComponentIdentity & { parentCode: string };
type OptionalValues = Record<'Model' | 'Rating' | 'Location' | 'Notes / Technical Information', string>;

const step = (title: string, expected: string, actual: string, status?: 'FAIL' | 'NOT RUN') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}${status ? `\nStatus: ${status}` : ''}`;

test.describe('Components CMP-082 to CMP-092 - Edit and persistence', () => {
  test.setTimeout(5 * 60_000);
  let browserInstance: Browser;
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let secondaryContext: BrowserContext | undefined;
  let secondaryPage: Page | undefined;
  let secondaryComponents: ComponentsPage | undefined;
  let selected: ComponentIdentity;
  const vessel = config.vesselA;
  const runToken = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

  const getSecondaryComponents = async (): Promise<ComponentsPage> => {
    if (secondaryComponents && secondaryPage && !secondaryPage.isClosed()) return secondaryComponents;
    expect(config.automationUser2Username.trim().toLowerCase()).not.toBe(config.username.trim().toLowerCase());
    secondaryContext = await browserInstance.newContext({ baseURL: config.baseUrl, viewport: null });
    secondaryPage = await secondaryContext.newPage();
    const login = new LoginPage(secondaryPage);
    await login.open();
    const dashboard = await login.loginForPms(config.automationUser2Username, config.automationUser2Password, config.domain);
    const openedComponents = await dashboard.goToTechnical().then((technical) => technical.goToComponents());
    await openedComponents.expectToBeOnPage();
    secondaryComponents = openedComponents;
    return openedComponents;
  };

  const openEdit = async (target = selected, targetComponents = components): Promise<ComponentFormPage> => {
    const identity = await targetComponents.searchAndSelectComponentByCode(target.code);
    expect(identity).toMatchObject({ code: target.code, name: target.name, vesselName: vessel });
    const form = await targetComponents.openSelectedComponentForEdit();
    await form.expectEditReady(target.code);
    return form;
  };

  const createFreshScenarioComponent = async (testCaseId: 'CMP-090' | 'CMP-091'): Promise<CreatedComponentIdentity> => {
    const suffix = `${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 4)}`.toUpperCase();
    const created = { code: `AT${testCaseId.slice(4)}-${suffix}`.slice(0, 20), name: `${testCaseId} disposable ${suffix}` };
    const hierarchy = await componentValidationStep(page, step(
      `Identify an accessible parent for the new ${testCaseId} component`,
      `The application should expose the actual parent branch of automation Component ${selected.code} in Vessel ${vessel}.`,
      `The application exposed an accessible parent branch for automation Component ${selected.code} without using Expand All.`,
    ), () => components.discoverHierarchyFixture(selected.code), {
      actual: ({ parent }) => `Component ${parent.code} (${parent.name}) was observed as the accessible parent of ${selected.code} in Vessel ${vessel}.`,
    });
    const parentCode = hierarchy.parent.code;
    const submission = await componentValidationStep(page, step(
      `Create fresh ${testCaseId} Component ${created.code} (${created.name})`,
      `One new automation-owned component should save under accessible Parent ${parentCode} and display successful application feedback.`,
      `The application accepted Component ${created.code} under Parent ${parentCode}.`,
    ), async () => {
      const form = await components.openComponentForAdd();
      const required = {
        parentCode,
        code: created.code,
        name: created.name,
        category: 'Ship General',
        department: config.componentDepartment,
        isParent: 'No' as const,
        isActive: 'Yes' as const,
      };
      await form.fillRequired({ ...required, actorLabel: 'the primary automation user' });
      await form.expectReadyForConcurrentSave(required);
      const outcome = await form.submitForConflict();
      expect(outcome.status, `Creating ${created.code} should return a successful response`).toBeGreaterThanOrEqual(200);
      expect(outcome.status, `Creating ${created.code} should return a successful response`).toBeLessThan(300);
      expect(outcome.uiMessage, `Creating ${created.code} should display success feedback`).toMatch(/success|created|saved|added/i);
      await trackCreatedComponent({ ...created, vessel, parentCode, sourceSpec: 'components-edit-and-persistence.spec.ts', testCaseId, runId: `${testCaseId.toLowerCase()}-${suffix}`, createdAt: new Date().toISOString() });
      return outcome;
    }, {
      actual: (outcome) => `Create returned HTTP ${outcome.status} with visible feedback "${outcome.uiMessage}"${outcome.responseMessage ? ` and response "${outcome.responseMessage}"` : ''} for ${created.code}.`,
    });
    expect(submission.status).toBeGreaterThanOrEqual(200);

    await componentValidationStep(page, step(
      `Refresh and verify fresh ${testCaseId} Component ${created.code}`,
      `After refresh, exact Code ${created.code}, Name ${created.name}, and Vessel ${vessel} should identify one editable component.`,
      `After refresh, the exact component identity was located and its Edit form opened successfully.`,
    ), async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await components.expectToBeOnPage();
      await components.selectVessel(vessel);
      const identity = await components.searchAndSelectComponentByCode(created.code);
      expect(identity).toEqual({ ...created, vesselName: vessel });
      const form = await components.openSelectedComponentForEdit();
      await form.expectEditReady(created.code);
      await form.back();
      return identity;
    }, {
      actual: (identity) => `The refreshed register showed exact Component ${identity.code} (${identity.name}) in Vessel ${identity.vesselName}, and its Edit form hydrated successfully.`,
    });
    return { ...created, parentCode };
  };

  const readOptional = async (form: ComponentFormPage): Promise<OptionalValues> => ({
    Model: await form.controlValue('Model', 'input-model'),
    Rating: await form.controlValue('Rating', 'input-rating'),
    Location: await form.controlValue('Location', 'input-location'),
    'Notes / Technical Information': await form.controlValue('Notes / Technical Information', 'input-notes'),
  });

  const saveAndReopen = async (form: ComponentFormPage): Promise<ComponentFormPage> => {
    await form.saveValid();
    await components.expectToBeOnPage();
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    return openEdit();
  };

  const selectSafeComponent = async (): Promise<ComponentIdentity> => {
    const tracked = (await readTrackedComponents())
      .filter((item) => item.vessel === vessel && (item.cleanupStatus === undefined || item.cleanupStatus === 'pending'))
      .sort((first, second) => first.code.localeCompare(second.code));
    for (const candidate of tracked) {
      try {
        const identity = await components.searchAndSelectComponentByCode(candidate.code);
        if (identity.name !== candidate.name || identity.vesselName !== vessel) continue;
        const form = await components.openSelectedComponentForEdit();
        await form.expectEditReady(candidate.code);
        await form.back();
        return { code: identity.code, name: identity.name };
      } catch {
        await restoreComponentsPage(page, components, vessel).catch(() => undefined);
      }
    }
    for (const term of ['Test CMP', 'AUTO', 'AAAA']) {
      const candidates = await components.searchTree(term);
      for (const candidate of candidates.filter((item) => /^(?:Test CMP|AUTO|AAAA)/i.test(item.name))) {
        try {
          const identity = await components.searchAndSelectComponentByCode(candidate.code);
          if (identity.vesselName !== vessel) continue;
          const form = await components.openSelectedComponentForEdit();
          await form.expectEditReady(candidate.code);
          await form.back();
          return { code: identity.code, name: identity.name };
        } catch {
          await restoreComponentsPage(page, components, vessel).catch(() => undefined);
        }
      }
      await components.clearComponentSearch();
    }
    throw new Error(`No editable automation-owned component was available in Vessel ${vessel}; unrelated operational components were not modified.`);
  };

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(5 * 60_000);
    browserInstance = browser;
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await test.step(step(
      `Initial setup - Select Vessel ${vessel}`,
      `The authenticated Components session should select Vessel ${vessel} once and load its collapsed component tree.`,
      `The authenticated Components session selected Vessel ${vessel}; the tree loaded without using Expand All.`,
    ), async () => {
      await components.selectVessel(vessel);
      await components.expectTreeLoaded();
    });
    selected = await test.step(step(
      'Initial setup - Select one safe editable automation component',
      'One existing automation-owned component should be selected by exact code, name, and vessel for the edit scenarios.',
      'An existing automation-owned component was selected and its editable identity was verified.',
    ), () => selectSafeComponent());
    testInfo.annotations.push({ type: 'components-selected-shared-component', description: `${selected.code} | ${selected.name} | ${vessel}` });
  });

  test.afterEach(async () => {
    await attachFailureScreenshot(page, test.info());
    await restoreComponentsPage(page, components, vessel);
  });
  test.afterAll(async () => Promise.allSettled([secondaryContext?.close(), context?.close()]));

  test('CMP-082 - Open Edit Component with saved values', componentScenario('Opening an existing component in Edit should populate its supported fields with the values currently saved for that exact component, without changing or duplicating it.'), async () => {
    await componentValidationStep(page, step(
      `Open Component ${selected.code} in Edit and compare its saved identity`,
      `Component ${selected.code} (${selected.name}) should open in Edit with the same saved Code and Name shown in the register.`,
      `Component ${selected.code} opened in Edit with its saved Code and Name populated.`,
    ), async () => {
      const before = await components.searchAndSelectComponentByCode(selected.code);
      const form = await components.openSelectedComponentForEdit();
      const hydrated = await form.expectEditReady(selected.code);
      expect(hydrated.name).toBe(before.name);
      expect(await form.controlValue('Component Code', 'input-component-code')).toBe(before.code);
      await form.back();
      return { before, hydrated };
    }, { actual: ({ before, hydrated }) => `The register selected ${before.code} (${before.name}) in Vessel ${before.vesselName}; Edit displayed Code ${before.code}, Name ${hydrated.name}, Category ${hydrated.category}, Department ${hydrated.department}, and Active ${hydrated.active}.` });
  });

  test('CMP-083 - Edit Model, Rating, Location and Notes', componentScenario('Changing Model, Rating, Location, and Notes should persist after one Save, refresh, and reopen of the same component, without creating a duplicate.'), async () => {
    const values: OptionalValues = { Model: `Model-${runToken}`, Rating: '5', Location: `Location-${runToken}`, 'Notes / Technical Information': `CMP-083 ${runToken}` };
    await componentValidationStep(page, step(
      `Edit and persist four optional fields on Component ${selected.code}`,
      'The new Model, Rating, Location, and Notes should remain unchanged after Save and reopen, and the exact component count should remain one.',
      `Component ${selected.code} reopened with the four entered values and no duplicate component.`,
    ), async () => {
      let form = await openEdit();
      await form.fillOptional(values);
      form = await saveAndReopen(form);
      const observed = await readOptional(form);
      await form.back();
      expect(observed).toEqual(values);
      expect(await components.exactComponentCount(selected.code)).toBe(1);
      return observed;
    }, { actual: (observed) => `After Save and reopen, ${selected.code} displayed ${JSON.stringify(observed)} and the register contained exactly one matching component.` });
  });

  test('CMP-084 - Save unchanged component', componentScenario('Saving an unchanged component should preserve its existing data and must not create another component.'), async () => {
    await componentValidationStep(page, step(
      `Save Component ${selected.code} without changing a field`,
      'The component should reopen with the same identity and optional values, with exactly one matching record.',
      `The unchanged component reopened with its prior values and remained a single record.`,
    ), async () => {
      let form = await openEdit();
      const before = await readOptional(form);
      form = await saveAndReopen(form);
      const after = await readOptional(form);
      await form.back();
      expect(after).toEqual(before);
      expect(await components.exactComponentCount(selected.code)).toBe(1);
      return { before, after };
    }, { actual: ({ before, after }) => `Component ${selected.code} retained ${JSON.stringify(after)} after an unchanged Save; the baseline was ${JSON.stringify(before)} and one matching record remained.` });
  });

  test('CMP-085 - Collapse and reopen form sections', componentScenario('A harmless unsaved draft value should remain in the Edit form when its section is collapsed and expanded again; refresh persistence is not part of this scenario.'), async () => {
    const draft = `Draft-${runToken}`;
    await componentValidationStep(page, step(
      'Enter a draft Location, collapse Component Information, and reopen it',
      `The unsaved Location value ${draft} should remain in the form after only collapsing and reopening the section.`,
      `The draft Location ${draft} remained after the section was collapsed and reopened.`,
    ), async () => {
      const form = await openEdit();
      await form.fillOptional({ Location: draft });
      const section = page.getByText('A. Component Information', { exact: true }).filter({ visible: true });
      await section.click();
      await section.click();
      const observed = await form.controlValue('Location', 'input-location');
      expect(observed).toBe(draft);
      await form.back();
      return observed;
    }, { actual: (observed) => `The unsaved Location remained "${observed}" after collapsing and reopening A. Component Information; the test then left without saving.` });
  });

  test('CMP-086 - Back out without saving', componentScenario('Using Back after an unsaved edit should discard that edit and leave the previously saved component value unchanged.'), async () => {
    await componentValidationStep(page, step(
      `Change Model on ${selected.code}, use Back, and reopen`,
      'The temporary Model should be discarded and the original saved Model should reopen.',
      'The original Model reopened; the unsaved temporary value was not stored.',
    ), async () => {
      let form = await openEdit();
      const original = await form.controlValue('Model', 'input-model');
      const draft = `Unsaved-${runToken}`;
      await form.fillOptional({ Model: draft });
      await form.back();
      form = await openEdit();
      const observed = await form.controlValue('Model', 'input-model');
      await form.back();
      expect(observed).toBe(original);
      return { original, draft, observed };
    }, { actual: ({ original, draft, observed }) => `Model was temporarily changed from "${original}" to "${draft}"; after Back and reopen the application displayed "${observed}".` });
  });

  test('CMP-088 - Clear mandatory field during edit', componentScenario('Clearing Component Name during Edit should block Save with relevant feedback and preserve the previously saved name.'), async () => {
    await componentValidationStep(page, step(
      `Clear mandatory Component Name on ${selected.code} and attempt Save`,
      'Save should be rejected with visible mandatory-field feedback, and the original saved Component Name should remain intact.',
      `Save was rejected and ${selected.code} retained its original Component Name.`,
    ), async () => {
      let form = await openEdit();
      const original = await form.controlValue('Component Name', 'input-component-name');
      expect(await form.clearRequiredText('Component Name', 'input-component-name')).toBe(true);
      const feedback = await form.expectSaveBlocked('Component Name', undefined, 'edit');
      await form.back();
      form = await openEdit();
      const observed = await form.controlValue('Component Name', 'input-component-name');
      await form.back();
      expect(observed).toBe(original);
      return { original, observed, feedback };
    }, { actual: ({ original, observed, feedback }) => `The application rejected the empty Component Name with "${feedback}"; after reopen the saved name remained "${observed}" (baseline "${original}").` });
  });

  test('CMP-089 - Controlled edit save failure', componentScenario('A controlled server failure during Edit Save should produce no false success, preserve the prior saved data, and keep the entered value recoverable in the open form where supported.'), async () => {
    await componentValidationStep(page, step(
      `Inject one isolated Save failure while editing ${selected.code}`,
      'The controlled failure should return readable failure evidence, keep the form open, and leave the stored Model unchanged.',
      'The isolated Save was rejected without a successful write; the persisted Model remained unchanged.',
    ), async () => {
      let form = await openEdit();
      const original = await form.controlValue('Model', 'input-model');
      const attempted = `Rejected-${runToken}`;
      await form.fillOptional({ Model: attempted });
      const pattern = '**/technical/api/components/**';
      await page.route(pattern, async (route) => {
        if (route.request().method() === 'GET') await route.continue();
        else await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled test save failure' }) });
      });
      let outcome;
      try {
        outcome = await form.submitForValidation();
      } finally {
        await page.unroute(pattern);
      }
      expect(outcome.succeeded).toBe(false);
      expect(outcome.formRemainedOpen).toBe(true);
      const recoverable = await form.controlValue('Model', 'input-model');
      await form.back();
      form = await openEdit();
      const persisted = await form.controlValue('Model', 'input-model');
      await form.back();
      expect(persisted).toBe(original);
      return { original, attempted, recoverable, persisted, outcome };
    }, { actual: ({ original, attempted, recoverable, persisted, outcome }) => `The attempted Model "${attempted}" received HTTP ${outcome.status ?? 'no response'} with "${outcome.feedback}"; the open form retained "${recoverable}" and the stored Model reopened as "${persisted}" (baseline "${original}").` });
  });

  test('CMP-090 - Save edit after record was deleted', componentScenario('When a coordinator deletes an isolated component while its Edit form remains open, Save should report that the record no longer exists and must not recreate it.'), async () => {
    const disposable = await createFreshScenarioComponent('CMP-090');
    test.info().annotations.push({ type: 'runtime-component', description: `${disposable.code} | ${disposable.name} | ${vessel} | Parent ${disposable.parentCode}` });
    let deleted = false;

    try {
      const staleForm = await componentValidationStep(page, step(
        `User 1 opens ${disposable.code} and prepares an unsaved Model edit`,
        `The primary user should verify ${disposable.code} in Vessel ${vessel}, open Edit, enter a unique Model, and keep the form open without saving.`,
        `User 1 opened the verified disposable component and kept its changed Model unsaved in the original Edit form.`,
      ), async () => {
        const form = await openEdit(disposable);
        const model = `Stale-${runToken}-${Date.now().toString(36).toUpperCase()}`;
        await form.fillOptional({ Model: model });
        return { form, model };
      }, { actual: ({ model }) => `User 1 kept Edit open for exact Component ${disposable.code} (${disposable.name}) in Vessel ${vessel} with unsaved Model "${model}".` });

      const componentsB = await getSecondaryComponents();
      const pageB = secondaryPage!;
      const deletionFeedback = await componentValidationStep(pageB, step(
        `User 2 verifies and deletes disposable Component ${disposable.code}`,
        `The separately authenticated secondary user should verify exact Code, Name, and Vessel, delete only ${disposable.code}, then refresh and confirm it is absent.`,
        `User 2 verified the exact disposable identity, completed the normal UI deletion, and confirmed the refreshed register contained no matching code.`,
      ), async () => {
        await componentsB.selectVessel(vessel);
        expect(await componentsB.searchAndSelectComponentByCode(disposable.code)).toEqual({ code: disposable.code, name: disposable.name, vesselName: vessel });
        const feedback = await componentsB.deleteSelectedComponent(disposable.code);
        expect(feedback).not.toBe('');
        await pageB.reload({ waitUntil: 'domcontentloaded' });
        await componentsB.expectToBeOnPage();
        await componentsB.selectVessel(vessel);
        expect(await componentsB.exactComponentCount(disposable.code)).toBe(0);
        deleted = true;
        await updateTrackedComponentCleanup(disposable.code, vessel, 'deleted', feedback);
        return feedback;
      }, { actual: (feedback) => `User 2 deleted ${disposable.code} (${disposable.name}) in Vessel ${vessel}; the application displayed "${feedback}", and refreshed exact search returned zero records.` });

      await componentValidationStep(page, step(
        `User 1 saves the stale Edit form for deleted Component ${disposable.code}`,
        `The original stale Save should be rejected with readable record-not-found feedback, and refresh should confirm ${disposable.code} remains deleted.`,
        `User 1's stale Save was rejected, and refreshed exact search confirmed the deleted component was not recreated.`,
      ), async () => {
        const outcome = await staleForm.form.submitForValidation();
        await Promise.all([
          test.info().attach('CMP-090 stale primary form evidence', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }),
          test.info().attach('CMP-090 deletion evidence', { body: await pageB.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }),
        ]);
        expect(outcome.succeeded).toBe(false);
        expect(outcome.feedback).toMatch(/not found|no longer exists|deleted|does not exist/i);
        await restoreComponentsPage(page, components, vessel);
        expect(await components.exactComponentCount(disposable.code)).toBe(0);
        return outcome;
      }, { actual: (outcome) => `After User 2's deletion feedback "${deletionFeedback}", User 1's stale Save received HTTP ${outcome.status ?? 'no response'} with "${outcome.feedback}"; refreshed exact search confirmed ${disposable.code} was not recreated.` });
    } finally {
      if (!deleted) {
        await updateTrackedComponentCleanup(disposable.code, vessel, 'failed', 'CMP-090 did not complete its authorized in-scenario deletion; the record was retained for explicit manual cleanup.').catch(() => undefined);
      }
    }
  });

  test.skip('CMP-091 - Two users save conflicting edits', componentScenario('When two authenticated users save different Model values for the same component concurrently, exactly one save should succeed, the other should be rejected with readable conflict feedback, and the stored Model should match the successful save.'), async () => {
    const concurrentComponent = await createFreshScenarioComponent('CMP-091');
    test.info().annotations.push({ type: 'runtime-component', description: `${concurrentComponent.code} | ${concurrentComponent.name} | ${vessel} | Parent ${concurrentComponent.parentCode}` });
    const componentsB = await getSecondaryComponents();
    const pageB = secondaryPage!;
    try {
      await pageB.reload({ waitUntil: 'domcontentloaded' });
      await componentsB.expectToBeOnPage();
      await Promise.all([components.selectVessel(vessel), componentsB.selectVessel(vessel)]);
      const userAModel = `Concurrent-User1-${runToken}`;
      const userBModel = `Concurrent-User2-${runToken}`;
      const preparedA = await componentValidationStep(page, step(
        `User 1 prepares Model "${userAModel}" on ${concurrentComponent.code}`,
        `The primary user should open the exact fresh component, record its original Model, and keep the changed Model unsaved.`,
        `User 1 verified the exact fresh component and kept the changed Model unsaved in Edit.`,
      ), async () => {
        const form = await openEdit(concurrentComponent);
        const baseline = await readOptional(form);
        await form.fillOptional({ Model: userAModel });
        return { form, baseline };
      }, { actual: ({ baseline }) => `User 1 opened ${concurrentComponent.code} (${concurrentComponent.name}) in Vessel ${vessel}; original Model was "${baseline.Model}", and unsaved Model was set to "${userAModel}".` });
      const formB = await componentValidationStep(pageB, step(
        `User 2 prepares conflicting Model "${userBModel}" on ${concurrentComponent.code}`,
        `The separately authenticated secondary user should verify and edit the exact same Component ${concurrentComponent.code}, keeping the conflicting Model unsaved.`,
        `User 2 verified the exact same component and kept the conflicting Model unsaved in a separate browser context.`,
      ), async () => {
        const identity = await componentsB.searchAndSelectComponentByCode(concurrentComponent.code);
        expect(identity).toEqual({ code: concurrentComponent.code, name: concurrentComponent.name, vesselName: vessel });
        const form = await componentsB.openSelectedComponentForEdit();
        await form.expectEditReady(concurrentComponent.code);
        await form.fillOptional({ Model: userBModel });
        return form;
      }, { actual: () => `User 2 opened exact Component ${concurrentComponent.code} (${concurrentComponent.name}) in Vessel ${vessel} and set unsaved Model to "${userBModel}".` });
      const outcomes = await test.step(step(
        'Synchronize and initiate both participants’ Save actions',
        'Both Save clicks should be initiated through one Promise.all synchronization point before either response completes.',
        'Both independent browser contexts initiated Save through the same synchronization point; each response was captured separately.',
      ), () => Promise.all([preparedA.form.submitForConflict(), formB.submitForConflict()]));
      await Promise.all([
        test.info().attach('CMP-091 primary participant evidence', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }),
        test.info().attach('CMP-091 secondary participant evidence', { body: await pageB.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' }),
      ]);
      const overlap = Math.max(...outcomes.map((item) => item.saveInitiatedAt)) <= Math.min(...outcomes.map((item) => item.responseReceivedAt));
      await restoreComponentsPage(page, components, vessel);
      const finalForm = await openEdit(concurrentComponent);
      const finalState = await readOptional(finalForm);
      await finalForm.back();
      const attempts = [
        { participant: 'Primary', model: userAModel, outcome: outcomes[0] },
        { participant: 'Secondary', model: userBModel, outcome: outcomes[1] },
      ];
      const accepted = attempts.filter(({ outcome }) => outcome.status !== undefined && outcome.status >= 200 && outcome.status < 300);
      const rejected = attempts.filter(({ outcome }) => outcome.status === undefined || outcome.status < 200 || outcome.status >= 300);
      await test.step(step(
        'Verify one winner, one readable conflict, and the final stored Model',
        'Exactly one concurrent Save should succeed; the other should be rejected with readable conflict feedback, and the reopened Model should equal the winning value.',
        `Primary submitted "${userAModel}" and received HTTP ${outcomes[0].status ?? 'no response'} with UI "${outcomes[0].uiMessage}" and response "${outcomes[0].responseMessage}". Secondary submitted "${userBModel}" and received HTTP ${outcomes[1].status ?? 'no response'} with UI "${outcomes[1].uiMessage}" and response "${outcomes[1].responseMessage}". Saves ${overlap ? 'overlapped' : 'were not proven to overlap'}. Reopened Model: "${finalState.Model}"; baseline Model: "${preparedA.baseline.Model}".`,
      ), async () => {
        const observedConcurrency = `Primary HTTP ${outcomes[0].status ?? 'no response'} with "${outcomes[0].uiMessage}"; Secondary HTTP ${outcomes[1].status ?? 'no response'} with "${outcomes[1].uiMessage}"; reopened Model "${finalState.Model}".`;
        expect(overlap, 'Both Save request lifetimes should overlap').toBe(true);
        expect(accepted, `Exactly one concurrent Save should succeed. Observed: ${observedConcurrency}`).toHaveLength(1);
        expect(rejected, `Exactly one concurrent Save should be rejected. Observed: ${observedConcurrency}`).toHaveLength(1);
        const conflictFeedback = `${rejected[0].outcome.uiMessage} ${rejected[0].outcome.responseMessage}`;
        expect(conflictFeedback).toMatch(/conflict|changed|modified|stale|another user|version/i);
        expect(finalState.Model).toBe(accepted[0].model);
      });
    } finally {
      await restoreComponentsPage(pageB, componentsB, vessel).catch(() => undefined);
    }
  });

  test('CMP-092 - Change vessel with pending edits', componentScenario('Changing vessel with an unsaved edit must not apply that draft value to another vessel or silently persist it to the original component.'), async () => {
    await componentValidationStep(page, step(
      `Enter an unsaved Location on ${selected.code} and switch from ${vessel} to ${config.vesselB}`,
      'The draft must not be applied to another component or vessel, and the original component should retain its saved Location.',
      'After the vessel switch attempt, the original component retained its prior Location and no Save was initiated.',
    ), async () => {
      let form = await openEdit();
      const original = await form.controlValue('Location', 'input-location');
      const draft = `Pending-${runToken}`;
      await form.fillOptional({ Location: draft });
      const vesselSelector = page.getByRole('combobox').first();
      await vesselSelector.click();
      await page.getByRole('option', { name: config.vesselB, exact: true }).click();
      const warning = page.getByText(/unsaved|discard|leave|changes/i).filter({ visible: true });
      const warningText = await warning.first().isVisible().catch(() => false)
        ? (await warning.first().innerText()).replace(/\s+/g, ' ').trim()
        : 'No unsaved-changes warning was displayed.';
      await restoreComponentsPage(page, components, vessel);
      form = await openEdit();
      const observed = await form.controlValue('Location', 'input-location');
      await form.back();
      expect(observed).toBe(original);
      return { original, draft, observed, warningText };
    }, { actual: ({ original, draft, observed, warningText }) => `The unsaved Location "${draft}" was not stored on ${selected.code}; it reopened as "${observed}" (baseline "${original}"). Navigation feedback: "${warningText}"` });
  });
});
