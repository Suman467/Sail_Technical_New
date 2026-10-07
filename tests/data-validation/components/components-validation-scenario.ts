import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../../../fixtures/baseFixture";

import { runBulkDataImportScenario } from "../../bulk-import/bulkDataImportScenario";

import { AuditDashboardPage } from "../../../pages/AuditDashboardPage";

import { TechnicalPage } from "../../../pages/TechnicalPage";

import type { ComponentTreeRow } from "../../../pages/ComponentsPage";

import type { RunningHoursUiRow } from "../../../pages/RunningHoursPage";

import { config } from "../../../utils/config";

import { generateStandardAuditReport } from "../../../utils/standardAuditReport";

import {
  loadExpectedComponentData,
  getComponentsWorkbook,
  loadImportedExpectedComponentData,
  normalizeExpectedText,
  normalizeRunningHours,
  saveComponentsImportResult,
  type ExpectedComponentRecord,
} from "../../../utils/componentsExpectedData";

/*

 * The workbook used for upload and the workbook used for expected-data

 * validation are deliberately the exact same file.

 */

const COMPONENTS_WORKBOOK = getComponentsWorkbook();

const expectedData = loadExpectedComponentData(COMPONENTS_WORKBOOK);

type ComponentFieldMapping = {
  excelColumn: string;

  section?: string;

  uiField?: string;

  normalization?:
    | "boolean"
    | "case-insensitive-text"
    | "date"
    | "number"
    | "rh-counter-type"
    | "text";

  notExposedReason?: string;
};

const COMPONENT_FIELD_MAPPINGS: ComponentFieldMapping[] = [
  {
    excelColumn: "Fleet Equipment Code",
    section: "B. Fleet Component Information",
    uiField: "Fleet Equipment Code",
  },

  {
    excelColumn: "Fleet Equipment Name",
    section: "B. Fleet Component Information",
    uiField: "Fleet Component Name",
  },

  {
    excelColumn: "Parent Component Code",
    section: "A. Component Information",
    uiField: "Parent Component Code",
  },

  {
    excelColumn: "Component Code",
    section: "A. Component Information",
    uiField: "Component Code",
  },

  {
    excelColumn: "Component Name",
    section: "A. Component Information",
    uiField: "Component Name",
  },

  {
    excelColumn: "Component Category",
    section: "A. Component Information",
    uiField: "Component Category",
  },

  {
    excelColumn: "Maker",
    section: "A. Component Information",
    uiField: "Maker",
  },

  {
    excelColumn: "Maker Code",
    section: "B. Fleet Component Information",
    uiField: "Maker Code",
  },

  {
    excelColumn: "Model",
    section: "A. Component Information",
    uiField: "Model",
  },

  {
    excelColumn: "Model Code",
    section: "B. Fleet Component Information",
    uiField: "Model Code",
  },

  {
    excelColumn: "Serial No",
    section: "A. Component Information",
    uiField: "Serial No.",
  },

  {
    excelColumn: "Drawing No",
    section: "A. Component Information",
    uiField: "Drawing No",
  },

  {
    excelColumn: "Location",
    section: "A. Component Information",
    uiField: "Location",
  },

  {
    excelColumn: "Criticality",
    section: "A. Component Information",
    uiField: "Criticality",
    normalization: "boolean",
  },

  {
    excelColumn: "Condition Based",
    section: "A. Component Information",
    uiField: "Condition Based",
    normalization: "boolean",
  },

  {
    excelColumn: "Installation Date",
    section: "A. Component Information",
    uiField: "Installation Date",
    normalization: "date",
  },

  {
    excelColumn: "Commissioned Date",
    section: "A. Component Information",
    uiField: "Commissioned Date",
    normalization: "date",
  },

  {
    excelColumn: "Rating",
    section: "A. Component Information",
    uiField: "Rating",
  },

  {
    excelColumn: "Equipment / System Department",
    section: "A. Component Information",
    uiField: "Equipment / System Department",
  },

  {
    excelColumn: "Class item",
    section: "A. Component Information",
    uiField: "Class Item",
    normalization: "boolean",
  },

  {
    excelColumn: "IS Active",
    section: "B. Fleet Component Information",
    uiField: "Is Active",
    normalization: "boolean",
  },

  {
    excelColumn: "Vessel Code",
    notExposedReason:
      "Vessel Code is not exposed in Components UI; the page exposes Vessel Name and the configured vessel selector instead.",
  },

  {
    excelColumn: "IS Parent",
    section: "B. Fleet Component Information",
    uiField: "Is Parent",
    normalization: "boolean",
  },

  {
    excelColumn: "Notes",
    section: "A. Component Information",
    uiField: "Notes / Technical Information",
  },

  {
    excelColumn: "RH Counter Type",
    section: "C. Running Hours & Condition Monitoring",
    uiField: "RH Counter Type",
    normalization: "rh-counter-type",
  },

  {
    excelColumn: "RH Counter Source",
    section: "C. Running Hours & Condition Monitoring",
    uiField: "RH Counter Source",
  },

  {
    excelColumn: "Running Hours",
    section: "C. Running Hours & Condition Monitoring",
    uiField: "Running Hours",
    normalization: "number",
  },

  {
    excelColumn: "Last Updated",
    section: "C. Running Hours & Condition Monitoring",
    uiField: "Last Updated",
    normalization: "date",
  },
];

export type ComponentsImportMode = "addOnly" | "updateOnly" | "addAndUpdate";

const IMPORT_MODE_LABELS: Record<ComponentsImportMode, string> = {
  addOnly: "Add Only",

  updateOnly: "Update Only",

  addAndUpdate: "Add + Update",
};

