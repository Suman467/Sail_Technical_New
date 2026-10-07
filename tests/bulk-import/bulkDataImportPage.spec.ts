import { test, expect } from "@playwright/test";
import { BulkDataImportPage } from "../../pages/BulkDataImportPage";
import { captureAndReportValidationErrors } from "./bulkDataImportScenario";

test("captures the complete visible unsupported-file toast as the actual UI result", async ({
  page,
}) => {
  await page.setContent(`
    <main><h1>Bulk Data Import</h1></main>
    <section data-sonner-toast data-type="error">
      <strong>Invalid File</strong>
      <div>Please upload a .xlsx, .xls, or .csv file</div>
    </section>
  `);

  const bulkImportPage = new BulkDataImportPage(page);
  await expect(bulkImportPage.waitForUploadResponse(1_000)).resolves.toEqual({
    status: "rejected",
    message: "Invalid File Please upload a .xlsx, .xls, or .csv file",
  });
  await expect(
    bulkImportPage.captureFileValidationMessage(1_000),
  ).resolves.toBe("Invalid File Please upload a .xlsx, .xls, or .csv file");
});

test("detects application upload acceptance from validation results", async ({
  page,
}) => {
  await page.setContent(`
    <h2>Validation Results</h2>
    <button>Import 1 Records</button>
  `);
  const bulkImportPage = new BulkDataImportPage(page);
  await expect(bulkImportPage.waitForUploadResponse(1_000)).resolves.toEqual({
    status: "accepted",
  });
});

// Local UI fixtures exercise the shared workflow without uploading vessel data.
for (const mode of ["Add Only", "Update Only", "Add + Update"]) {
  for (const hasErrors of [false, true]) {
    test(`shared bulk import: ${mode}, ${hasErrors ? "partial" : "zero errors"}`, async ({
      page,
    }) => {
      const accepted = ["Engine", "Pump", "Generator"];
      const rejected = hasErrors
        ? [
            {
              row: "5",
              dataPreview: "Invalid engine",
              errorDetails: "Missing code",
            },
            {
              row: "6",
              dataPreview: "Invalid pump",
              errorDetails: "Missing name",
            },
          ]
        : [];
      const action = hasErrors
        ? `Skip Errors & Import ${accepted.length} Valid Rows`
        : `Import ${accepted.length} Records`;
      await page.setContent(`
        ${["Add Only", "Update Only", "Add + Update"].map((label) => `<label><input type="radio" name="mode" ${label === mode ? "checked" : ""}>${label}</label>`).join("")}
        <h2>Validation Results</h2>
        <p>Warnings: 0 ${!hasErrors && mode === "Add + Update" ? "" : `Errors: ${rejected.length}`} Total Rows: ${accepted.length + rejected.length}</p>
        <button onclick="document.getElementById('${hasErrors ? "confirmation" : "complete"}').hidden = false">${action}</button>
        ${hasErrors ? '<button data-testid="button-view-errors" onclick="document.getElementById(\'errors\').hidden = false">View All Errors</button>' : ""}
        <div role="dialog" id="errors" hidden>
          <h2>Error Details (${rejected.length} rows)</h2>
          <table><thead><tr><th>Row</th><th>Data Preview</th><th>Error Details</th></tr></thead>
            <tbody>${rejected.map((row) => `<tr><td>${row.row}</td><td>${row.dataPreview}</td><td>${row.errorDetails}</td></tr>`).join("")}</tbody>
          </table>
          <button onclick="document.getElementById('errors').hidden = true">Close</button>
        </div>
        <div role="alertdialog" id="confirmation" hidden>
          <p>Proceed with partial import?</p>
          <button onclick="document.getElementById('confirmation').hidden = true; document.getElementById('complete').hidden = false">Proceed with Partial Import</button>
        </div>
        <div id="complete" hidden>
          <h2>Import Complete</h2>
          <div><span>Created</span> ${accepted.length}</div>
          <div><span>Updated</span> 0</div><div><span>Skipped</span> ${rejected.length}</div><div><span>Failed</span> 0</div>
          <button data-testid="import-complete-close">Close import</button>
        </div>
      `);
      const bulkImportPage = new BulkDataImportPage(page);
      if (!hasErrors) {
        // A zero-error result must not even query the error-view control.
        Object.defineProperty(bulkImportPage, "viewAllErrorsButton", {
          get: () => {
            throw new Error("Zero-error validation queried View All Errors");
          },
        });
      }
      const validation = await bulkImportPage.getValidationResults();
      expect(validation.validRows).toBe(String(accepted.length));
      expect(validation.errors).toBe(String(rejected.length));
      await expect(validation.importAction).toHaveText(action);

      const captured = await captureAndReportValidationErrors(
        bulkImportPage,
        "fixture.xlsx",
        "Valid",
        mode,
      );
      expect(captured.errorRows).toEqual(rejected);
      expect(captured.validRows).toBe(accepted.length);
      expect(captured.expectedErrorCount).toBe(rejected.length);
      expect(captured.screenshots).toHaveLength(hasErrors ? 1 : 0);
      await expect(page.getByRole("dialog")).toBeHidden();
      const attachments = test.info().attachments;
      expect(
        attachments.find((item) => item.name === `Validation Errors - ${mode}`)
          ?.contentType,
      ).toBe("text/plain");
      if (hasErrors) {
        const rows = attachments.find(
          (item) => item.name === `Validation Error Rows - ${mode}`,
        );
        expect(rows?.contentType).toBe("application/json");
        expect(JSON.parse(rows!.body!.toString())).toEqual(rejected);
        expect(
          attachments.find(
            (item) => item.name === `Validation Error Screenshot - ${mode} - 1`,
          )?.contentType,
        ).toBe("image/png");
      } else {
        expect(captured.details).toContain(
          "Actual Application Result: No validation errors returned by the application.",
        );
        expect(await bulkImportPage.getValidationErrors()).toEqual([]);
      }

      // Verify both legacy entry points and the new generic entry point.
      if (mode === "Add Only") await bulkImportPage.clickImportAction();
      else if (mode === "Update Only")
        await bulkImportPage.clickSkipErrorsAndImport();
      else await bulkImportPage.submitImport();
      if (hasErrors) await bulkImportPage.confirmPartialImport();
      else await expect(page.getByRole("alertdialog")).toBeHidden();
      expect(await bulkImportPage.waitForImportComplete()).toContain(
        `Created: ${accepted.length}`,
      );
    });
  }
}
