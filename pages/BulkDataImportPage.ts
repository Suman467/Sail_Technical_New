/* global document, HTMLElement */
import { expect, type Locator, type Page } from "@playwright/test";
import { config } from "../utils/config";
import { routes } from "../utils/routes";
import { BasePage } from "./BasePage";

/**
 * Models the Bulk Data Import page in the Admin module (PMS > Admin > Bulk Data Imp).
 * Covers the shared shell (vessel selector, template tabs, import mode, upload/history tabs)
 * used by Machinery Components, Jobs, Spares, Stores, and Locations templates.
 */
export class BulkDataImportPage extends BasePage {
  protected readonly path = routes.bulkDataImportPage;
  protected readonly pageName = "Bulk Data Import";
  protected readonly pageLoadedIndicator: Locator;

  private readonly vesselDropdown: Locator;
  private readonly bulkImportContent: Locator;
  private readonly importHistoryButton: Locator;
  private readonly machineryComponentsTemplate: Locator;
  private readonly jobsTemplate: Locator;
  private readonly sparesTemplate: Locator;
  private readonly storesTemplate: Locator;
  private readonly locationsTemplate: Locator;
  private readonly uploadPanelTitle: Locator;
  private readonly downloadTemplateButton: Locator;
  private readonly uploadTabPanel: Locator;
  private readonly uploadSubTab: Locator;
  private readonly fieldMappingGuideSubTab: Locator;
  private readonly historySubTab: Locator;
  private readonly addOnlyRadio: Locator;
  private readonly updateOnlyRadio: Locator;
  private readonly addAndUpdateRadio: Locator;
  private readonly fileInput: Locator;
  private readonly removeSelectedFileButton: Locator;
  private readonly revalidateButton: Locator;
  private readonly importValidRowsButton: Locator;
  private readonly viewAllErrorsButton: Locator;
  private readonly proceedWithPartialImportButton: Locator;
  private readonly importCompleteCloseButton: Locator;
  private readonly closeDialogButton: Locator;
  private readonly validationErrorDialog: Locator;
  private readonly validationErrorTable: Locator;
  private readonly validationErrorCountHeading: Locator;
  private readonly validationErrorList: Locator;
  private readonly fileValidationMessages: Locator;

