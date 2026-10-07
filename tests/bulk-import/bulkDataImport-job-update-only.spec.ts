import { test } from '../../fixtures/baseFixture';
import { runBulkDataImportFolderScenario } from './bulkDataImportScenario';

test(
  'Bulk Data Import - Job - Update Only',
  { tag: ['@regression', '@admin', '@bulkimport', '@job', '@update-only'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkDataImportFolderScenario(page, auditDashboardPage, {
      module: 'job', mode: 'updateOnly', rowErrors: 'skip-and-import',
    });
  },
);
