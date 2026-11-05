import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
  ComponentBlockedByLinkedJobsError,
  ComponentNotFoundDuringDeletionError,
  ComponentsPage,
} from '../../pages/ComponentsPage';
import { LoginPage } from '../../pages/LoginPage';
import { componentValidationStep } from '../../utils/componentValidationEvidence';
import {
  readApprovedRecoveryComponents,
  readTrackedComponents,
  removeApprovedRecoveryComponent,
  updateTrackedComponentCleanup,
  type TrackedComponent,
} from '../../utils/componentCreationTracker';
import { config } from '../../utils/config';
import { restoreComponentsPage } from '../../utils/componentsSession';
import {
  readTrackedJobs,
  trackCreatedJob,
  updateTrackedJobCleanup,
  type TrackedJob,
} from '../../utils/jobCreationTracker';

const manualCleanupRequested = process.env.MANUAL_COMPONENT_CLEANUP === 'true';
const step = (title: string, expected: string, actual: string) => `${title}\nExpected: ${expected}\nActual: ${actual}`;
const keyOf = ({ vessel, code }: Pick<TrackedComponent, 'vessel' | 'code'>) => `${vessel}\u0000${code}`;
type CleanupRecord = TrackedComponent & { source: 'tracked' | 'approved' };

test.describe('Manual Components automation cleanup', () => {
  test.skip(!manualCleanupRequested, 'Cleanup runs only when clean.spec.ts is explicitly requested.');

  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(3 * 60_000);
    context = await browser.newContext({ baseURL: config.baseUrl, viewport: null });
    page = await context.newPage();
    const login = new LoginPage(page);
    await login.open();
    components = await (await (await login.login()).goToTechnical()).goToComponents();
  });

  test.afterAll(async () => { await context?.close(); });

  test('Delete all exactly tracked automation components, including duplicates', async ({ browser }, testInfo) => {
    void browser; // Browser lifecycle is owned by beforeAll; keep Playwright's required fixture signature.
    test.setTimeout(60 * 60_000);
    const startedAt = Date.now();
    const allTracked = await readTrackedComponents();
    const trackedJobs = await readTrackedJobs();
    const approved = await readApprovedRecoveryComponents();
    const skippedCompleted = allTracked.filter(({ cleanupStatus }) => cleanupStatus === 'deleted' || cleanupStatus === 'already_absent').length;
    const eligibleTracked = allTracked.filter(({ cleanupStatus }) => !cleanupStatus || cleanupStatus === 'pending' || cleanupStatus === 'failed');
    const deduplicated = new Map<string, CleanupRecord>();
    for (const record of eligibleTracked) deduplicated.set(keyOf(record), { ...record, source: 'tracked' });
    for (const record of approved) {
      if (deduplicated.has(keyOf(record))) continue;
      deduplicated.set(keyOf(record), {
        ...record,
        sourceSpec: 'components-cleanup-approved.json',
        testCaseId: 'EXPLICIT RECOVERY ALLOWLIST',
        runId: `RECOVERY APPROVED BY ${record.approvedBy}`,
        createdAt: record.approvedAt,
        source: 'approved',
      });
    }

    const requestedCode = process.env.COMPONENT_CLEANUP_TARGET_CODE?.trim();
    const requestedVessel = process.env.COMPONENT_CLEANUP_TARGET_VESSEL?.trim();
    const authorizedPending = [...deduplicated.values()].filter((record) =>
      (!requestedCode || record.code === requestedCode)
      && (!requestedVessel || record.vessel === requestedVessel));
    if ((requestedCode || requestedVessel) && authorizedPending.length === 0) {
      throw new Error(`The requested manual cleanup target ${requestedCode || '(any code)'} in ${requestedVessel || '(any vessel)'} is not present in the tracked or approved cleanup records.`);
    }
    const pending = childrenFirst(authorizedPending);
    const grouped = new Map<string, CleanupRecord[]>();
    for (const record of pending) grouped.set(record.vessel, [...(grouped.get(record.vessel) ?? []), record]);
    const authorizedKeys = new Set(pending.map(keyOf));
    let deleted = 0;
    let alreadyAbsent = 0;
    const failures: string[] = [];
    const remainingComponents: string[] = [];
    const outcomes = allTracked
      .filter(({ cleanupStatus }) => cleanupStatus === 'deleted' || cleanupStatus === 'already_absent')
      .map((record) => `skipped — Vessel: ${record.vessel}; Code: ${record.code}; Name: ${record.name}; Reason: cleanup was already recorded as ${record.cleanupStatus}.`);

    for (const [vessel, records] of grouped) {
      await components.selectVessel(vessel);
      for (const record of records) {
        try {
          const outcome = await deleteAllTrackedDuplicates(
            page,
            components,
            record,
            authorizedKeys,
            trackedJobs,
            () => { deleted += 1; },
          );
          if (outcome.alreadyAbsentReason) {
            await componentValidationStep(page, step(
              `Confirm tracked Component ${record.code} is absent after the Component not found popup`,
              `After acknowledging the popup and refreshing Vessel ${vessel}, the exact tracked Component ${record.code} (${record.name}) should be absent.`,
              `${outcome.alreadyAbsentReason} The exact tracked Component ${record.code} (${record.name}) was confirmed absent from Vessel ${vessel}.`,
            ), async () => expect(outcome.remaining).toBe(0));
            await complete(record, 'already_absent', outcome.alreadyAbsentReason);
            alreadyAbsent += 1;
            outcomes.push(`already_absent — Vessel: ${vessel}; Code: ${record.code}; Name: ${record.name}; Reason: ${outcome.alreadyAbsentReason}`);
          } else if (outcome.deleted === 0) {
            await componentValidationStep(page, step(
              `Confirm tracked Component ${record.code} is already absent from Vessel ${vessel}`,
              `An exact vessel-and-code search should find no Component ${record.code}.`,
              `Exact search found no Component ${record.code}; no Delete action was used.`,
            ), async () => expect(outcome.remaining).toBe(0));
            await complete(record, 'already_absent', 'Exact vessel-and-code search confirmed the component is absent.');
            alreadyAbsent += 1;
            outcomes.push(`already_absent — Vessel: ${vessel}; Code: ${record.code}; Name: ${record.name}; Reason: exact tracked identity was confirmed absent.`);
          } else {
            await componentValidationStep(page, step(
              `Verify Component ${record.code} deletion after linked-job cleanup`,
              `After all authorized linked Jobs are absent, the exact Component ${record.code} (${record.name}) should be deleted from Vessel ${vessel} and remain absent after refresh.`,
              `${outcome.linkedJobResults.length} authorized linked Job(s) were deleted individually (${outcome.linkedJobResults.join('; ') || 'none'}); Component deletion succeeded and refreshed exact search returned zero records.`,
            ), async () => expect(outcome.remaining).toBe(0));
            await complete(record, 'deleted', `${outcome.deleted} exact tracked record(s) were deleted and absence was verified.`);
            outcomes.push(`deleted — Vessel: ${vessel}; Code: ${record.code}; Name: ${record.name}; Linked jobs found/deleted: ${outcome.linkedJobResults.length}; ${outcome.linkedJobResults.join('; ') || 'none'}; Component result: ${outcome.deleted} exact tracked record(s) deleted; final refresh verified absence.`);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          failures.push(`${record.code} (${vessel}): ${reason}`);
          outcomes.push(`failed — Vessel: ${vessel}; Code: ${record.code}; Name: ${record.name}; Reason: ${reason}`);
          const remainingCount = await components.exactComponentCountFullyLoaded(record.code)
            .catch(() => undefined);
          if (remainingCount === undefined || remainingCount > 0) {
            remainingComponents.push(
              `${record.code} (${record.name}, ${vessel}): ${remainingCount ?? 'unknown'} exact row(s) remaining`,
            );
          }
          if (record.source === 'tracked') await updateTrackedComponentCleanup(record.code, vessel, 'failed', reason);
        }
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const summary = [
      `Total tracked records: ${allTracked.length}`,
      `Pending identities processed: ${pending.length}`,
      `Component records deleted: ${deleted}`,
      `Already absent: ${alreadyAbsent}`,
      `Failed deletions: ${failures.length}`,
      `Remaining tracked identities: ${remainingComponents.length}`,
      `Skipped previously completed: ${skippedCompleted}`,
      `Automation Job tracking records read: ${trackedJobs.length}`,
      `Execution time: ${(elapsedMs / 1000).toFixed(1)}s`,
      'Per-component outcomes:',
      ...(outcomes.length ? outcomes.map((outcome) => `- ${outcome}`) : ['- No authorized tracked components required processing.']),
      ...(remainingComponents.length ? ['Remaining components:', ...remainingComponents.map((component) => `- ${component}`)] : ['Remaining components: none']),
      ...(failures.length ? ['Failure reasons:', ...failures.map((failure) => `- ${failure}`)] : []),
    ].join('\n');
    await attachSummary(testInfo, summary);
    await test.step(step(
      'Components cleanup summary',
      'Only pending exact tracked identities should be processed, duplicate automation records should all be removed, and every outcome should be persisted.',
      summary,
    ), async () => expect(failures, summary).toEqual([]));
  });

  const complete = async (record: CleanupRecord, status: 'deleted' | 'already_absent', result: string): Promise<void> => {
    if (record.source === 'tracked') await updateTrackedComponentCleanup(record.code, record.vessel, status, result);
    else await removeApprovedRecoveryComponent(record.code, record.vessel);
  };
});

async function deleteAllTrackedDuplicates(
  page: Page,
  components: ComponentsPage,
  record: CleanupRecord,
  authorizedKeys: Set<string>,
  trackedJobs: TrackedJob[],
  onDeleted: () => void,
): Promise<{ deleted: number; remaining: number; alreadyAbsentReason?: string; linkedJobResults: string[] }> {
  let deleted = 0;
  const linkedJobResults: string[] = [];
  for (let pass = 0; pass < 100; pass += 1) {
    const count = await components.exactComponentCountFullyLoaded(record.code);
    if (count === 0) return { deleted, remaining: 0, linkedJobResults };

    let authorizedOccurrence = -1;
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      await components.selectExactComponentOccurrence(record.code, occurrence);
      const identity = await components.readSelectedComponentIdentity();
      if (
        identity.code === record.code
        && identity.vesselName === record.vessel
        && normalizeComponentName(identity.name) === normalizeComponentName(record.name)
      ) {
        authorizedOccurrence = occurrence;
        break;
      }
    }
    if (authorizedOccurrence < 0) {
      throw new Error(`${count} exact-code row(s) remain, but none match the tracked name "${record.name}". They were not deleted.`);
    }

    const untrackedChildren = (await components.directChildCodes(record.code))
      .filter((code) => !authorizedKeys.has(`${record.vessel}\u0000${code}`));
    expect(untrackedChildren, 'A tracked parent with untracked children must not be deleted').toEqual([]);
    try {
      await components.deleteSelectedComponent(record.code);
    } catch (error) {
      if (error instanceof ComponentBlockedByLinkedJobsError) {
        linkedJobResults.push(...await deleteAuthorizedLinkedJobs(page, components, record, error, trackedJobs));
        continue;
      }
      if (!(error instanceof ComponentNotFoundDuringDeletionError)) throw error;
      try {
        const stillExists = await exactTrackedIdentityExists(components, record);
        if (!stillExists) {
          return { deleted, remaining: 0, alreadyAbsentReason: error.feedback, linkedJobResults };
        }
      } catch (verificationError) {
        const verificationReason = verificationError instanceof Error
          ? verificationError.message
          : String(verificationError);
        throw new Error(`${error.feedback} Absence could not be verified: ${verificationReason}`);
      }
      throw new Error(`${error.feedback} The exact tracked Component ${record.code} (${record.name}) still exists in Vessel ${record.vessel}; deletion was not retried.`);
    }
    deleted += 1;
    onDeleted();
  }
  throw new Error(`Cleanup stopped after deleting 100 duplicate rows for Component ${record.code}; a bounded safety limit was reached.`);
}

