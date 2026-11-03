import fs from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { ComponentFormPage } from '../../pages/ComponentFormPage';
import type { ComponentTreeRow, ComponentsPage, SelectedComponentIdentity } from '../../pages/ComponentsPage';
import { RotationItemMasterPage, type RotationItemRow } from '../../pages/RotationItemMasterPage';
import { readApprovedRecoveryComponents, readTrackedComponents, updateTrackedComponentCleanup } from '../../utils/componentCreationTracker';
import { attachFailureScreenshot, componentActionStep, componentNotExecutedStep, componentObservedCheck, componentScenario, componentValidationStep, ScenarioPlan, type PlannedStep } from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

/** What one inspected component holds; `undefined` means the value could not be read. */
type Inspection = {
  code: string;
  name: string;
  vesselName: string;
  depth: number;
  topLevel: string;
  active?: string;
  jobs?: string[];
  spares?: string[];
  stamp?: string;
  children: string[];
};
type FixtureKey = 'clean' | 'parent' | 'jobs' | 'spares';
type Selection = { inspected: Inspection[]; topLevels: string[]; fixtures: Partial<Record<FixtureKey, Inspection>>; missing: Partial<Record<FixtureKey, string>> };
type DeleteObservation = { kind: 'blocked' | 'confirmation' | 'none'; text: string };

const vessel = config.vesselName;
const sectionB = 'B. Fleet Component Information';
/** Only the first two top-level components and their children are ever inspected. */
const topLevelLimit = 2;
// Replacement workers in one run share the run-scoped authentication file, so the
// fixtures chosen by the first worker are reused instead of inspecting the tree again.
const selectionFile = process.env.COMPONENTS_AUTH_STATE_PATH ? `${process.env.COMPONENTS_AUTH_STATE_PATH}.lifecycle.json` : undefined;
const dependencyFeedback = /child|depend|linked|job|spare|cannot|not allowed|unable|in use/i;

const fixtureNeed: Record<FixtureKey, string> = {
  clean: 'an active component with no child components, no jobs, no linked spares and no installed stamp',
  parent: 'an active parent component with at least one active child component and no jobs or linked spares of its own',
  jobs: 'an active component with at least one job and no linked spares or child components',
  spares: 'an active component with linked spare parts and no jobs or child components',
};

const step = (title: string, expected: string) => `${title}\nExpected: ${expected}\nActual: Recorded after the validation completes.`;
const list = (values: string[] | undefined) => (values === undefined ? 'unreadable' : values.length ? values.join(', ') : 'none');
const label = (target: { code: string; name: string }) => `${target.code} (${target.name})`;
const describe = (item: Inspection) => `Is Active ${item.active ?? 'unreadable'}; child components ${list(item.children)}; jobs ${list(item.jobs)}; linked spares ${list(item.spares)}; stamp ${item.stamp || 'none'}`;

