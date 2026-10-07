import { test } from '../../fixtures/baseFixture';
import { runBulkDataImportFolderScenario } from './bulkDataImportScenario';

test(
  'Bulk Data Import - Location - Add + Update',
  { tag: ['@regression', '@admin', '@bulkimport', '@location', '@add-update'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkDataImportFolderScenario(page, auditDashboardPage, {
      module: 'location',
      mode: 'addAndUpdate',
      rowErrors: 'skip-and-import',
      testDataFolder: 'test-data/location',
    });
  },
);
