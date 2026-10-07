import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/baseFixture";
import type { AuditDashboardPage } from "../../pages/AuditDashboardPage";
import { BulkDataImportPage } from "../../pages/BulkDataImportPage";
import { config } from "../../utils/config";
import {
  getFirstFileFromFolder,
  listBulkImportFiles,
  listBulkImportFilesInFolder,
  type BulkImportDataModule,
} from "../../utils/testDataFile";

export type BulkImportModule =
  "components" | "job" | "spares" | "stores" | "location";
export type BulkImportMode = "addOnly" | "updateOnly" | "addAndUpdate";
export type BulkImportExpectedResult =
  | { outcome: "from-file"; rowErrors: "skip-and-import" | "reject" }
  | { outcome: "import"; rowErrors: "skip-and-import" | "reject" }
  | { outcome: "validation-rejection"; errorPattern?: RegExp }
  | {
      outcome: "file-rejection";
      reason: "unsupported-file-type" | "maximum-size";
      errorPattern?: RegExp;
    };

export type BulkImportScenario = {
  module: BulkImportModule;
  mode: BulkImportMode;
  expectedResult: BulkImportExpectedResult;
  storeType?: "Stores" | "Lubes" | "Chemicals" | "Others";
};

export type BulkImportRunResult = {
  uploadFile: string;
  validRows: number;
  validationErrors: number;
  rejectedWorkbookRows: number[];
  imported: boolean;
};

export type BulkImportFolderRunResult = {
  category: "attempted";
  result: BulkImportRunResult;
};

type ScenarioStep = (
  number: number,
  name: string,
  details: string,
) => Promise<void>;

const MODULE_LABELS: Record<BulkImportModule, string> = {
  components: "Components",
  job: "Job",
  spares: "Spares",
  stores: "Stores",
  location: "Location",
};

const MODE_LABELS: Record<BulkImportMode, string> = {
  addOnly: "Add Only",
  updateOnly: "Update Only",
  addAndUpdate: "Add + Update",
};

const BULK_IMPORT_DATA_MODULES: Record<
  Exclude<BulkImportModule, "location">,
  BulkImportDataModule
> = {
  components: "Components",
  job: "Job",
  spares: "Spares",
  stores: "Stores",
};

