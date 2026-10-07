import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/baseFixture";
import type { AuditDashboardPage } from "../../../pages/AuditDashboardPage";
import { TechnicalPage } from "../../../pages/TechnicalPage";
import { config } from "../../../utils/config";
import { generateStandardAuditReport } from "../../../utils/standardAuditReport";
import { runBulkDataImportScenario } from "../../bulk-import/bulkDataImportScenario";
import {
  getJobsValidationWorkbook,
  loadExpectedJobs,
  normalizeJobDate,
  normalizeJobFrequency,
  normalizeJobHour,
  normalizeJobText,
} from "../../../utils/jobsExpectedData";

const fieldsValidated = [
  "Job Code",
  "WO Title → Job Title",
  "Interval Value → Frequency",
  "Last Done Date",
  "Last Done Hour",
];

export type JobValidationResult = {
  successfullyImported: number;
  totalChecked: number;
  matched: number;
  missing: string[];
  mismatches: string[];
  sourceWorkbook: string;
};

export async function validateImportedJobs(
  page: Page,
  auditDashboardPage: AuditDashboardPage,
  limit?: number,
  options: { includeAuditSummary?: boolean } = {},
): Promise<JobValidationResult> {
  test.setTimeout(0);
  const importResult = await runBulkDataImportScenario(
    page,
    auditDashboardPage,
    {
      module: "job",
      mode: "addAndUpdate",
      expectedResult: { outcome: "import", rowErrors: "skip-and-import" },
    },
    () => getJobsValidationWorkbook(),
  );
  expect(
    importResult.imported,
    "The Job validation workbook should contain rows accepted for import.",
  ).toBe(true);
  const workbook = importResult.uploadFile;
  const allRecords = loadExpectedJobs(workbook);
  const rejectedRows = new Set(importResult.rejectedWorkbookRows);
  const successfullyImportedRecords = allRecords.filter(
    (_, index) => !rejectedRows.has(index + 2),
  );
  expect(
    successfullyImportedRecords.length,
    "Application validation should leave at least one successfully importable Job row.",
  ).toBeGreaterThan(0);

  await test.info().attach("Job import data summary", {
    body: [
      `Source workbook: ${path.basename(workbook)}`,
      `Workbook records: ${allRecords.length}`,
      `Validation errors: ${importResult.validationErrors}`,
      `Successfully imported/expected Job records: ${successfullyImportedRecords.length}`,
    ].join("\n"),
    contentType: "text/plain",
  });

  const records =
    limit === undefined
      ? successfullyImportedRecords
      : successfullyImportedRecords.slice(0, limit);

  const technicalPage = new TechnicalPage(page);
  const componentsPage = await technicalPage.goToComponents();
  await componentsPage.expectToBeOnPage();
  await componentsPage.selectVessel(config.vesselName);
  await componentsPage.expandAll();

  const missing: string[] = [];
  const mismatches: string[] = [];
  const reportComparisons: Array<{
    recordCode: string;
    recordName: string;
    field: string;
    expected: string;
    actual: string;
    status: "PASS" | "MISMATCH" | "MISSING";
    reason?: string;
  }> = [];
  let found = 0;
  for (const record of records) {
    const componentCode = String(record["Component Code"]).trim();
    const jobCode = String(record["Job Code"]).trim();
    await componentsPage.selectComponentByCode(componentCode);
    const actual = await componentsPage.readJobByCode(jobCode);
    if (!actual) {
      missing.push(`Component Code: ${componentCode}; Job Code: ${jobCode}`);
      reportComparisons.push({
        recordCode: `${componentCode} / ${jobCode}`,
        recordName: String(record["WO Title"] ?? ""),
        field: "Job record",
        expected: "Record should exist in UI",
        actual: "Record not found in UI",
        status: "MISSING",
        reason: "The Job was not found under its Component Code.",
      });
      await test
        .info()
        .attach(`Failure Screenshot - Job ${jobCode} - record not found`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      continue;
    }
    found += 1;
    const comparisons: Array<[string, string, string]> = [
      [
        "Job Code",
        normalizeJobText(record["Job Code"]),
        normalizeJobText(actual.jobCode),
      ],
      [
        "WO Title → Job Title",
        normalizeJobText(record["WO Title"]),
        normalizeJobText(actual.jobTitle),
      ],
      [
        "Interval Value → Frequency",
        normalizeJobFrequency(record["Interval Value"], record["Unit"]),
        normalizeJobFrequency(actual.frequency),
      ],
      [
        "Last Done Date",
        normalizeJobDate(record["Last Done Date"]),
        normalizeJobDate(actual.lastDoneDate),
      ],
      [
        "Last Done Hour",
        normalizeJobHour(record["Last Done Hour"]),
        normalizeJobHour(actual.lastDoneHour),
      ],
    ];
    for (const [field, expectedValue, actualValue] of comparisons) {
      const matches = !expectedValue || expectedValue === actualValue;
      reportComparisons.push({
        recordCode: `${componentCode} / ${jobCode}`,
        recordName: String(record["WO Title"] ?? ""),
        field,
        expected: expectedValue || "<blank>",
        actual: actualValue || "<blank>",
        status: matches ? "PASS" : "MISMATCH",
        reason: matches ? undefined : "Exact normalized values differ.",
      });
      if (expectedValue && expectedValue !== actualValue) {
        mismatches.push(
          `Component Code: ${componentCode}\nJob Code: ${jobCode}\nField: ${field}\nExpected Excel Value: ${expectedValue}\nActual UI Value: ${actualValue || "<blank>"}\nReason: Exact normalized values differ.`,
        );
        await test
          .info()
          .attach(`Failure Screenshot - Job ${jobCode} - ${field} mismatch`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
      }
    }
  }

  const issueRecords = new Set([
    ...missing,
    ...mismatches.map((item) => item.split("\n").slice(0, 2).join("\n")),
  ]);
  const result: JobValidationResult = {
    successfullyImported: successfullyImportedRecords.length,
    totalChecked: records.length,
    matched: records.length - issueRecords.size,
    missing,
    mismatches,
    sourceWorkbook: path.basename(workbook),
  };

  await test.info().attach("Job post-import validation summary", {
    body: [
      `Source workbook: ${path.basename(workbook)}`,
      `Successfully imported Jobs expected: ${records.length}`,
      `Jobs validated: ${records.length}`,
      `Jobs found: ${found}`,
      `Jobs missing: ${missing.length}`,
      `Field mismatches: ${mismatches.length}`,
      `Fields validated:\n${fieldsValidated.join("\n")}`,
      missing.length ? `Missing Jobs:\n${missing.join("\n")}` : "",
      mismatches.length ? `Mismatches:\n${mismatches.join("\n\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    contentType: "text/plain",
  });
  await test.info().attach("Job validation final state", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await test.info().attach("Job validation comparison data", {
    body: JSON.stringify(reportComparisons),
    contentType: "application/json",
  });
  if (options.includeAuditSummary) {
    const value = (text: string, label: string) =>
      text.match(new RegExp(`${label}:\\s*([^\\n;]+)`))?.[1]?.trim() ?? "";
    generateStandardAuditReport({
      dataType: "Jobs",
      fileName: `jobs-validation-audit${limit === undefined ? "" : "-partially"}.html`,
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
      identifierColumns: ["Component Code", "Job Code"],
      missingRecords: result.missing.map((item) => ({
        identifiers: {
          "Component Code": value(item, "Component Code"),
          "Job Code": value(item, "Job Code"),
        },
        issue: "Job record not found.",
      })),
      fieldMismatches: result.mismatches.map((item) => ({
        identifiers: {
          "Component Code": value(item, "Component Code"),
          "Job Code": value(item, "Job Code"),
        },
        field: value(item, "Field"),
        expected: value(item, "Expected Excel Value"),
        actual: value(item, "Actual UI Value"),
        reason: value(item, "Reason"),
      })),
    });
    await test.info().attach("Job audit summary", {
      body: [
        "AUDIT SUMMARY",
        `Source File: ${result.sourceWorkbook}`,
        `Vessel: ${config.vesselName}`,
        `Uploaded By: ${config.username}`,
        `Validation Type: ${limit === undefined ? "Complete" : `Partial - first ${limit} successfully imported records`}`,
        `Successfully Imported: ${result.successfullyImported}`,
        `Audited: ${result.totalChecked}`,
        `Matched: ${result.matched}`,
        `Records With Issues: ${issueRecords.size}`,
        `Missing: ${result.missing.length}`,
        `Field Mismatches: ${result.mismatches.length}`,
        "",
        "RECORDS REQUIRING REVIEW",
        ...(result.missing.length || result.mismatches.length
          ? [...result.missing, ...result.mismatches]
          : ["No records require review."]),
        "",
        "FINAL AUDIT RESULT",
        `${result.successfullyImported} records successfully imported`,
        `${result.totalChecked} records audited`,
        `${result.matched} matched`,
        `${issueRecords.size} require review`,
      ].join("\n"),
      contentType: "text/plain",
    });
  }
  expect(
    missing,
    "Every successfully imported Job should be present under its Component Code.",
  ).toEqual([]);
  expect(
    mismatches,
    "Every non-blank expected Job field should exactly match after normalization.",
  ).toEqual([]);
  return result;
}
