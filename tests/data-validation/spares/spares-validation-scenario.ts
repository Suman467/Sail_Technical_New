import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/baseFixture";
import type { AuditDashboardPage } from "../../../pages/AuditDashboardPage";
import type { ComponentSpareRow } from "../../../pages/ComponentsPage";
import { TechnicalPage } from "../../../pages/TechnicalPage";
import { config } from "../../../utils/config";
import { generateStandardAuditReport } from "../../../utils/standardAuditReport";
import {
  componentNamesMatch,
  getSparesValidationWorkbook,
  loadExpectedSpares,
  normalizeSpareRob,
  normalizeSpareText,
  type ExpectedSpareRecord,
} from "../../../utils/sparesExpectedData";
import { runBulkDataImportScenario } from "../../bulk-import/bulkDataImportScenario";

export type SpareIssue = {
  componentCode: string;
  partCode: string;
  issue: string;
};
export type SpareMismatch = {
  componentCode: string;
  partCode: string;
  field: string;
  expected: string;
  actual: string;
  reason: string;
};

export type SpareValidationLocation = "components" | "spares-module";
export type SpareValidationResult = {
  successfullyImported: number;
  totalChecked: number;
  matched: number;
  recordsWithIssues: number;
  missing: SpareIssue[];
  mismatches: SpareMismatch[];
  sourceWorkbook: string;
};

type SparesValidationOptions = {
  page: Page;
  auditDashboardPage: AuditDashboardPage;
  location: SpareValidationLocation;
  limit?: number;
  upload: boolean;
  strict: boolean;
  auditFileName?: string;
  includeAuditSummary?: boolean;
  scenarioTitle: string;
};

function spareFieldComparisons(
  expected: ExpectedSpareRecord,
  actual: ComponentSpareRow,
): Array<{
  field: string;
  expected: string;
  actual: string;
  matches: boolean;
  reason: string;
}> {
  return [
    {
      field: "Part Code",
      expected: normalizeSpareText(expected["Part Code"]),
      actual: normalizeSpareText(actual.partCode),
      matches:
        normalizeSpareText(expected["Part Code"]) ===
        normalizeSpareText(actual.partCode),
      reason: "Normalized values differ.",
    },
    {
      field: "Part Name",
      expected: normalizeSpareText(expected["Part Name"]),
      actual: normalizeSpareText(actual.partName),
      matches:
        normalizeSpareText(expected["Part Name"]) ===
        normalizeSpareText(actual.partName),
      reason: "Normalized values differ.",
    },
    {
      field: "Component Name",
      expected: normalizeSpareText(expected["Component Name"]),
      actual: normalizeSpareText(actual.componentName),
      matches: componentNamesMatch(
        expected["Component Name"],
        actual.componentName,
      ),
      reason: "Names are not an exact or controlled partial match.",
    },
    {
      field: "Part Number",
      expected: normalizeSpareText(expected["Part Number"]),
      actual: normalizeSpareText(actual.partNumber),
      matches:
        normalizeSpareText(expected["Part Number"]) ===
        normalizeSpareText(actual.partNumber),
      reason: "Normalized values differ.",
    },
    {
      field: "ROB",
      expected: normalizeSpareRob(expected["Total ROB"]),
      actual: normalizeSpareRob(actual.rob),
      matches:
        normalizeSpareRob(expected["Total ROB"]) ===
        normalizeSpareRob(actual.rob),
      reason: "Normalized values differ.",
    },
  ];
}

function compareSpare(
  expected: ExpectedSpareRecord,
  actual: ComponentSpareRow,
): SpareMismatch[] {
  const componentCode = String(expected["Component Code"]).trim();
  const partCode = String(expected["Part Code"]).trim();
  return spareFieldComparisons(expected, actual)
    .filter((item) => item.expected && !item.matches)
    .map((item) => ({
      componentCode,
      partCode,
      field: item.field,
      expected: item.expected,
      actual: item.actual || "<blank>",
      reason: item.reason,
    }));
}

