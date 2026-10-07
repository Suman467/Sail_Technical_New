import { test } from '../../../fixtures/baseFixture';
import { normalizeExpectedText } from '../../../utils/componentsExpectedData';
import { DATA_VALIDATION_LIMIT } from '../../../utils/config';
import { importUploadedComponents, validateComponentsPage } from './components-validation-scenario';

test(`Components partial validation and audit - first ${DATA_VALIDATION_LIMIT} - single execution`, { tag: ['@regression', '@components', '@data-validation', '@data-audit', '@limited-validation'] }, async ({ page, auditDashboardPage }) => {
  test.setTimeout(0);
  const imported = await importUploadedComponents(page, auditDashboardPage, 'addAndUpdate');
  const successfulRecords = imported.filter((record) => normalizeExpectedText(record['Parent Component Code']));
  await validateComponentsPage(page, successfulRecords.slice(0, DATA_VALIDATION_LIMIT), { includeAuditSummary: true, successfullyImported: successfulRecords.length });
});