/** Resolves one configured input file without predicting whether the application will accept it. */
function getScenarioUploadFile(scenario: BulkImportScenario): string {
  const files =
    scenario.module === "location"
      ? listBulkImportFilesInFolder("test-data/location")
      : listBulkImportFiles(BULK_IMPORT_DATA_MODULES[scenario.module]);
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one configured ${getModuleLabel(scenario.module)} input file, but found ${files.length}. Use the folder scenario runner when multiple files are intentional.`,
    );
  }
  return files[0];
}

function getModuleLabel(module: BulkImportModule): string {
  return MODULE_LABELS[module];
}

function normalizeStepDetails(details: string): string {
  return details
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n");
}

function createScenarioStep(): ScenarioStep {
  return async (number, name, details) => {
    await test.step(`Step ${number} - ${name}\nStatus: PASS\nDetails: ${normalizeStepDetails(details)}`, async () =>
      undefined);
  };
}

async function recordValidationStep(
  number: number,
  name: string,
  expected: string,
  actual: string,
  status: "PASS" | "FAIL" | "NOT RUN" = "PASS",
): Promise<void> {
  await test.step(`Step ${number} - ${name}\nStatus: ${status}\nExpected: ${normalizeStepDetails(expected)}\nActual: ${normalizeStepDetails(actual)}`, async () =>
    undefined);
}

/**
 * Captures the application's row-level validation details and attaches them
 * to the same Playwright report used by the rest of the framework.
 *
 * This intentionally remains separate from the scenario flow because both the
 * invalid-first/valid-second test and the normal bulk-import scenarios use it.
 */
export async function captureAndReportValidationErrors(
  bulkImportPage: BulkDataImportPage,
  filePath: string,
  uploadLabel: "Valid" | "Invalid" | "Input",
  reportLabel: string,
): Promise<
  Awaited<ReturnType<BulkDataImportPage["captureValidationResults"]>>
> {
  const validationErrors = await bulkImportPage.captureValidationResults();

  await test.info().attach(`Validation Errors - ${reportLabel}`, {
    body: `${uploadLabel} File: ${path.basename(filePath)}\n\nActual Application Validation Results:\n${validationErrors.summary}\n\n${validationErrors.details}`,
    contentType: "text/plain",
  });

  if (validationErrors.errorRows.length) {
    await test.info().attach(`Validation Error Rows - ${reportLabel}`, {
      body: JSON.stringify(validationErrors.errorRows),
      contentType: "application/json",
    });
  }

  for (const [index, screenshot] of validationErrors.screenshots.entries()) {
    await test
      .info()
      .attach(`Validation Error Screenshot - ${reportLabel} - ${index + 1}`, {
        body: screenshot,
        contentType: "image/png",
      });
  }

  if (validationErrors.expectedErrorCount !== null) {
    expect(
      validationErrors.errorRows.length,
      `Expected Error Rows: ${validationErrors.expectedErrorCount}; Captured Error Rows: ${validationErrors.errorRows.length}`,
    ).toBe(validationErrors.expectedErrorCount);
  }

  return validationErrors;
}

async function openBulkDataImport(
  page: Page,
  auditDashboardPage: AuditDashboardPage,
  scenario: BulkImportScenario,
  recordStep: ScenarioStep,
): Promise<BulkDataImportPage> {
  const { module, mode } = scenario;
  const moduleLabel = getModuleLabel(module);
  const modeLabel = MODE_LABELS[mode];

  await recordStep(1, "Login", "Login successful.");
  await expect(
    page.getByRole("button", { name: "Audit", exact: true }),
  ).toBeVisible({ timeout: 0 });
  await recordStep(2, "Dashboard", "Dashboard displayed.");

  console.log("[FLOW] Navigating to Technical");
  const technicalPage = await auditDashboardPage.goToTechnical();
  await recordStep(3, "Technical Module", "Technical module opened.");

  console.log("[FLOW] Opening Admin and Bulk Data Import");
  await technicalPage.openAdmin();
  await recordStep(4, "Admin Module", "Admin module opened.");

  const bulkImportPage = new BulkDataImportPage(page);
  await bulkImportPage.expectToBeOnPage();
  await recordStep(5, "Bulk Data Import", "Bulk Data Import page opened.");

  await bulkImportPage.selectVessel(config.vesselName);
  await recordStep(6, "Select Vessel", `${config.vesselName} selected.`);

  console.log(`[FLOW] Selecting ${moduleLabel} template`);
  if (module === "job") await bulkImportPage.openJobsTemplate();
  else if (module === "spares") await bulkImportPage.openSparesTemplate();
  else if (module === "location") await bulkImportPage.openLocationsTemplate();
  else if (module === "stores") {
    await bulkImportPage.openStoresTemplate();
    if (!scenario.storeType)
      throw new Error("A Store Type is required for Stores bulk import.");
    await bulkImportPage.selectStoreType(scenario.storeType);
    await recordStep(7, "Select Store Type", `${scenario.storeType} selected.`);
  } else await bulkImportPage.selectMachineryComponents();

  await bulkImportPage.openUploadTab();
  await recordStep(7, "Select Template", `${moduleLabel} template selected.`);

  if (module === "location") {
    await recordStep(
      8,
      "Select Import Mode",
      `${modeLabel} is the Locations template's built-in import behavior; this template does not display import-mode radios.`,
    );
  } else {
    console.log(`[FLOW] Selecting ${modeLabel}`);
    await bulkImportPage.selectImportMode(mode);
    await recordStep(8, "Select Import Mode", `${modeLabel} selected.`);
  }

  return bulkImportPage;
}

/**
 * Runs one independently executable bulk-import scenario.
 *
 * Every existing bulk-import spec remains a separate Playwright test file, so
 * a single scenario can still be run directly by filename or tag.
 */
