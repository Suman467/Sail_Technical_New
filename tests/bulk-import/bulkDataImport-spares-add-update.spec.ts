import { test } from '../../fixtures/baseFixture';
import { runBulkDataImportFolderScenario } from './bulkDataImportScenario';

test(
  'Bulk Data Import - Spares - Add + Update',
  { tag: ['@regression', '@admin', '@bulkimport', '@spares', '@add-update'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkDataImportFolderScenario(page, auditDashboardPage, {
      module: 'spares', mode: 'addAndUpdate', rowErrors: 'skip-and-import',
    });
  },
);