  /**
   * What this does: Creates the Bulk Data Import page object and collects the key selectors used on that screen.
   * When it's used: When a test needs to work with bulk import of Components, Jobs, or Spares.
   * @param page - The Playwright page instance for the Admin > Bulk Data Import screen.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole("heading", {
      name: "Bulk Data Import",
      exact: true,
    });
    this.bulkImportContent = page.getByRole("tabpanel", {
      name: "Bulk Data Imp",
    });
    this.vesselDropdown = page.getByRole("combobox").first();
    this.importHistoryButton = page.getByRole("button", {
      name: "Import History",
      exact: true,
    });

    // Prefer the visible button/label for the template; this is more stable than the n-th child CSS hook and still matches the same template entry.
    this.machineryComponentsTemplate = page
      .getByRole("button", { name: /Machinery Components/i })
      .first();
    this.jobsTemplate = page.getByRole("button", { name: "2. Jobs" });
    this.sparesTemplate = page.getByRole("button", { name: "3. Spares" });
    this.storesTemplate = page.getByRole("button", { name: "4. Stores" });
    this.locationsTemplate = page.getByRole("button", { name: "5. Locations" });

    this.uploadPanelTitle = page.getByRole("heading", {
      name: "Machinery Component Upload",
      exact: true,
    });
    this.downloadTemplateButton = page.getByRole("button", {
      name: "Download Template",
      exact: true,
    });
    this.uploadTabPanel = page.getByRole("tabpanel", { name: "Upload" });
    this.uploadSubTab = page.getByRole("tab", { name: "Upload", exact: true });
    this.fieldMappingGuideSubTab = page.getByRole("tab", {
      name: "Field Mapping Guide",
      exact: true,
    });
    this.historySubTab = page.getByRole("tab", {
      name: "History",
      exact: true,
    });

    this.addOnlyRadio = page.getByRole("radio", { name: /Add Only/i });
    this.updateOnlyRadio = page.getByRole("radio", { name: /Update Only/i });
    this.addAndUpdateRadio = page.getByRole("radio", {
      name: /Add \+ Update/i,
    });

    this.fileInput = page
      .getByTestId("input-file-upload")
      .or(page.locator('input[type="file"]'))
      .first();
    this.removeSelectedFileButton = page.locator(".absolute.right-2");
    this.revalidateButton = page.getByTestId("button-revalidate");
    this.importValidRowsButton = page.getByRole("button", {
      name: /^(?:Import \d+ Records|Skip Errors & Import \d+ Valid Rows|Import Locations)$/,
    });
    this.viewAllErrorsButton = page.getByTestId("button-view-errors");
    this.proceedWithPartialImportButton = page.getByRole("button", {
      name: "Proceed with Partial Import",
    });
    this.importCompleteCloseButton = page.getByTestId("import-complete-close");
    this.closeDialogButton = page.getByRole("button", { name: "Close" });
    this.validationErrorDialog = page.getByRole("dialog");
    this.validationErrorTable = this.validationErrorDialog
      .locator("table")
      .first();
    this.validationErrorCountHeading = this.validationErrorDialog.getByRole(
      "heading",
      { name: /Error Details\s*\(\s*[\d,]+\s+rows?\s*\)/i },
    );

    // TODO: confirm the real alert/error container after a failing upload; this is the most likely shared DOM for inline validation text.
    this.validationErrorList = page.locator(
      '[role="alert"], [data-testid*="error"], .text-red-500, .text-destructive',
    );
    this.fileValidationMessages = page.locator(
      [
        '[role="alert"]',
        '[role="alertdialog"]',
        '[data-testid*="toast" i]',
        '[data-testid*="error-message" i]',
        '[data-testid*="validation-message" i]',
        "[data-sonner-toast]",
        "[data-hot-toast]",
        ".toast",
        ".Toastify__toast",
        '[class*="toast" i]',
        '[class*="snackbar" i]',
        '[class*="notification" i]',
        '[class*="bg-red-"]',
        '[class*="bg-destructive"]',
        ".text-destructive",
        ".text-red-500",
      ].join(", "),
    );
  }

  /**
   * What this does: Selects a vessel from the dropdown on the Bulk Data Import page.
   * When it's used: Before uploading data, since all imports are associated with the selected vessel.
   * @param name - The vessel name to select.
   * @returns Nothing
   */
  public async selectVessel(name = config.vesselName): Promise<void> {
    await expect(
      this.pageLoadedIndicator,
      "The Bulk Data Import page should be ready before selecting a vessel",
    ).toBeVisible();
    await this.vesselDropdown.click();
    await this.page.getByRole("option", { name, exact: true }).click();
  }

  /**
   * What this does: Opens the Machinery Components import template.
   * When it's used: In tests covering bulk import of Components.
   * @returns Nothing
   */
  public async openMachineryComponentsTemplate(): Promise<void> {
    await this.machineryComponentsTemplate.click();
    await expect(
      this.uploadPanelTitle,
      "The Machinery Components template should open after the icon is clicked",
    ).toBeVisible();
  }

  /**
   * What this does: Opens the Jobs import template.
   * When it's used: In tests covering bulk import of Jobs.
   * @returns Nothing
   */
  public async openJobsTemplate(): Promise<void> {
    await this.jobsTemplate.click();
  }

  /**
   * What this does: Opens the Spares import template.
   * When it's used: In tests covering bulk import of Spares.
   * @returns Nothing
   */
  public async openSparesTemplate(): Promise<void> {
    await this.sparesTemplate.click();
  }

  public async openStoresTemplate(): Promise<void> {
    await this.storesTemplate.click();
  }

  public async openLocationsTemplate(): Promise<void> {
    await this.locationsTemplate.click();
  }

  public async selectStoreType(
    storeType: "Stores" | "Lubes" | "Chemicals" | "Others",
  ): Promise<void> {
    const storeTypeDropdown = this.page.getByRole("combobox").nth(1);
    await storeTypeDropdown.click();
    await this.page
      .getByRole("option", { name: storeType, exact: true })
      .click();
    await expect(storeTypeDropdown).toContainText(storeType);
  }

  /**
   * What this does: Selects the import mode (Add Only / Update Only / Add + Update).
   * When it's used: Before uploading a file, to control how existing records are handled.
   * @param mode - Which import mode radio to select.
   * @returns Nothing
   */
  public async selectImportMode(
    mode: "addOnly" | "updateOnly" | "addAndUpdate",
  ): Promise<void> {
    const radio =
      mode === "addOnly"
        ? this.addOnlyRadio
        : mode === "updateOnly"
          ? this.updateOnlyRadio
          : this.addAndUpdateRadio;
    await radio.check();
    await expect(radio).toBeChecked();
  }

  public async selectAddOnlyMode(): Promise<void> {
    await this.selectImportMode("addOnly");
  }