export async function runSparesValidation(
  options: SparesValidationOptions,
): Promise<SpareValidationResult> {
  test.setTimeout(0);
  const {
    page,
    auditDashboardPage,
    location,
    limit,
    upload,
    strict,
    scenarioTitle,
  } = options;
  let workbook: string;
  let allRecords: ExpectedSpareRecord[];
  let successfulRecords: ExpectedSpareRecord[];

  if (upload) {
    const importResult = await runBulkDataImportScenario(
      page,
      auditDashboardPage,
      {
        module: "spares",
        mode: "addAndUpdate",
        expectedResult: { outcome: "import", rowErrors: "skip-and-import" },
      },
      () => getSparesValidationWorkbook(),
    );
    expect(
      importResult.imported,
      "The Spares validation workbook should contain accepted rows.",
    ).toBe(true);
    workbook = importResult.uploadFile;
    allRecords = loadExpectedSpares(workbook);
    const rejected = new Set(importResult.rejectedWorkbookRows);
    successfulRecords = allRecords.filter(
      (_, index) => !rejected.has(index + 2),
    );
  } else {
    workbook = getSparesValidationWorkbook();
    allRecords = loadExpectedSpares(workbook);
    successfulRecords = allRecords;
    await auditDashboardPage.goToTechnical();
  }
  const records =
    limit === undefined ? successfulRecords : successfulRecords.slice(0, limit);
  const technicalPage = new TechnicalPage(page);
  const missing: SpareIssue[] = [];
  const mismatches: SpareMismatch[] = [];
  const reportComparisons: Array<{
    recordCode: string;
    recordName: string;
    field: string;
    expected: string;
    actual: string;
    status: "PASS" | "MISMATCH" | "MISSING";
    reason?: string;
  }> = [];

  if (location === "components") {
    const componentsPage = await technicalPage.goToComponents();
    await componentsPage.expectToBeOnPage();
    await componentsPage.selectVessel(config.vesselName);
    await componentsPage.expandAll();
    const componentCodes = new Set(
      (await componentsPage.readExpandedTreeRows()).map((row) =>
        row.code.toLowerCase(),
      ),
    );
    for (const record of records) {
      const componentCode = String(record["Component Code"]).trim();
      const partCode = String(record["Part Code"]).trim();
      if (!componentCodes.has(componentCode.toLowerCase())) {
        missing.push({
          componentCode,
          partCode,
          issue: "Component not found in Components hierarchy",
        });
        reportComparisons.push({
          recordCode: `${componentCode} / ${partCode}`,
          recordName: String(record["Part Name"] ?? ""),
          field: "Spare record",
          expected: "Record should exist in UI",
          actual: "Component not found in Components hierarchy",
          status: "MISSING",
          reason: "The parent Component was not available.",
        });
        await test
          .info()
          .attach(
            `Failure Screenshot - Spare ${partCode} - component not found`,
            { body: await page.screenshot(), contentType: "image/png" },
          );
        continue;
      }
      await componentsPage.selectComponentByCode(componentCode);
      const actual = await componentsPage.readSpareByPartCode(partCode);
      if (!actual) {
        missing.push({
          componentCode,
          partCode,
          issue: "Spare not found in F. Spares",
        });
        reportComparisons.push({
          recordCode: `${componentCode} / ${partCode}`,
          recordName: String(record["Part Name"] ?? ""),
          field: "Spare record",
          expected: "Record should exist in UI",
          actual: "Record not found in UI",
          status: "MISSING",
          reason: "The Spare was not found in F. Spares.",
        });
        await test
          .info()
          .attach(`Failure Screenshot - Spare ${partCode} - record not found`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
      } else {
        const recordMismatches = compareSpare(record, actual);
        mismatches.push(...recordMismatches);
        for (const field of spareFieldComparisons(record, actual))
          reportComparisons.push({
            recordCode: `${componentCode} / ${partCode}`,
            recordName: String(record["Part Name"] ?? ""),
            field: field.field,
            expected: field.expected || "<blank>",
            actual: field.actual || "<blank>",
            status: field.matches ? "PASS" : "MISMATCH",
            reason: field.matches ? undefined : field.reason,
          });
        for (const issue of recordMismatches) {
          await test
            .info()
            .attach(
              `Failure Screenshot - Spare ${partCode} - ${issue.field} mismatch`,
              { body: await page.screenshot(), contentType: "image/png" },
            );
        }
      }
    }
  } else {
    const sparesPage = await technicalPage.goToSpares();
    await sparesPage.expectToBeOnPage();
    await sparesPage.selectVessel(config.vesselName);
    for (const record of records) {
      const componentCode = String(record["Component Code"]).trim();
      const partCode = String(record["Part Code"]).trim();
      const actual = await sparesPage.readSpareByPartCode(
        partCode,
        componentCode,
      );
      if (!actual) {
        missing.push({
          componentCode,
          partCode,
          issue: "Spare not found in Spares module",
        });
        reportComparisons.push({
          recordCode: `${componentCode} / ${partCode}`,
          recordName: String(record["Part Name"] ?? ""),
          field: "Spare record",
          expected: "Record should exist in UI",
          actual: "Record not found in UI",
          status: "MISSING",
          reason: "The Spare was not found in the Spares module.",
        });
        await test
          .info()
          .attach(`Failure Screenshot - Spare ${partCode} - record not found`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
      } else {
        const recordMismatches = compareSpare(record, actual);
        mismatches.push(...recordMismatches);
        for (const field of spareFieldComparisons(record, actual))
          reportComparisons.push({
            recordCode: `${componentCode} / ${partCode}`,
            recordName: String(record["Part Name"] ?? ""),
            field: field.field,
            expected: field.expected || "<blank>",
            actual: field.actual || "<blank>",
            status: field.matches ? "PASS" : "MISMATCH",
            reason: field.matches ? undefined : field.reason,
          });
        for (const issue of recordMismatches) {
          await test
            .info()
            .attach(
              `Failure Screenshot - Spare ${partCode} - ${issue.field} mismatch`,
              { body: await page.screenshot(), contentType: "image/png" },
            );
        }
      }
    }
  }

  const issueKeys = new Set([
    ...missing.map((item) => `${item.componentCode}\n${item.partCode}`),
    ...mismatches.map((item) => `${item.componentCode}\n${item.partCode}`),
  ]);
  const result: SpareValidationResult = {
    successfullyImported: successfulRecords.length,
    totalChecked: records.length,
    matched: records.length - issueKeys.size,
    recordsWithIssues: issueKeys.size,
    missing,
    mismatches,
    sourceWorkbook: path.basename(workbook),
  };
  if (options.includeAuditSummary || options.auditFileName) {
    generateStandardAuditReport({
      dataType: "Spares",
      fileName:
        options.auditFileName ??
        `spares-validation-audit${limit === undefined ? "" : "-partially"}.html`,
      vessel: config.vesselName,
      excelFile: result.sourceWorkbook,
      uploadedBy: config.username,
      validationType:
        limit === undefined
          ? "Complete"
          : `Partial - first ${limit} successfully imported records`,
      successfullyImported: result.successfullyImported,
      recordsChecked: result.totalChecked,
      recordsMatched: result.matched,
      identifierColumns: ["Component Code", "Part Code"],
      additionalMetadata: { Scenario: scenarioTitle },
      missingRecords: result.missing.map((item) => ({
        identifiers: {
          "Component Code": item.componentCode,
          "Part Code": item.partCode,
        },
        issue: item.issue,
      })),
      fieldMismatches: result.mismatches.map((item) => ({
        identifiers: {
          "Component Code": item.componentCode,
          "Part Code": item.partCode,
        },
        field: item.field,
        expected: item.expected,
        actual: item.actual,
        reason: item.reason,
      })),
    });
  }

  await test.info().attach("Spares validation summary", {
    body: [
      `Source workbook: ${result.sourceWorkbook}`,
      `Successfully imported: ${result.successfullyImported}`,
      `Records checked: ${result.totalChecked}`,
      `Matched: ${result.matched}`,
      `Missing: ${result.missing.length}`,
      `Field mismatches: ${result.mismatches.length}`,
    ].join("\n"),
    contentType: "text/plain",
  });
  await test.info().attach("Spares validation comparison data", {
    body: JSON.stringify(reportComparisons),
    contentType: "application/json",
  });
  if (options.includeAuditSummary) {
    const validationType =
      limit === undefined
        ? "Complete"
        : `Partial - first ${limit} successfully imported records`;
    const issueDetails = [
      ...result.missing.map((issue) =>
        [
          `Record: Component ${issue.componentCode}; Part ${issue.partCode}`,
          "Field: Spare record",
          "Expected: Present",
          "Actual: Not Found",
          `Reason: ${issue.issue}`,
        ].join("\n"),
      ),
      ...result.mismatches.map((issue) =>
        [
          `Record: Component ${issue.componentCode}; Part ${issue.partCode}`,
          `Field: ${issue.field}`,
          `Expected: ${issue.expected}`,
          `Actual: ${issue.actual}`,
          `Reason: ${issue.reason}`,
        ].join("\n"),
      ),
    ];
    await test.info().attach("Spares audit summary", {
      body: [
        "AUDIT SUMMARY",
        `Source File: ${result.sourceWorkbook}`,
        `Vessel: ${config.vesselName}`,
        `Uploaded By: ${config.username}`,
        `Validation Type: ${validationType}`,
        `Successfully Imported: ${result.successfullyImported}`,
        `Audited: ${result.totalChecked}`,
        `Matched: ${result.matched}`,
        `Records With Issues: ${result.recordsWithIssues}`,
        `Missing: ${result.missing.length}`,
        `Field Mismatches: ${result.mismatches.length}`,
        "",
        "RECORDS REQUIRING REVIEW",
        ...(issueDetails.length
          ? issueDetails
          : ["No records require review."]),
        "",
        "FINAL AUDIT RESULT",
        `${result.successfullyImported} records successfully imported`,
        `${result.totalChecked} records audited`,
        `${result.matched} matched`,
        `${result.recordsWithIssues} require review`,
      ].join("\n"),
      contentType: "text/plain",
    });
  }
  await test.info().attach("Spares validation evidence", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await test.step(`Validate Spares Data\nStatus: PASS\nExpected: Successfully imported Excel Spares should match the UI.\nActual: Checked ${result.totalChecked}; matched ${result.matched}; missing ${result.missing.length}; field mismatches ${result.mismatches.length}.`, async () => {
    if (strict) {
      expect(
        result.missing,
        "No successfully imported Spare should be missing.",
      ).toEqual([]);
      expect(
        result.mismatches,
        "All required Spare fields should match.",
      ).toEqual([]);
    }
  });
  return result;
}
