import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ComponentsPage, type GeneratedWorkOrderResult } from '../../pages/ComponentsPage';
import { WorkOrderPage } from '../../pages/WorkOrderPage';
import { routes } from '../../utils/routes';
import { componentActionStep, componentScenario, componentValidationStep, attachFailureScreenshot } from '../../utils/componentValidationEvidence';
import { readTrackedComponents, trackCreatedComponent } from '../../utils/componentCreationTracker';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { readAppNotification } from '../../utils/appNotification';
import { recordMissingTreePrerequisite, searchComponentTree } from '../../utils/componentTreeSearch';
import type { ComponentJobRow } from '../../pages/ComponentsPage';

const step = (title: string, expected: string, actual: string) => `${title}\nExpected: ${expected}\nActual: ${actual}`;
const describeJobs = (code: string) => ({ jobs, emptyMessage }: { jobs: ComponentJobRow[]; emptyMessage: string }) => (jobs.length
  ? `Component ${code} displayed ${jobs.length} job(s): ${jobs.map((job) => `${job.jobCode} (${job.jobTitle})`).join(', ')}.`
  : `Component ${code} displayed no jobs${emptyMessage ? `; the section showed "${emptyMessage}"` : ''}.`);

const vessel = config.vesselName;
const parentCode = '8';
const runId = `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
const token = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const cmp124 = { code: `AT124-${token}`, name: `CMP124 Jobs ${token}` };
const job124 = { jobCode: `ATJ124-${token}`, jobTitle: `CMP124 Linked Job ${token}` };
const cmp125 = { code: `AT125-${token}`, name: `CMP125 Save Add Job ${token}` };
const noJobsMessage = 'No jobs found for this component';
/** The CMP-125 job code and title are derived from its component's run token, so dependants can find them. */
const cmp125JobFor = (componentCode: string) => {
  const suffix = componentCode.replace(/^AT125-/, '');
  return { jobCode: `ATJ125-${suffix}`, jobTitle: `CMP125 Linked Job ${suffix}` };
};
const job125 = cmp125JobFor(cmp125.code);
const job128 = { jobCode: `ATJ128-${token}`, jobTitle: `CMP128 Delete Job ${token}` };
const job131 = { jobCode: `ATJ131-${token}`, jobTitle: `CMP131 Duplicate WO ${token}` };
const latestCmp125 = async () => (await readTrackedComponents())
  .filter((item) => item.vessel === vessel && item.testCaseId === 'CMP-125' && item.cleanupStatus === 'pending')
  .at(-1);

test.describe('CMP-122 to CMP-132 - Linked Jobs and Work Orders', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;

  test.beforeAll(async ({ browser }) => {
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
  });

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    await restoreComponentsPage(page, components, vessel);
  });

  test.afterAll(async () => context?.close());

  /**
   * An intermediate business check shown as its own numbered report step with
   * evidence. componentValidationStep is reserved for each scenario's single
   * final validation, which the reporter presents as the scenario result.
   */
  const checkStep = <T>(title: string, expected: string, body: () => Promise<T>, options: { actual: (value: T) => string }) =>
    componentActionStep(title, expected, body, options.actual, { page });

  const generateCmp131WorkOrder = async (jobCode: string): Promise<GeneratedWorkOrderResult> => {
    let generate = await components.generateWorkOrderButton(jobCode);
    if (!(await generate.isVisible().catch(() => false))) {
      const shown = await components.showAllLinkedJobs();
      const viewport = shown.list.locator('.ag-center-cols-viewport').first();
      if (await viewport.count()) await viewport.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
      generate = shown.list.getByTestId(`btn-generate-wo-${jobCode}`).filter({ visible: true });
    }
    await expect(generate, `Job ${jobCode} should expose Generate WO in the Action column`).toBeVisible();
    await generate.click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Generate Work Order' }).filter({ visible: true }).last();
    await expect(dialog).toBeVisible();
    const reason = dialog.getByRole('button', { name: 'Planning - Scheduled ahead of time', exact: true });
    await expect(reason).toBeVisible();
    const responsePromise = page.waitForResponse((response) =>
      /\/technical\/api\/jobs\/[^/]+\/generate-wo(?:\?|$)/i.test(response.url()) && response.request().method() === 'POST');
    await reason.click();
    const confirm = page.getByRole('dialog').filter({ visible: true }).last()
      .getByRole('button', { name: /^(confirm|generate|yes|ok|submit)\b/i });
    const needsConfirmation = await Promise.race([
      responsePromise.then(() => false),
      confirm.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false),
    ]);
    if (needsConfirmation) await confirm.click();
    const response = await responsePromise;
    const responseBody = await response.text().catch(() => '');
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(responseBody) as Record<string, unknown>; } catch { /* diagnostics retain responseBody */ }
    const text = (keys: string[]) => keys.map((key) => payload[key]).find((value) => typeof value === 'string') as string | undefined;
    const feedback = await readAppNotification(page) || text(['message', 'error']) || `The application returned HTTP ${response.status()}.`;
    return {
      jobCode,
      reason: 'Planning - Scheduled ahead of time',
      httpStatus: response.status(),
      feedback,
      responseBody,
      workOrderNumber: text(['workOrderNumber', 'work_order_number', 'woNumber', 'wo_number'])
        ?? feedback.match(/Work order\s+([^\s]+?)(?:\s+has\b|[.,]|$)/i)?.[1]
        ?? '',
      status: text(['status', 'workOrderStatus']) ?? '',
    };
  };

  test('CMP-122 - View linked jobs', componentScenario(
    'At least one existing component should display a linked job with a visible Job Code and Job Title in D. Jobs.'), async () => {
    test.setTimeout(30 * 60_000);
    const condition = 'at least one linked job with a Job Code and Job Title is displayed in Section D – Jobs';
    const search = await searchComponentTree(page, components, async (visit) => {
      // Top-level groups (1 Ship General, 2 Hull, …) are opened to reach their
      // children; the Jobs check starts at their child components.
      if (visit.depth === 0) return undefined;
      const { jobs } = await components.readLoadedLinkedJobs();
      return jobs.find((job) => job.jobCode && job.jobTitle);
    });
    if (!search.match) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, condition);
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }
    const { visit, result: job } = search.match;

    await checkStep(`Select component ${visit.code}`, `Component ${visit.code} should be selected from the component tree.`,
      () => components.readSelectedComponentIdentity(),
      { actual: (identity) => `Component ${identity.code} (${identity.name}) was selected.` });
    await checkStep('Open D. Jobs', 'The selected component should display its linked jobs.',
      () => components.readLoadedLinkedJobs(),
      { actual: describeJobs(visit.code) });

    await componentValidationStep(page, step(
      `Verify linked Job ${job.jobCode}`,
      `Job Code ${job.jobCode} and Job Title "${job.jobTitle}" should be displayed in D. Jobs.`,
      'Recorded after the validation completes.',
    ), async () => {
      const identity = await components.readSelectedComponentIdentity();
      expect(identity.code).toBe(visit.code);
      expect(identity.name).toBe(visit.identity.name);
      const { jobs } = await components.readLoadedLinkedJobs();
      expect(jobs.filter((item) => item.jobCode === job.jobCode && item.jobTitle === job.jobTitle)).toHaveLength(1);
      return identity;
    }, { actual: (identity) => `Component Details showed ${identity.code} (${identity.name}) in ${identity.vesselName}, and Section D – Jobs listed Job Code ${job.jobCode} with Job Title "${job.jobTitle}" once.` });
  });

  test('CMP-123 - Component with no jobs', componentScenario(
    `A component without linked jobs should display "${noJobsMessage}" in D. Jobs.`), async () => {
    test.setTimeout(30 * 60_000);
    const condition = `Section D – Jobs displays "${noJobsMessage}"`;
    const search = await searchComponentTree(page, components, async (visit) => {
      if (visit.depth === 0) return undefined;
      const state = await components.readLoadedLinkedJobs();
      return state.emptyMessage === noJobsMessage ? state : undefined;
    });
    if (!search.match) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, condition);
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }
    const { visit } = search.match;
    await checkStep(`Select component ${visit.code}`, `Component ${visit.code} should be selected from the component tree.`,
      () => components.readSelectedComponentIdentity(),
      { actual: (identity) => `Component ${identity.code} (${identity.name}) was selected.` });
    await checkStep('Open D. Jobs', `D. Jobs should display "${noJobsMessage}".`,
      () => components.readLoadedLinkedJobs(),
      { actual: (state) => `D. Jobs displayed "${state.emptyMessage}".` });
    await componentValidationStep(page, step(
      `Verify no jobs are linked to component ${visit.code}`,
      `While Component ${visit.code} (${visit.identity.name}) is selected, D. Jobs should show "${noJobsMessage}" and no job rows.`,
      'Recorded after the validation completes.',
    ), async () => {
      const identity = await components.readSelectedComponentIdentity();
      expect(identity.code).toBe(visit.code);
      const state = await components.readLoadedLinkedJobs();
      expect(state.jobs).toEqual([]);
      expect(state.emptyMessage).toBe(noJobsMessage);
      await test.info().attach(`D. Jobs section — Component ${visit.code}`, { body: await components.linkedJobsSectionScreenshot(), contentType: 'image/png' });
      return { identity, message: state.emptyMessage };
    }, { actual: ({ identity, message }) => `Component ${identity.code} (${identity.name}) in ${identity.vesselName} showed no job rows, and D. Jobs displayed "${message}".` });
  });

  test('CMP-124 - Add a job to a new automation component', componentScenario(
    'A valid automation job should save and remain linked to the intended automation component in AUTO_VESSEL_002 after refresh.'), async () => {
    await components.searchAndSelectComponentByCode(parentCode);
    const form = await components.openComponentForAdd();
    await form.fillRequired({ parentCode, code: cmp124.code, name: cmp124.name, category: 'Ship Common Systems', department: config.componentDepartment, isParent: 'No', isActive: 'Yes' });
    await form.saveValid();
    await trackCreatedComponent({ ...cmp124, vessel, parentCode, sourceSpec: 'components-linked-jobs-work-orders.spec.ts', testCaseId: 'CMP-124', runId, createdAt: new Date().toISOString() });
    await components.selectVessel(vessel);
    await components.searchAndSelectComponentByCode(cmp124.code);
    const jobForm = await components.openAddJob();
    await jobForm.expectContext(cmp124);
    await componentActionStep(`Create Job ${job124.jobCode}`, `A valid job should save under Component ${cmp124.code}.`,
      async () => { await jobForm.fillRequired({ ...job124, description: `Automation-owned job for CMP-124 ${token}` }); return jobForm.create(); },
      ({ identity, feedback }) => `Job ${identity.jobCode} (${identity.jobTitle}) was submitted for Component ${identity.componentCode}; the application showed "${feedback}".`, { page });
    await restoreComponentsPage(page, components, vessel);
    await components.searchAndSelectComponentByCode(cmp124.code);
    await componentValidationStep(page, `Refresh and verify Job ${job124.jobCode} under Component ${cmp124.code}\nExpected: The saved job should appear once under the correct component and vessel.\nActual: Recorded after the validation completes.`, async () => {
      const jobs = await components.readLinkedJobs();
      expect(jobs.filter((job) => job.jobCode === job124.jobCode)).toHaveLength(1);
      return jobs.find((job) => job.jobCode === job124.jobCode)!;
    }, { actual: (job) => `Job ${job.jobCode} (${job.jobTitle}) appeared once under Component ${cmp124.code} in ${vessel}.` });
  });

  test('CMP-125 - Save and Add Jobs for a genuinely new component', componentScenario(
    'The new component should save first, the application should open Add Job with the new component and AUTO_VESSEL_002 context, and the saved job should remain linked to it after refresh.'), async () => {
    const existing = await latestCmp125();
    if (existing) {
      const expectedJob = cmp125JobFor(existing.code);
      const reusable = await checkStep(
        `Check component ${existing.code} for Job ${expectedJob.jobCode}`,
        `If Component ${existing.code} already shows Job ${expectedJob.jobCode}, reuse it instead of creating a duplicate.`,
      async () => {
        const identity = await components.searchAndSelectComponentByCode(existing.code);
        const { jobs } = await components.readAllLinkedJobs();
        return { identity, job: jobs.find((job) => job.jobCode === expectedJob.jobCode) };
      }, {
        actual: ({ identity, job }) => (job
          ? `Component ${identity.code} (${identity.name}) in ${identity.vesselName} already shows Job ${job.jobCode} (${job.jobTitle}); it is reused.`
          : `Component ${identity.code} (${identity.name}) does not show Job ${expectedJob.jobCode}, so a new component and job are required.`),
      });
      if (reusable.job) {
        test.skip(true, `SKIPPED — existing Component ${existing.code} and Job ${reusable.job.jobCode} were verified and reused; no duplicate was created.`);
        return;
      }
      await restoreComponentsPage(page, components, vessel);
    }
    await components.searchAndSelectComponentByCode(parentCode);
    const form = await components.openComponentForAdd();
    await form.fillRequired({
      parentCode,
      code: cmp125.code,
      name: cmp125.name,
      category: 'Ship Common Systems',
      department: config.componentDepartment,
      isParent: 'No',
      isActive: 'Yes',
    });
    const saved = await componentActionStep(
      `Save component ${cmp125.code} and open Add Job`,
      `The application should save ${cmp125.code} in ${vessel} before opening Add Job.`,
      () => form.saveAndOpenAddJob(),
      (value) => `The visible "${value.actionLabel}" action saved Component ${value.componentCode} (${value.componentName}) in ${value.vessel} and opened Add Job.`,
      { page },
    );
    await trackCreatedComponent({ ...cmp125, vessel, parentCode, sourceSpec: 'components-linked-jobs-work-orders.spec.ts', testCaseId: 'CMP-125', runId, createdAt: new Date().toISOString() });
    await checkStep(`Verify Add Job opened for component ${cmp125.code}`, `Add Job should identify Component ${cmp125.code} and Vessel ${vessel}.`, async () => {
      await saved.jobForm.expectContext(cmp125);
      return saved;
    }, { actual: () => `The component was saved from the ${vessel} Add Component form, and Job Form displayed Component ${cmp125.code} (${cmp125.name}) as its context.` });
    await componentActionStep(`Create Job ${job125.jobCode}`, `A valid job should save under Component ${cmp125.code}.`,
      async () => { await saved.jobForm.fillRequired({ ...job125, description: `Automation-owned job for CMP-125 ${token}` }); return saved.jobForm.create(); },
      ({ identity, feedback }) => `Job ${identity.jobCode} (${identity.jobTitle}) was submitted for Component ${identity.componentCode}; the application showed "${feedback}".`, { page });
    await restoreComponentsPage(page, components, vessel);
    await componentValidationStep(page, step(
      `Refresh and verify Job ${job125.jobCode} under Component ${cmp125.code}`,
      `After refresh, Job ${job125.jobCode} (${job125.jobTitle}) should appear once under Component ${cmp125.code} in ${vessel}.`,
      'Recorded after the validation completes.',
    ), async () => {
      const identity = await components.searchAndSelectComponentByCode(cmp125.code);
      const { jobs } = await components.readAllLinkedJobs();
      expect(jobs.filter((job) => job.jobCode === job125.jobCode && job.jobTitle === job125.jobTitle)).toHaveLength(1);
      return identity;
    }, { actual: (identity) => `After refresh, Component ${identity.code} (${identity.name}) in ${identity.vesselName} listed Job ${job125.jobCode} (${job125.jobTitle}) once.` });
  });

  /**
   * Opens the latest tracked CMP-125 component and reads its jobs. When no
   * tracked CMP-125 component exists, records the missing prerequisite and
   * stops the dependent scenario as NOT EXECUTED.
   */
  const openCmp125Component = async () => {
    const tracked = await latestCmp125();
    if (!tracked) {
      await test.step(`${step('Locate an automation-created component', `An automation-created component should exist in ${vessel}.`, `No suitable automation-created component is available in ${vessel}.`)}\nStatus: NOT RUN`, async () => {});
      test.skip(true, `NOT EXECUTED: no suitable automation-created component exists in ${vessel}.`);
      throw new Error('unreachable');
    }
    const expectedJob = cmp125JobFor(tracked.code);
    const identity = await checkStep(
      `Select component ${tracked.code}`,
      `Component ${tracked.code} (${tracked.name}) should be selected.`,
      () => components.searchAndSelectComponentByCode(tracked.code),
      { actual: (selected) => `Component ${selected.code} (${selected.name}) was selected.` });
    const opened = await checkStep(
      'Open D. Jobs and locate the existing job',
      `D. Jobs should display the linked jobs for Component ${tracked.code}.`,
    async () => {
      expect(identity.code).toBe(tracked.code);
      expect(identity.vesselName).toBe(vessel);
      const { jobs } = await components.readAllLinkedJobs();
      return { identity, jobs };
    }, { actual: ({ identity: selected, jobs }) => describeJobs(selected.code)({ jobs, emptyMessage: jobs.length ? '' : noJobsMessage }) });
    return { tracked, expectedJob, ...opened, job: opened.jobs.find((job) => job.jobCode === expectedJob.jobCode) };
  };

  test('CMP-126 - Generate Work Order and verify actual status', componentScenario(
    'An existing automation job should show a Generate WO action that creates a work order linked to the selected job and component and remains available after refresh.'), async () => {
    test.setTimeout(10 * 60_000);
    const { identity, expectedJob, job } = await openCmp125Component();
    if (!job) {
      await test.step(`${step(`Locate Job ${expectedJob.jobCode}`, `Job ${expectedJob.jobCode} (${expectedJob.jobTitle}) should be listed under Component ${identity.code}.`, `Job ${expectedJob.jobCode} was not listed under Component ${identity.code}; no work order was generated and no status was assumed.`)}\nStatus: NOT RUN`, async () => {});
      test.skip(true, `NOT EXECUTED: Job ${expectedJob.jobCode} was not listed under Component ${identity.code}.`);
      return;
    }

    await checkStep(
      `Locate Generate WO for Job ${job.jobCode}`,
      `The Action column should show Generate WO for Job ${job.jobCode} under Component ${identity.code}.`,
    async () => {
      const button = await components.generateWorkOrderButton(job.jobCode);
      expect(
        await button.isVisible().catch(() => false),
        `Generate WO button was not visible in the Action column for Job Code ${job.jobCode} under Component ${identity.code}. Work-order generation could not be performed.`,
      ).toBe(true);
    }, { actual: () => `Generate WO was visible in the Action column for Job Code ${job.jobCode} under Component ${identity.code}.` });

    const result = await componentActionStep(
      `Click Generate WO for Job ${job.jobCode} and select a reason`,
      'A work order should be generated for the selected job.',
      () => components.generateWorkOrder(job.jobCode),
      (value) => `Generate WO was clicked and reason "${value.reason}" was selected; the application showed "${value.feedback}".`,
      { page },
    );

    await checkStep(
      `Verify the application response for Job ${job.jobCode}`,
      'The application should create a work order and report its Work Order Number and status.',
    async () => {
      expect(
        result.httpStatus >= 200 && result.httpStatus < 300,
        `Generate WO was clicked for Job Code ${job.jobCode}, but the application did not create a work order. Application message: ${result.feedback}`,
      ).toBe(true);
      expect(
        result.workOrderNumber,
        `The application showed "${result.feedback}", but no Work Order Number was returned, so work-order creation could not be verified.`,
      ).not.toBe('');
      return result;
    }, { actual: (value) => `Work Order ${value.workOrderNumber} was created with status "${value.status || 'not stated by the application'}". Application message: "${value.feedback}".` });

    await componentValidationStep(page, step(
      `Refresh and verify Work Order ${result.workOrderNumber}`,
      `After refresh, Work Order ${result.workOrderNumber} should be listed for ${vessel} and linked to Job ${job.jobCode} and Component ${identity.code}.`,
      'Recorded after the validation completes.',
    ), async () => {
      const workOrders = new WorkOrderPage(page);
      await page.goto(routes.workOrder, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await workOrders.expectToBeOnPage();
      await workOrders.selectVessel(vessel);
      const found = await workOrders.findWorkOrder(result.workOrderNumber);
      expect(found, `Work Order ${result.workOrderNumber} was not listed under any Work Orders tab for ${vessel} after refresh.`).toBeTruthy();
      let evidence = found!.rowText;
      const linked = (text: string) => ({
        job: [job.jobCode, job.jobTitle].some((value) => text.toLowerCase().includes(value.toLowerCase())),
        component: [identity.code, identity.name].some((value) => text.toLowerCase().includes(value.toLowerCase())),
      });
      let association = linked(evidence);
      if (!association.job || !association.component) {
        // The list may not show every association; read the opened work order's details.
        await page.getByRole('gridcell').filter({ hasText: result.workOrderNumber }).first().click();
        await page.waitForURL(/\/technical\/pms\/work-order\/[^/]+/, { timeout: 30_000 }).catch(() => undefined);
        evidence = await page.locator('body').innerText();
        association = linked(evidence);
      }
      expect(association.job, `Work Order ${result.workOrderNumber} did not display Job ${job.jobCode} (${job.jobTitle}).`).toBe(true);
      expect(association.component, `Work Order ${result.workOrderNumber} did not display Component ${identity.code} (${identity.name}).`).toBe(true);
      return found!;
    }, { actual: (found) => `After refresh, Work Order ${result.workOrderNumber} was listed under the "${found.tab}" tab for ${vessel}${found.values.Status ? ` with status "${found.values.Status}"` : ''}, and showed Job ${job.jobCode} and Component ${identity.code}.` });
  });

  test('CMP-127 - Show All, Expand, Collapse and Pagination', componentScenario(
    'Show All should display the complete linked job list, and Collapse should return the list to its original view.'), async () => {
    test.setTimeout(30 * 60_000);
    const condition = 'Section D – Jobs displays Show All for a component with multiple linked jobs';
    const search = await searchComponentTree(page, components, async (visit) => {
      const state = await checkStep(
      `Check D. Jobs for Show All on component ${visit.code}`,
        `Section D – Jobs should finish loading for ${visit.code} so its jobs and any Show All control can be read.`,
      async () => ({ ...(await components.readLoadedLinkedJobs()), controls: await components.readLinkedJobsControls() }), {
        actual: (observed) => `${describeJobs(visit.code)(observed)} Show All was ${observed.controls.showAll ? `displayed as "${observed.controls.showAll}"` : 'not displayed'}.`,
      });
      return state.controls.showAll ? state : undefined;
    });
    if (!search.match) {
      const reason = await recordMissingTreePrerequisite(page, search, vessel, condition);
      test.skip(true, `NOT EXECUTED: ${reason}`);
      return;
    }
    const { visit, result: initial } = search.match;
    const originalCodes = initial.jobs.map((job) => job.jobCode);

    const shown = await componentActionStep(
      `Click "${initial.controls.showAll}"`,
      `The complete linked job list of ${visit.code} should be displayed.`,
      () => components.showAllLinkedJobs(),
      (value) => `"${value.label}" was clicked; the full job list was displayed ${value.mode === 'dialog' ? 'in a Jobs dialog' : 'inside Section D – Jobs'}.`,
      { page },
    );
    const expectedTotal = Number(shown.label.match(/\((\d+)\s+jobs?\)/i)?.[1] ?? Number.NaN);
    const full = await checkStep(
      'Verify the complete job list',
      `Every linked job should be displayed once${Number.isNaN(expectedTotal) ? '' : `, matching the ${expectedTotal} job(s) stated by Show All`}, including the ${originalCodes.length} job(s) shown before Show All.`,
    async () => {
      const result = await components.readJobsAcrossPages(shown.list);
      const codes = result.jobs.map((job) => job.jobCode);
      expect(new Set(codes).size, 'Show All should not display duplicate jobs').toBe(codes.length);
      if (!Number.isNaN(expectedTotal)) expect(codes.length, 'Show All should display the stated job count').toBe(expectedTotal);
      expect(codes.length).toBeGreaterThanOrEqual(originalCodes.length);
      for (const code of originalCodes) expect(codes, `Job ${code} should remain in the full list`).toContain(code);
      return result;
    }, {
      actual: ({ jobs, pageLabels }) => `${jobs.length} unique job(s) were displayed${pageLabels.length > 1 ? ` across ${pageLabels.length} pages (${pageLabels.join('; ')})` : ''}: ${jobs.map((job) => `${job.jobCode} (${job.jobTitle})`).join(', ')}.`,
    });

    const collapseLabel = await componentActionStep(
      'Click Collapse',
      'The Jobs list should return to its original collapsed view.',
      () => components.collapseLinkedJobs(shown.scope, shown.mode),
      (label) => `"${label}" was clicked and the expanded Jobs list closed.`,
      { page },
    );
    await componentValidationStep(page, step(
      'Verify D. Jobs returned to its original view',
      `Section D – Jobs should again show the original ${originalCodes.length} job(s) (${originalCodes.join(', ')}) with "${initial.controls.showAll}" available.`,
      'Recorded after the validation completes.',
    ), async () => {
      const { jobs } = await components.readLoadedLinkedJobs();
      expect(jobs.map((job) => job.jobCode)).toEqual(originalCodes);
      const controls = await components.readLinkedJobsControls();
      expect(controls.showAll).toBe(initial.controls.showAll);
      return jobs;
    }, { actual: (jobs) => `After "${collapseLabel}", Section D – Jobs showed ${jobs.length} job(s) (${jobs.map((job) => job.jobCode).join(', ')}) and "${initial.controls.showAll}" was displayed again.` });

    if (initial.controls.expand) {
      const expanded = await componentActionStep(
        `Click "${initial.controls.expand}" in Section D – Jobs for Component ${visit.code}`,
        'The Jobs list should expand without losing or duplicating jobs.',
        () => components.expandLinkedJobs(),
        (value) => `"${value.label}" was clicked; the Jobs list was displayed ${value.mode === 'dialog' ? 'in a Jobs dialog' : 'inside Section D – Jobs'}.`,
        { page },
      );
      await checkStep(
        `Verify the expanded Jobs list for Component ${visit.code}`,
        `The expanded list should include the original job(s) ${originalCodes.join(', ')} with no duplicates.`,
      async () => {
        const { jobs } = await components.readJobsAcrossPages(expanded.list);
        const codes = jobs.map((job) => job.jobCode);
        expect(new Set(codes).size).toBe(codes.length);
        for (const code of originalCodes) expect(codes).toContain(code);
        return codes;
      }, { actual: (codes) => `The expanded list displayed ${codes.length} unique job(s): ${codes.join(', ')}.` });
    } else {
      await test.step(step('Exercise the Expand control in Section D – Jobs', 'If displayed, Expand should show the Jobs list without losing or duplicating jobs.', `NOT APPLICABLE; Section D – Jobs for Component ${visit.code} did not display an Expand control.`) + '\nStatus: NOT RUN', async () => {});
    }

    if (initial.controls.pagination) {
      await checkStep(
        `Navigate the Jobs pagination for Component ${visit.code}`,
        'Each pagination page should display jobs, with no job repeated across pages.',
      async () => {
        const result = await components.readJobsAcrossPages(await components.linkedJobsGrid());
        const codes = result.jobs.map((job) => job.jobCode);
        expect(new Set(codes).size).toBe(codes.length);
        return result;
      }, { actual: ({ jobs, pageLabels }) => `The pager showed ${pageLabels.length} page(s) (${pageLabels.join('; ')}); ${jobs.length} unique job(s) were displayed across them.` });
    } else {
      await test.step(step('Navigate the Jobs pagination', 'If a pager is displayed, every page should show its jobs without duplicates.', `NOT APPLICABLE; Section D – Jobs for Component ${visit.code} did not display pagination.`) + '\nStatus: NOT RUN', async () => {});
    }

    await test.info().attach('CMP-127 verified component', {
      body: JSON.stringify({ vessel, componentCode: visit.code, componentName: visit.identity.name, jobCount: full.jobs.length, controls: initial.controls, collapseLabel }, null, 2),
      contentType: 'application/json',
    });
  });

  test('CMP-128 - Delete a newly created linked job', componentScenario(
    'A new job created only for this scenario should be deleted and no longer appear under D. Jobs after refresh, while the other linked jobs remain unchanged.'), async () => {
    test.setTimeout(10 * 60_000);
    const { identity } = await openCmp125Component();
    const component = { code: identity.code, name: identity.name };

    const jobForm = await componentActionStep(
      `Open D. Jobs and create a new job for component ${component.code}`,
      `Add Job should open the Job Form for Component ${component.code} (${component.name}).`,
      async () => {
        const form = await components.openAddJob();
        await form.expectContext(component);
        return form;
      },
      () => `The Job Form opened with Component ${component.code} (${component.name}) as its context.`,
      { page },
    );
    await componentActionStep(`Create Job ${job128.jobCode}`, `A valid new job should save under Component ${component.code}.`,
      async () => { await jobForm.fillRequired({ ...job128, description: `Automation-owned job created for deletion by CMP-128 ${token}` }); return jobForm.create(); },
      ({ identity: saved, feedback }) => `Job ${saved.jobCode} (${saved.jobTitle}) was submitted for Component ${saved.componentCode}; the application showed "${feedback}".`, { page });

    await restoreComponentsPage(page, components, vessel);
    const otherJobs = await checkStep(
      `Refresh and verify new Job ${job128.jobCode} under Component ${component.code}`,
      `After refresh, Job ${job128.jobCode} (${job128.jobTitle}) should appear once under Component ${component.code}.`,
    async () => {
      await components.searchAndSelectComponentByCode(component.code);
      const { jobs } = await components.readAllLinkedJobs();
      expect(jobs.filter((job) => job.jobCode === job128.jobCode && job.jobTitle === job128.jobTitle)).toHaveLength(1);
      return jobs.filter((job) => job.jobCode !== job128.jobCode);
    }, { actual: (others) => `After refresh, Job ${job128.jobCode} (${job128.jobTitle}) was listed once under Component ${component.code}, alongside ${others.length} other job(s): ${others.map((job) => job.jobCode).join(', ') || 'none'}.` });

    const opened = await componentActionStep(
      `Open Job ${job128.jobCode}`,
      `The Job Form for Job ${job128.jobCode} (${job128.jobTitle}) should open.`,
      async () => {
        const form = await components.openLinkedJob(job128.jobCode);
        await form.expectOpenedJob(job128.jobCode, job128.jobTitle);
        return form;
      },
      () => `The Job Form opened and showed Job ${job128.jobCode} (${job128.jobTitle}).`,
      { page },
    );
    const deletion = await componentActionStep(
      `Delete Job ${job128.jobCode}`,
      `Deleting Job ${job128.jobCode} should be confirmed by the application.`,
      () => opened.delete(),
      (value) => `Delete was clicked${value.confirmation ? ` and the confirmation "${value.confirmation}" was accepted` : ''}; the application showed "${value.feedback}".`,
      { page },
    );
    await checkStep(
      `Confirm deletion of Job ${job128.jobCode}`,
      'The application should accept the deletion.',
    async () => {
      expect(deletion.ok, `Delete was clicked for Job ${job128.jobCode}, but the application did not accept it. Application message: ${deletion.feedback}`).toBe(true);
    }, { actual: () => `The application accepted the deletion and showed "${deletion.feedback}".` });

    await restoreComponentsPage(page, components, vessel);
    await componentValidationStep(page, step(
      `Refresh and verify Job ${job128.jobCode} is absent and other jobs are unchanged`,
      `After refresh, Job ${job128.jobCode} (${job128.jobTitle}) should not appear under Component ${component.code}, and the other ${otherJobs.length} job(s) should remain unchanged.`,
      'Recorded after the validation completes.',
    ), async () => {
      await components.searchAndSelectComponentByCode(component.code);
      const { jobs } = await components.readAllLinkedJobs();
      expect(jobs.some((job) => job.jobCode === job128.jobCode || job.jobTitle === job128.jobTitle), `Job ${job128.jobCode} was still listed after deletion and refresh.`).toBe(false);
      expect(jobs.map(({ jobCode, jobTitle }) => ({ jobCode, jobTitle })), 'The other linked jobs should remain unchanged').toEqual(otherJobs.map(({ jobCode, jobTitle }) => ({ jobCode, jobTitle })));
      return jobs;
    }, { actual: (jobs) => `After refresh, Job ${job128.jobCode} was no longer listed under Component ${component.code}; the remaining ${jobs.length} job(s) (${jobs.map((job) => job.jobCode).join(', ') || 'none'}) were unchanged.` });
  });

  test('CMP-129 - Add Job with incomplete component details', componentScenario(
    'The actual Add Job action should block an incomplete component and save neither a component nor a job.'), async () => {
    const draft = { code: `AT129-${token}`, name: `CMP129 Incomplete ${token}` };
    await components.searchAndSelectComponentByCode(parentCode);
    const form = await components.openComponentForAdd();
    await form.fillRequired({ parentCode, code: draft.code, name: '', category: 'Ship Common Systems', department: config.componentDepartment, isParent: 'No', isActive: 'Yes' });
    const result = await componentActionStep(`Try the available Add Job action with Component Name missing`,
      'The application should block the action without saving an incomplete component or opening Job Form.',
      () => form.expectAddJobBlocked('Component Name'),
      (value) => value.disabled ? `The visible "${value.action}" action was disabled; no component write succeeded.` : `The visible "${value.action}" action was blocked; ${value.feedback}`,
      { page });
    expect(result.feedback).not.toBe('');
    await form.back();
    expect(await components.exactComponentCount(draft.code)).toBe(0);
  });

  test('CMP-130 - Cancel an unsaved job', componentScenario(
    'A uniquely titled draft job should not exist after Back and refresh.'), async () => {
    const fixture = (await readTrackedComponents()).filter((item) => item.vessel === vessel && item.testCaseId === 'CMP-124' && item.cleanupStatus === 'pending').at(-1);
    expect(fixture).toBeTruthy();
    const draft = { jobCode: `ATJ130-${token}`, jobTitle: `CMP130 Cancelled Job ${token}` };
    await components.searchAndSelectComponentByCode(fixture!.code);
    const jobForm = await components.openAddJob();
    await jobForm.fillRequired({ ...draft, description: `Unsaved CMP-130 draft ${token}` });
    await componentActionStep(`Cancel draft Job ${draft.jobCode}`, 'Back should leave the Job Form without creating the draft.',
      async () => { await jobForm.cancel(); return draft; },
      (value) => `Back left Job Form without clicking Create Job for ${value.jobCode} (${value.jobTitle}).`, { page });
    await restoreComponentsPage(page, components, vessel);
    await components.searchAndSelectComponentByCode(fixture!.code);
    const jobs = await components.readLinkedJobs();
    expect(jobs.some((job) => job.jobCode === draft.jobCode || job.jobTitle === draft.jobTitle)).toBe(false);
  });

  test('CMP-131 - Prevent duplicate planned work orders', componentScenario(
    'The first planned Work Order should be created for a new automation job; a second attempt for the same job should show the duplicate warning and create no additional Work Order.'), async () => {
    test.setTimeout(10 * 60_000);
    const component = (await readTrackedComponents())
      .filter((item) => item.vessel === vessel && (item.cleanupStatus === 'pending' || item.cleanupStatus === 'failed'))
      .at(-1);
    if (!component) {
      test.skip(true, `NOT EXECUTED: no automation-created component is available in ${vessel}.`);
      return;
    }

    await checkStep(`Select component ${component.code}`, `Component ${component.code} should be selected.`,
      () => components.searchAndSelectComponentByCode(component.code),
      { actual: (identity) => `Component ${identity.code} (${identity.name}) was selected.` });
    const jobForm = await componentActionStep('Open D. Jobs and click Add Job',
      `The Job Form should open for Component ${component.code}.`,
      async () => {
        const form = await components.openAddJob();
        await form.expectContext(component);
        return form;
      }, () => `The Job Form opened for Component ${component.code} (${component.name}).`, { page });
    await componentActionStep(`Create Job ${job131.jobCode}`, `Job ${job131.jobCode} should save under Component ${component.code}.`,
      async () => {
        await jobForm.fillRequired({ ...job131, description: `Automation-owned duplicate Work Order job ${token}` });
        return jobForm.create();
      }, ({ identity, feedback }) => `Job ${identity.jobCode} (${identity.jobTitle}) was saved under Component ${identity.componentCode}. The application displayed: "${feedback}"`, { page });

    await restoreComponentsPage(page, components, vessel);
    await components.searchAndSelectComponentByCode(component.code);
    await checkStep(`Refresh and verify Job ${job131.jobCode}`, `Job ${job131.jobCode} should appear once in D. Jobs.`, async () => {
      const { jobs } = await components.readAllLinkedJobs();
      expect(jobs.filter((job) => job.jobCode === job131.jobCode && job.jobTitle === job131.jobTitle)).toHaveLength(1);
      return jobs.find((job) => job.jobCode === job131.jobCode)!;
    }, { actual: (job) => `D. Jobs displayed Job ${job.jobCode} (${job.jobTitle}) once.` });

    const first = await componentActionStep(`Generate the first planned Work Order for Job ${job131.jobCode}`,
      'Planning should create one Work Order for the selected job.',
      () => generateCmp131WorkOrder(job131.jobCode),
      (result) => `Planning was selected. The application displayed: "${result.feedback}" Work Order: ${result.workOrderNumber || 'not returned'}.`, { page });
    expect(first.httpStatus >= 200 && first.httpStatus < 300, `The first planned Work Order was not created. Application message: ${first.feedback}`).toBe(true);
    expect(first.workOrderNumber, 'The first Generate WO attempt should return a Work Order number').not.toBe('');

    await restoreComponentsPage(page, components, vessel);
    await components.searchAndSelectComponentByCode(component.code);
    const second = await componentActionStep(`Generate a second planned Work Order for Job ${job131.jobCode}`,
      'The application should prevent duplicate creation and display the planned Work Order warning.',
      () => generateCmp131WorkOrder(job131.jobCode),
      (result) => `Planning was selected again. The application displayed: "${result.feedback}"`, { page });

    const expectedMessage = 'A planned Work Order already exists for this maintenance job. Please complete the existing planned Work Order from the WO section before proceeding.';
    await checkStep('Verify the duplicate warning', `The application should display "${expectedMessage}"`, async () => {
      expect(second.feedback).toContain(expectedMessage);
      return second.feedback;
    }, { actual: (message) => `The application displayed: "${message}"` });

    await componentValidationStep(page, step(
      `Verify only one planned Work Order exists for Job ${job131.jobCode}`,
      `Work Order ${first.workOrderNumber} should remain the only planned Work Order for Job ${job131.jobCode}.`,
      'Recorded after the validation completes.',
    ), async () => {
      expect(
        second.workOrderNumber === '' || second.workOrderNumber === first.workOrderNumber,
        `The duplicate attempt should return no Work Order number or the existing number ${first.workOrderNumber}`,
      ).toBe(true);
      const workOrders = new WorkOrderPage(page);
      await page.goto(routes.workOrder, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await workOrders.expectToBeOnPage();
      await workOrders.selectVessel(vessel);
      const found = await workOrders.findWorkOrder(first.workOrderNumber);
      expect(found, `Work Order ${first.workOrderNumber} should remain available after the duplicate attempt`).toBeTruthy();
      const matchingNumbers = new Set<string>();
      const search = page.getByPlaceholder('Search work orders...');
      for (const tabName of workOrders.tabNames) {
        if (!(await workOrders.tab(tabName).first().isVisible().catch(() => false))) continue;
        if (!(await workOrders.openTab(tabName).then(() => true, () => false))) continue;
        for (const term of [job131.jobCode, job131.jobTitle]) {
          await search.fill(term);
          const rows = page.locator('[role="row"]:has([role="gridcell"])');
          for (let index = 0; index < await rows.count(); index += 1) {
            const row = rows.nth(index);
            const text = (await row.innerText()).toLowerCase();
            if (![job131.jobCode, job131.jobTitle].some((value) => text.includes(value.toLowerCase()))) continue;
            const number = (await workOrders.workOrderNumberOf(row)).trim();
            if (number) matchingNumbers.add(number);
          }
        }
      }
      expect([...matchingNumbers]).toEqual([first.workOrderNumber]);
      return { found: found!, count: matchingNumbers.size };
    }, { actual: ({ found, count }) => `Work Order ${first.workOrderNumber} remained under the "${found.tab}" tab. ${count} planned Work Order was listed for Job ${job131.jobCode}; no duplicate was created.` });
  });

  test('CMP-132 - Work order for inactive equipment or job', componentScenario(
    'The application should prevent work-order generation for a prepared inactive automation item and create no work order.'), async () => {
    test.skip(true, 'SKIPPED — deferred by user request.');
  });
});