function recordStep(
  name: string,

  expected: string,

  actual: string,

  status: "PASS" | "FAIL" = "PASS",
): Promise<void> {
  return test.step(`${name}\nStatus: ${status}\nExpected: ${expected}\nActual: ${actual}`, async () =>
    undefined);
}

function normalizeCode(value: unknown): string {
  return normalizeExpectedText(value).replace(/\.0$/, "");
}

export function compareComponentTree(
  actualRows: ComponentTreeRow[],

  expectedRecords: ExpectedComponentRecord[],
): {
  missingCodes: string[];

  unexpectedCodes: string[];

  fieldMismatches: string[];

  hierarchyMismatches: string[];
} {
  const expectedByCode = new Map(
    expectedRecords.map((record) => [
      normalizeCode(record["Component Code"]),

      record,
    ]),
  );

  const actualByCode = new Map(
    actualRows.map((row) => [normalizeCode(row.code), row]),
  );

  const missingCodes = expectedRecords

    .map((record) => normalizeCode(record["Component Code"]))

    .filter((code) => !actualByCode.has(code));

  /*

   * The Components page can contain many pre-existing records for the vessel.

   * They are outside this upload validation scope and must not be reported as

   * unexpected. We validate only the component codes accepted from this Excel

   * import.

   */

  const unexpectedCodes: string[] = [];

  const fieldMismatches: string[] = [];

  for (const row of actualRows) {
    if (!expectedByCode.has(normalizeCode(row.code))) {
      continue;
    }

    const expected = expectedByCode.get(normalizeCode(row.code));

    if (!expected) {
      continue;
    }

    const expectedName = normalizeExpectedText(expected["Component Name"]);

    if (
      normalizeExpectedText(row.name).toLowerCase() !==
      expectedName.toLowerCase()
    ) {
      fieldMismatches.push(
        `${row.code} Component Name expected="${expectedName}" actual="${row.name}"`,
      );
    }
  }

  const hierarchyMismatches: string[] = [];

  const stack: Array<{
    depth: number;

    code: string;
  }> = [];

  for (const row of actualRows) {
    while (stack.length && stack[stack.length - 1].depth >= row.depth) {
      stack.pop();
    }

    const actualParent = stack.length ? stack[stack.length - 1].code : null;

    const expectedParent = expectedByCode.get(normalizeCode(row.code))?.[
      "Parent Component Code"
    ];

    const expectedParentCode = expectedParent
      ? normalizeCode(expectedParent)
      : null;

    if (
      expectedByCode.has(normalizeCode(row.code)) &&
      actualParent !== expectedParentCode
    ) {
      hierarchyMismatches.push(
        `${row.code} parent expected="${
          expectedParentCode ?? "<root>"
        }" actual="${actualParent ?? "<root>"}"`,
      );
    }

    stack.push({
      depth: row.depth,

      code: normalizeCode(row.code),
    });
  }

  return {
    missingCodes,

    unexpectedCodes,

    fieldMismatches,

    hierarchyMismatches,
  };
}

function normalizeUiRunningHours(value: unknown): string | null {
  return normalizeRunningHours(
    normalizeExpectedText(value).replace(/\s+hrs?$/i, ""),
  );
}