  public async selectUpdateOnlyMode(): Promise<void> {
    await this.selectImportMode("updateOnly");
  }

  public async selectAddAndUpdateMode(): Promise<void> {
    await this.selectImportMode("addAndUpdate");
  }

  public async selectMachineryComponents(): Promise<void> {
    await this.openMachineryComponentsTemplate();
  }

  /**
   * What this does: Downloads the import template file for the currently selected entity/template.
   * When it's used: When a test needs to prepare a valid upload file based on the current template.
   * @returns Nothing
   */
  public async downloadTemplate(): Promise<void> {
    const [download] = await Promise.all([
      this.page.waitForEvent("download"),
      this.downloadTemplateButton.click(),
    ]);
    await download.saveAs(`./downloads/${download.suggestedFilename()}`);
  }

  /**
   * What this does: Opens the Upload tab within the selected template.
   * When it's used: Before attaching a file or reading validation information.
   * @returns Nothing
   */
  public async openUploadTab(): Promise<void> {
    await this.uploadSubTab.click();
    await expect(
      this.uploadTabPanel,
      "The Upload panel should be active before file handling",
    ).toBeVisible();
  }

  public async waitForValidationComplete(): Promise<string> {
    await expect(
      this.page.getByText("Validation Results", { exact: true }),
    ).toBeVisible();
    return this.getUploadSummary();
  }

  /** Captures the summary, full popup error list, and first-view popup screenshot. */
  public async captureValidationResults(): Promise<{
    validRows: number | null;
    expectedErrorCount: number | null;
    summary: string;
    details: string;
    errorRows: { row: string; dataPreview: string; errorDetails: string }[];
    screenshots: Buffer[];
  }> {
    await this.waitForValidationComplete();
    const summary = await this.getValidationResults();
    const validCountText =
      summary.validRows === "Not displayed" ? undefined : summary.validRows;
    const validRows =
      validCountText === undefined ? null : Number(validCountText);
    let expectedErrorCount: number | null =
      summary.errors === "Not displayed" ? null : Number(summary.errors);
    let errorRows: {
      row: string;
      dataPreview: string;
      errorDetails: string;
    }[] = [];
    const screenshots: Buffer[] = [];
    if (
      expectedErrorCount !== 0 &&
      (expectedErrorCount !== null ||
        (await this.viewAllErrorsButton.isVisible()))
    ) {
      await this.viewAllErrorsButton.click();
      await expect(this.validationErrorDialog).toBeVisible();
      await expect(
        this.validationErrorCountHeading,
        "The Error Details dialog should display its dynamic row count",
      ).toBeVisible();
      screenshots.push(
        await this.validationErrorDialog.screenshot({ animations: "disabled" }),
      );
      const countText = await this.validationErrorCountHeading.innerText();
      const countMatch = countText.match(
        /Error Details\s*\(\s*([\d,]+)\s+rows?\s*\)/i,
      );
      expectedErrorCount = countMatch
        ? Number(countMatch[1].replace(/,/g, ""))
        : null;
      errorRows = await this.readAllValidationErrorRows(expectedErrorCount);
      const dialogClose = this.validationErrorDialog.getByRole("button", {
        name: /close/i,
      });
      if (
        (await dialogClose.count()) &&
        (await dialogClose.first().isVisible())
      )
        await dialogClose.first().click();
      else await this.page.keyboard.press("Escape");
      await expect(this.validationErrorDialog).toBeHidden();
    } else if (expectedErrorCount === null) {
      expectedErrorCount = 0;
    }

    const noErrors = expectedErrorCount === 0 && errorRows.length === 0;
    const details = [
      `Validation Errors - ${await this.getSelectedImportModeLabel()}`,
      `Total Errors: ${expectedErrorCount ?? summary.errors}`,
      ...(noErrors
        ? [
            "Actual Application Result: No validation errors returned by the application.",
            "Automation Result: No validation errors returned by the application.",
          ]
        : expectedErrorCount === null
          ? []
          : [
              `Actual Application Result: Error Details (${expectedErrorCount} rows)`,
            ]),
      ...(expectedErrorCount === null || noErrors
        ? []
        : [`Expected Error Rows: ${expectedErrorCount}`]),
      `Error Rows Captured: ${errorRows.length}`,
      ...(expectedErrorCount === null || noErrors
        ? []
        : [
            `Automation Result: Captured ${errorRows.length} unique validation errors; ${errorRows.length === expectedErrorCount ? "PASS" : "FAIL"}`,
          ]),
      ...(errorRows.length
        ? [
            "",
            "Row | Data Preview | Error Details",
            ...errorRows.map(
              (error) =>
                `${error.row} | ${error.dataPreview} | ${error.errorDetails}`,
            ),
          ]
        : []),
    ].join("\n");
    return {
      validRows,
      expectedErrorCount,
      summary: summary.summary,
      details,
      errorRows,
      screenshots,
    };
  }

