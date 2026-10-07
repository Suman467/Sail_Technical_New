import { test } from '../../../fixtures/baseFixture';
import { DATA_VALIDATION_LIMIT } from '../../../utils/config';
import { getStoresValidationWorkbooks } from '../../../utils/storesExpectedData';
import { runStoresValidation } from './stores-validation-scenario';

for (const workbook of getStoresValidationWorkbooks()) {
  test(`Stores partial validation and audit - ${workbook.storeType} - first ${DATA_VALIDATION_LIMIT} - single execution`, { tag: ['@regression', '@stores', '@data-validation', '@data-audit', '@limited-validation'] }, async ({ page, auditDashboardPage }) => {
    await runStoresValidation({ page, auditDashboardPage, workbook, limit: DATA_VALIDATION_LIMIT });
  });
}
