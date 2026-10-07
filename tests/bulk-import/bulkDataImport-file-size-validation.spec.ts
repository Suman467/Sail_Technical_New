import { test } from '../../fixtures/baseFixture';
import { BULK_IMPORT_MAX_UPLOAD_SIZE_MB } from '../../utils/config';
import { runBulkImportFileValidationScenario } from './bulkDataImportScenario';

test(
  `Components Bulk Import - File Size Greater Than ${BULK_IMPORT_MAX_UPLOAD_SIZE_MB} MB`,
  { tag: ['@regression', '@admin', '@bulkimport', '@component', '@add-update', '@invalid', '@file-size'] },
  async ({ page, auditDashboardPage }) => {
    await runBulkImportFileValidationScenario(page, auditDashboardPage, 'file-size-validation');
  },
);