/**
 * Verifies the blocked component after the linked-jobs popup was acknowledged and
 * Components refreshed, records the evidence-based outcome, and throws so the
 * caller marks the record failed and continues with the next tracked component.
 * Linked jobs are never deactivated or deleted, and deletion is not retried.
 */
async function deleteAuthorizedLinkedJobs(
  page: Page,
  components: ComponentsPage,
  record: CleanupRecord,
  error: ComponentBlockedByLinkedJobsError,
  trackedJobs: TrackedJob[],
): Promise<string[]> {
  return performAuthorizedLinkedJobCleanup(page, components, record, error, trackedJobs);
  /* Legacy blocked-only diagnostics retained below for historical context; the
     manual cleanup path now returns through the authorization workflow above. */
  const jobCount = error.linkedJobCount === undefined ? 'an unreadable number of' : String(error.linkedJobCount);
  let stillExists: boolean | undefined;
  let verificationReason = '';
  try {
    stillExists = await exactTrackedIdentityExists(components, record);
  } catch (verificationError) {
    verificationReason = verificationError instanceof Error ? (verificationError as Error).message : String(verificationError);
  }
  const presence = stillExists === undefined
    ? `Presence after refresh could not be verified: ${verificationReason}`
    : stillExists
      ? `After refresh, Component ${record.code} (${record.name}) remains present in Vessel ${record.vessel}.`
      : `After refresh, the exact tracked Component ${record.code} (${record.name}) was not found in Vessel ${record.vessel}.`;
  const reason = `BLOCKED BY LINKED JOBS — Popup: "${error.popupMessage}" Linked active jobs: ${jobCount}. `
    + `The popup was acknowledged by clicking OK. ${presence} Linked jobs were not changed and deletion was not retried.`;
  await componentValidationStep(page, step(
    `Delete tracked Component ${record.code} — Cannot Delete Component popup for linked jobs`,
    `The tracked Component ${record.code} (${record.name}) in Vessel ${record.vessel} should be deleted when no blocking dependencies exist.`,
    `The application displayed "Cannot Delete Component" because ${jobCount} active Job(s) are linked: "${error.popupMessage}" `
      + `The popup was acknowledged by clicking OK. ${presence}`,
  ), async () => expect(stillExists, reason).toBe(false)).catch(() => undefined);
  throw new Error(reason);
}

