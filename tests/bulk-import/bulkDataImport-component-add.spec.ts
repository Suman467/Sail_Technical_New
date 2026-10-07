import { test } from '../../fixtures/baseFixture';
import { runComponentBulkImportScenario } from './componentBulkImportScenario';

test(
  'Components Bulk Import - Add',
  { tag: ['@regression', '@admin', '@bulkimport', '@component', '@add-only'] },
  async ({ page, auditDashboardPage }) => {
    await runComponentBulkImportScenario(page, auditDashboardPage, 'addOnly');
  },
);
