import type { Page } from "@playwright/test";
import type { AuditDashboardPage } from "../../pages/AuditDashboardPage";
import { loadExpectedComponentData } from "../../utils/componentsExpectedData";
import { validateComponentsPage } from "../data-validation/components/components-validation-scenario";
import {
  runBulkDataImportFolderScenario,
  type BulkImportFolderRunResult,
  type BulkImportMode,
} from "./bulkDataImportScenario";

/**
 * Runs one Component bulk-import mode against the single file in the Component
 * module folder. Every file is submitted before the application response is interpreted.
 * Successfully imported files continue into the existing Component UI
 * validation without duplicating its comparison or reporting logic.
 */
export async function runComponentBulkImportScenario(
  page: Page,
  auditDashboardPage: AuditDashboardPage,
  mode: BulkImportMode,
): Promise<BulkImportFolderRunResult[]> {
  const results = await runBulkDataImportFolderScenario(
    page,
    auditDashboardPage,
    {
      module: "components",
      mode,
      rowErrors: "skip-and-import",
    },
  );

  for (const { result } of results) {
    if (!result.imported) continue;
    const expectedData = loadExpectedComponentData(result.uploadFile);
    const rejectedRows = new Set(result.rejectedWorkbookRows);
    const importedRecords = expectedData.records.filter(
      (_, index) => !rejectedRows.has(index + 2),
    );
    await validateComponentsPage(page, importedRecords, {
      successfullyImported: importedRecords.length,
    });
  }
  return results;
}