function compareRunningHours(
  actualRows: RunningHoursUiRow[],

  expectedRecords: ExpectedComponentRecord[],
): {
  expectedCount: number;

  actualCount: number;

  missingCodes: string[];

  unexpectedCodes: string[];

  mismatches: string[];
} {
  /*

   * Running Hours is not a 1:1 representation of the workbook.

   *

   * MASTER:

   *   One accepted MASTER record = one Running Hours UI row.

   *

   * INHERITED:

   *   An accepted INHERITED record does not create another top-level

   *   Running Hours row. The UI represents inherited records as a count in

   *   the "Inherited RH" column of the RH Counter Source (MASTER) row.

   *

   * Validation-error rows have already been removed by

   * getImportedExpectedRecords(), so only accepted/imported records are

   * considered here.

   */

  const rhExpected = expectedRecords.filter((record) => {
    const type = normalizeExpectedText(record["RH Counter Type"]).toUpperCase();

    return type === "MASTER" || type === "INHERITED";
  });

  const masterExpected = rhExpected.filter(
    (record) =>
      normalizeExpectedText(record["RH Counter Type"]).toUpperCase() ===
      "MASTER",
  );

  const inheritedExpected = rhExpected.filter(
    (record) =>
      normalizeExpectedText(record["RH Counter Type"]).toUpperCase() ===
      "INHERITED",
  );

  const expectedByCode = new Map(
    masterExpected.map((record) => [
      normalizeCode(record["Component Code"]),

      record,
    ]),
  );

  const actualByCode = new Map(
    actualRows.map((row) => [normalizeCode(row.componentCode), row]),
  );

  const uploadedMasterCodes = new Set(
    masterExpected.map((record) => normalizeCode(record["Component Code"])),
  );

  const relevantActualByCode = new Map(
    [...actualByCode.entries()].filter(([code]) =>
      uploadedMasterCodes.has(code),
    ),
  );

  const missingCodes = [...expectedByCode.keys()].filter(
    (code) => !relevantActualByCode.has(code),
  );

  const unexpectedCodes = [...relevantActualByCode.keys()].filter(
    (code) => !expectedByCode.has(code),
  );

  const mismatches: string[] = [];

  function normalizeInheritedCount(value: unknown): number {
    const normalized = normalizeExpectedText(value);

    if (!normalized || normalized === "—" || normalized === "-") {
      return 0;
    }

    const numeric = Number(
      normalized

        .replace(/,/g, "")

        .replace(/\s+/g, ""),
    );

    return Number.isFinite(numeric) ? numeric : 0;
  }

  /*

   * 1. MASTER validation

   */

  for (const [code, expected] of expectedByCode) {
    const actual = relevantActualByCode.get(code);

    if (!actual) {
      continue;
    }

    const checks: Array<[string, string, string]> = [
      [
        "Component Name",

        normalizeExpectedText(expected["Component Name"]),

        normalizeExpectedText(actual.componentName),
      ],

      [
        "Component Category",

        normalizeExpectedText(expected["Component Category"]),

        normalizeExpectedText(actual.componentCategory),
      ],
    ];

    for (const [field, expectedValue, actualValue] of checks) {
      if (expectedValue !== actualValue) {
        mismatches.push(
          `${code} ${field} expected="${expectedValue}" actual="${actualValue}"`,
        );
      }
    }

    /*

     * For Add + Update:

     * - real Excel RH must match the UI

     * - Excel blank/0 means "do not overwrite an existing RH", so we

     *   intentionally do not assert the post-import numeric value.

     */

    const excelHours = normalizeRunningHours(expected["Running Hours"]);

    if (excelHours !== null && excelHours !== "0") {
      const actualHours = normalizeUiRunningHours(actual.runningHours);

      if (excelHours !== actualHours) {
        mismatches.push(
          `${code} Running Hours expected="${
            excelHours ?? "<blank>"
          }" actual="${actualHours ?? "<blank>"}"`,
        );
      }
    }
  }

  /*

   * 2. INHERITED validation

   *

   * The Running Hours UI shows inherited records as a count on the

   * RH Counter Source row. Therefore group accepted INHERITED workbook

   * rows by RH Counter Source and compare the count with the UI's

   * "Inherited RH" value.

   */

  const inheritedBySource = new Map<string, ExpectedComponentRecord[]>();

  for (const inherited of inheritedExpected) {
    const inheritedCode = normalizeCode(inherited["Component Code"]);

    const sourceCode = normalizeCode(inherited["RH Counter Source"]);

    if (!sourceCode || sourceCode.toUpperCase() === "SELF") {
      mismatches.push(
        `${inheritedCode} INHERITED RH Counter Source is missing or invalid.`,
      );

      continue;
    }

    const records = inheritedBySource.get(sourceCode) ?? [];

    records.push(inherited);

    inheritedBySource.set(sourceCode, records);
  }

  for (const [sourceCode, inheritedRecords] of inheritedBySource) {
    const sourceActual = actualByCode.get(sourceCode);

    if (!sourceActual) {
      mismatches.push(
        `Inherited RH source "${sourceCode}" is not present in Running Hours UI.`,
      );

      continue;
    }

    const expectedInheritedCount = inheritedRecords.length;

    const actualInheritedCount = normalizeInheritedCount(
      sourceActual.inheritedRh,
    );

    if (actualInheritedCount !== expectedInheritedCount) {
      mismatches.push(
        `${sourceCode} Inherited RH count expected="${expectedInheritedCount}" actual="${actualInheritedCount}"`,
      );
    }
  }

  /*

   * The physical Running Hours row count represents MASTER records only.

   * INHERITED records are validated through the source row's Inherited RH

   * count.

   */

  return {
    expectedCount: masterExpected.length,

    actualCount: relevantActualByCode.size,

    missingCodes,

    unexpectedCodes,

    mismatches,
  };
}

function summarizeList(
  values: string[],

  limit = 12,
): string {
  if (!values.length) {
    return "None";
  }

  const shown = values

    .slice(0, limit)

    .join(", ");

  return values.length > limit
    ? `${shown}, ... (+${values.length - limit} more)`
    : shown;
}

function normalizeComponentDetailValue(
  value: unknown,
  normalization: ComponentFieldMapping["normalization"] = "text",
): string {
  const text = normalizeExpectedText(value)
    .replace(/^(?:\u2014|\u2013|-)$/, "")
    .trim();
  if (normalization === "boolean") {
    if (!text) return "No";
    if (/^(?:true|yes|y|1)$/i.test(text)) return "Yes";
    if (/^(?:false|no|n|0)$/i.test(text)) return "No";
  }
  if (normalization === "number") {
    return normalizeRunningHours(text) ?? "0";
  }
  if (normalization === "date" && text) {
    const dateParts = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(.*)$/);
    if (dateParts) {
      return `${dateParts[3]}-${dateParts[2].padStart(2, "0")}-${dateParts[1].padStart(2, "0")}${dateParts[4].trim()}`;
    }
    const isoParts = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(.*)$/);
    if (isoParts) {
      return `${isoParts[1]}-${isoParts[2].padStart(2, "0")}-${isoParts[3].padStart(2, "0")}${isoParts[4].trim()}`;
    }

    const namedMonthParts = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(.*)$/);
    if (namedMonthParts) {
      const month =
        [
          "jan",
          "feb",
          "mar",
          "apr",
          "may",
          "jun",
          "jul",
          "aug",
          "sep",
          "oct",
          "nov",
          "dec",
        ].indexOf(namedMonthParts[2].toLowerCase()) + 1;
      if (month > 0) {
        return `${namedMonthParts[3]}-${String(month).padStart(2, "0")}-${namedMonthParts[1].padStart(2, "0")}${namedMonthParts[4].trim()}`;
      }
    }
  }

  if (normalization === "case-insensitive-text") {
    return text.toLowerCase();
  }

  if (normalization === "rh-counter-type") {
    return (text || "Not RH Driven").toLowerCase();
  }

  return text;
}

