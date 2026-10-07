import { test } from '../../fixtures/baseFixture';
import { runBulkDataImportFolderScenario } from './bulkDataImportScenario';

test(
  'Bulk Data Import - Job - Add + Update',
  { tag: ['@regression', '@admin', '@bulkimport', '@job', '@add-update'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkDataImportFolderScenario(page, auditDashboardPage, {
      module: 'job', mode: 'addAndUpdate', rowErrors: 'skip-and-import',
    });
  },
);
