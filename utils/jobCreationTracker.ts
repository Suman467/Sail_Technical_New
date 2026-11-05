import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TrackedJob {
  jobCode: string;
  jobTitle: string;
  componentCode: string;
  componentName: string;
  vessel: string;
  source: string;
  createdAt: string;
  cleanupStatus?: 'pending' | 'deleted' | 'already_absent' | 'failed' | 'skipped';
  cleanupAttemptedAt?: string;
  cleanupResult?: string;
}

const trackingFile = path.resolve(process.cwd(), 'test-data', 'jobs-auto-created.json');
const lockFile = `${trackingFile}.lock`;
let pendingUpdate: Promise<void> = Promise.resolve();

export async function readTrackedJobs(): Promise<TrackedJob[]> {
  try {
    const value: unknown = JSON.parse(await readFile(trackingFile, 'utf8'));
    if (!Array.isArray(value)) throw new Error('Job tracking data must be an array.');
    const invalid = value.findIndex((job) => !isTrackedJob(job));
    if (invalid >= 0) throw new Error(`Job tracking record ${invalid + 1} is incomplete; no records were discarded.`);
    return value.map((job) => ({ ...(job as TrackedJob), cleanupStatus: (job as TrackedJob).cleanupStatus ?? 'pending' }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function trackCreatedJob(job: TrackedJob): Promise<void> {
  await update((tracked) => [
    ...tracked.filter((item) => !(item.vessel === job.vessel && item.componentCode === job.componentCode && item.jobCode === job.jobCode)),
    { ...job, cleanupStatus: 'pending', cleanupAttemptedAt: undefined, cleanupResult: undefined },
  ]);
}

export async function updateTrackedJobCleanup(jobCode: string, componentCode: string, vessel: string,
  cleanupStatus: NonNullable<TrackedJob['cleanupStatus']>, cleanupResult: string): Promise<void> {
  await update((tracked) => tracked.map((job) =>
    job.jobCode === jobCode && job.componentCode === componentCode && job.vessel === vessel
      ? { ...job, cleanupStatus, cleanupAttemptedAt: new Date().toISOString(), cleanupResult }
      : job));
}

async function update(change: (tracked: TrackedJob[]) => TrackedJob[]): Promise<void> {
  const operation = pendingUpdate.then(async () => withLock(async () => {
    const jobs = change(await readTrackedJobs());
    await mkdir(path.dirname(trackingFile), { recursive: true });
    const temporary = `${trackingFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8');
    await rename(temporary, trackingFile);
  }));
  pendingUpdate = operation.catch(() => undefined);
  await operation;
}

async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  await mkdir(path.dirname(lockFile), { recursive: true });
  while (true) {
    try {
      const lock = await open(lockFile, 'wx');
      try { return await operation(); }
      finally { await lock.close(); await unlink(lockFile).catch(() => undefined); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function isTrackedJob(value: unknown): value is TrackedJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Record<string, unknown>;
  const identity = ['jobCode', 'jobTitle', 'componentCode', 'componentName', 'vessel', 'source', 'createdAt']
    .every((field) => typeof job[field] === 'string' && job[field] !== '');
  return identity && (job.cleanupStatus === undefined || ['pending', 'deleted', 'already_absent', 'failed', 'skipped'].includes(String(job.cleanupStatus)));
}