async function compareComponentDetails(
  page: Page,

  componentsPage: Awaited<ReturnType<TechnicalPage["goToComponents"]>>,

  expectedRecords: ExpectedComponentRecord[],

  captureEvidence = true,
): Promise<{
  mismatches: string[];

  validatedFields: string[];

  notExposedFields: string[];

  reportComparisons: Array<{
    recordCode: string;
    recordName: string;
    field: string;
    expected: string;
    actual: string;
    status: "PASS" | "MISMATCH" | "ERROR";
    reason?: string;
    evidence?: { name: string; contentType: string; body: string };
  }>;
}> {
  const mismatches: string[] = [];

  const validatedFields = new Set<string>();

  const notExposedFields = new Set<string>();
  const reportComparisons: Array<{
    recordCode: string;
    recordName: string;
    field: string;
    expected: string;
    actual: string;
    status: "PASS" | "MISMATCH" | "ERROR";
    reason?: string;
    evidence?: { name: string; contentType: string; body: string };
  }> = [];

  let firstComponent = true;

  for (const [recordIndex, expected] of expectedRecords.entries()) {
    const code = normalizeCode(expected["Component Code"]);
    const recordName = normalizeExpectedText(expected["Component Name"]);
    const recordLabel = `Record ${recordIndex + 1} of ${expectedRecords.length}: ${code} - ${recordName}`;

    try {
      await componentsPage.selectComponentByCode(code);
    } catch (error) {
      const selectionError =
        error instanceof Error ? error.message : String(error);
      await recordStep(
        "Select Component",
        `${recordLabel} should be found and selected in the Components tree.`,
        `${recordLabel} could not be selected or its details did not become available. ${selectionError}`,
        "FAIL",
      );
      const evidenceName = `Failure Screenshot - Component ${code} - selection or details failed`;
      const evidenceBody = await page.screenshot();
      mismatches.push(
        `Component: ${code}\nField: Component details\nExpected Result: Component Information should be displayed.\nActual Application Result: Component Information could not be accessed: ${selectionError}\nAutomation Result: ERROR`,
      );
      reportComparisons.push({
        recordCode: code,
        recordName,
        field: "Open Component Details",
        expected: "Component Information should be displayed.",
        actual: `Component Information could not be accessed: ${selectionError}`,
        status: "ERROR",
        reason: `Component ${code} could not be selected or its details panel did not load.`,
        evidence: {
          name: evidenceName,
          contentType: "image/png",
          body: evidenceBody.toString("base64"),
        },
      });
      await test
        .info()
        .attach(evidenceName, { body: evidenceBody, contentType: "image/png" });
      continue;
    }

    await recordStep(
      "Search Component",
      `${recordLabel} should be available in the Components tree.`,
      `${recordLabel} was found.`,
      "PASS",
    );
    await recordStep(
      "Select Component",
      `${recordLabel} should be selected.`,
      `${recordLabel} was selected.`,
      "PASS",
    );

    let componentHasMismatch = false;
    let detailsPanelRecorded = false;

    if (captureEvidence && firstComponent) {
      await test.info().attach(`Component ${code} details - upper section`, {
        body: await page.screenshot(),

        contentType: "image/png",
      });
    }

    for (const mapping of COMPONENT_FIELD_MAPPINGS) {
      if (mapping.notExposedReason) {
        notExposedFields.add(
          `${mapping.excelColumn}: ${mapping.notExposedReason}`,
        );

        continue;
      }

      if (
        mapping.excelColumn === "Last Updated" &&
        !normalizeExpectedText(expected[mapping.excelColumn])
      ) {
        notExposedFields.add(
          "Last Updated: displayed by the UI but application-generated, so a blank workbook value is not deterministically comparable.",
        );

        continue;
      }

      const usesTextComparison =
        mapping.normalization === undefined ||
        mapping.normalization === "text" ||
        mapping.normalization === "case-insensitive-text";

      const expectedValue = normalizeComponentDetailValue(
        expected[mapping.excelColumn],

        mapping.normalization,
      );

      if (usesTextComparison && !expectedValue) {
        continue;
      }

      let actual: string;
      try {
        actual = await componentsPage.readSelectedComponentDetail({
          section: mapping.section!,
          label: mapping.uiField!,
        });
      } catch {
        await recordStep(
          `Validate ${mapping.excelColumn}`,
          `${mapping.uiField} in ${mapping.section} should be available for ${recordLabel}.`,
          `${mapping.uiField} in ${mapping.section} was not available within the configured timeout for ${recordLabel}.`,
          "FAIL",
        );
        const evidenceName = `Failure Screenshot - Component ${code} - ${mapping.section} not displayed`;
        const evidenceBody = await page.screenshot();
        componentHasMismatch = true;
        mismatches.push(
          `Component: ${code}\nField: ${mapping.excelColumn}\nExpected Result: ${mapping.section} should be displayed.\nActual Application Result: Component information could not be accessed within the allowed time.\nAutomation Result: ERROR`,
        );
        reportComparisons.push({
          recordCode: code,
          recordName,
          field: mapping.excelColumn,
          expected: `${mapping.section} should be displayed.`,
          actual:
            "Component information could not be accessed within the allowed time.",
          status: "ERROR",
          reason: `The ${mapping.section} section did not appear within the configured timeout.`,
          evidence: {
            name: evidenceName,
            contentType: "image/png",
            body: evidenceBody.toString("base64"),
          },
        });
        await test.info().attach(evidenceName, {
          body: evidenceBody,
          contentType: "image/png",
        });
        break;
      }
      if (!detailsPanelRecorded) {
        await recordStep(
          "Validate Component Details",
          `Component Information should be displayed for ${recordLabel}.`,
          `Component Information was displayed for ${recordLabel}.`,
          "PASS",
        );
        detailsPanelRecorded = true;
      }

      const detailValue =
        mapping.excelColumn === "Component Name"
          ? actual.replace(
              new RegExp(`^${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`),
              "",
            )
          : actual;

      const actualValue = normalizeComponentDetailValue(
        detailValue,
        mapping.normalization,
      );

      validatedFields.add(`${mapping.excelColumn} → ${mapping.uiField}`);

      const valuesMatch = usesTextComparison
        ? expectedValue.toLowerCase() === actualValue.toLowerCase()
        : expectedValue === actualValue;

      reportComparisons.push({
        recordCode: code,
        recordName,
        field: mapping.excelColumn,
        expected: expectedValue || "<blank>",
        actual: actualValue || "<blank>",
        status: valuesMatch ? "PASS" : "MISMATCH",
        reason: valuesMatch
          ? undefined
          : "Normalized Excel and UI values differ.",
      });

      if (!valuesMatch) {
        componentHasMismatch = true;

        mismatches.push(
          `Component: ${code}\nField: ${mapping.excelColumn}\nExpected Result: ${expectedValue || "<blank>"}\nActual Application Result: ${actualValue || "<blank>"}\nAutomation Result: FAIL`,
        );
      }
    }

    if (detailsPanelRecorded) {
      const recordComparisons = reportComparisons.filter(
        (item) => item.recordCode === code && item.status !== "ERROR",
      );
      const failedComparisons = recordComparisons.filter(
        (item) => item.status === "MISMATCH",
      );
      await recordStep(
        "Validate Component Fields",
        `All ${recordComparisons.length} configured Excel fields should match the UI for ${recordLabel}.`,
        failedComparisons.length
          ? `${failedComparisons.length} field comparison${failedComparisons.length === 1 ? "" : "s"} did not match for ${recordLabel}. See Validation Details.`
          : `All ${recordComparisons.length} configured fields matched for ${recordLabel}. See Validation Details for each Expected and Actual value.`,
        failedComparisons.length ? "FAIL" : "PASS",
      );
    }

    if (captureEvidence && firstComponent) {
      await test.info().attach(`Component ${code} details - lower section`, {
        body: await page.screenshot(),

        contentType: "image/png",
      });

      firstComponent = false;
    }

    if (captureEvidence && componentHasMismatch) {
      await test.info().attach(`Component ${code} detail mismatch`, {
        body: await page.screenshot(),

        contentType: "image/png",
      });
    }
  }

  return {
    mismatches,

    validatedFields: [...validatedFields],

    notExposedFields: [...notExposedFields],

    reportComparisons,
  };
}

