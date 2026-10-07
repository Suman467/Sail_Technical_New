import { test } from '../../../fixtures/baseFixture';
import { DATA_VALIDATION_LIMIT } from '../../../utils/config';
import { runSparesValidation } from './spares-validation-scenario';

test(`Spares partial validation and audit - first ${DATA_VALIDATION_LIMIT} - single execution`, { tag: ['@regression', '@spares', '@data-validation', '@data-audit', '@limited-validation'] }, async ({ page, auditDashboardPage }) => {
  await runSparesValidation({ page, auditDashboardPage, location: 'components', limit: DATA_VALIDATION_LIMIT, upload: true, strict: true, includeAuditSummary: true, scenarioTitle: `Spares partial validation and audit - first ${DATA_VALIDATION_LIMIT} - single execution` });
});
