import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/baseFixture";
import type { AuditDashboardPage } from "../../../pages/AuditDashboardPage";
import { BulkDataImportPage } from "../../../pages/BulkDataImportPage";
import { config } from "../../../utils/config";
import { listBulkImportFilesInFolder } from "../../../utils/testDataFile";

const IMPORT_MODE = "Add + Update (built-in Location behavior)";

type PlannedStep = {
  name: string;
  expected: string;
};

const plannedSteps: PlannedStep[] = [
  { name: "Open Technical", expected: "The Technical module should open." },
  { name: "Open Bulk Data Import", expected: "The Admin Bulk Data Import page should open." },
  { name: "Select Vessel", expected: `The configured vessel ${config.vesselName} should be selected.` },
  { name: "Select Location Template", expected: "The Location bulk-import template should open." },
  { name: "Select Import Mode", expected: `The Location import should use ${IMPORT_MODE}.` },
  { name: "Resolve Location Workbook", expected: "Exactly one existing Excel workbook should be found in test-data/location." },
  { name: "Upload Location Workbook", expected: "The selected Location workbook should be submitted for application validation." },
  { name: "Capture Upload Response", expected: "The application should display its actual acceptance or rejection response." },
  { name: "Review Import Validation", expected: "The application should show the import summary and any validation errors that are available." },
  { name: "Import Location Records", expected: "The application should enable and run the Location import only after accepting the workbook." },
  { name: "Verify Final Import Result", expected: "The application should display a final Location import result and any available created, updated, rejected, or error counts." },
];

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function recordStep(number: number, actual: string, status: "PASS" | "FAIL" | "NOT EXECUTED" = "PASS"): Promise<void> {
  const step = plannedSteps[number - 1];
  await test.step(
    `Step ${number} - ${step.name}\nExpected: ${step.expected}\nActual: ${clean(actual)}\nStatus: ${status}`,
    async () => undefined,
  );
}

export async function runLocationValidation(page: Page, auditDashboardPage: AuditDashboardPage): Promise<void> {
  test.setTimeout(12 * 60 * 1000);
  let completedSteps = 0;

  try {
    const technicalPage = await auditDashboardPage.goToTechnical();
    await recordStep(++completedSteps, "The Technical module opened from the authenticated application session.");

    await technicalPage.openAdmin();
    const bulkImportPage = new BulkDataImportPage(page);
    await bulkImportPage.expectToBeOnPage();
    await recordStep(++completedSteps, "Admin opened the Bulk Data Import page.");

    await bulkImportPage.selectVessel(config.vesselName);
    await recordStep(++completedSteps, `Vessel selected: ${config.vesselName}.`);

    await bulkImportPage.openLocationsTemplate();
    await bulkImportPage.openUploadTab();
    await recordStep(++completedSteps, "The Location template and its Upload tab opened.");

    await recordStep(++completedSteps, `${IMPORT_MODE} is used; the Location template does not display separate import-mode controls.`);

    const files = listBulkImportFilesInFolder("test-data/location");
    expect(files, "test-data/location should contain exactly one Location workbook").toHaveLength(1);
    const workbook = files[0];
    expect(fs.existsSync(workbook), `Location workbook should exist: ${workbook}`).toBe(true);
    expect(fs.statSync(workbook).isFile(), `Location workbook should be a file: ${workbook}`).toBe(true);
    const fileName = path.basename(workbook);
    await test.info().attach(`Bulk Import File Attempt - ${fileName}`, {
      body: JSON.stringify({
        fileName,
        module: "Location",
        importMode: IMPORT_MODE,
        vessel: config.vesselName,
      }),
      contentType: "application/json",
    });
    await recordStep(++completedSteps, `Existing workbook selected: ${fileName}.`);

    await bulkImportPage.uploadFile(workbook);
    await recordStep(++completedSteps, `Workbook ${fileName} was submitted to the Location upload control.`);

    const response = await bulkImportPage.waitForUploadResponse();
    if (response.status === "rejected") {
      await test.info().attach("Actual Location import response", { body: response.message, contentType: "text/plain" });
      await recordStep(++completedSteps, `The application rejected ${fileName}. Actual message: ${response.message}`, "FAIL");
      await recordStep(++completedSteps, "The workbook did not reach import validation because the application rejected it.", "NOT EXECUTED");
      await recordStep(++completedSteps, "The import action was not reached because the workbook was rejected.", "NOT EXECUTED");
      await recordStep(++completedSteps, "The final import result was not reached because the workbook was rejected.", "NOT EXECUTED");
      throw new Error(`Location workbook rejected by the application: ${response.message}`);
    }

    const validation = await bulkImportPage.getValidationResults();
    const uploadMessage = `Workbook ${fileName} was accepted and the Import Locations action was displayed.`;
    await test.info().attach("Actual Location import response", { body: uploadMessage, contentType: "text/plain" });
    await recordStep(++completedSteps, `The application accepted ${fileName}. Actual response: ${uploadMessage}`);

    const validationErrors = validation.errors;
    await recordStep(
      ++completedSteps,
      `Validation summary: ${uploadMessage} Valid: ${validation.validRows}; Warnings: ${validation.warnings}; Errors/Rejected: ${validationErrors}; Total rows: ${validation.totalRows}.`,
    );

    await expect(validation.importAction, "Accepted Location data should enable Import Locations").toBeVisible();
    await expect(validation.importAction, "Accepted Location data should enable Import Locations").toBeEnabled();
    const actionText = clean(await validation.importAction.innerText());
    await bulkImportPage.clickImportAction();
    await recordStep(++completedSteps, `The enabled application action "${actionText}" was selected.`);

    await bulkImportPage.waitForLocationImportSuccess();
    const successTitle = page.getByText(/^Import Successful$/i).last();
    const successDetails = page.getByText(/^\d+ created, \d+ updated, \d+ skipped\.$/i).last();
    await expect(successTitle, "The Location import should display its success title").toBeVisible();
    await expect(successDetails, "The Location import should display its exact result counts").toBeVisible();
    const titleText = clean(await successTitle.innerText());
    const detailsText = clean(await successDetails.innerText());
    const countMatch = detailsText.match(/^(\d+) created, (\d+) updated, (\d+) skipped\.$/i);
    const countSummary = countMatch
      ? `Created: ${countMatch[1]}; Updated: ${countMatch[2]}; Rejected/Skipped: ${countMatch[3]}; Errors: Not displayed.`
      : "Created, updated, rejected/skipped, and error counts were not displayed in the expected summary format.";
    const finalMessage = `${titleText} — ${detailsText}`;
    await test.info().attach("Location final import result", {
      body: `Actual import response: ${finalMessage}\n${countSummary}`,
      contentType: "text/plain",
    });
    await test.info().attach("Location import result screenshot", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await recordStep(++completedSteps, `Actual import response: ${finalMessage} ${countSummary}`);
  } catch (error) {
    while (completedSteps < plannedSteps.length) {
      await recordStep(++completedSteps, "NOT EXECUTED because the preceding application stage did not complete.", "NOT EXECUTED");
    }
    throw error;
  }
}
