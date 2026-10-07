import { test } from '../../fixtures/baseFixture';
import { runBulkDataImportFolderScenario } from './bulkDataImportScenario';

test(
  'Bulk Data Import - Spares - Add Only',
  { tag: ['@regression', '@admin', '@bulkimport', '@spares', '@add-only'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkDataImportFolderScenario(page, auditDashboardPage, {
      module: 'spares', mode: 'addOnly', rowErrors: 'skip-and-import',
    });
  },
);