test.describe('CMP-175 to CMP-190 - Component lifecycle', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let selection: Selection | undefined;
  let setupProblem = '';

  // ---------- Reading component state ----------

  const readActive = () => components.readSelectedComponentDetail({ section: sectionB, label: 'Is Active' });
  const readJobs = async () => (await components.readAllLinkedJobs()).jobs.map((job) => job.jobCode);
  const readSpares = async () => (await components.readLoadedLinkedSpares()).spares.map((spare) => spare.partCode);
  const readStamp = async () => {
    const rotation = await components.readSelectedRotationItem();
    return rotation.rotationalItem === 'Yes' && rotation.stamp && rotation.stamp !== '-' ? rotation.stamp : '';
  };
  const optional = <T>(read: () => Promise<T>) => read().catch(() => undefined);

  /** Selects a component by code and confirms the details panel shows the same identity in the vessel. */
  const openComponent = async (target: { code: string; name: string }): Promise<SelectedComponentIdentity> => {
    const identity = await components.searchAndSelectComponentByCode(target.code);
    const plain = (value: string) => value.replace(/\s*\(Inactive\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    if (identity.code !== target.code || plain(identity.name) !== plain(target.name) || identity.vesselName !== vessel) {
      throw new Error(`Observed Application Result: Component Details showed ${identity.code} (${identity.name}) in Vessel ${identity.vesselName} instead of ${label(target)} in Vessel ${vessel}.`);
    }
    return identity;
  };

  const refresh = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await components.expectToBeOnPage();
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
  };

  const openEdit = async (code: string): Promise<ComponentFormPage> => {
    const form = await components.openSelectedComponentForEdit();
    await form.expectEditReady(code);
    return form;
  };

  // ---------- Bounded fixture discovery (first two top-level components only) ----------

  const inspectRow = async (row: ComponentTreeRow, topLevel: string): Promise<Inspection> => componentActionStep(
    `Select Component ${row.code} (${row.name}) and inspect its dependencies`,
    `Component ${row.code} should open in Vessel ${vessel} and show its Is Active status, jobs, linked spares and stamp.`,
    async () => {
      const identity = await components.selectTreeComponent(row);
      return {
        code: identity.code, name: identity.name, vesselName: identity.vesselName, depth: row.depth, topLevel,
        active: await optional(readActive), jobs: await optional(readJobs), spares: await optional(readSpares), stamp: await optional(readStamp), children: [],
      } satisfies Inspection;
    },
    (item) => `Component ${label(item)} in Vessel ${item.vesselName}: Is Active ${item.active ?? 'unreadable'}; jobs ${list(item.jobs)}; linked spares ${list(item.spares)}; stamp ${item.stamp || 'none'}.`,
  );

  /** Visits one top-level component, then its children and subchildren, in tree order. */
  const inspectSubtree = async (top: ComponentTreeRow, inspected: Inspection[]) => {
    const visited = new Set<string>();
    let rows = (await components.readTreeRowsWithCoverage()).rows;
    for (;;) {
      const start = rows.findIndex((row) => row.code === top.code && row.depth === 0);
      const end = rows.findIndex((row, index) => index > start && row.depth === 0);
      const next = rows.slice(start, end < 0 ? undefined : end).find((row) => !visited.has(row.code));
      if (start < 0 || !next) return;
      visited.add(next.code);
      inspected.push(await inspectRow(next, top.code));
      if (await components.treeComponentExpansionState(next.code) === 'collapsed') {
        const before = new Set(rows.map((row) => row.code));
        rows = await componentActionStep(
          `Expand Component ${next.code} to check for child components`,
          `Clicking the expand control of ${next.code} should display any child components it has beneath it.`,
          async () => {
            await components.expandTreeComponent(next.code);
            return (await components.readTreeRowsWithCoverage()).rows;
          },
          (after) => {
            const added = after.filter((row) => !before.has(row.code)).map((row) => row.code);
            return added.length ? `Component ${next.code} displayed ${added.length} child row(s): ${added.join(', ')}.` : `Component ${next.code} displayed no child component rows.`;
          },
        );
      } else {
        rows = (await components.readTreeRowsWithCoverage()).rows;
      }
    }
  };

  /** Fills each inspected component's direct children from the tree order (pre-order with depth). */
  const linkChildren = (inspected: Inspection[]) => {
    inspected.forEach((item, index) => {
      item.children = [];
      for (const later of inspected.slice(index + 1)) {
        if (later.depth <= item.depth) break;
        if (later.depth === item.depth + 1) item.children.push(later.code);
      }
    });
  };

  const descendantCount = (inspected: Inspection[], item: Inspection) => {
    const index = inspected.indexOf(item);
    const end = inspected.findIndex((later, laterIndex) => laterIndex > index && later.depth <= item.depth);
    return (end < 0 ? inspected.length : end) - index - 1;
  };

  const chooseFixtures = (inspected: Inspection[]): Selection['fixtures'] => {
    linkChildren(inspected);
    // Classification nodes show no Vessel Name; only components of the configured vessel qualify.
    const known = inspected.filter((item) => item.vesselName === vessel && item.active === 'Yes' && item.jobs && item.spares && item.stamp !== undefined);
    const byCode = new Map(inspected.map((item) => [item.code, item]));
    // Top-level classification components are used only when no deeper component qualifies.
    const preferDeep = (candidates: Inspection[]) => candidates.find((item) => item.depth > 0) ?? candidates[0];
    const parents = known.filter((item) => item.children.some((code) => byCode.get(code)?.active === 'Yes') && !item.jobs!.length && !item.spares!.length && item.depth > 0)
      .sort((first, second) => descendantCount(inspected, first) - descendantCount(inspected, second));
    return {
      clean: preferDeep(known.filter((item) => !item.children.length && !item.jobs!.length && !item.spares!.length && !item.stamp)),
      parent: parents[0],
      jobs: preferDeep(known.filter((item) => item.jobs!.length && !item.spares!.length && !item.children.length)),
      spares: preferDeep(known.filter((item) => item.spares!.length && !item.jobs!.length && !item.children.length)),
    };
  };

  const discoverFixtures = async (): Promise<Selection> => {
    await components.clearComponentSearch();
    await components.expectTreeLoaded();
    const tops = (await components.readTreeRowsWithCoverage()).rows.filter((row) => row.depth === 0).slice(0, topLevelLimit);
    const inspected: Inspection[] = [];
    const topLevels: string[] = [];
    let fixtures: Selection['fixtures'] = {};
    for (const top of tops) {
      topLevels.push(`${top.code} (${top.name})`);
      await inspectSubtree(top, inspected);
      fixtures = chooseFixtures(inspected);
      // The second top-level component is inspected only when a fixture is still missing.
      if ((Object.keys(fixtureNeed) as FixtureKey[]).every((key) => fixtures[key])) break;
    }
    const missing: Selection['missing'] = {};
    for (const key of Object.keys(fixtureNeed) as FixtureKey[]) {
      if (!fixtures[key]) missing[key] = `the test needs ${fixtureNeed[key]}, but none was found among the ${inspected.length} component(s) inspected under top-level component(s) ${topLevels.join(' and ')} in Vessel ${vessel}; the rest of the tree is deliberately not searched.`;
    }
    return { inspected, topLevels, fixtures, missing };
  };

  const fixtureFor = (key: FixtureKey): Inspection => {
    test.skip(!selection, `NOT EXECUTED: ${setupProblem || 'the shared component inspection did not complete.'}`);
    const fixture = selection!.fixtures[key];
    test.skip(!fixture, `NOT EXECUTED: missing prerequisite - ${selection!.missing[key]}`);
    return fixture!;
  };

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(20 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
    const saved = selectionFile ? await fs.readFile(selectionFile, 'utf8').then((text) => JSON.parse(text) as Selection).catch(() => undefined) : undefined;
    if (saved) {
      selection = saved;
      await componentObservedCheck(page, 'Reuse the components selected earlier in this run',
        'The lifecycle fixtures selected earlier in this run should be reused so related test cases keep the same components.',
        { passed: true, actual: `Reused the selection made from top-level component(s) ${saved.topLevels.join(' and ')} in Vessel ${vessel}.` });
      return;
    }
    try {
      selection = await discoverFixtures();
    } catch (error) {
      setupProblem = `the bounded inspection of the first two top-level components did not complete: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
      throw error;
    }
    const lines = (Object.keys(fixtureNeed) as FixtureKey[]).map((key) => {
      const fixture = selection!.fixtures[key];
      return fixture ? `${key}: ${label(fixture)} - ${describe(fixture)}` : `${key}: not available`;
    });
    await componentObservedCheck(page, 'Record the components selected for the lifecycle test cases',
      'One suitable existing component should be identified for each dependency type, inspecting only the first top-level component and its children, and the second only when data is missing.',
      { passed: true, actual: `Selected Vessel: ${vessel}. Inspected ${selection.inspected.length} component(s) under ${selection.topLevels.join(' and ')}. ${lines.join('. ')}.` });
    if (selectionFile) await fs.writeFile(selectionFile, JSON.stringify(selection), 'utf8');
  });

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    await restoreComponentsPage(page, components, vessel);
  });
  test.afterAll(async () => context?.close());

  // ---------- Shared actions ----------

  const run = <T>(plan: ScenarioPlan, planned: PlannedStep, body: () => Promise<T>, actual: (value: T) => string): Promise<T> => {
    plan.begin(planned.title);
    return componentActionStep(planned.title, planned.expected, body, actual, { page });
  };

  /** The shared Save helper records this step title itself. */
  const saveTitle = 'Click Save and capture the application response';
  const setStep = (target: { code: string; name: string }, value: 'Yes' | 'No'): PlannedStep => ({
    title: `Set Is Active = ${value} on Component ${target.code}`,
    expected: `Edit Component - B. Fleet Component Information of ${label(target)} should open and hold Is Active ${value} before Save.`,
  });

  /** Opens Edit Component and changes B. Fleet Component Information - Is Active, without saving. */
  const setIsActive = async (target: { code: string; name: string }, value: 'Yes' | 'No') => {
    const form = await openEdit(target.code);
    const before = await form.controlValue('Is Active', 'select-is-active');
    await form.setYesNo('Is Active', 'select-is-active', value);
    // Any warning shown on changing the value, before Save, appears in a dialog or alert.
    const warning = (await page.locator('[role="dialog"], [role="alert"]').filter({ visible: true }).filter({ hasText: dependencyFeedback }).allInnerTexts().catch(() => []))
      .map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
    return { form, before, after: await form.controlValue('Is Active', 'select-is-active'), warning };
  };
  const setActual = (state: { before: string; after: string; warning: string }) =>
    `Is Active was changed from ${state.before} to ${state.after}; ${state.warning ? `the form showed "${state.warning}" before Save` : 'no warning was shown before Save'}.`;

  /** Clicks Save once through the shared form helper, which records its own step, and leaves the form. */
  const save = async (plan: ScenarioPlan | undefined, form: ComponentFormPage, expected: string) => {
    plan?.begin(saveTitle);
    const outcome = await form.submitForValidation({ expected });
    if (outcome.formRemainedOpen) await form.back().catch(() => undefined);
    return outcome;
  };

  /** Puts Is Active back to Yes on a business component the application deactivated unexpectedly. */
  const restoreActive = async (target: { code: string; name: string }) => {
    const restoreSet = setStep(target, 'Yes');
    const { form } = await componentActionStep(`${restoreSet.title} to restore it after the unexpected deactivation`, restoreSet.expected,
      async () => {
        await refresh();
        await openComponent(target);
        return setIsActive(target, 'Yes');
      }, setActual, { page });
    await save(undefined, form, `Save should reactivate ${label(target)} so the test leaves business data as it found it.`);
    return componentActionStep(`Refresh and confirm Component ${target.code} is active again`,
      `After the restore, ${label(target)} should show Is Active Yes.`,
      async () => {
        await refresh();
        await openComponent(target);
        return readActive();
      }, (active) => `Component ${label(target)} showed Is Active ${active} after the restore.`, { page });
  };

  const deleteButton = () => page.getByTestId('btn-delete-component');
  const cannotDeleteDialog = () => page.getByRole('dialog').filter({ hasText: 'Cannot Delete Component' }).last();
  const confirmationDialog = () => page.getByRole('dialog').filter({ hasText: /delete/i }).filter({ hasNotText: 'Cannot Delete Component' }).last();

  /** Clicks Delete and reports whether the application blocked it or asked for confirmation. */
  const clickDelete = async (): Promise<DeleteObservation> => {
    await expect(deleteButton(), 'The selected component should expose its Delete action').toBeVisible();
    await deleteButton().click();
    const kind = await Promise.race([
      cannotDeleteDialog().waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'blocked' as const),
      confirmationDialog().waitFor({ state: 'visible', timeout: 10_000 }).then(() => 'confirmation' as const),
    ]).catch(() => 'none' as const);
    // The dialog text ends with its button labels; keep only the title and message.
    const text = kind === 'none' ? '' : (await (kind === 'blocked' ? cannotDeleteDialog() : confirmationDialog()).innerText()).replace(/\s+/g, ' ').replace(/(?:\s+(?:Cancel|Delete|Close|OK))+\s*$/, '').trim();
    return { kind, text };
  };

  const closeDialog = async (dialog: ReturnType<typeof confirmationDialog>, button: 'Cancel' | 'OK') => {
    await dialog.getByRole('button', { name: button, exact: true }).click();
    await expect(dialog, `The dialog should close after ${button}`).toBeHidden();
  };

  /** Confirms an open deletion dialog and reports whether the application then blocked or deleted. */
  const confirmDelete = async (): Promise<{ deleted: boolean; message: string; status?: number }> => {
    const response = page.waitForResponse((candidate) => candidate.url().includes('/technical/api/components') && candidate.request().method() === 'DELETE', { timeout: 20_000 });
    response.catch(() => undefined);
    await confirmationDialog().getByRole('button', { name: 'Delete', exact: true }).click();
    const outcome = await Promise.race([
      cannotDeleteDialog().waitFor({ state: 'visible', timeout: 20_000 }).then(() => ({ blocked: true as const })),
      response.then((received) => ({ received })),
    ]);
    if ('blocked' in outcome) {
      const message = (await cannotDeleteDialog().innerText()).replace(/\s+/g, ' ').replace(/\s*OK\s*$/, '').trim();
      await closeDialog(cannotDeleteDialog(), 'OK');
      return { deleted: false, message };
    }
    const toast = page.getByText(/deleted|cannot|unable|not allowed/i).filter({ visible: true }).last();
    await toast.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    const message = await toast.isVisible().catch(() => false) ? (await toast.innerText()).replace(/\s+/g, ' ').trim() : 'No visible message was displayed.';
    return { deleted: outcome.received.ok(), message, status: outcome.received.status() };
  };

  /** Approved deletion fixtures in the configured vessel, from test-data/components-cleanup-approved.json. */
  const approvedInVessel = async () => (await readApprovedRecoveryComponents()).filter((item) => item.vessel === vessel);
  const isApproved = async (code: string) => (await approvedInVessel()).some((item) => item.code === code);

  // ---------- Negative deactivation / deletion scenarios ----------

  type Dependents = { describe: string; read: (target: Inspection) => Promise<string[]> };
  const childDependents: Dependents = {
    describe: 'child components (parent and Is Active)',
    read: async (target) => {
      const states: string[] = [];
      for (const child of target.children) {
        const identity = await components.searchAndSelectComponentByCode(child);
        const parentCode = await components.readSelectedComponentDetail({ section: 'A. Component Information', label: 'Parent Component Code' });
        states.push(`${identity.code} parent ${parentCode} Is Active ${await readActive()}`);
      }
      await openComponent(target);
      return states;
    },
  };
  const jobDependents: Dependents = { describe: 'jobs', read: async () => readJobs() };
  const spareDependents: Dependents = { describe: 'linked spare parts', read: async () => readSpares() };

  const deactivationBlocked = async (target: Inspection, dependents: Dependents, dependency: string) => {
    const steps = {
      open: { title: `Open Component ${target.code} and record its ${dependents.describe}`, expected: `Component ${label(target)} should open active in Vessel ${vessel} with its ${dependents.describe} displayed.` },
      set: setStep(target, 'No'),
      save: { title: saveTitle, expected: `The application should refuse to deactivate ${label(target)} because it has ${dependency}, and show a dependency warning.` },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should still be active with the same ${dependents.describe}.` },
      verify: { title: `Verify deactivation was blocked and ${target.code} is unchanged`, expected: `Deactivating ${label(target)} should be blocked with a dependency warning, and the component and its ${dependents.describe} should remain unchanged.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    let restored = false;
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => {
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `Component ${label(target)} showed Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}.`);
      const changed = await run(plan, steps.set, () => setIsActive(target, 'No'), setActual);
      const attempt = { warning: changed.warning, outcome: await save(plan, changed.form, steps.save.expected) };
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `After refresh, ${label(target)} showed Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}.`);
      const changedChildren = dependents === childDependents
        ? after.dependents.filter((state) => !before.dependents.includes(state)).map((state) => state.split(' ')[0]) : [];
      if (after.active === 'No') { await restoreActive(target); restored = true; }
      for (const child of changedChildren) {
        const item = selection!.inspected.find((inspected) => inspected.code === child);
        if (item?.active === 'Yes') await restoreActive(item);
      }
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(attempt.outcome.succeeded ? [`Save accepted Is Active = No (HTTP ${attempt.outcome.status}, "${attempt.outcome.feedback}") instead of blocking it`] : []),
          ...(!attempt.outcome.succeeded && !dependencyFeedback.test(`${attempt.outcome.feedback} ${attempt.warning}`) ? [`no dependency warning was shown; the application displayed "${attempt.outcome.feedback}"`] : []),
          ...(after.active !== before.active ? [`Is Active changed from ${before.active} to ${after.active}${restored ? ' and was restored to Yes by the test' : ''}`] : []),
          ...(after.dependents.join('|') !== before.dependents.join('|') ? [`${dependents.describe} changed from ${list(before.dependents)} to ${list(after.dependents)}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return { attempt, after };
      }, { actual: ({ attempt: blocked, after: state }) => `The application blocked deactivation of ${label(target)} with "${blocked.outcome.feedback}"; after refresh it remained Is Active ${state.active} with ${dependents.describe}: ${list(state.dependents)}.` });
    });
  };

  const deletionBlocked = async (target: Inspection, dependents: Dependents, dependency: string) => {
    const approved = await isApproved(target.code);
    const steps = {
      open: { title: `Open Component ${target.code} and record its ${dependents.describe}`, expected: `Component ${label(target)} should open in Vessel ${vessel} with its ${dependents.describe} displayed.` },
      click: { title: `Click Delete for Component ${target.code}`, expected: `The application should block deletion of ${label(target)} because it has ${dependency}.` },
      confirm: { title: `Confirm deletion of Component ${target.code} and observe whether it is blocked`, expected: `If a confirmation is shown, confirming it should still be refused because ${label(target)} has ${dependency}.` },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should still exist in Vessel ${vessel} with the same ${dependents.describe}.` },
      verify: { title: `Verify deletion was blocked and ${target.code} is unchanged`, expected: `Deleting ${label(target)} should be blocked, and the component and its ${dependents.describe} should remain available.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    let notExecuted = '';
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => {
        await openComponent(target);
        return dependents.read(target);
      }, (values) => `Component ${label(target)} showed ${dependents.describe}: ${list(values)}.`);
      const clicked = await run(plan, steps.click, clickDelete, (observed) => observed.kind === 'blocked'
        ? `The application blocked the deletion with "${observed.text}".`
        : observed.kind === 'confirmation'
          ? `The application did not block the deletion; it showed its standard confirmation "${observed.text}", which does not mention the ${dependency}.`
          : 'No blocking message or confirmation was displayed after Delete was clicked.');
      let blockedMessage = clicked.kind === 'blocked' ? clicked.text : '';
      if (clicked.kind === 'blocked') {
        await closeDialog(cannotDeleteDialog(), 'OK');
        plan.begin(steps.confirm.title);
        await componentNotExecutedStep(steps.confirm.title, steps.confirm.expected, 'the application blocked the deletion before any confirmation was shown, so there was nothing to confirm.');
      } else if (clicked.kind === 'confirmation' && approved) {
        const confirmed = await run(plan, steps.confirm, confirmDelete,
          (result) => result.deleted ? `The application deleted ${label(target)} (HTTP ${result.status}) with "${result.message}".` : `The application refused the deletion with "${result.message}".`);
        if (!confirmed.deleted) blockedMessage = confirmed.message;
      } else if (clicked.kind === 'confirmation') {
        await componentActionStep(`Cancel the deletion confirmation for business Component ${target.code}`,
          `The confirmation should close without deleting ${label(target)}, which is not an approved deletion fixture.`,
          () => closeDialog(confirmationDialog(), 'Cancel'),
          () => `Cancel was clicked and the confirmation closed; ${label(target)} was not deleted.`, { page });
        notExecuted = `the application did not block deletion of ${label(target)} when Delete was clicked; it showed its standard confirmation without mentioning the ${dependency}. Whether the application would refuse the confirmed deletion could not be checked, because ${target.code} is an existing business component that is not listed in test-data/components-cleanup-approved.json, and confirming could permanently delete it. The confirmation was cancelled.`;
        plan.begin(steps.confirm.title);
        await componentNotExecutedStep(steps.confirm.title, steps.confirm.expected, notExecuted);
      }
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `After refresh, ${label(target)} was still present in Vessel ${vessel} with Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}.`);
      plan.begin(steps.verify.title);
      if (notExecuted) {
        await componentNotExecutedStep(steps.verify.title, steps.verify.expected, notExecuted);
        test.skip(true, `NOT EXECUTED: ${notExecuted}`);
      }
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(!blockedMessage ? ['the application did not block the deletion'] : []),
          ...(after.dependents.join('|') !== before.join('|') ? [`${dependents.describe} changed from ${list(before)} to ${list(after.dependents)}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return after;
      }, { actual: (state) => `The application blocked deletion of ${label(target)} with "${blockedMessage}"; after refresh the component remained with ${dependents.describe}: ${list(state.dependents)}.` });
    });
  };

  // ---------- Positive scenarios ----------

  test('CMP-175 - Deactivate Eligible Component', componentScenario('Setting Is Active = No on an isolated component with no dependencies should save, show the component as inactive after reopening, and leave unrelated components unchanged.'), async () => {
    test.setTimeout(8 * 60_000);
    const target = fixtureFor('clean');
    const index = selection!.inspected.findIndex((item) => item.code === target.code);
    const parent = selection!.inspected.slice(0, index).reverse().find((item) => item.depth === target.depth - 1);
    const related = [...(parent ? [parent] : []), ...selection!.inspected.filter((item) => item.code !== target.code && item.depth === target.depth && parent?.children.includes(item.code)).slice(0, 2)];
    const readRelated = async () => {
      const states: string[] = [];
      for (const item of related) {
        await openComponent(item);
        states.push(`${item.code} Is Active ${await readActive()}`);
      }
      return states;
    };
    const steps = {
      related: { title: 'Record Is Active of related components before the change', expected: `The parent and neighbouring components of ${label(target)} should show their current Is Active status.` },
      open: { title: `Open Component ${target.code}`, expected: `Component ${label(target)} should open active in Vessel ${vessel}.` },
      set: setStep(target, 'No'),
      save: { title: saveTitle, expected: `The application should save ${label(target)} as inactive.` },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should show Is Active No in Section B and in the Edit form.` },
      relatedAfter: { title: 'Record Is Active of related components after the change', expected: 'The parent and neighbouring components should keep their previous Is Active status.' },
      verify: { title: `Verify Component ${target.code} is inactive and related components are unchanged`, expected: `${label(target)} should be inactive after reopening, and its parent and neighbours should be unchanged.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const relatedBefore = await run(plan, steps.related, readRelated, (states) => `Related components: ${list(states)}.`);
      await run(plan, steps.open, async () => { await openComponent(target); return readActive(); }, (active) => `Component ${label(target)} opened in Vessel ${vessel} with Is Active ${active}.`);
      const changed = await run(plan, steps.set, () => setIsActive(target, 'No'), setActual);
      const attempt = { outcome: await save(plan, changed.form, steps.save.expected) };
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        const identity = await openComponent(target);
        const details = await readActive();
        const form = await openEdit(target.code);
        const formValue = await form.controlValue('Is Active', 'select-is-active');
        await form.back();
        return { identity, details, formValue };
      }, (state) => `After refresh, ${state.identity.code} (${state.identity.name}) showed Is Active ${state.details} in Section B and ${state.formValue} in the Edit form.`);
      const relatedAfter = await run(plan, steps.relatedAfter, readRelated, (states) => `Related components: ${list(states)}.`);
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(!attempt.outcome.succeeded ? [`Save did not succeed: "${attempt.outcome.feedback}"`] : []),
          ...(after.details !== 'No' ? [`Section B showed Is Active ${after.details}`] : []),
          ...(after.formValue !== 'No' ? [`the Edit form showed Is Active ${after.formValue}`] : []),
          ...(relatedAfter.join('|') !== relatedBefore.join('|') ? [`related components changed from ${list(relatedBefore)} to ${list(relatedAfter)}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return after;
      }, { actual: (state) => `Component ${label(target)} saved as inactive and reopened with Is Active ${state.details}; related components were unchanged (${list(relatedAfter)}).` });
    });
  });

  test('CMP-176 - Reactivate Inactive Component', componentScenario('Setting Is Active = Yes on the component deactivated by CMP-175 should save, and after a refresh the component should be active and visible in the vessel component tree.'), async () => {
    test.setTimeout(6 * 60_000);
    const target = fixtureFor('clean');
    const steps = {
      open: { title: `Open inactive Component ${target.code}`, expected: `Component ${label(target)}, deactivated by CMP-175, should open in Vessel ${vessel} with Is Active No.` },
      set: setStep(target, 'Yes'),
      save: { title: saveTitle, expected: `The application should save ${label(target)} as active.` },
      refresh: { title: `Refresh Components and find Component ${target.code} in the tree`, expected: `After a refresh, ${label(target)} should be visible in the Vessel ${vessel} tree and show Is Active Yes.` },
      verify: { title: `Verify Component ${target.code} is active and visible`, expected: `${label(target)} should be active and visible in the Vessel ${vessel} component tree.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => { await openComponent(target); return readActive(); },
        (active) => `Component ${label(target)} opened in Vessel ${vessel} with Is Active ${active}.`);
      if (before !== 'No') {
        const reason = `CMP-175 did not leave ${label(target)} inactive; it showed Is Active ${before}, so there was no inactive component to reactivate.`;
        for (const planned of [steps.set, steps.save, steps.refresh, steps.verify]) {
          plan.begin(planned.title);
          await componentNotExecutedStep(planned.title, planned.expected, reason);
        }
        test.skip(true, `NOT EXECUTED: ${reason}`);
      }
      const changed = await run(plan, steps.set, () => setIsActive(target, 'Yes'), setActual);
      const attempt = { outcome: await save(plan, changed.form, steps.save.expected) };
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        const identity = await openComponent(target);
        return { identity, active: await readActive() };
      }, (state) => `After refresh, ${state.identity.code} (${state.identity.name}) was found in the Vessel ${state.identity.vesselName} tree with Is Active ${state.active}.`);
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(!attempt.outcome.succeeded ? [`Save did not succeed: "${attempt.outcome.feedback}"`] : []),
          ...(after.active !== 'Yes' ? [`Section B showed Is Active ${after.active}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return after;
      }, { actual: (state) => `Component ${label(target)} was reactivated and is visible in the Vessel ${state.identity.vesselName} tree with Is Active ${state.active}.` });
    });
  });

  test('CMP-177 - Cancel Delete Confirmation', componentScenario('Choosing Cancel in the delete confirmation should close it without deleting, and the component should be unchanged after a refresh.'), async () => {
    test.setTimeout(5 * 60_000);
    const target = fixtureFor('clean');
    const steps = {
      open: { title: `Open Component ${target.code}`, expected: `Component ${label(target)} should open in Vessel ${vessel}.` },
      click: { title: `Click Delete for Component ${target.code}`, expected: `The application should ask for confirmation before deleting ${label(target)}.` },
      cancel: { title: 'Click Cancel in the delete confirmation', expected: 'The confirmation should close and no deletion should be sent.' },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should still exist with the same name and Is Active status.` },
      verify: { title: `Verify Component ${target.code} was not deleted or changed`, expected: `${label(target)} should remain in Vessel ${vessel} unchanged after cancelling the deletion.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => ({ identity: await openComponent(target), active: await readActive() }),
        (state) => `Component ${state.identity.code} (${state.identity.name}) opened in Vessel ${state.identity.vesselName} with Is Active ${state.active}.`);
      const clicked = await run(plan, steps.click, clickDelete, (observed) => observed.kind === 'confirmation'
        ? `The application showed the confirmation "${observed.text}".`
        : observed.kind === 'blocked' ? `The application showed "${observed.text}" instead of a confirmation.` : 'No confirmation was displayed.');
      if (clicked.kind !== 'confirmation') throw new Error(`Observed Application Result: clicking Delete did not show a deletion confirmation${clicked.text ? `; it showed "${clicked.text}"` : ''}.`);
      const deletes: string[] = [];
      const listener = (request: import('@playwright/test').Request) => { if (request.method() === 'DELETE') deletes.push(request.url()); };
      page.on('request', listener);
      try {
        await run(plan, steps.cancel, () => closeDialog(confirmationDialog(), 'Cancel'), () => 'Cancel was clicked and the confirmation closed.');
        const after = await run(plan, steps.refresh, async () => {
          await refresh();
          return { identity: await openComponent(target), active: await readActive() };
        }, (state) => `After refresh, ${state.identity.code} (${state.identity.name}) was still present in Vessel ${state.identity.vesselName} with Is Active ${state.active}.`);
        plan.begin(steps.verify.title);
        await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
          const problems = [
            ...(deletes.length ? ['a deletion request was sent after Cancel'] : []),
            ...(after.active !== before.active ? [`Is Active changed from ${before.active} to ${after.active}`] : []),
          ];
          expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
          return after;
        }, { actual: (state) => `After Cancel no deletion was sent; ${state.identity.code} (${state.identity.name}) remained in Vessel ${state.identity.vesselName} with Is Active ${state.active}.` });
      } finally {
        page.off('request', listener);
      }
    });
  });

  /** Finds an approved deletion fixture in the vessel that meets the scenario's condition. */
  const approvedFixture = async (need: string, qualifies: (state: { children: string[]; jobs: string[]; spares: string[]; stamp: string }) => boolean) => {
    const approved = await approvedInVessel();
    const rejected: string[] = [];
    for (const candidate of approved) {
      try {
        await openComponent(candidate);
        // A row with an expand control is treated as possibly having children.
        const children = await components.treeComponentExpansionState(candidate.code) === 'leaf' ? [] : ['expand control shown in the tree'];
        const state = { children, jobs: await readJobs(), spares: await readSpares(), stamp: await readStamp() };
        if (qualifies(state)) return { candidate, state };
        rejected.push(`${candidate.code} (children ${list(state.children)}, jobs ${list(state.jobs)}, spares ${list(state.spares)}, stamp ${state.stamp || 'none'})`);
      } catch {
        rejected.push(`${candidate.code} (could not be opened in Vessel ${vessel})`);
      }
    }
    test.skip(true, `NOT EXECUTED: missing prerequisite - no explicitly approved test component ${need} exists for Vessel ${vessel} in test-data/components-cleanup-approved.json (${approved.length ? `approved entries checked: ${rejected.join('; ')}` : 'the file lists no approved component for this vessel'}). Existing business components are never deleted.`);
    throw new Error('unreachable');
  };

  const recordDeletion = async (code: string, message: string) => {
    if ((await readTrackedComponents()).some((item) => item.code === code && item.vessel === vessel)) {
      await updateTrackedComponentCleanup(code, vessel, 'deleted', `Deleted by components-lifecycle.spec.ts: ${message}`);
    }
  };

  test('CMP-178 - Delete Eligible Clean Leaf', componentScenario('Deleting an approved, isolated test component with no children, jobs, spares or stamp should show a confirmation warning, delete it after confirmation with success feedback, and remove it from normal component views.'), async () => {
    test.setTimeout(6 * 60_000);
    test.skip(!selection, `NOT EXECUTED: ${setupProblem || 'the shared component inspection did not complete.'}`);
    const { candidate, state } = await approvedFixture('that is a clean leaf with no children, jobs, linked spares or stamp',
      (found) => !found.children.length && !found.jobs.length && !found.spares.length && !found.stamp);
    const steps = {
      check: { title: `Confirm approved Component ${candidate.code} has no blocking dependencies`, expected: `Approved test component ${label(candidate)} should have no child components, jobs, linked spares or installed stamp.` },
      click: { title: `Click Delete for Component ${candidate.code} and read the confirmation warning`, expected: `The application should show a deletion confirmation warning for ${label(candidate)}.` },
      confirm: { title: 'Confirm the deletion', expected: `The application should delete ${label(candidate)} and show success feedback.` },
      verify: { title: `Verify Component ${candidate.code} is removed from normal views`, expected: `After a refresh, ${label(candidate)} should no longer appear in the Vessel ${vessel} component tree.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      await run(plan, steps.check, async () => state, (found) => `Approved by ${candidate.approvedBy}; child components ${list(found.children)}, jobs ${list(found.jobs)}, linked spares ${list(found.spares)}, stamp ${found.stamp || 'none'}.`);
      const clicked = await run(plan, steps.click, clickDelete, (observed) => `The application showed ${observed.kind === 'confirmation' ? 'the confirmation' : observed.kind === 'blocked' ? 'the blocking message' : 'nothing'}${observed.text ? ` "${observed.text}"` : ''}.`);
      if (clicked.kind !== 'confirmation') throw new Error(`Observed Application Result: no deletion confirmation was shown${clicked.text ? `; the application showed "${clicked.text}"` : ''}.`);
      const result = await run(plan, steps.confirm, confirmDelete, (outcome) => `${outcome.deleted ? 'The deletion succeeded' : 'The deletion was refused'}${outcome.status ? ` (HTTP ${outcome.status})` : ''} with "${outcome.message}".`);
      if (result.deleted) await recordDeletion(candidate.code, result.message);
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        expect(result.deleted, `Observed Application Result: the deletion of ${candidate.code} was refused with "${result.message}".`).toBe(true);
        await refresh();
        return components.expectDeletedComponentUnavailable(candidate.code, vessel);
      }, { actual: (neutral) => `${label(candidate)} was deleted with "${result.message}"; after refresh the tree no longer listed it and the details panel showed "${neutral}".` });
    });
  });

  test('CMP-180 - Delete Component Holding Installed Stamp', componentScenario('Deleting an approved test component that holds an installed rotational stamp should delete the component and release the stamp in the Rotation Item Master List, without changing other stamps.'), async () => {
    test.setTimeout(8 * 60_000);
    test.skip(!selection, `NOT EXECUTED: ${setupProblem || 'the shared component inspection did not complete.'}`);
    const { candidate, state } = await approvedFixture('with an installed rotational stamp', (found) => Boolean(found.stamp) && !found.children.length);
    const readMaster = async () => {
      const tab = await context.newPage();
      try {
        const master = new RotationItemMasterPage(tab);
        await master.openForVessel(vessel);
        return await master.readStamps();
      } finally {
        await tab.close();
      }
    };
    const rowText = (rows: RotationItemRow[], stamp: string) => {
      const row = rows.find((item) => item.stamp === stamp || stamp.includes(item.stamp));
      return row ? `${row.stamp} status ${row.status}, installed on ${row.installedOn || 'nothing'}` : `${stamp} not listed`;
    };
    const steps = {
      before: { title: `Record the stamp installed on approved Component ${candidate.code}`, expected: `The Rotation Item Master List should show stamp ${state.stamp} installed on ${label(candidate)}.` },
      click: { title: `Click Delete for Component ${candidate.code}`, expected: `The application should ask for confirmation before deleting ${label(candidate)}.` },
      confirm: { title: 'Confirm the deletion', expected: `The application should delete ${label(candidate)}.` },
      after: { title: 'Read the Rotation Item Master List after deletion', expected: `Stamp ${state.stamp} should be released and no longer installed on ${candidate.code}; other stamps should be unchanged.` },
      verify: { title: `Verify stamp ${state.stamp} was released`, expected: `Stamp ${state.stamp} should no longer be linked to deleted Component ${candidate.code}, and no other stamp should change.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const masterBefore = await run(plan, steps.before, readMaster, (rows) => `Rotation Item Master List: ${rowText(rows, state.stamp)}.`);
      const clicked = await run(plan, steps.click, clickDelete, (observed) => `The application showed ${observed.kind === 'confirmation' ? 'the confirmation' : observed.kind === 'blocked' ? 'the blocking message' : 'nothing'}${observed.text ? ` "${observed.text}"` : ''}.`);
      if (clicked.kind !== 'confirmation') throw new Error(`Observed Application Result: no deletion confirmation was shown${clicked.text ? `; the application showed "${clicked.text}"` : ''}.`);
      const result = await run(plan, steps.confirm, confirmDelete, (outcome) => `${outcome.deleted ? 'The deletion succeeded' : 'The deletion was refused'}${outcome.status ? ` (HTTP ${outcome.status})` : ''} with "${outcome.message}".`);
      if (result.deleted) await recordDeletion(candidate.code, result.message);
      const masterAfter = await run(plan, steps.after, readMaster, (rows) => `Rotation Item Master List: ${rowText(rows, state.stamp)}.`);
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const stampRow = masterAfter.find((item) => item.stamp === state.stamp || state.stamp.includes(item.stamp));
        const others = (rows: RotationItemRow[]) => rows.filter((item) => item !== stampRow && item.stamp !== stampRow?.stamp).map((item) => `${item.stamp}:${item.status}:${item.installedOn}`).sort().join('|');
        const problems = [
          ...(!result.deleted ? [`the deletion was refused with "${result.message}"`] : []),
          ...(stampRow && (/installed/i.test(stampRow.status) || stampRow.installedOn.includes(candidate.code)) ? [`stamp ${stampRow.stamp} still showed status ${stampRow.status}, installed on ${stampRow.installedOn}`] : []),
          ...(others(masterAfter) !== others(masterBefore) ? ['other stamps changed status or installation'] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return stampRow;
      }, { actual: () => `${label(candidate)} was deleted; Rotation Item Master List showed ${rowText(masterAfter, state.stamp)}, and other stamps were unchanged.` });
    });
  });

  // ---------- Negative scenarios ----------

  test('CMP-181 - Deactivate Parent With Active Children', componentScenario('Setting Is Active = No on a parent that has active child components should be blocked with a dependency warning, and the parent and its children should remain unchanged.'), async () => {
    test.setTimeout(10 * 60_000);
    await deactivationBlocked(fixtureFor('parent'), childDependents, 'active child components');
  });

  test('CMP-182 - Delete Parent With Active Children', componentScenario('Deleting a parent that has active child components should be blocked, and after a refresh the parent-child relationships should be intact.'), async () => {
    test.setTimeout(8 * 60_000);
    await deletionBlocked(fixtureFor('parent'), childDependents, 'active child components');
  });

  test('CMP-183 - Deactivate Component With Active Jobs', componentScenario('Setting Is Active = No on a component that has an active job should be blocked with a dependency warning, and the component and its jobs should remain unchanged.'), async () => {
    test.setTimeout(8 * 60_000);
    await deactivationBlocked(fixtureFor('jobs'), jobDependents, 'active jobs');
  });

  test('CMP-184 - Delete Component With Active Jobs', componentScenario('Deleting a component that has an active job should be blocked, and the component and its jobs should remain available.'), async () => {
    test.setTimeout(8 * 60_000);
    await deletionBlocked(fixtureFor('jobs'), jobDependents, 'active jobs');
  });

  test('CMP-185 - Deactivate Component With Linked Spares', componentScenario('Setting Is Active = No on a component with linked spare parts should be blocked, and the component and its spare links should remain unchanged.'), async () => {
    test.setTimeout(8 * 60_000);
    await deactivationBlocked(fixtureFor('spares'), spareDependents, 'linked spare parts');
  });

  test('CMP-186 - Delete Component With Linked Spares', componentScenario('Deleting a component with linked spare parts should be blocked, and after a refresh its spare part associations should be unchanged.'), async () => {
    test.setTimeout(8 * 60_000);
    await deletionBlocked(fixtureFor('spares'), spareDependents, 'linked spare parts');
  });

  // ---------- Cases listed without a definition ----------

  for (const id of ['CMP-187', 'CMP-190']) {
    test(`${id} - Definition not supplied`, componentScenario(`No steps or expected result were supplied for ${id}, so no application behaviour is validated.`), async () => {
      test.skip(true, `NOT EXECUTED: ${id} was listed, but its steps and expected result were not supplied; the scenario was not invented.`);
    });
  }
});