async function performAuthorizedLinkedJobCleanup(
  page: Page,
  components: ComponentsPage,
  record: CleanupRecord,
  error: ComponentBlockedByLinkedJobsError,
  trackedJobs: TrackedJob[],
): Promise<string[]> {
  const jobCount = error.linkedJobCount === undefined ? 'not readable' : String(error.linkedJobCount);
  await componentValidationStep(page, step(
    `Acknowledge Component Deletion Blocked for ${record.code}`,
    `The popup should show the dynamic linked-Job count and close after OK without marking Component ${record.code} deleted.`,
    `The application displayed ${error.popupMessage} with linked active Job count ${jobCount}; OK was clicked and Component ${record.code} remained pending cleanup.`,
  ), async () => {
    expect(error.popupMessage).toMatch(/This component cannot be deleted because it has \d+ active Job\(s\) linked to it\. Please deactivate or delete all linked Jobs first\./i);
    expect(await exactTrackedIdentityExists(components, record)).toBe(true);
  });

  const authorized = new Map<string, string>();
  for (const job of trackedJobs) {
    if (job.vessel === record.vessel
      && job.componentCode === record.code
      && normalizeComponentName(job.componentName) === normalizeComponentName(record.name)
      && !['deleted', 'already_absent'].includes(job.cleanupStatus ?? 'pending')) {
      authorized.set(job.jobCode, job.jobTitle);
    }
  }
  for (const job of record.cleanupAuthorizedJobs ?? []) authorized.set(job.jobCode, job.jobTitle);
  for (const workOrder of record.generatedWorkOrders ?? []) authorized.set(workOrder.jobCode, workOrder.jobTitle);
  for (const job of recoverExactJobsFromComponentCreation(record)) authorized.set(job.jobCode, job.jobTitle);
  const identity = await components.searchAndSelectComponentByCode(record.code);
  expect(identity).toEqual({ code: record.code, name: record.name, vesselName: record.vessel });
  const jobs = (await components.readAllLinkedJobs()).jobs;
  const unauthorized = jobs.filter((job) => authorized.get(job.jobCode) !== job.jobTitle);
  if (unauthorized.length) {
    throw new Error(`Component ${record.code} has ${jobs.length} linked Job(s), but ${unauthorized.length} lack exact cleanup authorization: ${unauthorized.map((job) => `${job.jobCode} (${job.jobTitle})`).join(', ')}. No linked Job was deleted.`);
  }
  for (const [jobCode, jobTitle] of authorized) {
    if (!trackedJobs.some((job) => job.vessel === record.vessel && job.componentCode === record.code && job.jobCode === jobCode)) {
      const recovered: TrackedJob = {
        jobCode, jobTitle, componentCode: record.code, componentName: record.name, vessel: record.vessel,
        source: 'Recovered from exact component cleanup authorization or generated Work Order record',
        createdAt: record.createdAt,
      };
      await trackCreatedJob(recovered);
      trackedJobs.push({ ...recovered, cleanupStatus: 'pending' });
    }
  }
  return deleteLinkedJobsOneByOne(page, components, record, authorized, jobs.length);
}

