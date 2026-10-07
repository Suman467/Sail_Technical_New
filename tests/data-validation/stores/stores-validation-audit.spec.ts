import { test } from '../../../fixtures/baseFixture';
import { getStoresValidationWorkbooks } from '../../../utils/storesExpectedData';
import { runStoresValidation } from './stores-validation-scenario';

for (const workbook of getStoresValidationWorkbooks()) {
  test(`Stores complete validation and audit - ${workbook.storeType} - single execution`, { tag: ['@regression', '@stores', '@data-validation', '@data-audit'] }, async ({ page, auditDashboardPage }) => {
    await runStoresValidation({ page, auditDashboardPage, workbook });
  });
}