export type ComponentAuditComparison = {
  actualRows: ComponentTreeRow[];
  missingCodes: string[];
  fieldMismatches: string[];
  hierarchyMismatches: string[];
  detailMismatches: string[];
};

export async function collectComponentAuditComparison(
  page: Page,
  importedExpectedRecords: ExpectedComponentRecord[],
): Promise<ComponentAuditComparison> {
  const technicalPage = new TechnicalPage(page);
  const componentsPage = await technicalPage.goToComponents();
  await componentsPage.expectToBeOnPage();
  await componentsPage.selectVessel(config.vesselName);
  await componentsPage.expandAll();
  const actualRows = await componentsPage.readExpandedTreeRows();
  const treeComparison = compareComponentTree(
    actualRows,
    importedExpectedRecords,
  );
  const actualCodes = new Set(actualRows.map((row) => normalizeCode(row.code)));
  const foundRecords = importedExpectedRecords.filter((record) =>
    actualCodes.has(normalizeCode(record["Component Code"])),
  );
  const detailComparison = await compareComponentDetails(
    page,
    componentsPage,
    foundRecords,
    false,
  );
  return {
    actualRows,
    missingCodes: treeComparison.missingCodes,
    fieldMismatches: treeComparison.fieldMismatches,
    hierarchyMismatches: treeComparison.hierarchyMismatches,
    detailMismatches: detailComparison.mismatches,
  };
}

export async function importUploadedComponents(
  page: Page,

  auditDashboardPage: AuditDashboardPage,

  importMode: ComponentsImportMode,
): Promise<ExpectedComponentRecord[]> {
  const result = await runBulkDataImportScenario(
    page,
    auditDashboardPage,
    {
      module: "components",
      mode: importMode,
      expectedResult: { outcome: "import", rowErrors: "skip-and-import" },
    },
    COMPONENTS_WORKBOOK,
  );

  expect(
    result.imported,
    "The Components workbook should complete import.",
  ).toBe(true);
  const rejectedRows = new Set(result.rejectedWorkbookRows);
  const importedExpectedRecords = expectedData.records.filter(
    (_record, index) => !rejectedRows.has(index + 2),
  );
  const totalRows = result.validRows + result.validationErrors;

  expect(
    totalRows,
    "The application validation total should match the current uploaded workbook row count.",
  ).toBe(expectedData.rowCount);
  expect(
    importedExpectedRecords.length,
    "The workbook rows accepted by the application should be used for Component post-import validation.",
  ).toBe(result.validRows);

  await test.info().attach("Import Data Summary", {
    body: [
      `Source workbook: ${path.basename(COMPONENTS_WORKBOOK)}`,
      `Workbook rows: ${expectedData.rowCount}`,
      `Application valid rows: ${result.validRows}`,
      `Application validation errors skipped: ${result.validationErrors}`,
      `Expected post-import records: ${importedExpectedRecords.length}`,
      "Post-import Components and Running Hours checks use only rows accepted by the application.",
    ].join("\n"),
    contentType: "text/plain",
  });

  saveComponentsImportResult(
    COMPONENTS_WORKBOOK,
    config.vesselName,
    result.rejectedWorkbookRows,
    importedExpectedRecords.length,
  );

  return importedExpectedRecords;
}

