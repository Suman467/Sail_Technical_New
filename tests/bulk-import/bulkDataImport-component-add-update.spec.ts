import { test } from '../../fixtures/baseFixture';
import { runComponentBulkImportScenario } from './componentBulkImportScenario';

test(
  'Components Bulk Import - Add + Update',
  { tag: ['@regression', '@admin', '@bulkimport', '@component', '@add-update'] },
  async ({ page, auditDashboardPage }) => {
    await runComponentBulkImportScenario(page, auditDashboardPage, 'addAndUpdate');
  },
);
