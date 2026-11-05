import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TrackedComponent {
  code: string;
  name: string;
  vessel: string;
  parentCode: string;
  sourceSpec: string;
  testCaseId: string;
  runId: string;
  createdAt: string;
  cleanupStatus?: 'pending' | 'deleted' | 'already_absent' | 'failed';
  cleanupAttemptedAt?: string;
  cleanupResult?: string;
  generatedWorkOrders?: Array<{ workOrderNumber: string; status: string; jobCode: string; jobTitle: string; createdAt: string }>;
  cleanupAuthorizedJobs?: Array<{ jobCode: string; jobTitle: string; authorizedAt: string; reason: string }>;
}

export interface ApprovedRecoveryComponent {
  code: string;
  name: string;
  vessel: string;
  parentCode: string;
  approvedBy: string;
  approvedAt: string;
}

export interface RecoveryCandidate {
  code: string;
  name: string;
  vessel: string;
  parentCode: string;
  reason: string;
}

const trackingFile = path.resolve(process.cwd(), 'test-data', 'components-auto-created.json');
const approvalFile = path.resolve(process.cwd(), 'test-data', 'components-cleanup-approved.json');
const candidatesFile = path.resolve(process.cwd(), 'test-data', 'components-cleanup-recovery-candidates.json');
const trackingLockFile = `${trackingFile}.lock`;
let pendingUpdate: Promise<void> = Promise.resolve();

export async function readTrackedComponents(): Promise<TrackedComponent[]> {
  try {
    const value: unknown = JSON.parse(await readFile(trackingFile, 'utf8'));
    if (!Array.isArray(value)) throw new Error('Tracking data must be an array.');
    const invalidIndex = value.findIndex((component) => !isTrackedComponent(component));
    if (invalidIndex >= 0) {
      throw new Error(`Tracking record ${invalidIndex + 1} is incomplete; no cleanup records were discarded.`);
    }
    return value.map((component) => normalizeTrackedComponent(component as TrackedComponent));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function trackCreatedComponent(component: TrackedComponent): Promise<void> {
  await update(async (tracked) => {
    const withoutDuplicate = tracked.filter(({ code, vessel }) =>
      code !== component.code || vessel !== component.vessel);
    return [...withoutDuplicate, { ...component, cleanupStatus: 'pending', cleanupAttemptedAt: undefined, cleanupResult: undefined }];
  });
}

export async function updateTrackedComponentCleanup(
  code: string,
  vessel: string,
  cleanupStatus: NonNullable<TrackedComponent['cleanupStatus']>,
  cleanupResult: string,
): Promise<void> {
  await update(async (tracked) => tracked.map((component) =>
    component.code === code && component.vessel === vessel
      ? { ...component, cleanupStatus, cleanupAttemptedAt: new Date().toISOString(), cleanupResult }
      : component));
}

export async function trackComponentWorkOrder(
  code: string,
  vessel: string,
  workOrder: NonNullable<TrackedComponent['generatedWorkOrders']>[number],
): Promise<void> {
  await update(async (tracked) => tracked.map((component) => {
    if (component.code !== code || component.vessel !== vessel) return component;
    const generatedWorkOrders = (component.generatedWorkOrders ?? [])
      .filter((item) => item.workOrderNumber !== workOrder.workOrderNumber);
    return { ...component, generatedWorkOrders: [...generatedWorkOrders, workOrder] };
  }));
}

export async function removeTrackedComponent(code: string, vessel: string): Promise<void> {
  await update(async (tracked) => tracked.filter((component) =>
    component.code !== code || component.vessel !== vessel));
}

export async function readApprovedRecoveryComponents(): Promise<ApprovedRecoveryComponent[]> {
  return readValidatedArray(approvalFile, isApprovedRecoveryComponent, 'approved recovery');
}

export async function removeApprovedRecoveryComponent(code: string, vessel: string): Promise<void> {
  const approved = await readApprovedRecoveryComponents();
  await saveFile(approvalFile, approved.filter((component) =>
    component.code !== code || component.vessel !== vessel));
}

export async function writeRecoveryCandidates(candidates: RecoveryCandidate[]): Promise<void> {
  await saveFile(candidatesFile, candidates);
}

async function update(change: (tracked: TrackedComponent[]) => Promise<TrackedComponent[]>): Promise<void> {
  const operation = pendingUpdate.then(async () => withTrackingLock(async () => {
    await save(await change(await readTrackedComponents()));
  }));
  pendingUpdate = operation.catch(() => undefined);
  await operation;
}

async function save(components: TrackedComponent[]): Promise<void> {
  await saveFile(trackingFile, components);
}

async function saveFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryFile, file);
}

async function withTrackingLock<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  await mkdir(path.dirname(trackingLockFile), { recursive: true });
  while (true) {
    try {
      const lock = await open(trackingLockFile, 'wx');
      try {
        await lock.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        return await operation();
      } finally {
        await lock.close();
        await unlink(trackingLockFile).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function readValidatedArray<T>(
  file: string,
  validator: (value: unknown) => value is T,
  label: string,
): Promise<T[]> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(value)) throw new Error(`The ${label} file must contain an array.`);
    const invalidIndex = value.findIndex((record) => !validator(record));
    if (invalidIndex >= 0) throw new Error(`${label} record ${invalidIndex + 1} is incomplete.`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function isTrackedComponent(value: unknown): value is TrackedComponent {
  if (!value || typeof value !== 'object') return false;
  const component = value as Record<string, unknown>;
  const identityIsValid = ['code', 'name', 'vessel', 'parentCode', 'runId', 'createdAt']
    .every((field) => typeof component[field] === 'string' && component[field] !== '');
  const status = component.cleanupStatus;
  return identityIsValid && (status === undefined || ['pending', 'deleted', 'already_absent', 'failed'].includes(String(status)));
}

function normalizeTrackedComponent(component: TrackedComponent): TrackedComponent {
  return {
    ...component,
    sourceSpec: component.sourceSpec || 'historical tracker record',
    testCaseId: component.testCaseId || 'unknown',
    cleanupStatus: component.cleanupStatus || 'pending',
  };
}

function isApprovedRecoveryComponent(value: unknown): value is ApprovedRecoveryComponent {
  if (!value || typeof value !== 'object') return false;
  const component = value as Record<string, unknown>;
  return ['code', 'name', 'vessel', 'parentCode', 'approvedBy', 'approvedAt']
    .every((field) => typeof component[field] === 'string' && component[field] !== '');
}