  private async inspectValidationErrorTable(
    action: "read" | "top" | "next" = "read",
  ): Promise<{
    rows: { row: string; dataPreview: string; errorDetails: string }[];
    scrollable: boolean;
    atBottom: boolean;
    moved: boolean;
  }> {
    await expect(
      this.validationErrorTable,
      "The validation error table should be visible",
    ).toBeVisible();
    return this.validationErrorTable.evaluate((tableElement, scrollAction) => {
      const headers = Array.from(
        tableElement.querySelectorAll<HTMLElement>(
          'thead th, [role="columnheader"]',
        ),
      ).map((header) => header.innerText.trim().toLowerCase());
      const rowColumn = headers.findIndex((header) =>
        /^row(?:\s|$|#)/i.test(header),
      );
      const previewColumn = headers.findIndex((header) =>
        /data\s*preview|preview/i.test(header),
      );
      const errorColumn = headers.findIndex((header) =>
        /error|detail/i.test(header),
      );
      const htmlRows = Array.from(
        tableElement.querySelectorAll<HTMLElement>("tbody tr"),
      );
      const rowElements = htmlRows.length
        ? htmlRows
        : Array.from(
            tableElement.querySelectorAll<HTMLElement>('[role="row"]'),
          );
      const rows = rowElements.flatMap((rowElement) => {
        const cellElements = Array.from(
          rowElement.querySelectorAll<HTMLElement>(
            ':scope > td, :scope > [role="cell"], :scope > [role="gridcell"]',
          ),
        );
        const cells = cellElements.map((cell) => cell.innerText.trim());
        if (cells.length < 3) return [];
        const row = cells[rowColumn >= 0 ? rowColumn : 0] ?? "";
        const dataPreview = cells[previewColumn >= 0 ? previewColumn : 1] ?? "";
        const errorDetails = cells[errorColumn >= 0 ? errorColumn : 2] ?? "";
        if (
          /^row\s*$/i.test(row) &&
          /^data\s*preview\s*$/i.test(dataPreview) &&
          /^(?:errors?|error details)\s*$/i.test(errorDetails)
        )
          return [];
        return row || dataPreview || errorDetails
          ? [{ row, dataPreview, errorDetails }]
          : [];
      });
      let scrollContainer: HTMLElement | null = tableElement.parentElement;
      while (scrollContainer && scrollContainer !== document.body) {
        if (scrollContainer.scrollHeight > scrollContainer.clientHeight + 1)
          break;
        if (scrollContainer.getAttribute("role") === "dialog") {
          scrollContainer = null;
          break;
        }
        scrollContainer = scrollContainer.parentElement;
      }
      if (
        scrollContainer?.getAttribute("role") !== "dialog" &&
        scrollContainer &&
        scrollContainer.scrollHeight <= scrollContainer.clientHeight + 1
      ) {
        scrollContainer = null;
      }
      let moved = false;
      let atBottom = true;
      if (scrollContainer) {
        const maxScrollTop = Math.max(
          0,
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
        );
        if (scrollAction === "top") scrollContainer.scrollTop = 0;
        if (scrollAction === "next") {
          const previous = scrollContainer.scrollTop;
          scrollContainer.scrollTop = Math.min(
            previous + Math.max(scrollContainer.clientHeight * 0.75, 1),
            maxScrollTop,
          );
          moved = scrollContainer.scrollTop > previous;
        }
        atBottom = maxScrollTop - scrollContainer.scrollTop <= 1;
      }
      return { rows, scrollable: Boolean(scrollContainer), atBottom, moved };
    }, action);
  }

  private async readAllValidationErrorRows(
    expectedCount: number | null,
  ): Promise<{ row: string; dataPreview: string; errorDetails: string }[]> {
    if (expectedCount === null)
      throw new Error(
        "The Error Details popup did not provide a readable validation row count.",
      );
    const collected = new Map<
      string,
      { row: string; dataPreview: string; errorDetails: string }
    >();
    const seenPages = new Set<string>();
    while (true) {
      let view = await this.inspectValidationErrorTable("top");
      const firstPageInitialCount = view.rows.length;
      if (firstPageInitialCount >= expectedCount) {
        for (const error of view.rows)
          collected.set(
            `${error.row}\n${error.dataPreview}\n${error.errorDetails}`,
            error,
          );
        break;
      }
      while (true) {
        for (const error of view.rows)
          collected.set(
            `${error.row}\n${error.dataPreview}\n${error.errorDetails}`,
            error,
          );
        if (!view.scrollable || view.atBottom) break;
        const previousSignature = view.rows
          .map(
            (error) =>
              `${error.row}\n${error.dataPreview}\n${error.errorDetails}`,
          )
          .join("\n---\n");
        const scroll = await this.inspectValidationErrorTable("next");
        if (!scroll.moved) break;
        view = await this.inspectValidationErrorTable();
        const nextSignature = view.rows
          .map(
            (error) =>
              `${error.row}\n${error.dataPreview}\n${error.errorDetails}`,
          )
          .join("\n---\n");
        const nextPageButton = this.validationErrorDialog
          .getByRole("button", { name: /next/i })
          .last();
        const paginationAvailable =
          (await nextPageButton.count()) > 0 &&
          (await nextPageButton.isEnabled());
        if (
          nextSignature === previousSignature &&
          !view.atBottom &&
          view.rows.length < expectedCount &&
          !paginationAvailable
        ) {
          await expect
            .poll(async () => {
              const current = await this.inspectValidationErrorTable();
              return current.rows
                .map(
                  (error) =>
                    `${error.row}\n${error.dataPreview}\n${error.errorDetails}`,
                )
                .join("\n---\n");
            })
            .not.toBe(previousSignature);
          view = await this.inspectValidationErrorTable();
        }
      }

      if (collected.size >= expectedCount) break;
      const nextPage = this.validationErrorDialog
        .getByRole("button", { name: /next/i })
        .last();
      if (!(await nextPage.count()) || !(await nextPage.isEnabled())) break;
      const pageRows = await this.inspectValidationErrorTable().then(
        (result) => result.rows,
      );
      const pageSignature = pageRows
        .map(
          (error) =>
            `${error.row}\n${error.dataPreview}\n${error.errorDetails}`,
        )
        .join("|");
      if (!pageSignature || seenPages.has(pageSignature)) break;
      seenPages.add(pageSignature);
      await nextPage.click();
      await expect
        .poll(async () =>
          (await this.inspectValidationErrorTable()).rows
            .map(
              (error) =>
                `${error.row}\n${error.dataPreview}\n${error.errorDetails}`,
            )
            .join("|"),
        )
        .not.toBe(pageSignature);
    }
    return [...collected.values()];
  }

  private async getSelectedImportModeLabel(): Promise<string> {
    for (const [radio, label] of [
      [this.addOnlyRadio, "Add Only"],
      [this.updateOnlyRadio, "Update Only"],
      [this.addAndUpdateRadio, "Add + Update"],
    ] as const) {
      if (await radio.isChecked()) return label;
    }
    return "Unknown mode";
  }

  public async getValidationResults(): Promise<{
    summary: string;
    validRows: string;
    warnings: string;
    errors: string;
    totalRows: string;
    importAction: Locator;
  }> {
    const summary = await this.getUploadSummary();
    const actionText = (await this.importValidRowsButton.count())
      ? (await this.importValidRowsButton.innerText()).trim()
      : "";
    const actionCount = actionText.match(
      /^(?:Import|Skip Errors & Import) (\d+) (?:Records|Valid Rows)$/,
    )?.[1];
    const isFullImport = /^Import \d+ Records$/.test(actionText);
    const readCount = (label: string) =>
      summary.match(new RegExp(`${label}:\\s*(\\d+)`, "i"))?.[1] ??
      "Not displayed";
    return {
      summary,
      validRows:
        readCount("Valid") === "Not displayed"
          ? (actionCount ?? "Not displayed")
          : readCount("Valid"),
      warnings: readCount("Warnings?"),
      errors:
        readCount("Errors?") === "Not displayed" && isFullImport
          ? "0"
          : readCount("Errors?"),
      totalRows: readCount("Total Rows"),
      importAction: this.importValidRowsButton,
    };
  }

  public async clickImportAction(): Promise<void> {
    await this.importValidRowsButton.click();
  }

  public async waitForLocationImportSuccess(): Promise<string> {
    const successMessage = this.page
      .getByText(
        /(?:locations?.*(?:imported|success)|(?:imported|success).*locations?)/i,
      )
      .last();
    await expect(
      successMessage,
      "The application should confirm the Location import succeeded",
    ).toBeVisible({
      timeout: 10 * 60 * 1000,
    });
    return (await successMessage.innerText()).trim();
  }

  /** Kept for existing scenarios; supports both full and partial imports. */
  public async clickSkipErrorsAndImport(): Promise<void> {
    await this.clickImportAction();
  }

  public async confirmPartialImport(): Promise<void> {
    await this.proceedWithPartialImportButton.click();
  }

  public async waitForImportComplete(): Promise<string> {
    const importCompleteTimeout = 10 * 60 * 1000; // 10 minutes

    await expect(
      this.page.getByRole("heading", { name: "Import Complete", exact: true }),
    ).toBeVisible({
      timeout: importCompleteTimeout,
    });

    await expect(this.importCompleteCloseButton).toBeVisible({
      timeout: importCompleteTimeout,
    });

    const readCount = async (
      label: "Created" | "Updated" | "Skipped" | "Failed",
    ) => {
      const metric = this.page.getByText(label, { exact: true });
      if (!(await metric.count())) return "Not displayed";
      return (
        (await metric.locator("..").innerText()).match(/\d+/)?.[0] ??
        "Not displayed"
      );
    };
    const created = await readCount("Created");
    const updated = await readCount("Updated");
    const skipped = await readCount("Skipped");
    const failed = await readCount("Failed");
    return `Created: ${created}; Updated: ${updated}; Skipped: ${skipped}; Failed: ${failed}.`;
  }

  public async getImportSummary(): Promise<{
    text: string;
    totalProcessed: string;
    successfullyImported: string;
    failedRecords: string;
  }> {
    const text = await this.getUploadSummary();
    const readMetric = async (label: string) => {
      const metric = this.page.getByText(label, { exact: true });
      await expect(metric).toBeVisible();
      return (
        (await metric.locator("..").innerText()).match(/\d+/)?.[0] ??
        "Not displayed"
      );
    };
    return {
      text,
      totalProcessed: await readMetric("Total Records Processed"),
      successfullyImported: await readMetric("Successfully Imported"),
      failedRecords: await readMetric("Failed Records"),
    };
  }

  public async openHistoryTab(): Promise<void> {
    await this.openSubTab("history");
  }

  public async getLatestHistoryRecord(fileName: string): Promise<Locator> {
    const table = this.page
      .getByRole("table")
      .filter({ hasText: fileName })
      .first();
    await expect(
      table,
      `History should contain an import for ${fileName}`,
    ).toBeVisible();
    const matchingRows = table.getByRole("row").filter({ hasText: fileName });
    await expect(matchingRows.first()).toBeVisible();
    const rows = await matchingRows.all();
    const headers = (await table.getByRole("columnheader").allInnerTexts()).map(
      (header) => header.trim().toLowerCase(),
    );
    const dateColumn = headers.findIndex((header) => /date|time/.test(header));
    if (dateColumn < 0 || rows.length === 1) {
      return matchingRows.first();
    }

    const dates = await Promise.all(
      rows.map(async (row) => {
        const dateText = (
          await row.getByRole("cell").nth(dateColumn).innerText()
        ).trim();
        return Date.parse(dateText);
      }),
    );
    const newestIndex = dates.reduce(
      (newest, current, index) => (current > dates[newest] ? index : newest),
      0,
    );
    return rows[newestIndex];
  }

  public async getHistoryRecordDetails(record: Locator): Promise<{
    dateTime: string;
    file: string;
    mode: string;
    created: string;
    updated: string;
    skipped: string;
    status: string;
    actions: string;
  }> {
    const table = record.locator("..").locator("..");
    const headers = (await table.getByRole("columnheader").allInnerTexts()).map(
      (header) => header.trim().toLowerCase(),
    );
    const cells = record.getByRole("cell");
    const values = await cells.allInnerTexts();
    const valueFor = (pattern: RegExp) => {
      const index = headers.findIndex((header) => pattern.test(header));
      return index >= 0
        ? values[index]?.replace(/\s+/g, " ").trim() || "Not displayed"
        : "Not displayed";
    };
    return {
      dateTime: valueFor(/date|time/),
      file: valueFor(/file/),
      mode: valueFor(/mode/),
      created: valueFor(/created/),
      updated: valueFor(/updated/),
      skipped: valueFor(/skipped/),
      status: valueFor(/status/),
      actions: await this.getHistoryActions(cells, headers, values),
    };
  }

  private async getHistoryActions(
    cells: Locator,
    headers: string[],
    values: string[],
  ): Promise<string> {
    const index = headers.findIndex((header) => /action/.test(header));
    if (index < 0) return "Not displayed";
    if (values[index]?.trim()) return values[index].replace(/\s+/g, " ").trim();
    const actionCell = cells.nth(index);
    const buttons = actionCell.getByRole("button");
    const labels = await buttons.evaluateAll((elements) =>
      elements
        .map(
          (element) =>
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            element.textContent?.trim() ||
            "",
        )
        .filter(Boolean),
    );
    return labels.join(", ") || "Not displayed";
  }

  /**
   * What this does: Chooses a file for upload using the file input on the Upload tab.
   * When it's used: In both positive and negative bulk import flows.
   * @param filePath - Absolute or relative path to the CSV/Excel file to upload.
   * @returns Nothing
   */
  public async chooseFile(filePath: string): Promise<void> {
    await this.fileInput.setInputFiles(filePath);
  }

  /**
   * What this does: Uploads a file for bulk import via the file input on the Upload tab.
   * When it's used: In positive and negative bulk import test flows.
   * @param filePath - Absolute or relative path to the CSV/Excel file to upload.
   * @returns Nothing
   */
  public async uploadFile(filePath: string): Promise<void> {
    await this.chooseFile(filePath);
  }

  /**
   * What this does: Clears the selected file from the upload control.
   * When it's used: After a rejected file should be retried or replaced.
   * @returns Nothing
   */
  public async removeSelectedFile(): Promise<void> {
    await this.removeSelectedFileButton.click();
  }

  /**
   * What this does: Triggers the validation refresh after a file is replaced or corrected.
   * When it's used: In partial-import and negative validation flows when re-checking rows.
   * @returns Nothing
   */
  public async revalidate(): Promise<void> {
    if (await this.revalidateButton.isVisible()) {
      await this.revalidateButton.click();
      await expect(
        this.revalidateButton,
        "The revalidate control should remain available while validation refreshes",
      ).toBeVisible();
    }
  }

  /**
   * What this does: Starts the import of only the valid rows on the page.
   * When it's used: After validation shows some rows failed but the rest are importable.
   * @returns Nothing
   */
  public async importValidRows(): Promise<void> {
    await this.clickImportAction();
  }

  /**
   * What this does: Confirms the partial-import prompt when some rows are valid but others fail.
   * When it's used: After the validation summary lists both valid and invalid data.
   * @returns Nothing
   */
  public async proceedWithPartialImport(): Promise<void> {
    if (await this.proceedWithPartialImportButton.isVisible()) {
      await this.proceedWithPartialImportButton.click();
    }
  }

  /**
   * What this does: Closes the import-complete confirmation dialog.
   * When it's used: After a valid partial import completes successfully.
   * @returns Nothing
   */
  public async closeImportComplete(): Promise<void> {
    await this.importCompleteCloseButton.click();
  }

  /**
   * What this does: Dismisses the generic close control for leftover dialogs or toasts.
   * When it's used: After import completion or when a secondary dialog remains open.
   * @returns Nothing
   */
  public async closeDialog(): Promise<void> {
    if (await this.closeDialogButton.isVisible()) {
      await this.closeDialogButton.click();
    }
  }

  /**
   * What this does: Reads the inline validation errors shown after a file has been uploaded.
   * When it's used: To assert blank-file rejection or partial row failures before import.
   * @returns The validation messages shown on the page after a file upload.
   */
  public async getValidationErrors(): Promise<string[]> {
    if ((await this.getValidationResults()).errors === "0") return [];
    if (await this.viewAllErrorsButton.isVisible()) {
      await this.viewAllErrorsButton.click();
      await expect(
        this.validationErrorDialog,
        "The validation error details should open",
      ).toBeVisible();
    }

    const errorText = await ((await this.validationErrorDialog.isVisible())
      ? this.validationErrorDialog.allInnerTexts()
      : this.validationErrorList.allInnerTexts());
    const messages = errorText
      .flatMap((text) => text.split(/\n|\r\n/))
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(
        (line) =>
          line.length > 0 &&
          /error|invalid|required|missing|duplicate|failed|must|cannot|not valid|wrong/i.test(
            line,
          ),
      );

    return [...new Set(messages)];
  }

  /**
   * What this does: Detects whether the file was rejected before import can proceed.
   * When it's used: In blank-file validation tests and other negative upload scenarios.
   * @returns True when the uploader shows an error state and no import can proceed.
   */
  public async isFileRejected(): Promise<boolean> {
    const validationErrors = await this.getValidationErrors();
    if (validationErrors.length > 0) {
      return true;
    }
    if (await this.importValidRowsButton.isVisible()) {
      return !(await this.importValidRowsButton.isEnabled());
    }
    return true;
  }

  /**
   * What this does: Starts the actual import submission if the page is ready.
   * When it's used: When a valid file has already been validated and the user is ready to submit.
   * @returns Nothing
   */
  public async submitImport(): Promise<void> {
    await this.importValidRows();
  }

  /**
   * What this does: Reads the summary area currently shown for the latest upload.
   * When it's used: To assert the result of a successful or failed upload in a given scenario.
   * @returns Visible text from the Admin Bulk Data Import content only.
   */
  public async getUploadSummary(): Promise<string> {
    // The PMS Assistant and global navigation are siblings of this tab panel.
    // Scoping here keeps every current/future bulk-upload template's evidence
    // relevant without filtering individual assistant sentences.
    const content = (await this.bulkImportContent.count())
      ? this.bulkImportContent
      : this.page.locator("body"); // Supports isolated page-object fixtures.
    return (await content.innerText()).trim();
  }

  private async readVisibleFileValidationMessages(): Promise<string[]> {
    const messages: string[] = [];
    for (const locator of [
      this.fileValidationMessages,
      this.validationErrorDialog,
    ]) {
      for (let index = 0; index < (await locator.count()); index += 1) {
        const item = locator.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const text = (await item.innerText()).replace(/\s+/g, " ").trim();
        if (text) messages.push(text);
      }
    }
    return [...new Set(messages)];
  }

  /** Reads the actual toast, alert, inline error, or error dialog shown for a rejected file. */
  public async captureFileValidationMessage(
    timeout = 15_000,
  ): Promise<string | null> {
    try {
      await expect
        .poll(() => this.readVisibleFileValidationMessages(), {
          message:
            "A rejected file should display a toast, alert, inline validation, or error dialog.",
          timeout,
        })
        .not.toEqual([]);
    } catch {
      return null;
    }
    return (await this.readVisibleFileValidationMessages()).join("\n");
  }

  /** Waits for the application's response after a file is submitted to the upload control. */
  public async waitForUploadResponse(
    timeout = 30_000,
  ): Promise<{ status: "accepted" } | { status: "rejected"; message: string }> {
    const validationResults = this.page.getByText("Validation Results", {
      exact: true,
    });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const messages = await this.readVisibleFileValidationMessages();
      if (messages.length) {
        return { status: "rejected", message: messages.join("\n") };
      }
      if (
        (await validationResults.isVisible().catch(() => false)) ||
        (await this.importValidRowsButton.isVisible().catch(() => false))
      ) {
        return { status: "accepted" };
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error(
      `The application did not display an upload acceptance or rejection response within ${timeout} ms.`,
    );
  }

  /** Confirms that a file-level rejection did not enter row validation or import. */
  public async confirmFileStayedRejected(): Promise<void> {
    await expect(
      this.uploadTabPanel,
      "The rejected file should remain on the Upload stage",
    ).toBeVisible();
    await expect(
      this.page.getByText("Validation Results", { exact: true }),
    ).toBeHidden();
    await expect(this.importValidRowsButton).toBeHidden();
    await expect(this.importCompleteCloseButton).toBeHidden();
  }

  /**
   * What this does: Triggers the download of a validation error report if the application exposes one.
   * When it's used: In negative-import scenarios when the user wants to review row-level problem details.
   * @returns Nothing
   */
  public async downloadErrorReport(): Promise<void> {
    const downloadButton = this.page.getByRole("button", {
      name: /download error report/i,
    });
    if (await downloadButton.isVisible()) {
      await downloadButton.click();
    }
  }

  /**
   * What this does: Opens the Import History panel/dialog.
   * When it's used: When a test needs to verify past import runs.
   * @returns Nothing
   */
  public async openImportHistory(): Promise<void> {
    await this.importHistoryButton.click();
  }

  /**
   * What this does: Switches between the Upload, Field Mapping Guide, and History sub-tabs.
   * When it's used: To verify content on each sub-tab within a template.
   * @param tab - Which sub-tab to open.
   * @returns Nothing
   */
  public async openSubTab(
    tab: "upload" | "fieldMappingGuide" | "history",
  ): Promise<void> {
    const target =
      tab === "upload"
        ? this.uploadSubTab
        : tab === "fieldMappingGuide"
          ? this.fieldMappingGuideSubTab
          : this.historySubTab;
    await target.click();
  }
}
