import { test } from '../../../fixtures/baseFixture';
import { DATA_VALIDATION_LIMIT } from '../../../utils/config';
import { validateImportedJobs } from './jobs-validation-scenario';

test(`Jobs partial validation and audit - first ${DATA_VALIDATION_LIMIT} - single execution`, { tag: ['@regression', '@jobs', '@data-validation', '@data-audit', '@limited-validation'] }, async ({ page, auditDashboardPage }) => {
  await validateImportedJobs(page, auditDashboardPage, DATA_VALIDATION_LIMIT, { includeAuditSummary: true });
});
