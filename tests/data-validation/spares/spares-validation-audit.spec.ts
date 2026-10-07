import { test } from '../../../fixtures/baseFixture';
import { runSparesValidation } from './spares-validation-scenario';

test(
  'Spares complete validation and audit - single execution',
  { tag: ['@regression', '@spares', '@data-validation', '@data-audit', '@bulkimport'] },
  async ({ page, auditDashboardPage }) => {
    await runSparesValidation({
      page,
      auditDashboardPage,
      location: 'components',
      upload: true,
      strict: true,
      includeAuditSummary: true,
      scenarioTitle: 'Spares complete validation and audit - single execution',
    });
  },
);