async function deleteLinkedJobsOneByOne(
  page: Page,
  components: ComponentsPage,
  record: CleanupRecord,
  authorized: Map<string, string>,
  initialCount: number,
): Promise<string[]> {
  const results: string[] = [];
  for (let pass = 0; pass < 100; pass += 1) {
    await restoreComponentsPage(page, components, record.vessel);
    const identity = await components.searchAndSelectComponentByCode(record.code);
    expect(identity).toEqual({ code: record.code, name: record.name, vesselName: record.vessel });
    const jobs = (await components.readAllLinkedJobs()).jobs;
    if (jobs.length === 0) {
      await componentValidationStep(page, step(
        `Verify all authorized linked Jobs are absent from Component ${record.code}`,
        `After individual deletion and refresh, Component ${record.code} should show no linked Jobs before component deletion is retried.`,
        `${initialCount} linked Job(s) were found and processed; refresh showed zero linked Jobs for Component ${record.code}.`,
      ), async () => expect(jobs).toEqual([]));
      return results;
    }
    const job = jobs[0];
    expect(authorized.get(job.jobCode), `Job ${job.jobCode} is not exactly authorized for cleanup`).toBe(job.jobTitle);
    const form = await components.openLinkedJob(job.jobCode);
    await form.expectOpenedJob(job.jobCode, job.jobTitle);
    const deletion = await form.delete();
    await componentValidationStep(page, step(
      `Delete authorized linked Job ${job.jobCode} (${job.jobTitle})`,
      `The exact Job ${job.jobCode} (${job.jobTitle}) linked to Component ${record.code} in Vessel ${record.vessel} should be deleted through its Jobs Form.`,
      `Delete was confirmed for Job ${job.jobCode} (${job.jobTitle}); the application accepted the deletion and showed ${deletion.feedback}.`,
    ), async () => expect(deletion.ok, `Job ${job.jobCode} deletion was blocked: ${deletion.feedback}`).toBe(true));

    await restoreComponentsPage(page, components, record.vessel);
    expect(await components.searchAndSelectComponentByCode(record.code)).toEqual(identity);
    const remaining = (await components.readAllLinkedJobs()).jobs;
    expect(remaining.some((item) => item.jobCode === job.jobCode || item.jobTitle === job.jobTitle), `Job ${job.jobCode} still appeared after deletion and refresh`).toBe(false);
    results.push(`${job.jobCode} (${job.jobTitle}): deleted and confirmed absent`);
    await updateTrackedJobCleanup(job.jobCode, record.code, record.vessel, 'deleted',
      `Deleted through Jobs Form and confirmed absent after refresh from Component ${record.code}.`);
  }
  throw new Error(`Linked-job cleanup for Component ${record.code} reached the bounded 100-deletion safety limit.`);
}

