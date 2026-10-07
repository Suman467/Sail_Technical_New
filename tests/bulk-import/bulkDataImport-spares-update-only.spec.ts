import { test } from '../../fixtures/baseFixture';
import { runBulkDataImportFolderScenario } from './bulkDataImportScenario';

test(
  'Bulk Data Import - Spares - Update Only',
  { tag: ['@regression', '@admin', '@bulkimport', '@spares', '@update-only'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkDataImportFolderScenario(page, auditDashboardPage, {
      module: 'spares', mode: 'updateOnly', rowErrors: 'skip-and-import',
    });
  },
);
