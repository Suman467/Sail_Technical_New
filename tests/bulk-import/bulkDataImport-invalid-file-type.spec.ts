import { test } from '../../fixtures/baseFixture';
import { runBulkImportFileValidationScenario } from './bulkDataImportScenario';

test(
  'Components Bulk Import - Invalid Word File Type',
  { tag: ['@regression', '@admin', '@bulkimport', '@component', '@add-update', '@invalid', '@file-type'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkImportFileValidationScenario(page, auditDashboardPage, 'invalid-file-type');
  },
);
