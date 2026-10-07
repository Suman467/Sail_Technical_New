import { test } from '../../../fixtures/baseFixture';
import { validateImportedJobs } from './jobs-validation-scenario';

test('Jobs complete validation and audit - single execution', { tag: ['@regression', '@jobs', '@data-validation', '@data-audit'] }, async ({ page, auditDashboardPage }) => {
  await validateImportedJobs(page, auditDashboardPage, undefined, { includeAuditSummary: true });
});