export async function runBulkDataImportScenario(
  page: Page,
  auditDashboardPage: AuditDashboardPage,
  scenario: BulkImportScenario,
  uploadFileOverride?: string | (() => string),
): Promise<BulkImportRunResult> {
  test.setTimeout(0);

  const { module, mode } = scenario;
  const modeLabel = MODE_LABELS[mode];
  const moduleLabel = getModuleLabel(module);
  const recordStep = createScenarioStep();
  const bulkImportPage = await openBulkDataImport(
    page,
    auditDashboardPage,
    scenario,
    recordStep,
  );
  console.log(`[FLOW] Resolving configured ${moduleLabel} upload file`);
  let uploadFile = "";
  await test.step(`Step 9 - Resolve Upload File\nExpected: The configured ${moduleLabel} test-data file should resolve to an existing physical file.`, async () => {
    uploadFile =
      typeof uploadFileOverride === "function"
        ? uploadFileOverride()
        : (uploadFileOverride ?? getScenarioUploadFile(scenario));
    if (!fs.existsSync(uploadFile) || !fs.statSync(uploadFile).isFile()) {
      throw new Error(
        `Configured Bulk Import test file does not exist: ${uploadFile}`,
      );
    }
  });
  const uploadFileName = path.basename(uploadFile);
  console.log(`[FLOW] Resolved upload file: ${uploadFile}`);
  await test.info().attach(`Bulk Import File Attempt - ${uploadFileName}`, {
    body: JSON.stringify({
      fileName: uploadFileName,
      module: moduleLabel,
      importMode: modeLabel,
    }),
    contentType: "application/json",
  });
  await recordValidationStep(
    9,
    `Select File - ${uploadFileName}`,
    `The file resolved from the configured ${moduleLabel} test-data path should be selected.`,
    `Selected file: ${uploadFileName}.`,
  );
  console.log(
    `[FLOW] Sending file to browser upload control: ${uploadFileName}`,
  );
  await bulkImportPage.uploadFile(uploadFile);
  console.log(`[FLOW] File submitted: ${uploadFileName}`);
  await recordValidationStep(
    10,
    `Upload File - ${uploadFileName}`,
    "The selected file should be submitted to the application's Bulk Data Import upload control.",
    `File "${uploadFileName}" was submitted to the application's upload control.`,
  );

  console.log("[FLOW] Waiting for application upload validation");
  const uploadResponse = await bulkImportPage.waitForUploadResponse();
  console.log(
    `[FLOW] Application upload validation received: ${uploadResponse.status === "rejected" ? uploadResponse.message : "accepted"}`,
  );
  if (uploadResponse.status === "rejected") {
    const rejectionExpectation =
      scenario.expectedResult.outcome === "file-rejection"
        ? scenario.expectedResult
        : null;
    const expectedMessage = rejectionExpectation
      ? "The application should reject the selected file and display its upload validation message."
      : `The application should validate the uploaded ${moduleLabel} file and allow the normal ${modeLabel} import scenario to continue when upload requirements are satisfied.`;
    await test.info().attach(`Upload validation message - ${uploadFileName}`, {
      body: [
        `File: ${uploadFileName}`,
        `Expected Result: ${expectedMessage}`,
        `Actual Result: ${uploadResponse.message}`,
      ].join("\n\n"),
      contentType: "text/plain",
    });
    await test
      .info()
      .attach(`Upload validation screenshot - ${uploadFileName}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    await recordValidationStep(
      11,
      `Validate Uploaded File - ${uploadFileName}`,
      expectedMessage,
      `File "${uploadFileName}" was rejected by the application. UI Validation Message: ${uploadResponse.message}`,
      rejectionExpectation &&
        (!rejectionExpectation.errorPattern ||
          rejectionExpectation.errorPattern.test(uploadResponse.message))
        ? "PASS"
        : "FAIL",
    );
    await bulkImportPage.confirmFileStayedRejected();
    if (!rejectionExpectation) {
      await recordValidationStep(
        12,
        "Import Records",
        `Eligible ${moduleLabel} records should be imported successfully using ${modeLabel} mode.`,
        "NOT EXECUTED — application file validation prevented import.",
        "NOT RUN",
      );
      await recordValidationStep(
        13,
        "Post-Import Validation",
        `Successfully imported ${moduleLabel} records should be validated against the configured source data.`,
        "NOT EXECUTED — no records were imported.",
        "NOT RUN",
      );
      throw new Error(
        `The application rejected "${uploadFileName}" before import. UI Validation Message: ${uploadResponse.message}`,
      );
    }
    if (rejectionExpectation.errorPattern) {
      expect(
        uploadResponse.message,
        "The displayed validation message should match the explicit business requirement.",
      ).toMatch(rejectionExpectation.errorPattern);
    }
    return {
      uploadFile,
      validRows: 0,
      validationErrors: 0,
      rejectedWorkbookRows: [],
      imported: false,
    };
  }

  if (scenario.expectedResult.outcome === "file-rejection") {
    await test
      .info()
      .attach(`Unexpected upload acceptance - ${uploadFileName}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    await recordValidationStep(
      11,
      `Validate Uploaded File - ${uploadFileName}`,
      "The application should reject the selected negative-test file.",
      `The application accepted "${uploadFileName}" and continued to import validation.`,
      "FAIL",
    );
    throw new Error(
      `The application unexpectedly accepted the negative-test file "${uploadFileName}".`,
    );
  }
  await recordValidationStep(
    11,
    `Validate Uploaded File - ${uploadFileName}`,
    `The application should validate the uploaded ${moduleLabel} file and allow the ${modeLabel} import process to continue when upload requirements are satisfied.`,
    `The application accepted "${uploadFileName}" in ${modeLabel} mode and displayed import validation.`,
  );

  if (module === "location") {
    const importAction = (await bulkImportPage.getValidationResults())
      .importAction;
    await expect(
      importAction,
      "The application should accept the Location workbook and enable import",
    ).toBeEnabled();
    await recordStep(
      11,
      "Application Validation",
      "The Location workbook was accepted and Import Locations was enabled.",
    );
    await test.info().attach("Location workbook accepted", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await bulkImportPage.clickImportAction();
    await recordStep(12, "Import Records", "Import Locations selected.");
    const confirmation = await bulkImportPage.waitForLocationImportSuccess();
    await test.info().attach("Location import successful", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await recordStep(13, "Import Complete", confirmation);
    return {
      uploadFile,
      validRows: 0,
      validationErrors: 0,
      rejectedWorkbookRows: [],
      imported: true,
    };
  }

  const validationSummary = await bulkImportPage.waitForValidationComplete();
  const validation = await bulkImportPage.getValidationResults();
  const validationErrors = await captureAndReportValidationErrors(
    bulkImportPage,
    uploadFile,
    "Input",
    `${moduleLabel} - ${modeLabel}`,
  );
  const rejectedWorkbookRows = validationErrors.errorRows
    .map((error) => Number(String(error.row).match(/\d+/)?.[0]))
    .filter((row) => Number.isInteger(row) && row > 0);
  const validationMessage =
    validationSummary
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /validation complete|found \d+ error/i.test(line)) ??
    "Validation results displayed.";
  await test.info().attach("Validation results", {
    body: `Input File: ${uploadFileName}\n\n${validationSummary}`,
    contentType: "text/plain",
  });
  await test.info().attach("Validation screenshot", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  const errorCount =
    validationErrors.expectedErrorCount ?? validationErrors.errorRows.length;
  const validRowCount =
    validationErrors.validRows ?? Number(validation.validRows);
  await recordValidationStep(
    12,
    "Validate Import Data",
    `The application should validate the uploaded ${moduleLabel} records and identify records eligible for import using ${modeLabel} mode.`,
    `Application validation completed for "${uploadFileName}": ${validRowCount} valid rows, ${errorCount} validation-error rows, ${validation.warnings} warnings, ${validation.totalRows} total rows. ${validationMessage}`,
    validRowCount > 0 ||
      scenario.expectedResult.outcome === "validation-rejection"
      ? "PASS"
      : "FAIL",
  );

  if (scenario.expectedResult.outcome === "validation-rejection") {
    expect(
      validRowCount,
      "A validation-rejection scenario should not leave importable rows.",
    ).toBe(0);
    expect(
      validationErrors.expectedErrorCount ?? validationErrors.errorRows.length,
      "The application should return validation errors.",
    ).toBeGreaterThan(0);
    if (scenario.expectedResult.errorPattern) {
      expect(
        validationErrors.details,
        "The validation error should match the scenario expectation.",
      ).toMatch(scenario.expectedResult.errorPattern);
    }
    await recordValidationStep(
      13,
      "Verify Validation Rejection",
      "The file should be rejected during application data validation.",
      validationErrors.details,
    );
    return {
      uploadFile,
      validRows: 0,
      validationErrors:
        validationErrors.expectedErrorCount ??
        validationErrors.errorRows.length,
      rejectedWorkbookRows,
      imported: false,
    };
  }

  if (validRowCount === 0) {
    await recordValidationStep(
      13,
      "Import Records",
      `Eligible ${moduleLabel} records should be imported successfully using ${modeLabel} mode.`,
      "NOT EXECUTED — application data validation did not identify any eligible records.",
      "NOT RUN",
    );
    await recordValidationStep(
      14,
      "Post-Import Validation",
      `Successfully imported ${moduleLabel} records should be validated against the configured source data.`,
      "NOT EXECUTED — no records were imported.",
      "NOT RUN",
    );
    throw new Error(
      `The ${moduleLabel} scenario expected importable rows, but the application accepted none.`,
    );
  }

  if (validationErrors.expectedErrorCount !== 0) {
    const rowErrorHandling =
      scenario.expectedResult.outcome === "import" ||
      scenario.expectedResult.outcome === "from-file"
        ? scenario.expectedResult.rowErrors
        : "reject";
    expect(
      rowErrorHandling,
      "The workbook contains row errors, so the scenario must explicitly allow Skip Errors before import.",
    ).toBe("skip-and-import");
  }

  await validation.importAction.scrollIntoViewIfNeeded();
  await expect(validation.importAction).toBeVisible({ timeout: 0 });
  await expect(validation.importAction).toBeEnabled();
  const actionText = (await validation.importAction.innerText()).trim();
  await bulkImportPage.clickImportAction();
  await recordValidationStep(
    13,
    validationErrors.expectedErrorCount !== 0
      ? "Skip Errors & Import"
      : "Import Records",
    `Eligible ${moduleLabel} records should be imported successfully using ${modeLabel} mode.`,
    `Selected application action: ${actionText}.`,
  );

  if (validationErrors.expectedErrorCount !== 0) {
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toBeVisible({ timeout: 0 });
    const confirmationText = (
      await confirmation.locator("p").innerText()
    ).trim();
    await test.info().attach("Partial import confirmation screenshot", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await recordStep(13, "Partial Import Confirmation", confirmationText);

    await bulkImportPage.confirmPartialImport();
    await recordStep(
      14,
      "Proceed with Partial Import",
      "Partial import confirmed.",
    );
  }
  await expect(page.getByTestId("import-progress-overlay")).toBeVisible({
    timeout: 0,
  });
  await expect(page.getByTestId("import-complete-close")).toBeVisible({
    timeout: 0,
  });

  const completeDetails = await bulkImportPage.waitForImportComplete();
  await recordStep(15, "Import Processing", "Import processing completed.");
  await test.info().attach("Import complete screenshot", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await recordStep(16, "Import Complete", completeDetails);
  await bulkImportPage.closeImportComplete();

  const importSummary = await bulkImportPage.getImportSummary();
  const successfullyImported = Number(importSummary.successfullyImported);
  const importMatchesValidation = successfullyImported === validRowCount;
  const summaryDetails = `Total Records Processed: ${importSummary.totalProcessed}; Successfully Imported: ${importSummary.successfullyImported}; Failed Records: ${importSummary.failedRecords}.`;
  await recordValidationStep(
    17,
    "Import Result",
    `Eligible ${moduleLabel} records should be imported successfully using ${modeLabel} mode.`,
    summaryDetails,
    importMatchesValidation ? "PASS" : "FAIL",
  );
  expect(
    successfullyImported,
    "Successfully Imported should match the valid row count reported before import.",
  ).toBe(validRowCount);
  await test.info().attach("Import summary screenshot", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await bulkImportPage.closeDialog();
  return {
    uploadFile,
    validRows: validRowCount,
    validationErrors:
      validationErrors.expectedErrorCount ?? validationErrors.errorRows.length,
    rejectedWorkbookRows,
    imported: true,
  };
}

/**
 * Executes every configured file without predicting extension, size, or validity.
 * Each file is submitted to the application and classified only by the UI response.
 */
export async function runBulkDataImportFolderScenario(
  page: Page,
  auditDashboardPage: AuditDashboardPage,
  scenario: Omit<BulkImportScenario, "expectedResult"> & {
    rowErrors: "skip-and-import" | "reject";
    testDataFolder?: string;
  },
): Promise<BulkImportFolderRunResult[]> {
  const files = scenario.testDataFolder
    ? listBulkImportFilesInFolder(scenario.testDataFolder)
    : scenario.module === "location"
      ? listBulkImportFilesInFolder("test-data/location")
      : listBulkImportFiles(BULK_IMPORT_DATA_MODULES[scenario.module]);
  const plan: Array<{
    category: BulkImportFolderRunResult["category"];
    file: string;
    expectedResult: BulkImportExpectedResult;
  }> = files.map((file) => ({
    category: "attempted" as const,
    file,
    expectedResult: {
      outcome: "from-file" as const,
      rowErrors: scenario.rowErrors,
    },
  }));
  const results: BulkImportFolderRunResult[] = [];
  const failures: string[] = [];
  for (const item of plan) {
    try {
      const result = await runBulkDataImportScenario(
        page,
        auditDashboardPage,
        {
          module: scenario.module,
          mode: scenario.mode,
          storeType: scenario.storeType,
          expectedResult: item.expectedResult,
        },
        item.file,
      );
      results.push({ category: item.category, result });
    } catch (error) {
      failures.push(
        `${path.basename(item.file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const successfulImports = results.filter(({ result }) => result.imported);
  const importedFileNames = successfulImports.map(({ result }) =>
    path.basename(result.uploadFile),
  );

  if (successfulImports.length === 0) {
    const actual = `${plan.length} configured file attempt(s) were submitted to the application, but none reached a successful final import result.`;
    await recordValidationStep(
      18,
      "Final Import Result",
      `${getModuleLabel(scenario.module)} data should be successfully imported in ${MODE_LABELS[scenario.mode]} mode.`,
      actual,
      "FAIL",
    );
    failures.push(actual);
  } else {
    await recordValidationStep(
      18,
      "Final Import Result",
      `${getModuleLabel(scenario.module)} data should be successfully imported in ${MODE_LABELS[scenario.mode]} mode.`,
      `Import completed successfully for: ${importedFileNames.join(", ")}.`,
      "PASS",
    );
  }

  expect(
    failures,
    `Bulk-import scenario did not reach its required successful import outcome:\n${failures.join("\n\n")}`,
  ).toEqual([]);
  return results;
}

export async function runBulkImportFileValidationScenario(
  page: Page,
  auditDashboardPage: AuditDashboardPage,
  scenario: "file-size-validation" | "invalid-file-type",
): Promise<void> {
  const isFileSize = scenario === "file-size-validation";
  const directory = isFileSize
    ? "test-data/bulk-import/file-size-validation"
    : "test-data/bulk-import";
  const uploadFile = getFirstFileFromFolder(directory);

  if (isFileSize) {
    const fileSize = fs.statSync(uploadFile).size;
    await test.info().attach("File size validation input", {
      body: `File: ${path.basename(uploadFile)}\nSize: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`,
      contentType: "text/plain",
    });
  }

  await runBulkDataImportScenario(
    page,
    auditDashboardPage,
    {
      module: "components",
      mode: "addAndUpdate",
      expectedResult: {
        outcome: "file-rejection",
        reason: isFileSize ? "maximum-size" : "unsupported-file-type",
      },
    },
    uploadFile,
  );
}