async function exactTrackedIdentityExists(
  components: ComponentsPage,
  record: CleanupRecord,
): Promise<boolean> {
  const count = await components.exactComponentCountFullyLoaded(record.code);
  for (let occurrence = 0; occurrence < count; occurrence += 1) {
    await components.selectExactComponentOccurrence(record.code, occurrence);
    const identity = await components.readSelectedComponentIdentity();
    if (
      identity.code === record.code
      && identity.vesselName === record.vessel
      && normalizeComponentName(identity.name) === normalizeComponentName(record.name)
    ) return true;
  }
  return false;
}

async function attachSummary(testInfo: TestInfo, summary: string): Promise<void> {
  await testInfo.attach('Components cleanup summary', {
    body: Buffer.from(summary, 'utf8'),
    contentType: 'text/plain',
  });
}

function childrenFirst<T extends Pick<TrackedComponent, 'code' | 'vessel' | 'parentCode'>>(records: T[]): T[] {
  const byIdentity = new Map(records.map((record) => [keyOf(record), record]));
  const depth = (record: T, visited = new Set<string>()): number => {
    const key = keyOf(record);
    if (visited.has(key)) return 0;
    const parent = byIdentity.get(`${record.vessel}\u0000${record.parentCode}`);
    return parent ? 1 + depth(parent, new Set([...visited, key])) : 0;
  };
  return [...records].sort((left, right) => depth(right) - depth(left));
}