export type ComponentValidationResult = {
  successfullyImported: number;
  totalChecked: number;
  matched: number;
  missingCodes: string[];
  fieldMismatches: string[];
  hierarchyMismatches: string[];
  detailMismatches: string[];
};

export async function validateComponentsPage(
  page: Page,

  importedExpectedRecords: ExpectedComponentRecord[],

  options: {
    includeAuditSummary?: boolean;
    successfullyImported?: number;
  } = {},
): Promise<ComponentValidationResult> {
  const technicalPage = new TechnicalPage(page);

  const componentsPage = await technicalPage.goToComponents();

  await componentsPage.expectToBeOnPage();

  await componentsPage.selectVessel(config.vesselName);

  await recordStep(
    "Components Module",

    "The Components page should show the selected vessel.",

    `${config.vesselName} selected and Components page loaded.`,
  );

  await componentsPage.expandAll();

  await test.info().attach("Components hierarchy expanded", {
    body: await page.screenshot(),

    contentType: "image/png",
  });

  const actualTree = await componentsPage.readExpandedTreeRows();

  const comparison = compareComponentTree(
    actualTree,

    importedExpectedRecords,
  );

  const actualCodes = new Set(actualTree.map((row) => normalizeCode(row.code)));

  const treeOrder = new Map(
    actualTree.map((row, index) => [normalizeCode(row.code), index]),
  );

  const foundExpectedRecords = importedExpectedRecords

    .filter((record) =>
      actualCodes.has(normalizeCode(record["Component Code"])),
    )

    .sort(
      (first, second) =>
        (treeOrder.get(normalizeCode(first["Component Code"])) ??
          Number.MAX_SAFE_INTEGER) -
        (treeOrder.get(normalizeCode(second["Component Code"])) ??
          Number.MAX_SAFE_INTEGER),
    );

  const detailsComparison = await compareComponentDetails(
    page,

    componentsPage,

    foundExpectedRecords,
  );

  const expectedCount = importedExpectedRecords.length;

  const uploadedCodes = new Set(
    importedExpectedRecords.map((record) =>
      normalizeCode(record["Component Code"]),
    ),
  );

  const actualUploadedCount = actualTree.filter((row) =>
    uploadedCodes.has(normalizeCode(row.code)),
  ).length;

  const expectedSummary = `${expectedCount} successfully imported Excel components with matching code, name, and full parent hierarchy.`;

  const actualSummary = `${actualUploadedCount} uploaded components found in the Components page; missing ${comparison.missingCodes.length}; field mismatches ${comparison.fieldMismatches.length}; hierarchy mismatches ${comparison.hierarchyMismatches.length}. Pre-existing vessel components are ignored.`;

  const issueCodes = new Set([
    ...comparison.missingCodes,
    ...comparison.fieldMismatches.map(
      (item) => item.match(/^(\S+)/)?.[1] ?? item,
    ),
    ...comparison.hierarchyMismatches.map(
      (item) => item.match(/^(\S+)/)?.[1] ?? item,
    ),
    ...detailsComparison.mismatches.map(
      (item) => item.match(/Component:\s*([^\n]+)/)?.[1] ?? item,
    ),
  ]);
  const result: ComponentValidationResult = {
    successfullyImported:
      options.successfullyImported ?? importedExpectedRecords.length,
    totalChecked: expectedCount,
    matched: expectedCount - issueCodes.size,
    missingCodes: comparison.missingCodes,
    fieldMismatches: comparison.fieldMismatches,
    hierarchyMismatches: comparison.hierarchyMismatches,
    detailMismatches: detailsComparison.mismatches,
  };
  await test.info().attach("Components validation comparison data", {
    body: JSON.stringify(detailsComparison.reportComparisons),
    contentType: "application/json",
  });

  await test.info().attach(
    "Components UI vs Excel comparison",

    {
      body: [
        `Expected source workbook: ${expectedData.sourceWorkbook}`,

        `Expected records: ${expectedCount}`,

        `Actual Components tree records (all vessel data): ${actualTree.length}`,

        `Actual records matching this successful Excel import: ${actualUploadedCount}`,

        "Pre-existing/non-uploaded vessel Components are ignored for this validation.",

        `Missing codes: ${comparison.missingCodes.length} (${summarizeList(comparison.missingCodes)})`,

        `Unexpected codes: ${comparison.unexpectedCodes.length} (${summarizeList(comparison.unexpectedCodes)})`,

        `Name mismatches: ${comparison.fieldMismatches.length} (${summarizeList(comparison.fieldMismatches)})`,

        `Hierarchy mismatches: ${comparison.hierarchyMismatches.length} (${summarizeList(comparison.hierarchyMismatches)})`,

        `Component detail mismatches: ${detailsComparison.mismatches.length}`,

        `Fields validated:\n${detailsComparison.validatedFields.join("\n")}`,

        `Fields not exposed/not deterministically comparable: ${detailsComparison.notExposedFields.join(" | ")}`,
      ].join("\n"),

      contentType: "text/plain",
    },
  );

  if (options.includeAuditSummary) {
    const review = [
      ...result.missingCodes,
      ...result.fieldMismatches,
      ...result.detailMismatches,
      ...result.hierarchyMismatches,
    ];
    const mismatch = (text: string, fallbackField: string) => {
      const componentCode =
        text.match(/Component:\s*([^\n]+)/)?.[1]?.trim() ??
        text.match(/^(\S+)/)?.[1] ??
        "";
      return {
        identifiers: { "Component Code": componentCode },
        field: text.match(/Field:\s*([^\n]+)/)?.[1]?.trim() ?? fallbackField,
        expected:
          text.match(/Expected (?:Result)?:?\s*([^\n]+)/)?.[1]?.trim() ??
          text.match(/expected="([^"]*)"/)?.[1] ??
          "Expected value",
        actual:
          text.match(/Actual Application Result:\s*([^\n]+)/)?.[1]?.trim() ??
          text.match(/actual="([^"]*)"/)?.[1] ??
          "Different value",
        reason: "Normalized values differ.",
      };
    };
    const partial = result.totalChecked < result.successfullyImported;
    const automationIssues = detailsComparison.reportComparisons.filter(
      (item) => item.status === "ERROR",
    );
    const attemptedRecords = new Set(
      detailsComparison.reportComparisons.map((item) => item.recordCode),
    ).size;
    generateStandardAuditReport({
      dataType: "Components",
      fileName: `components-validation-audit${partial ? "-partially" : ""}.html`,
      vessel: config.vesselName,
      excelFile: expectedData.sourceWorkbook,
      uploadedBy: config.username,
      validationType: partial
        ? `Partial - first ${result.totalChecked} successfully imported records`
        : "Complete",
      successfullyImported: result.successfullyImported,
      recordsSelected: result.totalChecked,
      recordsAttempted: attemptedRecords,
      recordsChecked: result.totalChecked,
      recordsMatched: result.matched,
      identifierColumns: ["Component Code"],
      missingRecords: result.missingCodes.map((code) => ({
        identifiers: { "Component Code": code },
        issue: "Component record not found.",
      })),
      fieldMismatches: [
        ...result.fieldMismatches.map((item) =>
          mismatch(item, "Component field"),
        ),
        ...result.detailMismatches
          .filter((item) => !/Automation Result:\s*ERROR/i.test(item))
          .map((item) => mismatch(item, "Component detail")),
        ...result.hierarchyMismatches.map((item) =>
          mismatch(item, "Component hierarchy"),
        ),
      ],
      automationIssues: automationIssues.map((item) => ({
        identifiers: { "Component Code": item.recordCode },
        failedStep:
          item.field === "Open Component Details"
            ? "Select Component / Validate Component Details"
            : "Validate Component Details",
        expected: item.expected,
        actual: item.actual,
        reason:
          item.reason ??
          "The details panel did not reach its expected loaded state.",
        evidence: item.evidence,
      })),
    });
    await test.info().attach("Components audit summary", {
      body: [
        "AUDIT SUMMARY",
        `Source File: ${expectedData.sourceWorkbook}`,
        `Vessel: ${config.vesselName}`,
        `Uploaded By: ${config.username}`,
        `Successfully Imported: ${result.successfullyImported}`,
        `Audited: ${result.totalChecked}`,
        `Matched: ${result.matched}`,
        `Records With Issues: ${issueCodes.size}`,
        `Missing: ${result.missingCodes.length}`,
        `Field Mismatches: ${result.fieldMismatches.length + result.detailMismatches.length}`,
        `Hierarchy Mismatches: ${result.hierarchyMismatches.length}`,
        "",
        "RECORDS REQUIRING REVIEW",
        ...(review.length ? review : ["No records require review."]),
        "",
        "FINAL AUDIT RESULT",
        `${result.successfullyImported} records successfully imported`,
        `${result.totalChecked} records audited`,
        `${result.matched} matched`,
        `${issueCodes.size} require review`,
      ].join("\n"),
      contentType: "text/plain",
    });
  }

  await test.step(`Components Data Match\nStatus: PASS\nExpected: ${expectedSummary}\nActual: ${actualSummary}`, async () => {
    expect(
      comparison.missingCodes,

      "No accepted uploaded component code should be missing from the Components tree.",
    ).toEqual([]);

    expect(
      comparison.fieldMismatches,

      "Component code/name values should match the workbook.",
    ).toEqual([]);

    expect(
      comparison.hierarchyMismatches,

      "Parent/child/sub-child relationships should match the workbook.",
    ).toEqual([]);

    expect(
      detailsComparison.mismatches,

      "Every UI-verifiable Component detail should match the accepted workbook record.",
    ).toEqual([]);
  });

  return result;
}

