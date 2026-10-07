import { test } from '../../../fixtures/baseFixture';
import { normalizeExpectedText } from '../../../utils/componentsExpectedData';
import { importUploadedComponents, validateComponentsPage } from './components-validation-scenario';

test('Components complete validation and audit - single execution', { tag: ['@regression', '@components', '@data-validation', '@data-audit'] }, async ({ page, auditDashboardPage }) => {
  test.setTimeout(0);
  const imported = await importUploadedComponents(page, auditDashboardPage, 'addAndUpdate');
  const records = imported.filter((record) => normalizeExpectedText(record['Parent Component Code']));
  await validateComponentsPage(page, records, { includeAuditSummary: true, successfullyImported: records.length });
});
