import { test } from '../../fixtures/baseFixture';
import { runComponentBulkImportScenario } from './componentBulkImportScenario';

test(
  'Components Bulk Import - Update',
  { tag: ['@regression', '@admin', '@bulkimport', '@component', '@update-only'] },
  async ({ page, auditDashboardPage }) => {
    await runComponentBulkImportScenario(page, auditDashboardPage, 'updateOnly');
  },
);