function normalizeComponentName(name: string): string {
  return name.replace(/\s*\(Inactive\)\s*$/i, '').trim();
}

/**
 * Historical CMP-124/125 runs predate the job tracker. Their component creation
 * record contains the originating spec, scenario and unique suffix, which is
 * enough to reconstruct the one exact job that scenario created. No generic
 * prefix or display-name ownership inference is used.
 */
function recoverExactJobsFromComponentCreation(record: CleanupRecord): Array<{ jobCode: string; jobTitle: string }> {
  if (record.sourceSpec !== 'components-linked-jobs-work-orders.spec.ts') return [];
  const match = /^(AT124|AT125)-([A-Z0-9]+)$/.exec(record.code);
  if (!match) return [];
  const [, family, suffix] = match;
  if (record.testCaseId === 'CMP-124' && family === 'AT124' && record.name === `CMP124 Jobs ${suffix}`) {
    return [{ jobCode: `ATJ124-${suffix}`, jobTitle: `CMP124 Linked Job ${suffix}` }];
  }
  if (record.testCaseId === 'CMP-125' && family === 'AT125' && record.name === `CMP125 Save Add Job ${suffix}`) {
    return [{ jobCode: `ATJ125-${suffix}`, jobTitle: `CMP125 Linked Job ${suffix}` }];
  }
  return [];
}