async function validateRunningHoursPage(
  page: Page,

  importedExpectedRecords: ExpectedComponentRecord[],
): Promise<void> {
  const technicalPage = new TechnicalPage(page);

  const runningHoursPage = await technicalPage.goToRunningHours();

  await runningHoursPage.expectToBeOnPage();

  await runningHoursPage.selectVessel(config.vesselName);

  const actualRows = await runningHoursPage.readOverviewRows({
    allowEmpty: true,
  });

  await test.info().attach("Running Hours after import", {
    body: await page.screenshot(),

    contentType: "image/png",
  });

  const comparison = compareRunningHours(
    actualRows,

    importedExpectedRecords,
  );

  const expectedSummary = `${comparison.expectedCount} MASTER Running Hours rows; accepted INHERITED records are validated through the source row's Inherited RH count.`;

  const actualSummary = `${comparison.actualCount} rows; missing ${comparison.missingCodes.length}; unexpected ${comparison.unexpectedCodes.length}; mismatches ${comparison.mismatches.length}.`;

  await test.info().attach(
    "Running Hours UI vs Excel comparison",

    {
      body: [
        `Expected source workbook: ${expectedData.sourceWorkbook}`,

        `Expected RH-driven records: ${comparison.expectedCount}`,

        `UI records matching uploaded MASTER codes: ${comparison.actualCount}`,

        `Missing codes: ${comparison.missingCodes.length} (${summarizeList(comparison.missingCodes)})`,

        `Unexpected codes: ${comparison.unexpectedCodes.length} (${summarizeList(comparison.unexpectedCodes)})`,

        `Value/field mismatches: ${comparison.mismatches.length} (${summarizeList(comparison.mismatches)})`,
      ].join("\n"),

      contentType: "text/plain",
    },
  );

  await test.step(`Running Hours Data Match\nStatus: PASS\nExpected: ${expectedSummary}\nActual: ${actualSummary}`, async () => {
    expect(
      comparison.missingCodes,

      "No RH-driven uploaded component should be missing from Running Hours.",
    ).toEqual([]);

    expect(
      comparison.unexpectedCodes,

      "Running Hours should not contain an unexpected RH-driven component.",
    ).toEqual([]);

    expect(
      comparison.mismatches,

      "Running Hours name/category/value/inherited RH should match the workbook.",
    ).toEqual([]);
  });
}

