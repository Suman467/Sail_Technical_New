import { test } from '../../fixtures/baseFixture';
import { runBulkDataImportFolderScenario } from './bulkDataImportScenario';

test(
  'Bulk Data Import - Job - Add Only',
  { tag: ['@regression', '@admin', '@bulkimport', '@job', '@add-only'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkDataImportFolderScenario(page, auditDashboardPage, {
      module: 'job', mode: 'addOnly', rowErrors: 'skip-and-import',
    });
  },
);
