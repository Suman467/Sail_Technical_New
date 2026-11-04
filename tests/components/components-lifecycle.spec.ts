import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import type { ComponentFormPage } from '../../pages/ComponentFormPage';
import type { ComponentTreeRow, ComponentsPage, SelectedComponentIdentity } from '../../pages/ComponentsPage';
import { RotationItemMasterPage, type RotationItemRow } from '../../pages/RotationItemMasterPage';
import { readTrackedComponents, trackCreatedComponent, updateTrackedComponentCleanup } from '../../utils/componentCreationTracker';
import { attachFailureScreenshot, componentActionStep, componentNotExecutedStep, componentObservedCheck, componentScenario, componentValidationStep, ScenarioPlan, type PlannedStep } from '../../utils/componentValidationEvidence';
import { forgetComponentsViewState, openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

/** What one inspected component holds; `undefined` means the value could not be read. */
type Inspection = {
  code: string;
  name: string;
  vesselName: string;
  depth: number;
  topLevel: string;
  active?: string;
  /** Section A - Is Parent, the application's own statement of whether the component holds children. */
  isParent?: string;
  jobs?: string[];
  spares?: string[];
  stamp?: string;
  children: string[];
  /** Child rows the tree showed without the (Inactive) label. */
  activeChildren?: string[];
  childNames?: Record<string, string>;
};
/** `existing` is the component CMP-175 selected; the others are found directly in the tree when first needed. */
type FixtureKey = 'existing' | 'creationParent' | 'parent' | 'jobs' | 'spares';
type SearchedFixture = Exclude<FixtureKey, 'existing'>;
type DeleteObservation = { kind: 'blocked' | 'confirmation' | 'none'; text: string };
type Target = { code: string; name: string };
type ActivationTarget = Target & { originalParent: string };
/** How the tree draws one row: its text, (Inactive) label and the text colour seen over the white tree background. */
type RowLook = { code: string; text: string; inactiveLabel: boolean; color: string; opacity: number; luminance: number; neutral: boolean };
type TreeLook = { target?: RowLook; reference?: RowLook };

const vessel = config.vesselName;
const sourceSpec = 'components-lifecycle.spec.ts';
const sectionA = 'A. Component Information';
const sectionB = 'B. Fleet Component Information';
// Replacement workers in one run share the run-scoped authentication file, so components
// selected by an earlier test case are reused instead of being searched for again.
const fixturesFile = process.env.COMPONENTS_AUTH_STATE_PATH ? `${process.env.COMPONENTS_AUTH_STATE_PATH}.lifecycle-fixtures.json` : undefined;
const activationTargetFile = process.env.COMPONENTS_AUTH_STATE_PATH ? `${process.env.COMPONENTS_AUTH_STATE_PATH}.cmp-175-176.json` : undefined;
const runId = `cmp-lifecycle-${path.basename(process.env.COMPONENTS_AUTH_STATE_PATH ?? `worker-${process.ppid}`).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`;
const dependencyFeedback = /child|depend|linked|job|spare|cannot|not allowed|unable|in use/i;
// Passed to the shared Save helper so it waits for the real response instead of matching unrelated page text.
const saveFeedback = /cannot be (?:deleted|deactivated)|cannot deactivate|are linked|active child/i;
/** Smallest rise in relative luminance (0-1) that counts as visibly lighter text; no exact colour is assumed. */
const lighterBy = 0.15;
/** Tree rows CMP-175 may open while looking for an active component; no full traversal is made. */
const activationSelectionLimit = 10;
/** Tree rows a dependency scenario may open while looking for its component; the search stops at the first match. */
const fixtureSearchLimit = 40;
/** CMP-183 to CMP-186 use existing components of this vessel known to hold the dependency; they are opened by code. */
const dependencyVessel = 'PMS Test 1';
const dependencyComponents = { jobs: '813.030', spares: '813.011' } as const;

const fixtureNeed: Record<SearchedFixture, string> = {
  creationParent: 'an active existing component with Is Parent Yes, under which a new test component can be created',
  parent: 'an active parent component with at least one active child component and no jobs or linked spares of its own',
  jobs: 'an active component with Is Parent No, at least one job and no linked spares',
  spares: 'an active component with Is Parent No and linked spare parts',
};

const step = (title: string, expected: string) => `${title}\nExpected: ${expected}\nActual: Recorded after the validation completes.`;
const list = (values: string[] | undefined) => (values === undefined ? 'unreadable' : values.length ? values.join(', ') : 'none');
const label = (target: Target) => `${target.code} (${target.name})`;
const describe = (item: Inspection) => `Is Active ${item.active ?? 'unreadable'}; Is Parent ${item.isParent ?? 'unreadable'}; child components ${list(item.children)}; jobs ${list(item.jobs)}; linked spares ${list(item.spares)}; stamp ${item.stamp || 'none'}`;
const lookText = (look: RowLook | undefined) => (look ? `"${look.text}" in ${look.color}${look.opacity < 1 ? ` at opacity ${look.opacity}` : ''}` : 'no row shown');
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when a displayed stamp contains the complete stamp name as a whole token. */
const showsStamp = (displayed: string, stampName: string) => new RegExp(`(?:^|[^\\w])${escapeRegExp(stampName)}(?:$|[^\\w])`).test(displayed);

test.describe('CMP-175 to CMP-186 - Component lifecycle', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let fixtures: Partial<Record<FixtureKey, Inspection>> = {};
  /** An existing component CMP-175 left inactive that CMP-176 has not yet reactivated in this worker. */
  let pendingReactivation: ActivationTarget | undefined;
  let lastFailedTitle: string | undefined;
  /** The vessel the running scenario works in; reset to the configured vessel after each test. */
  let currentVessel = vessel;

  // ---------- Reading component state ----------

  const readActive = () => components.readSelectedComponentDetail({ section: sectionB, label: 'Is Active' });
  const readParent = () => components.readSelectedComponentDetail({ section: sectionA, label: 'Parent Component Code' });
  const readIsParent = () => components.readSelectedComponentDetail({ section: sectionA, label: 'Is Parent' });
  const uniqueValues = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const readJobs = async () => uniqueValues((await components.readAllLinkedJobs()).jobs.map((job) => job.jobCode));
  const readSpares = async () => {
    const loaded = await components.readLoadedLinkedSpares();
    if (!(await components.readLinkedSparesControls()).showAll) return uniqueValues(loaded.spares.map((spare) => spare.partCode));
    const view = await components.showAllLinkedSpares();
    try {
      const all = await components.readSparesAcrossPages(view.list, view.scope);
      return uniqueValues(all.spares.map((spare) => spare.partCode));
    } finally {
      await components.collapseLinkedSpares(view);
    }
  };
  const readStamp = async () => {
    const rotation = await components.readSelectedRotationItem();
    return rotation.rotationalItem === 'Yes' && rotation.stamp && rotation.stamp !== '-' ? rotation.stamp : '';
  };
  const optional = <T>(read: () => Promise<T>) => read().catch(() => undefined);

  /** Selects a component by code and confirms the details panel shows the same identity in the vessel. */
  const openComponent = async (target: Target): Promise<SelectedComponentIdentity> => {
    const identity = await components.searchAndSelectComponentByCode(target.code);
    const plain = (value: string) => value.replace(/\s*\(Inactive\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    if (identity.code !== target.code || plain(identity.name) !== plain(target.name) || identity.vesselName !== currentVessel) {
      throw new Error(`Observed Application Result: Component Details showed ${identity.code} (${identity.name}) in Vessel ${identity.vesselName} instead of ${label(target)} in Vessel ${currentVessel}.`);
    }
    return identity;
  };

  // A deleted component's code re-applied from the saved view after a reload would empty the tree.
  const forgetViewState = () => forgetComponentsViewState(page);

  const refresh = async () => {
    const load = async () => {
      await forgetViewState();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await components.expectToBeOnPage();
      // The tree search survives a reload; after a deletion it would filter on a code that no longer exists.
      await components.clearComponentSearch();
      await components.selectVessel(currentVessel);
      await components.expectTreeLoaded();
    };
    await load().catch(load);
  };

  const openEdit = async (code: string): Promise<ComponentFormPage> => {
    const form = await components.openSelectedComponentForEdit();
    await form.expectEditReady(code);
    return form;
  };

  /**
   * Reads how the tree draws a component's row, and one other active row shown with it,
   * from the computed text colour and opacity. Selecting a row changes only its background.
   */
  const readTreeLook = (code: string): Promise<TreeLook> => page.getByTestId('B6').evaluate((tree, wanted) => {
    const view = tree.ownerDocument.defaultView!;
    const style = (element: Parameters<typeof view.getComputedStyle>[0]) => view.getComputedStyle(element);
    const rows = Array.from(tree.querySelectorAll('div.flex.items-center.px-3.py-2.cursor-pointer'));
    const looks = rows.map((row) => {
      const text = (row.textContent ?? '').replace(/\s*\(Inactive\)/, ' (Inactive)').replace(/\s+/g, ' ').trim();
      const rowCode = text.split(' ')[0];
      const nameLabel = Array.from(row.querySelectorAll('span')).find((span) => (span.textContent ?? '').trim().startsWith(rowCode)) ?? row;
      let opacity = 1;
      for (let element: typeof nameLabel | null = nameLabel; element && element !== tree; element = element.parentElement) opacity *= Number(style(element).opacity);
      const color = style(nameLabel).color;
      const channels = (color.match(/^rgba?\(([^)]+)\)/)?.[1].split(',').map(Number) ?? []).slice(0, 3);
      const seen = channels.map((channel) => channel * opacity + 255 * (1 - opacity));
      const linear = seen.map((channel) => (channel / 255 <= 0.03928 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4));
      return {
        code: rowCode,
        text,
        inactiveLabel: /\(Inactive\)/.test(text),
        color,
        opacity: Math.round(opacity * 100) / 100,
        luminance: linear.length === 3 ? 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] : Number.NaN,
        neutral: seen.length === 3 && Math.max(...seen) - Math.min(...seen) <= 40,
      };
    });
    return { target: looks.find((look) => look.code === wanted), reference: looks.find((look) => look.code !== wanted && !look.inactiveLabel) };
  }, code);

  /** Differences from the inactive appearance: visible, (Inactive) label, gray text lighter than active text. */
  const inactiveLookProblems = (after: TreeLook, activeBefore: RowLook | undefined): string[] => {
    const row = after.target;
    if (!row) return ['the component was not visible in the component tree'];
    const active = activeBefore ?? after.reference;
    return [
      ...(!row.inactiveLabel ? [`the tree row ${lookText(row)} did not show the (Inactive) label`] : []),
      ...(!row.neutral ? [`the tree text colour ${row.color} is not gray`] : []),
      ...(!active || !(row.luminance - active.luminance >= lighterBy) ? [`the tree text ${lookText(row)} was not lighter than active text ${lookText(active)}`] : []),
    ];
  };

  /** Differences from the normal active appearance, compared with another active row shown in the tree. */
  const activeLookProblems = (after: TreeLook): string[] => {
    const row = after.target;
    if (!row) return ['the component was not visible in the component tree'];
    const normal = after.reference;
    return [
      ...(row.inactiveLabel ? [`the tree row ${lookText(row)} still showed the (Inactive) label`] : []),
      ...(normal && (row.color !== normal.color || row.opacity !== normal.opacity) ? [`the tree text was ${lookText(row)} instead of the normal active ${lookText(normal)}`] : []),
    ];
  };

  // ---------- Direct component selection ----------

  const readFixtures = async (): Promise<Partial<Record<FixtureKey, Inspection>>> => (fixturesFile
    ? fs.readFile(fixturesFile, 'utf8').then((text) => JSON.parse(text) as Partial<Record<FixtureKey, Inspection>>).catch(() => ({}))
    : {});
  const saveFixture = async (key: FixtureKey, item: Inspection) => {
    fixtures = { ...(await readFixtures()), ...fixtures, [key]: item };
    if (fixturesFile) await fs.writeFile(fixturesFile, JSON.stringify(fixtures), 'utf8');
  };
  const automationCodes = async () => new Set((await readTrackedComponents()).filter((item) => item.vessel === vessel).map((item) => item.code));
  const inactiveRow = (row: ComponentTreeRow) => /\(Inactive\)/i.test(row.rawText);

  /** The child rows the tree shows directly beneath a row (tree order with depth). */
  const childRows = (rows: ComponentTreeRow[], code: string) => {
    const index = rows.findIndex((row) => row.code === code);
    if (index < 0) return [];
    const end = rows.findIndex((row, later) => later > index && row.depth <= rows[index].depth);
    return rows.slice(index + 1, end < 0 ? undefined : end).filter((row) => row.depth === rows[index].depth + 1);
  };

  /**
   * Selects tree rows in tree order, as a tester scanning the tree would, and stops at the first
   * component that meets the need. Only the selected row's own details are read, and a parent is
   * opened so its children follow it. Never a full traversal: at most fixtureSearchLimit rows.
   */
  const findInTree = async (accept: (item: Inspection) => Promise<boolean>) => {
    const automation = await automationCodes();
    await components.clearComponentSearch();
    await components.expectTreeLoaded();
    const tried = new Set<string>();
    const checked: Inspection[] = [];
    while (tried.size < fixtureSearchLimit) {
      const row = (await components.readTreeRowsWithCoverage()).rows.find((item) => !tried.has(item.code) && !automation.has(item.code) && !inactiveRow(item));
      if (!row) break;
      tried.add(row.code);
      const identity = await components.selectTreeComponent(row);
      const item: Inspection = { code: identity.code, name: identity.name, vesselName: identity.vesselName, depth: row.depth, topLevel: '', active: await optional(readActive), isParent: await optional(readIsParent), children: [] };
      if (item.isParent !== 'No' && await components.treeComponentExpansionState(row.code) === 'collapsed') await components.expandTreeComponent(row.code);
      // Classification rows carry no Vessel Name; only active components of the vessel qualify.
      if (item.vesselName !== vessel || item.active !== 'Yes') continue;
      const children = childRows((await components.readTreeRowsWithCoverage()).rows, row.code);
      item.children = children.map((child) => child.code);
      item.activeChildren = children.filter((child) => !inactiveRow(child)).map((child) => child.code);
      item.childNames = Object.fromEntries(children.map((child) => [child.code, child.name]));
      checked.push(item);
      if (await accept(item)) return { found: item, checked };
    }
    return { found: undefined, checked };
  };

  const withJobsAndSpares = async (item: Inspection) => {
    item.jobs = await optional(readJobs);
    item.spares = await optional(readSpares);
    return item;
  };
  const accepts: Record<SearchedFixture, (item: Inspection) => Promise<boolean>> = {
    creationParent: async (item) => item.isParent === 'Yes',
    parent: async (item) => item.isParent === 'Yes' && Boolean(item.activeChildren?.length)
      && (await withJobsAndSpares(item)).jobs?.length === 0 && item.spares?.length === 0,
    jobs: async (item) => item.isParent === 'No' && Boolean((await withJobsAndSpares(item)).jobs?.length) && item.spares?.length === 0,
    // A component with spares and no jobs isolates the spare-part rule; the first one with both is the fallback.
    spares: async (item) => item.isParent === 'No' && Boolean((await withJobsAndSpares(item)).spares?.length) && item.jobs?.length === 0,
  };

  /**
   * Returns the component a scenario needs: one selected earlier in this run when available,
   * otherwise the first suitable one found directly in the tree. A missing component makes the
   * scenario NOT EXECUTED with the reason.
   */
  const fixture = async (key: SearchedFixture): Promise<Inspection> => {
    fixtures = { ...(await readFixtures()), ...fixtures };
    const saved = fixtures[key];
    if (saved) return saved;
    const title = `Select ${fixtureNeed[key]} from the component tree`;
    const expected = `The first suitable existing Component of Vessel ${vessel} shown in the tree, not created by automation, should be selected.`;
    // The component CMP-175 and CMP-176 used is reused as a parent when it can hold children.
    const existing = fixtures.existing;
    if (key === 'creationParent' && existing?.isParent === 'Yes') {
      await componentObservedCheck(page, title, expected, { passed: true, actual: `Reused Component ${label(existing)}, selected for CMP-175 and CMP-176, which shows Is Parent Yes.` });
      await saveFixture(key, existing);
      return existing;
    }
    const search = await findInTree(accepts[key]);
    const found = search.found ?? (key === 'spares' ? search.checked.find((item) => item.spares?.length) : undefined);
    const checked = `${search.checked.length} active Component(s) checked in tree order: ${search.checked.map((item) => item.code).join(', ') || 'none'}`;
    if (!found) {
      const reason = `missing prerequisite - the test needs ${fixtureNeed[key]}, but none was found; ${checked}.`;
      await componentNotExecutedStep(title, expected, reason);
      test.skip(true, `NOT EXECUTED: ${reason}`);
    }
    await componentObservedCheck(page, title, expected, { passed: true, actual: `Selected ${label(found!)}: ${describe(found!)}. ${checked}.` });
    await saveFixture(key, found!);
    return found!;
  };

  /**
   * Picks an existing active component for CMP-175/176 the way a tester would: straight from the
   * rows the tree already shows, in tree order. Dependencies are not inspected beforehand; a
   * component is expanded only when no shown row is an active component of the vessel.
   */
  const selectActivationTarget = async (): Promise<Target> => componentActionStep(
    'Select an existing active Component from the component tree',
    `Any existing active parent or child Component of Vessel ${vessel}, not created by automation, should be selected directly from the tree.`,
    async () => {
      const automationCodes = new Set((await readTrackedComponents()).filter((item) => item.vessel === vessel).map((item) => item.code));
      await components.clearComponentSearch();
      await components.expectTreeLoaded();
      const tried = new Set<string>();
      for (let attempt = 0; attempt < activationSelectionLimit; attempt++) {
        const rows = (await components.readTreeRowsWithCoverage()).rows;
        const row = rows.find((item) => !tried.has(item.code) && !automationCodes.has(item.code) && !inactiveRow(item));
        if (!row) break;
        tried.add(row.code);
        const identity = await components.selectTreeComponent(row);
        // Classification rows carry no Vessel Name; their children are shown instead.
        if (identity.vesselName === vessel && await readActive() === 'Yes') {
          await saveFixture('existing', { code: identity.code, name: identity.name, vesselName: identity.vesselName, depth: row.depth, topLevel: '', active: 'Yes', isParent: await optional(readIsParent), children: [] });
          return { code: identity.code, name: identity.name };
        }
        if (await components.treeComponentExpansionState(row.code) === 'collapsed') await components.expandTreeComponent(row.code);
      }
      throw new Error(`Observed Application Result: none of the ${tried.size} component(s) selected from the tree (${[...tried].join(', ') || 'none'}) was an active existing Component of Vessel ${vessel}.`);
    },
    (target) => `Selected existing Component ${label(target)} in Vessel ${vessel}, shown with Is Active Yes.`,
    { page },
  );

  const saveActivationTarget = async (target: ActivationTarget) => {
    pendingReactivation = target;
    if (activationTargetFile) await fs.writeFile(activationTargetFile, JSON.stringify(target), 'utf8');
  };

  const readActivationTarget = async (): Promise<ActivationTarget | undefined> => pendingReactivation
    ?? (activationTargetFile
      ? fs.readFile(activationTargetFile, 'utf8').then((text) => JSON.parse(text) as ActivationTarget).catch(() => undefined)
      : undefined);

  const clearActivationTarget = async () => {
    pendingReactivation = undefined;
    if (activationTargetFile) await fs.rm(activationTargetFile, { force: true }).catch(() => undefined);
  };

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(20 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
  });

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    lastFailedTitle = testInfo.status !== testInfo.expectedStatus ? testInfo.title : undefined;
    await attachFailureScreenshot(page, testInfo);
    currentVessel = vessel;
    await forgetViewState();
    await restoreComponentsPage(page, components, vessel);
  });

  test.afterAll(async () => {
    // An existing component is never left inactive by this suite, including when CMP-175 failed
    // after its deactivation was saved; CMP-176 then finds it active and is not executed.
    if (pendingReactivation && page) {
      await restoreActive(pendingReactivation, lastFailedTitle?.startsWith('CMP-175') ? 'because CMP-175 failed after deactivating it' : 'because CMP-176 did not reactivate it in this run')
        .then(clearActivationTarget)
        .catch(() => undefined);
    }
    await context?.close();
  });

  // ---------- Shared actions ----------

  const run = <T>(plan: ScenarioPlan, planned: PlannedStep, body: () => Promise<T>, actual: (value: T) => string): Promise<T> => {
    plan.begin(planned.title);
    return componentActionStep(planned.title, planned.expected, body, actual, { page });
  };

  /** Records every remaining planned step as NOT EXECUTED with the reason, then skips the test. */
  const notExecuted = async (plan: ScenarioPlan, planned: PlannedStep[], reason: string): Promise<never> => {
    for (const item of planned) {
      plan.begin(item.title);
      await componentNotExecutedStep(item.title, item.expected, reason);
    }
    test.skip(true, `NOT EXECUTED: ${reason}`);
    throw new Error(reason);
  };

  /** The shared Save helper records this step title itself. */
  const saveTitle = 'Click Save and capture the application response';
  const setStep = (target: Target, value: 'Yes' | 'No'): PlannedStep => ({
    title: `Set Is Active = ${value} on Component ${target.code}`,
    expected: `Edit Component - B. Fleet Component Information of ${label(target)} should open and hold Is Active ${value} before Save.`,
  });

  /** Opens Edit Component and changes B. Fleet Component Information - Is Active, without saving. */
  const setIsActive = async (target: Target, value: 'Yes' | 'No') => {
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
    const outcome = await form.submitForValidation({ expected, feedbackPattern: saveFeedback });
    if (outcome.formRemainedOpen) await form.back().catch(() => undefined);
    return outcome;
  };

  /** Puts Is Active back to Yes on an existing component this suite left inactive. */
  const restoreActive = async (target: Target, reason: string) => {
    const restoreSet = setStep(target, 'Yes');
    const { form } = await componentActionStep(`${restoreSet.title} to restore it ${reason}`, restoreSet.expected,
      async () => {
        await refresh();
        await openComponent(target);
        return setIsActive(target, 'Yes');
      }, setActual, { page });
    await save(undefined, form, `Save should reactivate ${label(target)} so the test leaves business data as it found it.`);
    const active = await componentActionStep(`Refresh and confirm Component ${target.code} is active again`,
      `After the restore, ${label(target)} should show Is Active Yes.`,
      async () => {
        await refresh();
        await openComponent(target);
        return readActive();
      }, (value) => `Component ${label(target)} showed Is Active ${value} after the restore.`, { page });
    if (active === 'Yes' && pendingReactivation?.code === target.code) pendingReactivation = undefined;
    return active;
  };

  const deleteButton = () => page.getByTestId('btn-delete-component');
  const blockedTitle = /Cannot Delete Component|Component Deletion Blocked/;
  const cannotDeleteDialog = () => page.getByRole('dialog').filter({ hasText: blockedTitle }).last();
  const confirmationDialog = () => page.getByRole('dialog').filter({ hasText: /delete/i }).filter({ hasNotText: blockedTitle }).last();

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
  const clickedText = (observed: DeleteObservation) => (observed.kind === 'confirmation'
    ? `The application showed the confirmation "${observed.text}".`
    : observed.kind === 'blocked' ? `The application showed "${observed.text}" instead of a confirmation.` : 'No dialog was displayed after Delete was clicked.');

  const closeDialog = async (dialog: ReturnType<typeof confirmationDialog>, button: 'Cancel' | 'OK') => {
    // The Component Deletion Blocked popup may acknowledge with Close instead of OK.
    const preferred = dialog.getByRole('button', { name: button, exact: true });
    if (await preferred.count()) await preferred.first().click();
    else {
      expect(button, 'Only an OK acknowledgement may fall back to the dialog Close control').toBe('OK');
      await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    }
    await expect(dialog, `The dialog should close after ${button}`).toBeHidden();
  };

  /** Confirms an open deletion dialog and reports whether the application then blocked or deleted. */
  const confirmDelete = async (expectedWarning?: string): Promise<{ deleted: boolean; message: string; status?: number }> => {
    const recordBlockedPopup = async (message: string) => componentObservedCheck(page, 'Verify the Component Deletion Blocked popup',
      expectedWarning ?? 'The application should show Component Deletion Blocked with the applicable dependency warning.',
      { passed: !expectedWarning || message === expectedWarning, actual: `The popup displayed "${message}".` }, { screenshot: 'always' });
    const response = page.waitForResponse((candidate) => candidate.url().includes('/technical/api/components') && candidate.request().method() === 'DELETE', { timeout: 20_000 });
    response.catch(() => undefined);
    await confirmationDialog().getByRole('button', { name: 'Delete', exact: true }).click();
    const outcome = await Promise.race([
      cannotDeleteDialog().waitFor({ state: 'visible', timeout: 20_000 }).then(() => ({ blocked: true as const })),
      response.then((received) => ({ received })),
    ]);
    if ('blocked' in outcome) {
      const message = (await cannotDeleteDialog().innerText()).replace(/\s+/g, ' ').replace(/(?:\s+(?:OK|Close))+\s*$/i, '').trim();
      await recordBlockedPopup(message);
      await closeDialog(cannotDeleteDialog(), 'OK');
      return { deleted: false, message };
    }
    if (!outcome.received.ok()) {
      await cannotDeleteDialog().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
      if (await cannotDeleteDialog().isVisible().catch(() => false)) {
        const message = (await cannotDeleteDialog().innerText()).replace(/\s+/g, ' ').replace(/(?:\s+(?:OK|Close))+\s*$/i, '').trim();
        await recordBlockedPopup(message);
        await closeDialog(cannotDeleteDialog(), 'OK');
        return { deleted: false, message, status: outcome.received.status() };
      }
    }
    const toast = page.getByText(/deleted|cannot|unable|not allowed/i).filter({ visible: true }).last();
    await toast.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    const message = await toast.isVisible().catch(() => false) ? (await toast.innerText()).replace(/\s+/g, ' ').trim() : 'No visible message was displayed.';
    return { deleted: outcome.received.ok(), message, status: outcome.received.status() };
  };

  /** Reads the Rotation Item Master List in a separate tab of the same authenticated session. */
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
  const stampRow = (rows: RotationItemRow[], stamp: string) => rows.find((row) => row.stamp === stamp);
  const stampText = (rows: RotationItemRow[], stamp: string) => {
    const row = stampRow(rows, stamp);
    return row ? `${row.stamp} status ${row.status}, installed on ${row.installedOn || 'nothing'}` : `${stamp} not listed`;
  };

  // ---------- Negative deactivation / deletion scenarios ----------

  type DeleteWarning = { item: 'Job' | 'Spare'; plural: 'Jobs' | 'Spares' };
  type Dependents = { describe: string; specific: RegExp; read: (target: Inspection) => Promise<string[]>; deleteWarning?: DeleteWarning };
  const childDependents: Dependents = {
    describe: 'child components (parent and Is Active)',
    specific: /child/i,
    read: async (target) => {
      const states: string[] = [];
      for (const child of target.activeChildren ?? target.children) {
        const identity = await components.searchAndSelectComponentByCode(child);
        states.push(`${identity.code} parent ${await readParent()} Is Active ${await readActive()}`);
      }
      await openComponent(target);
      return states;
    },
  };
  const jobDependents: Dependents = { describe: 'jobs', specific: /job/i, read: async () => readJobs(), deleteWarning: { item: 'Job', plural: 'Jobs' } };
  const spareDependents: Dependents = { describe: 'linked spare parts', specific: /spare/i, read: async () => readSpares(), deleteWarning: { item: 'Spare', plural: 'Spares' } };

  /** Dependencies of the target other than the one the scenario is about; any of them could cause a block. */
  const otherDependencies = (target: Inspection, dependents: Dependents) => [
    ...(dependents !== childDependents && target.children.length ? [`child components ${list(target.children)}`] : []),
    ...(dependents !== jobDependents && target.jobs?.length ? [`jobs ${list(target.jobs)}`] : []),
    ...(dependents !== spareDependents && target.spares?.length ? [`linked spare parts ${list(target.spares)}`] : []),
  ];
  /**
   * `specificMessage`: the blocking message must name the scenario's dependency, not only a generic dependency.
   * `byCode`: the component was named by the test case rather than searched for in the tree.
   */
  type BlockOptions = { specificMessage?: boolean; byCode?: boolean };
  const notIsolated = (target: Inspection, others: string[], message: string, dependency: string, options: BlockOptions = {}) =>
    `the application blocked the action on ${label(target)} with "${message}", which does not mention the ${dependency}. ${target.code} also has ${others.join(' and ')}, ${options.byCode
      ? 'so the block may have been caused by those instead'
      : `and no component with only ${dependency} was found within the first ${fixtureSearchLimit} tree rows checked`}, so this run cannot show that the ${dependency} alone block it.`;

  const deactivationBlocked = async (target: Inspection, dependents: Dependents, dependency: string, options: BlockOptions = {}) => {
    const others = otherDependencies(target, dependents);
    const steps = {
      open: { title: `Open Component ${target.code} and record its ${dependents.describe}`, expected: `Component ${label(target)} should open active in Vessel ${currentVessel} with its ${dependents.describe} displayed.` },
      set: setStep(target, 'No'),
      save: { title: saveTitle, expected: `The application should refuse to deactivate ${label(target)} because it has ${dependency}, and show a dependency warning.` },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should still be active with the same ${dependents.describe}.` },
      verify: { title: `Verify deactivation was blocked and ${target.code} is unchanged`, expected: `Deactivating ${label(target)} should be blocked with a warning about its ${dependency}, and the component and its ${dependents.describe} should remain unchanged.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    let restored = false;
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => {
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `Component ${label(target)} showed Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}${others.length ? `; it also has ${others.join(' and ')}` : ''}.`);
      const changed = await run(plan, steps.set, () => setIsActive(target, 'No'), setActual);
      const attempt = { warning: changed.warning, outcome: await save(plan, changed.form, steps.save.expected) };
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `After refresh, ${label(target)} showed Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}.`);
      const changedChildren = dependents === childDependents
        ? after.dependents.filter((state) => !before.dependents.includes(state)).map((state) => state.split(' ')[0]) : [];
      if (after.active === 'No') { await restoreActive(target, 'after the unexpected deactivation'); restored = true; }
      for (const child of changedChildren) {
        if (before.dependents.some((state) => state.startsWith(`${child} `) && state.endsWith('Is Active Yes'))) {
          await restoreActive({ code: child, name: target.childNames?.[child] ?? child }, 'after the unexpected deactivation');
        }
      }
      const feedback = `${attempt.outcome.feedback} ${attempt.warning}`.trim();
      const changes = [
        ...(after.active !== before.active ? [`Is Active changed from ${before.active} to ${after.active}${restored ? ' and was restored to Yes by the test' : ''}`] : []),
        ...(after.dependents.join('|') !== before.dependents.join('|') ? [`${dependents.describe} changed from ${list(before.dependents)} to ${list(after.dependents)}`] : []),
      ];
      plan.begin(steps.verify.title);
      if (!attempt.outcome.succeeded && others.length && !dependents.specific.test(feedback) && !changes.length) {
        await notExecuted(plan, [steps.verify], notIsolated(target, others, feedback, dependency, options));
      }
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const warned = (others.length || options.specificMessage ? dependents.specific : dependencyFeedback).test(feedback);
        const problems = [
          ...(attempt.outcome.succeeded ? [`Save accepted Is Active = No (HTTP ${attempt.outcome.status}, "${attempt.outcome.feedback}") instead of blocking it`] : []),
          ...(!attempt.outcome.succeeded && !warned ? [`no warning about the ${dependency} was shown; the application displayed "${feedback}"`] : []),
          ...changes,
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return after;
      }, { actual: (state) => `The application blocked deactivation of ${label(target)} with "${attempt.outcome.feedback}"; after refresh it remained Is Active ${state.active} with ${dependents.describe}: ${list(state.dependents)}.` });
    });
  };

  /** Clicks Delete on an existing business component, never confirms it, and checks that nothing changed. */
  const deletionBlocked = async (target: Inspection, dependents: Dependents, dependency: string) => {
    const others = otherDependencies(target, dependents);
    const steps = {
      open: { title: `Open Component ${target.code} and record its ${dependents.describe}`, expected: `Component ${label(target)} should open in Vessel ${currentVessel} with its ${dependents.describe} displayed.` },
      click: { title: `Click Delete for Component ${target.code}`, expected: `The application should block deletion of ${label(target)} with a warning about its ${dependency}.` },
      close: { title: `Close the Delete dialog without deleting Component ${target.code}`, expected: `The dialog should close and ${label(target)}, an existing business component, should not be deleted; a deletion confirmation is always cancelled.` },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should still exist in Vessel ${currentVessel} with the same Is Active status and ${dependents.describe}.` },
      unchanged: { title: `Verify Component ${target.code} and its ${dependents.describe} are unchanged`, expected: `${label(target)} should still exist with the same Is Active status and ${dependents.describe} as before Delete was clicked.` },
      verify: { title: `Verify deletion of ${target.code} was blocked`, expected: `Deleting ${label(target)} should be blocked because it has ${dependency}.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => {
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `Component ${label(target)} showed Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}${others.length ? `; it also has ${others.join(' and ')}` : ''}.`);
      const clicked = await run(plan, steps.click, clickDelete, (observed) => observed.kind === 'blocked'
        ? `The application blocked the deletion with "${observed.text}".`
        : observed.kind === 'confirmation'
          ? `The application did not block the deletion; it showed its standard confirmation "${observed.text}", which does not mention the ${dependency}.`
          : 'No blocking message or confirmation was displayed after Delete was clicked.');
      if (clicked.kind === 'none') {
        plan.begin(steps.close.title);
        await componentNotExecutedStep(steps.close.title, steps.close.expected, 'no dialog was displayed after Delete was clicked, so there was nothing to close.');
      } else {
        await run(plan, steps.close, () => closeDialog(clicked.kind === 'blocked' ? cannotDeleteDialog() : confirmationDialog(), clicked.kind === 'blocked' ? 'OK' : 'Cancel'),
          () => clicked.kind === 'blocked' ? 'OK was clicked and the blocking message closed.' : `Cancel was clicked and the confirmation closed; ${label(target)} was not deleted.`);
      }
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `After refresh, ${label(target)} was still present in Vessel ${currentVessel} with Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}.`);
      const changes = [
        ...(after.active !== before.active ? [`Is Active changed from ${before.active} to ${after.active}`] : []),
        ...(after.dependents.join('|') !== before.dependents.join('|') ? [`${dependents.describe} changed from ${list(before.dependents)} to ${list(after.dependents)}`] : []),
      ];
      plan.begin(steps.unchanged.title);
      await componentObservedCheck(page, steps.unchanged.title, steps.unchanged.expected, {
        passed: !changes.length,
        actual: changes.length ? `${changes.join('; ')}.` : `${label(target)} still showed Is Active ${after.active} and ${dependents.describe}: ${list(after.dependents)}.`,
      });
      if (changes.length) throw new Error(`Observed Application Result: after the Delete dialog was closed, ${changes.join('; ')}.`);
      plan.begin(steps.verify.title);
      if (clicked.kind === 'confirmation') {
        await notExecuted(plan, [steps.verify], `the application did not block deletion of ${label(target)} when Delete was clicked; it showed its standard confirmation without mentioning the ${dependency}. Whether the application would refuse the confirmed deletion was not checked, because ${target.code} is an existing business component and confirming could permanently delete it. The confirmation was cancelled and the component was unchanged.`);
      }
      if (clicked.kind === 'blocked' && others.length && !dependents.specific.test(clicked.text)) {
        await notExecuted(plan, [steps.verify], notIsolated(target, others, clicked.text, dependency));
      }
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        expect(clicked.kind, 'Observed Application Result: no blocking message or confirmation was displayed after Delete was clicked.').toBe('blocked');
        return after;
      }, { actual: (state) => `The application blocked deletion of ${label(target)} with "${clicked.text}"; after refresh the component remained with ${dependents.describe}: ${list(state.dependents)}.` });
    });
  };

  /**
   * Existing components the user explicitly authorized for clicking Delete inside the Delete Component
   * confirmation, as a comma-separated list of codes in COMPONENT_DELETE_CONFIRM_AUTHORIZED. That click
   * sends a real deletion request, so without the authorization the confirmation is always cancelled.
   */
  const deleteConfirmAuthorized = (code: string) => (process.env.COMPONENT_DELETE_CONFIRM_AUTHORIZED ?? '')
    .split(',').map((item) => item.trim()).includes(code);

  /**
   * The application deletes in two steps: the Delete icon opens the Delete Component confirmation, and
   * the dependency check runs only after the Delete button inside it is clicked, when the server answers
   * with Component Deletion Blocked. The second Delete is clicked only on authorized components.
   */
  const confirmedDeletionBlocked = async (target: Inspection, dependents: Dependents, dependency: string) => {
    const others = otherDependencies(target, dependents);
    const authorized = deleteConfirmAuthorized(target.code);
    const steps = {
      open: { title: `Open Component ${target.code} and record its ${dependents.describe}`, expected: `Component ${label(target)} should open in Vessel ${currentVessel} with its ${dependents.describe} displayed.` },
      click: { title: `Click the Delete icon for Component ${target.code}`, expected: 'The Delete Component confirmation should open with its own Delete button, which submits the deletion.' },
      cancel: { title: `Cancel the Delete Component confirmation for ${target.code}`, expected: `The confirmation should close without sending a deletion request, leaving ${label(target)} in place.` },
      confirm: { title: 'Click Delete in the Delete Component confirmation', expected: `The application should refuse the deletion and show Component Deletion Blocked, explaining that the ${dependency} prevent deleting ${label(target)}.` },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should still exist in Vessel ${currentVessel} with the same Is Active status and ${dependents.describe}.` },
      unchanged: { title: `Verify Component ${target.code} and its ${dependents.describe} are unchanged`, expected: `${label(target)} should still exist with the same Is Active status and ${dependents.describe} as before Delete was clicked.` },
      verify: { title: `Verify deletion of ${target.code} was blocked because of its ${dependency}`, expected: `Confirming the deletion of ${label(target)} should be refused with Component Deletion Blocked naming its ${dependency}.` },
    };
    const plan = new ScenarioPlan(authorized
      ? [steps.open, steps.click, steps.confirm, steps.refresh, steps.unchanged, steps.verify]
      : [steps.open, steps.click, steps.cancel, steps.refresh, steps.unchanged, steps.confirm, steps.verify]);
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => {
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `Component ${label(target)} showed Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}${others.length ? `; it also has ${others.join(' and ')}` : ''}.`);
      const dependentCount = before.dependents.length;
      const warning = dependents.deleteWarning;
      const expectedWarning = warning
        ? `Component Deletion Blocked This component cannot be deleted because it has ${dependentCount} active ${warning.item}(s) linked to it. Please deactivate or delete all linked ${warning.plural} first.`
        : undefined;

      const clicked = await run(plan, steps.click, async () => {
        const observed = await clickDelete();
        const secondDelete = observed.kind === 'confirmation' && await confirmationDialog().getByRole('button', { name: 'Delete', exact: true }).isVisible();
        if (observed.kind === 'confirmation') expect(observed.text, 'Popup 1 should be titled Delete Component').toMatch(/^Delete Component\b/);

        return { ...observed, secondDelete };
      }, (observed) => (observed.kind === 'confirmation'
        ? `The Delete Component confirmation opened: "${observed.text}". ${observed.secondDelete ? 'It offers its own Delete button to submit the deletion.' : 'It showed no Delete button.'}`
        : observed.kind === 'blocked' ? `The application showed "${observed.text}" straight away, without a confirmation.` : 'No confirmation or message was displayed after the Delete icon was clicked.'));
      let result: Awaited<ReturnType<typeof confirmDelete>> | undefined;
      if (clicked.kind === 'confirmation' && clicked.secondDelete && authorized) {
        result = await run(plan, steps.confirm, async () => {
          const authorizedCodes = (process.env.COMPONENT_DELETE_CONFIRM_AUTHORIZED ?? '').split(',').map((item) => item.trim()).filter(Boolean);
          const expectedCode = dependencyComponents[dependents === jobDependents ? 'jobs' : 'spares'];
          expect(currentVessel, 'The final Delete confirmation is authorized only in Vessel PMS Test 1').toBe(dependencyVessel);
          expect(target.code, 'The selected component must exactly match the authorized dependency component').toBe(expectedCode);
          expect(authorizedCodes, `Component ${target.code} must be explicitly authorized before the final Delete confirmation`).toContain(target.code);
          return confirmDelete(expectedWarning);
        }, (outcome) => (outcome.deleted
          ? `The application accepted the deletion (HTTP ${outcome.status}) with "${outcome.message}".`
          : `The application refused the deletion and showed "${outcome.message}"; OK was clicked and the message closed.`));
        if (result.deleted) throw new Error(`Observed Application Result: the application deleted ${label(target)} with "${result.message}" although it has ${dependency}.`);
      } else if (clicked.kind !== 'none') {
        await run(plan, steps.cancel, () => closeDialog(clicked.kind === 'blocked' ? cannotDeleteDialog() : confirmationDialog(), clicked.kind === 'blocked' ? 'OK' : 'Cancel'),
          () => (clicked.kind === 'blocked' ? 'OK was clicked and the message closed.' : `Cancel was clicked; the confirmation closed and no deletion request was sent for ${label(target)}.`));
      } else {
        plan.begin(steps.cancel.title);
        await componentNotExecutedStep(steps.cancel.title, steps.cancel.expected, 'no confirmation was displayed after the Delete icon was clicked, so there was nothing to cancel.');
      }
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        await openComponent(target);
        return { active: await readActive(), dependents: await dependents.read(target) };
      }, (state) => `After refresh, ${label(target)} was still present in Vessel ${currentVessel} with Is Active ${state.active}; ${dependents.describe}: ${list(state.dependents)}.`);
      const changes = [
        ...(after.active !== before.active ? [`Is Active changed from ${before.active} to ${after.active}`] : []),
        ...(after.dependents.join('|') !== before.dependents.join('|') ? [`${dependents.describe} changed from ${list(before.dependents)} to ${list(after.dependents)}`] : []),
      ];
      plan.begin(steps.unchanged.title);
      await componentObservedCheck(page, steps.unchanged.title, steps.unchanged.expected, {
        passed: !changes.length,
        actual: changes.length ? `${changes.join('; ')}.` : `${label(target)} still showed Is Active ${after.active} and ${dependents.describe}: ${list(after.dependents)}.`,
      });
      if (changes.length) throw new Error(`Observed Application Result: after the Delete workflow, ${changes.join('; ')}.`);
      if (clicked.kind === 'confirmation' && !result) {
        await notExecuted(plan, [steps.confirm, steps.verify], clicked.secondDelete
          ? `the application deletes in two steps: the Delete icon opened the Delete Component confirmation, and the check for ${dependency} runs only after the Delete button inside it is clicked, which sends a real deletion request. That button was not clicked because ${label(target)} is an existing business component and confirming its deletion has not been authorized. The confirmation was cancelled and the component was unchanged, so whether the application shows Component Deletion Blocked for its ${dependency} remains unverified.`
          : `the Delete Component confirmation for ${label(target)} showed no Delete button, so the deletion could not be submitted. The confirmation was cancelled and the component was unchanged.`);
      }
      const message = result?.message ?? (clicked.kind === 'blocked' ? clicked.text : '');
      plan.begin(steps.verify.title);
      if (message && others.length && !dependents.specific.test(message)) {
        await notExecuted(plan, [steps.verify], notIsolated(target, others, message, dependency, { byCode: true }));
      }
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(!message ? ['no confirmation or blocking message was displayed after the Delete icon was clicked'] : []),
          ...(message && !/Component Deletion Blocked/i.test(message) ? [`the application showed "${message}" instead of Component Deletion Blocked`] : []),
          ...(message && !dependents.specific.test(message) ? [`the message "${message}" does not identify the ${dependency}`] : []),
          ...(!dependentCount ? [`the selected component showed no active ${dependents.describe}, so there was no observed dependency count to validate`] : []),
          ...(message && expectedWarning && message !== expectedWarning
            ? [`the warning did not exactly match the ${dependentCount} active ${warning!.item}(s) observed on the component; expected "${expectedWarning}" but the application showed "${message}"`]
            : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return after;
      }, { actual: (state) => `The application refused to delete ${label(target)} with "${message}", matching the ${dependentCount} active ${dependents.describe} displayed for the component; after refresh the same component remained with Is Active ${state.active} and ${dependents.describe}: ${list(state.dependents)}.` });
    });
  };

  // ---------- Existing components: deactivate, reactivate, cancel delete ----------

  test('CMP-175 - Deactivate Existing Component', componentScenario('Setting Is Active = No on an existing active component selected from the tree should save; after a refresh Section B and the Edit form should show Is Active No, the component should stay visible in the tree in light gray text with the (Inactive) label, and its parent should be unchanged.'), async () => {
    test.setTimeout(8 * 60_000);
    const target = await selectActivationTarget();
    const steps = {
      open: { title: `Open Component ${target.code} and record its parent, status and tree appearance`, expected: `Component ${label(target)} should open active in Vessel ${vessel}, drawn in normal tree text without the (Inactive) label.` },
      set: setStep(target, 'No'),
      save: { title: saveTitle, expected: `The application should save ${label(target)} as inactive.` },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should show Is Active No in Section B and in the Edit form, and stay visible in the tree.` },
      verify: { title: `Verify Component ${target.code} is inactive, shown in light gray with (Inactive), under the same parent`, expected: `${label(target)} should be inactive after reopening, remain in the tree in light gray text with the (Inactive) label, and keep the same parent.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => ({ identity: await openComponent(target), parent: await readParent(), isParent: await readIsParent(), active: await readActive(), look: await readTreeLook(target.code) }),
        (state) => `Component ${state.identity.code} (${state.identity.name}) opened in Vessel ${state.identity.vesselName} under parent ${state.parent} with Is Active ${state.active} and Is Parent ${state.isParent}; the tree showed ${lookText(state.look.target)}.`);
      if (before.active !== 'Yes') {
        await notExecuted(plan, [steps.set, steps.save, steps.refresh, steps.verify], `${label(target)} showed Is Active ${before.active} when the test started, so it was not an active existing component available for deactivation.`);
      }
      const changed = await run(plan, steps.set, () => setIsActive(target, 'No'), setActual);
      const attempt = { outcome: await save(plan, changed.form, steps.save.expected) };
      if (attempt.outcome.succeeded) await saveActivationTarget({ ...target, originalParent: before.parent });
      const after = await run(plan, steps.refresh, async () => {
        await refresh();
        const identity = await openComponent(target);
        const state = { identity, details: await readActive(), parent: await readParent(), look: await readTreeLook(target.code) };
        const form = await openEdit(target.code);
        const formValue = await form.controlValue('Is Active', 'select-is-active');
        await form.back();
        return { ...state, formValue };
      }, (state) => `After refresh, ${state.identity.code} (${state.identity.name}) showed Is Active ${state.details} in Section B and ${state.formValue} in the Edit form, parent ${state.parent}; the tree showed ${lookText(state.look.target)}.`);
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(!attempt.outcome.succeeded ? [`Save did not succeed: "${attempt.outcome.feedback}"`] : []),
          ...(after.details !== 'No' ? [`Section B showed Is Active ${after.details}`] : []),
          ...(after.formValue !== 'No' ? [`the Edit form showed Is Active ${after.formValue}`] : []),
          ...inactiveLookProblems(after.look, before.look.target),
          ...(after.parent !== before.parent ? [`the parent changed from ${before.parent} to ${after.parent}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return after;
      }, { actual: (state) => `Component ${label(target)} saved as inactive and reopened with Is Active ${state.details}; the tree showed ${lookText(state.look.target)}, lighter than its active text ${lookText(before.look.target)}; parent remained ${state.parent}.` });
    });
  });

  test('CMP-176 - Reactivate Existing Component', componentScenario('Setting Is Active = Yes on the component deactivated by CMP-175 should save; after a refresh Section B should show Is Active Yes, the tree should show the component in normal active text without the (Inactive) label, and it should stay under the same parent.'), async () => {
    test.setTimeout(8 * 60_000);
    const target = await readActivationTarget();
    test.skip(!target, 'NOT EXECUTED: CMP-175 did not persist an inactive existing Component for CMP-176 to reactivate.');
    const steps = {
      open: { title: `Open inactive Component ${target!.code} and record its parent and tree appearance`, expected: `Component ${label(target!)}, deactivated by CMP-175, should open in Vessel ${vessel} with Is Active No and the (Inactive) label in the tree under original parent ${target!.originalParent}.` },
      set: setStep(target!, 'Yes'),
      save: { title: saveTitle, expected: `The application should save ${label(target!)} as active.` },
      refresh: { title: `Refresh Components and reopen Component ${target!.code}`, expected: `After a refresh, ${label(target!)} should show Is Active Yes and be drawn in normal tree text.` },
      verify: { title: `Verify Component ${target!.code} is active, shown normally without (Inactive), under the same parent`, expected: `${label(target!)} should be active, drawn like other active components without the (Inactive) label, and remain under original parent ${target!.originalParent}.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    let reactivated = false;
    let observedInactive = false;
    try {
      await plan.run(async () => {
        const before = await run(plan, steps.open, async () => ({ identity: await openComponent(target!), parent: await readParent(), active: await readActive(), look: await readTreeLook(target!.code) }),
          (state) => `Component ${state.identity.code} (${state.identity.name}) opened in Vessel ${state.identity.vesselName} under parent ${state.parent} with Is Active ${state.active}; the tree showed ${lookText(state.look.target)}.`);
        if (before.active !== 'No') {
          await notExecuted(plan, [steps.set, steps.save, steps.refresh, steps.verify], `CMP-175 did not leave ${label(target!)} inactive (it was not deactivated, or it was restored to its original active state after CMP-175 failed); it showed Is Active ${before.active}, so there was no inactive component to reactivate.`);
        }
        observedInactive = true;
        pendingReactivation = target!;
        const changed = await run(plan, steps.set, () => setIsActive(target!, 'Yes'), setActual);
        const attempt = { outcome: await save(plan, changed.form, steps.save.expected) };
        const after = await run(plan, steps.refresh, async () => {
          await refresh();
          const identity = await openComponent(target!);
          return { identity, active: await readActive(), parent: await readParent(), look: await readTreeLook(target!.code) };
        }, (state) => `After refresh, ${state.identity.code} (${state.identity.name}) showed Is Active ${state.active} under parent ${state.parent}; the tree showed ${lookText(state.look.target)}; another active row showed ${lookText(state.look.reference)}.`);
        reactivated = after.active === 'Yes';
        if (reactivated) await clearActivationTarget();
        plan.begin(steps.verify.title);
        await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
          const problems = [
            ...(!attempt.outcome.succeeded ? [`Save did not succeed: "${attempt.outcome.feedback}"`] : []),
            ...(after.active !== 'Yes' ? [`Section B showed Is Active ${after.active}`] : []),
            ...activeLookProblems(after.look),
            ...(before.parent !== target!.originalParent ? [`CMP-176 opened the component under ${before.parent} instead of its original parent ${target!.originalParent}`] : []),
            ...(after.parent !== target!.originalParent ? [`the parent changed from ${target!.originalParent} to ${after.parent}`] : []),
          ];
          expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
          return after;
        }, { actual: (state) => `Component ${label(target!)} was reactivated with Is Active ${state.active}; the tree showed ${lookText(state.look.target)} without the (Inactive) label, matching active row ${lookText(state.look.reference)}; parent remained ${state.parent}.` });
      });
    } finally {
      // An existing business component is never left inactive when the reactivation did not complete.
      if (observedInactive && !reactivated) {
        await restoreActive(target!, 'because the reactivation did not complete')
          .then(clearActivationTarget)
          .catch(() => undefined);
      }
    }
  });

  test('CMP-177 - Cancel Delete Confirmation', componentScenario('Choosing Cancel in the delete confirmation of an existing component should close it without deleting, and after a refresh the component should be unchanged with the same status and parent.'), async () => {
    test.setTimeout(5 * 60_000);
    fixtures = { ...(await readFixtures()), ...fixtures };
    const reused = fixtures.existing;
    const target = reused ?? await selectActivationTarget();
    const reuse = reused ? 'the same component used by CMP-175 and CMP-176' : 'an existing active component selected from the tree; Cancel never deletes it';
    const steps = {
      open: { title: `Open Component ${target.code} and record its status and parent`, expected: `Component ${label(target)}, ${reuse}, should open in Vessel ${vessel}.` },
      click: { title: `Click Delete for Component ${target.code}`, expected: `The application should ask for confirmation before deleting ${label(target)}.` },
      cancel: { title: 'Click Cancel in the delete confirmation', expected: 'The confirmation should close and no deletion should be sent.' },
      refresh: { title: `Refresh Components and reopen Component ${target.code}`, expected: `After a refresh, ${label(target)} should still exist with the same name, Is Active status and parent.` },
      verify: { title: `Verify Component ${target.code} was not deleted or changed`, expected: `${label(target)} should remain in Vessel ${vessel} unchanged after cancelling the deletion.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const before = await run(plan, steps.open, async () => ({ identity: await openComponent(target), active: await readActive(), parent: await readParent() }),
        (state) => `Component ${state.identity.code} (${state.identity.name}) opened in Vessel ${state.identity.vesselName} with Is Active ${state.active} under parent ${state.parent}.`);
      const clicked = await run(plan, steps.click, clickDelete, clickedText);
      if (clicked.kind !== 'confirmation') throw new Error(`Observed Application Result: clicking Delete did not show a deletion confirmation${clicked.text ? `; it showed "${clicked.text}"` : ''}.`);
      const deletes: string[] = [];
      const listener = (request: Request) => { if (request.method() === 'DELETE') deletes.push(request.url()); };
      page.on('request', listener);
      try {
        await run(plan, steps.cancel, () => closeDialog(confirmationDialog(), 'Cancel'), () => 'Cancel was clicked and the confirmation closed.');
        const after = await run(plan, steps.refresh, async () => {
          await refresh();
          return { identity: await openComponent(target), active: await readActive(), parent: await readParent() };
        }, (state) => `After refresh, ${state.identity.code} (${state.identity.name}) was still present in Vessel ${state.identity.vesselName} with Is Active ${state.active} under parent ${state.parent}.`);
        plan.begin(steps.verify.title);
        await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
          const problems = [
            ...(deletes.length ? ['a deletion request was sent after Cancel'] : []),
            ...(after.active !== before.active ? [`Is Active changed from ${before.active} to ${after.active}`] : []),
            ...(after.parent !== before.parent ? [`the parent changed from ${before.parent} to ${after.parent}`] : []),
          ];
          expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
          return after;
        }, { actual: (state) => `After Cancel no deletion was sent; ${state.identity.code} (${state.identity.name}) remained in Vessel ${state.identity.vesselName} with Is Active ${state.active} under parent ${state.parent}.` });
      } finally {
        page.off('request', listener);
      }
    });
  });

  // ---------- New test components: delete clean leaf, delete with stamp ----------

  const newComponent = (testCaseId: string): Target => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    return { code: `ATLC${testCaseId.slice(4)}-${suffix}`, name: `${testCaseId} automation leaf ${suffix}` };
  };

  const creationSteps = (parent: Inspection, created: Target) => ({
    parent: { title: `Open existing parent Component ${parent.code}`, expected: `Parent ${label(parent)} should open active in Vessel ${vessel}.` },
    add: { title: `Open Add Component under ${parent.code}`, expected: `The Add Component form should open with Parent Component Code ${parent.code}.` },
    fill: { title: `Enter required Add Component values for ${created.code} for the primary automation user in Vessel ${vessel}`, expected: `The Add form should hold Code ${created.code}, Name "${created.name}", Parent ${parent.code}, Is Parent No and Is Active Yes.` },
    ready: { title: `Confirm the Add form for ${created.code} finished loading with the entered values`, expected: 'The Add form should keep every entered value after it finishes loading, with Save enabled.' },
    save: { title: `Click Save for Component ${created.code} (${created.name})`, expected: `The application should save Component ${created.code} once and return a successful response.` },
    exists: { title: `Refresh and confirm new Component ${created.code} exists under ${parent.code}`, expected: `After a refresh, ${label(created)} should open in Vessel ${vessel} with Parent Component Code ${parent.code} and Is Active Yes.` },
  });

  /** Creates one automation-owned child component and tracks it as soon as Save succeeds. */
  const createChild = async (plan: ScenarioPlan, steps: ReturnType<typeof creationSteps>, parent: Inspection, created: Target, testCaseId: string) => {
    const parentBefore = await run(plan, steps.parent, async () => ({ identity: await openComponent(parent), active: await readActive() }),
      (state) => `Parent ${state.identity.code} (${state.identity.name}) opened in Vessel ${state.identity.vesselName} with Is Active ${state.active}.`);
    const form = await run(plan, steps.add, async () => {
      const opened = await components.openComponentForAdd();
      await opened.expectAddContext(parent.code);
      return opened;
    }, () => `The Add Component form opened with Parent Component Code ${parent.code}.`);
    const required = { parentCode: parent.code, code: created.code, name: created.name, category: 'Ship General', department: config.componentDepartment, isParent: 'No' as const, isActive: 'Yes' as const };
    plan.begin(steps.fill.title);
    await form.fillRequired({ ...required, actorLabel: 'the primary automation user' });
    await run(plan, steps.ready, () => form.expectReadyForConcurrentSave(required),
      () => `The Add form kept Code ${created.code}, Name "${created.name}", Parent ${parent.code}, Category ${required.category}, Department ${required.department}, Is Parent No and Is Active Yes, with Save enabled.`);
    plan.begin(steps.save.title);
    try {
      await form.saveValid();
    } finally {
      // A successful response creates the component even if a later check fails, so it is tracked at once.
      if (await form.successMessageVisible().catch(() => false)) {
        await trackCreatedComponent({ ...created, vessel, parentCode: parent.code, sourceSpec, testCaseId, runId, createdAt: new Date().toISOString() });
      }
    }
    await run(plan, steps.exists, async () => {
      await refresh();
      const identity = await openComponent(created);
      const state = { identity, parentCode: await readParent(), active: await readActive() };
      expect(state.parentCode, `Observed Application Result: new Component ${created.code} showed Parent Component Code ${state.parentCode} instead of ${parent.code}.`).toBe(parent.code);
      return state;
    }, (state) => `After refresh, ${state.identity.code} (${state.identity.name}) opened in Vessel ${state.identity.vesselName} with Parent Component Code ${state.parentCode} and Is Active ${state.active}.`);
    return parentBefore;
  };

  const deletionSteps = (parent: Inspection, created: Target) => ({
    click: { title: `Click Delete for new Component ${created.code}`, expected: `The application should ask for confirmation before deleting ${label(created)}.` },
    confirm: { title: `Confirm deletion of new Component ${created.code} only`, expected: `The application should delete ${label(created)} and show success feedback.` },
    removed: { title: `Refresh and confirm Component ${created.code} is removed from normal views`, expected: `After a refresh, ${label(created)} should no longer appear in the Vessel ${vessel} component tree.` },
    parentAfter: { title: `Reopen parent Component ${parent.code} and confirm it is unchanged`, expected: `Parent ${label(parent)} should still exist in Vessel ${vessel} with the same name and Is Active status.` },
  });

  /** Deletes only the given newly created, tracked component, then rechecks its parent. */
  const deleteCreated = async (plan: ScenarioPlan, steps: ReturnType<typeof deletionSteps>, parent: Inspection, created: Target, testCaseId: string) => {
    await run(plan, steps.click, async () => {
      await refresh();
      await openComponent(created);
      const observed = await clickDelete();
      expect(observed.kind, `Observed Application Result: clicking Delete for ${created.code} did not show a deletion confirmation${observed.text ? `; it showed "${observed.text}"` : ''}.`).toBe('confirmation');
      return observed;
    }, clickedText);
    const result = await run(plan, steps.confirm, async () => {
      const outcome = await confirmDelete();
      if (outcome.deleted) await updateTrackedComponentCleanup(created.code, vessel, 'deleted', `Deleted by ${sourceSpec} ${testCaseId}: ${outcome.message}`);
      expect(outcome.deleted, `Observed Application Result: the deletion of ${created.code} was refused${outcome.status ? ` (HTTP ${outcome.status})` : ''} with "${outcome.message}".`).toBe(true);
      return outcome;
    }, (outcome) => `The application deleted ${label(created)} (HTTP ${outcome.status}) with "${outcome.message}".`);
    const neutral = await run(plan, steps.removed, async () => {
      await refresh();
      return components.expectDeletedComponentUnavailable(created.code, vessel);
    }, (shown) => `After refresh, the Vessel ${vessel} tree no longer listed ${created.code}; the details panel showed "${shown}".`);
    const parentAfter = await run(plan, steps.parentAfter, async () => ({ identity: await openComponent(parent), active: await readActive() }),
      (state) => `Parent ${state.identity.code} (${state.identity.name}) was still present in Vessel ${state.identity.vesselName} with Is Active ${state.active}.`);
    return { result, neutral, parentAfter };
  };

  test('CMP-178 - Delete Eligible Clean Leaf', componentScenario('A newly created test child component with no children, jobs, spares or stamp should show a deletion confirmation, be deleted after confirmation with success feedback, disappear from normal component views, and leave its existing parent unchanged.'), async () => {
    test.setTimeout(10 * 60_000);
    const parent = await fixture('creationParent');
    const created = newComponent('CMP-178');
    const create = creationSteps(parent, created);
    const remove = deletionSteps(parent, created);
    const steps = {
      ...create,
      clean: { title: `Confirm new Component ${created.code} has no children, jobs, linked spares or stamp`, expected: `${label(created)} should have no child components, no jobs, no linked spares and no installed stamp.` },
      ...remove,
      verify: { title: `Verify only new Component ${created.code} was deleted`, expected: `${label(created)} should be deleted and gone from normal views, and parent ${label(parent)} should be unchanged.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const parentBefore = await createChild(plan, create, parent, created, 'CMP-178');
      await run(plan, steps.clean, async () => {
        const state = { isParent: await readIsParent(), jobs: await readJobs(), spares: await readSpares(), stamp: await readStamp() };
        expect([state.isParent === 'No' ? '' : 'child components', state.jobs.length ? 'jobs' : '', state.spares.length ? 'linked spares' : '', state.stamp ? 'stamp' : ''].filter(Boolean),
          `Observed Application Result: new Component ${created.code} showed Is Parent ${state.isParent}, jobs ${list(state.jobs)}, linked spares ${list(state.spares)} and stamp ${state.stamp || 'none'}.`).toEqual([]);
        return state;
      }, (state) => `${label(created)} showed Is Parent ${state.isParent} with jobs ${list(state.jobs)}, linked spares ${list(state.spares)} and stamp ${state.stamp || 'none'}.`);
      const deleted = await deleteCreated(plan, remove, parent, created, 'CMP-178');
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(deleted.parentAfter.identity.name !== parentBefore.identity.name ? [`the parent name changed from ${parentBefore.identity.name} to ${deleted.parentAfter.identity.name}`] : []),
          ...(deleted.parentAfter.active !== parentBefore.active ? [`the parent Is Active changed from ${parentBefore.active} to ${deleted.parentAfter.active}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return deleted;
      }, { actual: (state) => `${label(created)} was deleted with "${state.result.message}" and no longer appears in the Vessel ${vessel} tree; parent ${label(parent)} still shows Is Active ${state.parentAfter.active}.` });
    });
  });

  test('CMP-180 - Delete Component With Installed Stamp', componentScenario('A newly created test child component holding an installed Spare stamp should be deleted after confirmation, and the Rotation Item Master List should show the stamp released and no longer linked to it, with other stamps and the existing parent unchanged.'), async () => {
    test.setTimeout(12 * 60_000);
    const parent = await fixture('creationParent');
    const created = newComponent('CMP-180');
    const create = creationSteps(parent, created);
    const remove = deletionSteps(parent, created);
    const steps = {
      masterBefore: { title: 'Read the Rotation Item Master List before installing a stamp', expected: `The Rotation Item Master List for Vessel ${vessel} should list at least one stamp with status Spare.` },
      ...create,
      edit: { title: `Click Edit for new Component ${created.code}`, expected: `The Edit Component form for ${created.code} should finish loading with its saved values.` },
      rotational: { title: 'Set Rotational Item to Yes', expected: 'Rotational Item should show Yes and the Stamp dropdown should become available.' },
      pick: { title: 'Choose a Spare stamp offered in the Stamp dropdown', expected: 'The Stamp dropdown should offer at least one stamp whose status is Spare in the Rotation Item Master List.' },
      select: { title: 'Select the Spare stamp', expected: 'The Stamp dropdown should keep the selected stamp before Save.' },
      saveStamp: create.save,
      stampSaved: { title: `Refresh and confirm the stamp is saved on Component ${created.code}`, expected: `After a refresh, ${label(created)} should show Rotational Item Yes and the selected stamp.` },
      masterInstalled: { title: 'Read the Rotation Item Master List after installing the stamp', expected: `The selected stamp should show status Installed on ${created.code}.` },
      ...remove,
      masterAfter: { title: 'Read the Rotation Item Master List after deletion', expected: `The selected stamp should no longer be installed on ${created.code}; other stamps should be unchanged.` },
      verify: { title: `Verify the stamp was released and only ${created.code} was deleted`, expected: `The stamp should be released from deleted Component ${created.code}, other stamps should be unchanged, and parent ${label(parent)} should be unchanged.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      const masterBefore = await run(plan, steps.masterBefore, readMaster, (rows) => `Rotation Item Master List: Spare ${rows.filter((row) => row.status === 'Spare').map((row) => row.stamp).join(', ') || 'none'}; ${rows.length} stamp(s) listed.`);
      const spareStamps = masterBefore.filter((row) => row.status === 'Spare').map((row) => row.stamp);
      if (!spareStamps.length) {
        await notExecuted(plan, Object.values(steps).filter((planned) => planned !== steps.masterBefore),`missing prerequisite - the Rotation Item Master List for Vessel ${vessel} lists no stamp with status Spare, so no stamp could be installed; no test component was created.`);
      }
      const parentBefore = await createChild(plan, create, parent, created, 'CMP-180');
      const form = await run(plan, steps.edit, () => openEdit(created.code), () => `The Edit Component form for ${created.code} finished loading.`);
      await run(plan, steps.rotational, () => form.setRotationalItem('Yes'),
        (state) => `Rotational Item showed "${state.rotationalItem}"; Stamp showed "${state.stamp}" and was ${state.stampDisabled ? 'disabled' : 'enabled'}.`);
      const chosen = await run(plan, steps.pick, async () => {
        const offered = await form.availableStamps();
        const eligible = offered.filter((option) => spareStamps.includes(option.value));
        expect(eligible.length, `Observed Application Result: the Stamp dropdown offered ${offered.map((option) => option.value).join(', ') || 'no stamps'}, none of them Spare in the master list (${spareStamps.join(', ')}).`).toBeGreaterThan(0);
        return { stamp: eligible[0], offered };
      }, (value) => `The dropdown offered ${value.offered.length} stamp(s); ${value.stamp.value} ("${value.stamp.text}"), Spare in the master list, was chosen.`);
      const selected = await run(plan, steps.select, () => form.selectStamp(chosen.stamp.value), (value) => `The Stamp dropdown showed "${value.label}" (stamp ${value.name}).`);
      plan.begin(steps.saveStamp.title);
      await form.saveValid();
      await run(plan, steps.stampSaved, async () => {
        await refresh();
        await openComponent(created);
        const rotation = await components.readSelectedRotationItem();
        expect(rotation.rotationalItem === 'Yes' && showsStamp(rotation.stamp, selected.name),
          `Observed Application Result: after refresh ${created.code} showed Rotational Item ${rotation.rotationalItem} and Stamp "${rotation.stamp}" instead of ${selected.name}.`).toBe(true);
        return rotation;
      }, (rotation) => `After refresh, ${label(created)} showed Rotational Item ${rotation.rotationalItem} and Stamp "${rotation.stamp}".`);
      const masterInstalled = await run(plan, steps.masterInstalled, async () => {
        const rows = await readMaster();
        const row = stampRow(rows, selected.name);
        expect(Boolean(row && /installed/i.test(row.status) && (row.installedOn.includes(created.code) || row.installedOn.includes(created.name))),
          `Observed Application Result: the Rotation Item Master List showed ${stampText(rows, selected.name)} instead of Installed on ${created.code}.`).toBe(true);
        return rows;
      }, (rows) => `Rotation Item Master List: ${stampText(rows, selected.name)}.`);
      const deleted = await deleteCreated(plan, remove, parent, created, 'CMP-180');
      const masterAfter = await run(plan, steps.masterAfter, readMaster, (rows) => `Rotation Item Master List: ${stampText(rows, selected.name)}.`);
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const row = stampRow(masterAfter, selected.name);
        const others = (rows: RotationItemRow[]) => rows.filter((item) => item.stamp !== selected.name).map((item) => `${item.stamp}:${item.status}:${item.installedOn}`).sort().join('|');
        const problems = [
          ...(!row ? [`stamp ${selected.name} was no longer listed in the Rotation Item Master List`] : []),
          ...(row && (/installed/i.test(row.status) || row.installedOn.includes(created.code) || row.installedOn.includes(created.name)) ? [`stamp ${row.stamp} still showed status ${row.status}, installed on ${row.installedOn}`] : []),
          ...(others(masterAfter) !== others(masterInstalled) ? ['other stamps changed status or installation'] : []),
          ...(deleted.parentAfter.active !== parentBefore.active ? [`the parent Is Active changed from ${parentBefore.active} to ${deleted.parentAfter.active}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return row!;
      }, { actual: (row) => `${label(created)} was deleted with "${deleted.result.message}"; the Rotation Item Master List showed ${row.stamp} status ${row.status}, installed on ${row.installedOn || 'nothing'}; other stamps and parent ${label(parent)} were unchanged.` });
    });
  });

  // ---------- Existing component dependencies ----------

  test('CMP-181 - Deactivate Parent With Active Children', componentScenario('Setting Is Active = No on a parent that has active child components should be blocked with a dependency warning, and the parent and its children should remain unchanged.'), async () => {
    test.setTimeout(10 * 60_000);
    await deactivationBlocked(await fixture('parent'), childDependents, 'active child components');
  });

  test('CMP-182 - Delete Parent With Active Children', componentScenario('Deleting a parent that has active child components should be blocked, and after a refresh the parent-child relationships should be intact.'), async () => {
    test.setTimeout(8 * 60_000);
    await deletionBlocked(await fixture('parent'), childDependents, 'active child components');
  });

  /**
   * Selects the dependency vessel and opens the component the test case names by code, recording
   * what it holds. A component that is missing, inactive or without the dependency makes the
   * scenario NOT EXECUTED with that reason; nothing is created to satisfy it.
   */
  const dependencyComponent = async (key: keyof typeof dependencyComponents): Promise<Inspection> => {
    const code = dependencyComponents[key];
    const need = key === 'jobs' ? 'jobs' : 'linked spare parts';
    const selectTitle = `Select Vessel ${dependencyVessel}`;
    await componentActionStep(selectTitle, `Vessel ${dependencyVessel} should be selected and its component register should finish loading.`, async () => {
      currentVessel = dependencyVessel;
      await components.clearComponentSearch();
      await components.selectVessel(dependencyVessel);
      await components.expectTreeLoaded();
    }, () => `Vessel ${dependencyVessel} was selected and its component register finished loading.`, { page });
    const title = `Search Component ${code} and record its status, child components, jobs and linked spare parts`;
    const expected = `Component ${code} should open active in Vessel ${dependencyVessel} with its ${need} listed.`;
    const item = await componentActionStep(title, expected, async () => {
      const identity = await components.searchAndSelectComponentByCode(code);
      const found: Inspection = { code: identity.code, name: identity.name, vesselName: identity.vesselName, depth: 0, topLevel: '', active: await optional(readActive), isParent: await optional(readIsParent), children: [] };
      if (identity.code === code && found.isParent !== 'No') {
        if (await components.treeComponentExpansionState(code) === 'collapsed') await components.expandTreeComponent(code);
        const children = childRows((await components.readTreeRowsWithCoverage()).rows, code);
        found.children = children.map((child) => child.code);
        found.activeChildren = children.filter((child) => !inactiveRow(child)).map((child) => child.code);
      }
      return withJobsAndSpares(found);
    }, (found) => `Component ${label(found)} opened in Vessel ${found.vesselName}: ${describe(found)}.`, { page });
    const problems = [
      ...(item.code !== code || item.vesselName !== dependencyVessel ? [`the search for ${code} opened ${label(item)} in Vessel ${item.vesselName}`] : []),
      ...(item.active !== 'Yes' ? [`${code} showed Is Active ${item.active ?? 'unreadable'}`] : []),
      ...(!(key === 'jobs' ? item.jobs : item.spares)?.length ? [`${code} showed no ${need}`] : []),
    ];
    if (problems.length) {
      const reason = `missing prerequisite - the test needs Component ${code} of Vessel ${dependencyVessel} active with ${need}, but ${problems.join(' and ')}. No data was changed.`;
      await componentNotExecutedStep(`Run the scenario on Component ${code}`, `Component ${code} should be an active component with ${need}.`, reason);
      test.skip(true, `NOT EXECUTED: ${reason}`);
    }
    return item;
  };

  test('CMP-183 - Deactivate Component With Active Jobs', componentScenario(`Setting Is Active = No on Component ${dependencyComponents.jobs} of Vessel ${dependencyVessel}, which has active jobs, should be blocked with a deactivation message, and after a refresh the component should still be active with the same jobs.`), async () => {
    test.setTimeout(8 * 60_000);
    await deactivationBlocked(await dependencyComponent('jobs'), jobDependents, 'active jobs', { byCode: true });
  });

  test('CMP-184 - Delete Component With Active Jobs', componentScenario(`Clicking Delete for Component ${dependencyComponents.jobs} of Vessel ${dependencyVessel}, which has active jobs, should open the Delete Component confirmation; confirming it with its Delete button should be refused with Component Deletion Blocked naming the linked active jobs, and after a refresh the component should still exist with the same jobs.`), async () => {
    test.setTimeout(8 * 60_000);
    await confirmedDeletionBlocked(await dependencyComponent('jobs'), jobDependents, 'active jobs');
  });

  test('CMP-185 - Deactivate Component With Linked Spares', componentScenario(`Setting Is Active = No on Component ${dependencyComponents.spares} of Vessel ${dependencyVessel}, which has linked spare parts, should be blocked with a message naming the linked active spares, and after a refresh the component should still be active with the same spare links.`), async () => {
    test.setTimeout(8 * 60_000);
    await deactivationBlocked(await dependencyComponent('spares'), spareDependents, 'linked spare parts', { byCode: true, specificMessage: true });
  });

  test('CMP-186 - Delete Component With Linked Spares', componentScenario(`Clicking Delete for Component ${dependencyComponents.spares} of Vessel ${dependencyVessel}, which has linked spare parts, should open the Delete Component confirmation; confirming it with its Delete button should be refused with Component Deletion Blocked naming the linked active spares, and after a refresh the component and its spare links should be unchanged.`), async () => {
    test.setTimeout(8 * 60_000);
    await confirmedDeletionBlocked(await dependencyComponent('spares'), spareDependents, 'linked spare parts');
  });
});