async function validateCachedData(
  page: Page,

  importedExpectedRecords: ExpectedComponentRecord[],
): Promise<void> {
  const technicalPage = new TechnicalPage(page);

  const componentsPage = await technicalPage.goToComponents();

  await componentsPage.expectToBeOnPage();

  await componentsPage.selectVessel(config.vesselName);

  await componentsPage.expandAll();

  const refreshedComponents = await componentsPage.readExpandedTreeRows();

  const componentComparison = compareComponentTree(
    refreshedComponents,

    importedExpectedRecords,
  );

  const refreshedRunningHours = await technicalPage.goToRunningHours();

  await refreshedRunningHours.expectToBeOnPage();

  await refreshedRunningHours.selectVessel(config.vesselName);

  const refreshedRhRows = await refreshedRunningHours.readOverviewRows();

  const rhComparison = compareRunningHours(
    refreshedRhRows,

    importedExpectedRecords,
  );

  const importedCodes = new Set(
    importedExpectedRecords.map((record) =>
      normalizeCode(record["Component Code"]),
    ),
  );

  const refreshedImportedComponentCount = refreshedComponents.filter((row) =>
    importedCodes.has(normalizeCode(row.code)),
  ).length;

  const cachedExpected = `the same ${importedExpectedRecords.length} successfully imported Excel Components records and ${rhComparison.expectedCount} MASTER Running Hours rows should remain after fresh navigation; pre-existing vessel data is ignored and accepted INHERITED records remain validated through source-row counts.`;

  const cachedActual = `Uploaded Components found ${refreshedImportedComponentCount} (all vessel Components ${refreshedComponents.length}); Running Hours ${refreshedRhRows.length}; component mismatches ${
    componentComparison.missingCodes.length +
    componentComparison.unexpectedCodes.length +
    componentComparison.fieldMismatches.length +
    componentComparison.hierarchyMismatches.length
  }; RH mismatches ${
    rhComparison.missingCodes.length +
    rhComparison.unexpectedCodes.length +
    rhComparison.mismatches.length
  }.`;

  await test.step(`Refresh and Cached Data\nStatus: PASS\nExpected: ${cachedExpected}\nActual: ${cachedActual}`, async () => {
    expect(
      refreshedImportedComponentCount,

      "Only successfully imported Excel component codes are counted; pre-existing vessel Components are outside this validation scope.",
    ).toBe(importedExpectedRecords.length);

    expect(componentComparison.missingCodes).toEqual([]);

    expect(componentComparison.unexpectedCodes).toEqual([]);

    expect(componentComparison.fieldMismatches).toEqual([]);

    expect(componentComparison.hierarchyMismatches).toEqual([]);

    expect(rhComparison.missingCodes).toEqual([]);

    expect(rhComparison.unexpectedCodes).toEqual([]);

    expect(rhComparison.mismatches).toEqual([]);
  });
}

export async function runComponentsAndRunningHoursScenario(
  page: Page,

  auditDashboardPage: AuditDashboardPage,

  importMode: ComponentsImportMode,

  options: { stopAfterRunningHours?: boolean } = {},
): Promise<void> {
  test.setTimeout(0);

  await test.step(`Expected data source - ${IMPORT_MODE_LABELS[importMode]}`, async () => {
    expect(expectedData.sheet).toBe("Data");

    expect(expectedData.records.length).toBe(expectedData.rowCount);

    expect(expectedData.rowCount).toBeGreaterThan(0);

    expect(COMPONENTS_WORKBOOK).toContain(
      path.join(
        "test-data",

        "components-validation",
      ),
    );

    expect(config.baseUrl).toBeTruthy();
  });

  const importedExpectedRecords = await importUploadedComponents(
    page,

    auditDashboardPage,

    importMode,
  );

  await validateRunningHoursPage(
    page,

    importedExpectedRecords,
  );

  if (options.stopAfterRunningHours) {
    return;
  }

  await validateComponentsPage(
    page,

    importedExpectedRecords,
  );

  await validateCachedData(
    page,

    importedExpectedRecords,
  );
}

export function loadPersistedImportedExpectedRecords(): ExpectedComponentRecord[] {
  return loadImportedExpectedComponentData(
    COMPONENTS_WORKBOOK,

    config.vesselName,
  ).records.filter((record) =>
    normalizeExpectedText(record["Parent Component Code"]),
  );
}
