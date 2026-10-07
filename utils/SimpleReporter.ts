// Writes a small, self-contained summary for people who do not read test logs.
// The detailed Playwright report remains available for technical investigation.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { config } from "./config";
import { generateStandardAuditReport } from "./standardAuditReport";

type ValidationErrorRow = {
  row: string;
  dataPreview: string;
  errorDetails: string;
};
type FieldComparison = {
  recordCode: string;
  recordName?: string;
  field: string;
  expected: string;
  actual: string;
  status: "PASS" | "MISMATCH" | "MISSING" | "ERROR";
  reason?: string;
  evidence?: { name: string; contentType: string; body: string };
};
type ReportAttachment = { name: string; contentType: string; body: string };
type BulkImportFileAttempt = {
  fileName: string;
  module?: string;
  importMode?: string;
};
type ResultRow = {
  specName: string;
  title: string;
  tags: string[];
  status: string;
  duration: number;
  error: string;
  steps: string[];
  failedSteps: string[];
  uploadedFiles: BulkImportFileAttempt[];
  historyDetails?: string;
  evidence: ReportAttachment[];
  attachments: ReportAttachment[];
  comparisons: FieldComparison[];
  validationSections: {
    title: string;
    details: string;
    screenshots: string[];
    rows: ValidationErrorRow[];
  }[];
};

/**
 * Builds a simple HTML summary for a Playwright run so testers can spot pass and fail trends quickly.
 */
export default class SimpleReporter implements Reporter {
  private rows = new Map<string, ResultRow>();
  private startedAt = new Date();

  /**
   * What this does: Resets the timer at the start of the test run.
   * When it's used: When Playwright starts the suite.
   * @returns Nothing
   */
  onBegin(): void {
    this.startedAt = new Date();
    this.rows.clear();
  }

  /**
   * What this does: Stores the result from each test so the summary report can show pass, fail, and retry details.
   * When it's used: After each test finishes.
   * @param test - The test case being recorded.
   * @param result - The execution result for that test.
   * @returns Nothing
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    const bodyFor = (attachment: TestResult["attachments"][number]) =>
      attachment.body ??
      (attachment.path && fs.existsSync(attachment.path)
        ? fs.readFileSync(attachment.path)
        : undefined);
    const businessSteps = getBusinessStepTitles(result.steps);
    const failedSteps = getFailedStepTitles(result.steps);
    this.rows.set(test.id, {
      specName: getSpecReportName(test.location.file),
      title: test.title,
      tags: test.tags,
      status: result.status,
      duration: result.duration,
      error: result.error
        ? simplifyValidationError(
            result.error.message ?? "",
            test.title,
            businessSteps,
            failedSteps,
          )
        : "",
      steps: businessSteps,
      failedSteps,
      uploadedFiles: readBulkImportFileAttempts(result.attachments, bodyFor),
      historyDetails: (() => {
        const attachment = result.attachments.find(
          (item) => item.name === "Latest import history record",
        );
        return attachment ? bodyFor(attachment)?.toString() : undefined;
      })(),
      evidence: result.attachments.flatMap((attachment) => {
        const body = bodyFor(attachment);
        if (!attachment.contentType.startsWith("image/") || !body) return [];
        if (
          !/failure|validation evidence|validation screenshot|import complete|import summary screenshot|import successful|workbook accepted|partial import confirmation|post-import screenshot|details - upper section|rejection screenshot/i.test(
            attachment.name,
          )
        )
          return [];
        return [
          {
            name: attachment.name,
            contentType: attachment.contentType,
            body: body.toString("base64"),
          },
        ];
      }),
      attachments: result.attachments.flatMap((attachment) => {
        const body = bodyFor(attachment);
        if (!body || attachment.contentType.startsWith("image/")) return [];
        if (
          attachment.name === "Latest import history record" ||
          attachment.name.startsWith("Validation Errors - ") ||
          attachment.name.startsWith("Validation Error Rows - ") ||
          attachment.name.startsWith("Bulk Import File Attempt - ")
        )
          return [];
        if (
          /error-context|current page|snapshot|trace|call log|audit report|^validation results$|validation screenshot|validation comparison data/i.test(
            attachment.name,
          )
        )
          return [];
        if (!/^(text\/|application\/(?:json|xml))/.test(attachment.contentType))
          return [];
        return [
          {
            name: attachment.name,
            contentType: attachment.contentType,
            body: body.toString(),
          },
        ];
      }),
      comparisons: result.attachments
        .filter((attachment) =>
          /validation comparison data/i.test(attachment.name),
        )
        .flatMap((attachment) => {
          try {
            const body = bodyFor(attachment);
            return body
              ? (JSON.parse(body.toString()) as FieldComparison[])
              : [];
          } catch {
            return [];
          }
        }),
      validationSections: result.attachments
        .filter((attachment) =>
          attachment.name.startsWith("Validation Errors - "),
        )
        .map((attachment) => {
          const title = attachment.name.replace("Validation Errors - ", "");
          const screenshots = result.attachments
            .filter((image) =>
              image.name.startsWith(
                `Validation Error Screenshot - ${title} - `,
              ),
            )
            .flatMap((image) => {
              const body = bodyFor(image);
              return body ? [body.toString("base64")] : [];
            });
          const rowsAttachment = result.attachments.find(
            (rows) => rows.name === `Validation Error Rows - ${title}`,
          );
          let rows: ValidationErrorRow[] = [];
          try {
            const rowsBody = rowsAttachment
              ? bodyFor(rowsAttachment)
              : undefined;
            rows = rowsBody
              ? (JSON.parse(rowsBody.toString()) as ValidationErrorRow[])
              : [];
          } catch {
            rows = [];
          }
          return {
            title,
            details: bodyFor(attachment)?.toString() ?? "",
            screenshots,
            rows,
          };
        }),
    });
  }

  /**
   * What this does: Saves a final summary HTML file with totals, failed steps, and screenshots.
   * When it's used: After the whole suite finishes so human-readable results are available.
   * @param result - The full Playwright run result to summarise.
   * @returns Nothing
   */
  async onEnd(result: FullResult): Promise<void> {
    void result;
    const runRows = [...this.rows.values()];
    const rowsBySpec = new Map<string, ResultRow[]>();
    for (const row of runRows)
      rowsBySpec.set(row.specName, [
        ...(rowsBySpec.get(row.specName) ?? []),
        row,
      ]);
    const validationDirectory = path.resolve("reports", "validation");
    for (const [specName, specRows] of rowsBySpec) {
      const reportPath = path.resolve(validationDirectory, `${specName}.html`);
      if (path.dirname(reportPath) !== validationDirectory) {
        throw new Error(
          `Validation report resolved outside reports/validation: ${reportPath}`,
        );
      }
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        renderValidationReport(specName, specRows, this.startedAt),
        "utf8",
      );
      ensureAuditReport(specName, specRows, this.startedAt);
    }

    const packageScript = path.resolve(
      "scripts",
      "package-playwright-report.ps1",
    );
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", packageScript],
      { stdio: "inherit" },
    );
  }
}

/**
 * What this does: Escapes special characters so the summary report stays valid HTML.
 * When it's used: Before writing any test names or messages into the report output.
 * @param value - The text that needs to be safe for HTML output.
 * @returns The HTML-safe version of the text.
 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

function getSpecReportName(specFile: string): string {
  const fileName = path.basename(specFile);
  return fileName.endsWith(".spec.ts")
    ? fileName.slice(0, -".spec.ts".length)
    : path.parse(fileName).name;
}

function renderSpecReport(
  specName: string,
  rows: ResultRow[],
  startedAt: Date,
): string {
  const passed = rows.filter((row) => row.status === "passed").length;
  const failed = rows.filter(
    (row) => row.status !== "passed" && row.status !== "skipped",
  ).length;
  const skipped = rows.filter((row) => row.status === "skipped").length;
  const total = rows.length;
  const passPercent = total === 0 ? 0 : Math.round((passed / total) * 100);
  const reportStatus = failed ? "FAIL" : skipped === total ? "SKIPPED" : "PASS";
  const reportRows = rows.map(renderResultRow).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(specName)} Execution Report</title><style>body{font:16px system-ui;margin:32px;color:#17202a}h1{color:${failed ? "#b42318" : "#167c3a"}}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d5dd;padding:8px;text-align:left;vertical-align:top}th{background:#eef2f6}.card,button{display:inline-block;margin:4px;padding:12px 18px;background:#eef2f6;border:1px solid #d0d5dd;border-radius:6px}img{display:block;max-width:900px;margin-top:12px}pre{white-space:pre-wrap}.pass{color:#167c3a}.fail{color:#b42318}.business-steps{table-layout:fixed}.business-steps th:nth-child(1){width:8%}.business-steps th:nth-child(2){width:27%}.business-steps th:nth-child(3){width:27%}.business-steps th:nth-child(4){width:28%}.business-steps th:nth-child(5){width:10%}</style></head><body><h1>${escapeHtml(specName)} — ${reportStatus}</h1><p>${startedAt.toLocaleString()} | ${escapeHtml(config.baseUrl)}</p><div class="card">Total: ${total}</div><div class="card">Passed: ${passed}</div><div class="card">Failed: ${failed}</div><div class="card">Skipped: ${skipped}</div><div class="card">Pass: ${passPercent}%</div><h2>Execution Results</h2><p>Green means the check passed. Red means the check needs attention. A failed check includes its business-level result and evidence where available.</p><p><button onclick="show('all')">All</button><button onclick="show('passed')">Passed</button><button onclick="show('failed')">Failed</button></p><table><thead><tr><th>No.</th><th>Test / Scenario and Execution Details</th><th>Result</th><th>Time</th></tr></thead><tbody>${reportRows}</tbody></table><script>function show(status){document.querySelectorAll('tr[data-status]').forEach(row=>row.hidden=status!=='all'&&!row.dataset.status.includes(status));}</script></body></html>`;
}

function renderValidationReport(
  specName: string,
  rows: ResultRow[],
  startedAt: Date,
): string {
  const fileAttempts = rows.flatMap((row) => row.uploadedFiles);
  const moduleName =
    fileAttempts.find((attempt) => attempt.module)?.module ??
    moduleNameForSpec(specName);
  const validationType = /partially|partial/i.test(specName)
    ? "Partial"
    : "Complete";
  const overallStatus = rows.some(
    (row) => row.status !== "passed" && row.status !== "skipped",
  )
    ? "FAILED"
    : "PASSED";
  const importMode =
    fileAttempts.find((attempt) => attempt.importMode)?.importMode ??
    importModeForSpec(specName);
  const uploadedFiles = [
    ...new Set(fileAttempts.map((attempt) => attempt.fileName)),
  ];
  const uploadedFileInformation = uploadedFiles.length
    ? `<br><strong>Uploaded File:</strong> ${uploadedFiles.map(escapeHtml).join(", ")}`
    : "";
  const executionInformation = `<h2>Execution Information</h2><p><strong>Module:</strong> ${escapeHtml(moduleName)}<br><strong>Validation Type:</strong> ${validationType}<br><strong>Vessel:</strong> ${escapeHtml(config.vesselName)}<br><strong>Import Mode:</strong> ${escapeHtml(importMode)}${uploadedFileInformation}<br><strong>Logged-in User:</strong> ${escapeHtml(config.username)}<br><strong>Execution Date:</strong> ${escapeHtml(startedAt.toLocaleString())}<br><strong>Overall Status:</strong> ${overallStatus}</p>`;
  return renderSpecReport(specName, rows, startedAt)
    .replace(
      `<title>${escapeHtml(specName)} Execution Report</title>`,
      `<title>${escapeHtml(moduleName.toUpperCase())} VALIDATION REPORT</title>`,
    )
    .replace(
      `<h1>${escapeHtml(specName)} â€”`,
      `<h1>${escapeHtml(moduleName.toUpperCase())} VALIDATION REPORT â€”`,
    )
    .replace(
      `<p>${startedAt.toLocaleString()} | ${escapeHtml(config.baseUrl)}</p>`,
      executionInformation,
    )
    .replace(/<p>Tags:.*?<\/p>/g, "");
}

function isBusinessStep(title: string): boolean {
  return !/getBy(?:Role|Text|TestId)|locator\s*\(|selector|\.spec\.ts|\.ts:\d|stack trace/i.test(
    title,
  );
}

function getBusinessStepTitles(steps: TestStep[]): string[] {
  const titles = steps.flatMap((step) => [
    ...(step.category === "test.step" && isBusinessStep(step.title)
      ? [step.title]
      : []),
    ...getBusinessStepTitles(step.steps),
  ]);
  const firstLogin = titles.findIndex((title) =>
    /^(?:Step\s+\d+\s+-\s+)?(?:Log in|Login)\b/i.test(title),
  );
  return titles.filter(
    (title, index) =>
      !/^(?:Step\s+\d+\s+-\s+)?(?:Log in|Login)\b/i.test(title) ||
      index === firstLogin,
  );
}

function expectedForStep(name: string): string {
  const cleanName = name.replace(/[.]+$/, "");
  if (/^log in/i.test(cleanName))
    return "User should successfully log in to the application.";
  if (/^(?:open|navigate to)\b/i.test(cleanName))
    return `${cleanName} should open successfully.`;
  if (/^select\b/i.test(cleanName))
    return `${cleanName} should be selected successfully.`;
  if (/^(?:upload|import)\b/i.test(cleanName))
    return `${cleanName} should complete with the configured test data.`;
  if (/^(?:verify|validate|confirm|check)\b/i.test(cleanName))
    return `${cleanName} should match the expected application result.`;
  if (/^(?:read|capture)\b/i.test(cleanName))
    return `${cleanName} should return the application data required by the scenario.`;
  if (/^(?:fill|enter|answer)\b/i.test(cleanName))
    return `${cleanName} should accept the configured test data.`;
  if (/^(?:save|submit|approve|create|edit)\b/i.test(cleanName))
    return `${cleanName} should complete successfully in the application.`;
  return `The application should satisfy this business check: ${cleanName}.`;
}

function actualForStep(name: string, failed: boolean): string {
  const cleanName = name.replace(/[.]+$/, "");
  return failed
    ? `The application did not satisfy this business check: ${cleanName}.`
    : `The application satisfied this business check: ${cleanName}.`;
}

function parseBusinessStep(
  title: string,
  index: number,
  row: ResultRow,
): {
  number: string;
  title: string;
  expected: string;
  actual: string;
  status: string;
} {
  const heading = title.match(/^(?:Step\s+(\d+)\s+-\s+)?([^\r\n]+)/);
  const explicitStatus = title
    .match(/(?:^|\r?\n)Status:\s*([^\r\n]+)/i)?.[1]
    ?.trim();
  const number = heading?.[1] ?? String(index + 1);
  const name = heading?.[2] ?? title.split(/\r?\n/)[0];
  const content = title.split(/\r?\n/).slice(1).join("\n");
  const expected =
    content.match(/(?:^|\r?\n)Expected:\s*([^\r\n]+)/i)?.[1]?.trim() ??
    expectedForStep(name);
  const details = content
    .match(
      /(?:^|\r?\n)Details:\s*([\s\S]*?)(?=\r?\n(?:Status:|Expected:|Actual:)|$)/i,
    )?.[1]
    ?.trim();
  const failed = row.failedSteps.some(
    (failedTitle) =>
      failedTitle === title || failedTitle.startsWith(`Step ${number} -`),
  );
  let actual =
    content
      .match(
        /(?:^|\r?\n)Actual:\s*([\s\S]*?)(?=\r?\n(?:Status:|Expected:)|$)/i,
      )?.[1]
      ?.trim() ??
    details ??
    actualForStep(name, failed);
  if (
    number === "16" &&
    row.historyDetails &&
    /Created:\s*Not displayed/i.test(actual)
  ) {
    const created = readHistoryValue(row.historyDetails, "Created");
    if (created)
      actual = actual.replace(
        /Created:\s*Not displayed/i,
        `Created: ${created}`,
      );
  }
  const status = explicitStatus ?? (failed ? "FAIL" : "PASS");
  return { number, title: name, expected, actual, status };
}

function renderResultRow(row: ResultRow, index: number): string {
  const parsedSteps = row.steps.map((title, stepIndex) =>
    parseBusinessStep(title, stepIndex, row),
  );
  if (!parsedSteps.length) {
    parsedSteps.push({
      number: "1",
      title: row.title,
      expected: expectedForStep(row.title),
      actual:
        row.status === "passed"
          ? "All recorded scenario business checks passed."
          : "The scenario ended before a business step was recorded.",
      status:
        row.status === "passed"
          ? "PASS"
          : row.status === "skipped"
            ? "NOT RUN"
            : "FAIL",
    });
  }
  const validationSummary = readValidationSummary(
    parsedSteps.map((step) => step.actual).join("\n"),
  );
  const steps = parsedSteps
    .map((step) => {
      const status = /^(?:pass|passed)$/i.test(step.status)
        ? "PASS"
        : /^(?:not run|skipped)$/i.test(step.status)
          ? "NOT RUN"
          : "FAIL";
      const stepText = `${step.expected}\n${step.actual}`;
      const code =
        stepText.match(/Record\s+\d+\s+of\s+\d+:\s*([\w.-]+)/i)?.[1] ??
        stepText.match(/Component Code:\s*([\w.-]+)/i)?.[1];
      const failureEvidence =
        status === "FAIL"
          ? row.evidence.find(
              (item) =>
                /failure/i.test(item.name) &&
                (!code || item.name.includes(code)),
            )
          : undefined;
      const evidenceRow = failureEvidence
        ? `<tr><td></td><td colspan="4"><strong>Failure Evidence</strong><figure><figcaption>${escapeHtml(failureEvidence.name)}</figcaption><img alt="${escapeHtml(failureEvidence.name)}" src="data:${failureEvidence.contentType};base64,${failureEvidence.body}"></figure></td></tr>`
        : "";
      return `<tr><td>${escapeHtml(step.number)}</td><td>${escapeHtml(step.title)}</td><td>${escapeHtml(step.expected)}</td><td>${escapeHtml(step.actual).replace(/\r?\n/g, "<br>")}</td><td class="${status === "PASS" ? "pass" : "fail"}">${status}</td></tr>${evidenceRow}`;
    })
    .join("");

  const validation = row.validationSections
    .map((section) => {
      const normalized = normalizeValidationErrorRows(section.rows);
      const errors = Number(
        section.details.match(/Total Errors:\s*(\d+)/i)?.[1] ??
          validationSummary.errors ??
          normalized.rows.length,
      );
      const fileMatch = section.details.match(
        /(?:Valid|Invalid|Input|Uploaded) File:\s*([^\r\n]+)/i,
      );
      const fileName = fileMatch?.[1]?.trim() ?? "Not displayed";
      const errorRows = normalized.rows
        .map(
          (error) =>
            `<tr><td>${escapeHtml(error.row)}</td><td>${formatDataPreview(error.dataPreview)}</td><td>${escapeHtml(error.errorDetails).replace(/\r?\n/g, "<br>")}</td></tr>`,
        )
        .join("");
      const table = errorRows
        ? `<table><thead><tr><th>Row</th><th>Data Preview</th><th>Error Details</th></tr></thead><tbody>${errorRows}</tbody></table>`
        : "";
      const summary = `<section><h3>Validation Summary</h3><p>Total Rows: ${escapeHtml(validationSummary.totalRows ?? "Not displayed")}<br>Valid Rows: ${escapeHtml(validationSummary.validRows ?? "Not displayed")}<br>Warnings: ${escapeHtml(validationSummary.warnings ?? "Not displayed")}<br>Errors: ${escapeHtml(validationSummary.errors ?? String(errors))}</p></section>`;
      const mismatch =
        normalized.rows.length !== errors
          ? `<br>Unmatched Error Row Count: ${normalized.rows.length - errors}`
          : "";
      const expectedRows = section.details.match(
        /Expected Error Rows:\s*(\d+)/i,
      )?.[1];
      const actualApplicationResult = section.details.match(
        /Actual Application Result:\s*([^\r\n]+)/i,
      )?.[1];
      const automationResult = section.details.match(
        /Automation Result:\s*([^\r\n]+)/i,
      )?.[1];
      const resultComparison = `<p><strong>Expected Result:</strong> Captured unique validation rows should match the application-reported count.${actualApplicationResult ? `<br><strong>Actual Application Result:</strong> ${escapeHtml(actualApplicationResult)}` : ""}${automationResult ? `<br><strong>Automation Result:</strong> ${escapeHtml(automationResult)}` : ""}</p>`;
      const reconciliation = `${resultComparison}<p>Total Errors: ${errors}${expectedRows ? `<br>Expected Error Rows: ${expectedRows}` : ""}<br>Popup Table Rows Read: ${section.rows.length}<br>Error Rows Captured: ${normalized.rows.length}${normalized.repeatedHeaders ? `<br>Repeated Header Rows Excluded: ${normalized.repeatedHeaders}` : ""}${normalized.duplicates ? `<br>Duplicate Detail Rows Excluded: ${normalized.duplicates}` : ""}${mismatch}</p>`;
      const screenshots = section.screenshots
        .map(
          (image, screenshotIndex) =>
            `<p>Validation screenshot ${screenshotIndex + 1}</p><img alt="Validation Results — ${escapeHtml(section.title)}" src="data:image/png;base64,${image}">`,
        )
        .join("");
      return `${summary}<section><h3>Validation Results — ${escapeHtml(section.title)}</h3><p>Uploaded File: ${escapeHtml(fileName)}</p><h4>Validation Errors</h4>${reconciliation}${table}${screenshots}</section>`;
    })
    .join("");
  const history = row.historyDetails
    ? `<section><h3>History Details</h3><pre>${escapeHtml(row.historyDetails)}</pre></section>`
    : "";
  const evidence = row.evidence
    .filter((image) => !/failure/i.test(image.name))
    .map(
      (image) =>
        `<figure><figcaption>${escapeHtml(image.name)}</figcaption><img alt="${escapeHtml(image.name)}" src="data:${image.contentType};base64,${image.body}"></figure>`,
    )
    .join("");
  const details = row.attachments
    .map(
      (attachment) =>
        `<section><h3>${escapeHtml(attachment.name)}</h3><pre>${escapeHtml(cleanBusinessText(attachment.body))}</pre></section>`,
    )
    .join("");
  const comparisonRows = row.comparisons
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.recordCode)}</td><td>${escapeHtml(item.recordName ?? "")}</td><td>${escapeHtml(item.field)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.actual)}</td><td class="${item.status === "PASS" ? "pass" : "fail"}">${item.status}</td></tr>`,
    )
    .join("");
  const comparisonTable = comparisonRows
    ? `<section><h3>Validation Details</h3><table><thead><tr><th>Record Code</th><th>Record Name</th><th>Field</th><th>Expected (Excel)</th><th>Actual (UI)</th><th>Status</th></tr></thead><tbody>${comparisonRows}</tbody></table></section>`
    : "";
  const attention = row.comparisons.filter((item) => item.status !== "PASS");
  const attentionSection = attention.length
    ? `<section><h3>Records Requiring Attention</h3>${attention.map((item) => `<p><strong>${escapeHtml(item.recordCode)}</strong>${item.recordName ? ` — ${escapeHtml(item.recordName)}` : ""}<br>Failed Field: ${escapeHtml(item.field)}<br>Expected: ${escapeHtml(item.expected)}<br>Actual: ${escapeHtml(item.actual)}<br>Reason: ${escapeHtml(item.reason ?? "The expected and actual values did not match.")}<br>Status: ${item.status}</p>`).join("")}</section>`
    : "";
  const actual =
    row.status === "passed"
      ? "The scenario completed successfully."
      : row.status === "skipped"
        ? "The scenario was skipped."
        : row.error;
  return `<tr data-status="${escapeHtml(row.status)}"><td>${index + 1}</td><td><details open><summary>${escapeHtml(row.title)}</summary><p>Tags: ${escapeHtml(row.tags.join(", "))}</p><p><strong>Expected Result:</strong> All recorded business steps for ${escapeHtml(row.title)} should meet their expected outcomes.</p><p><strong>Actual Result:</strong> ${escapeHtml(actual).replace(/\r?\n/g, "<br>")}</p><table class="business-steps"><thead><tr><th>Step</th><th>Execution Step</th><th>Expected</th><th>Actual</th><th>Status</th></tr></thead><tbody>${steps}</tbody></table>${comparisonTable}${validation}${history}${details}${attentionSection}${evidence}</details></td><td class="${row.status === "passed" ? "pass" : row.status === "failed" ? "fail" : ""}">${escapeHtml(row.status.toUpperCase())}</td><td>${row.duration} ms</td></tr>`;
}

function cleanBusinessText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*at\s/.test(line) &&
        !/getBy(?:Role|Text|TestId)|locator\s*\(|\.spec\.ts|\.ts:\d|(?:[A-Za-z]:\\|\/Users\/|\/home\/)/i.test(
          line,
        ),
    )
    .join("\n")
    .trim();
}

function readValidationSummary(details: string): {
  totalRows?: string;
  validRows?: string;
  warnings?: string;
  errors?: string;
} {
  const read = (label: string) =>
    details.match(new RegExp(`${label}:\\s*(\\d+)`, "i"))?.[1];
  return {
    totalRows: read("Total Rows"),
    validRows: read("Valid Rows"),
    warnings: read("Warnings?"),
    errors: read("Errors?"),
  };
}

function readHistoryValue(details: string, label: string): string | undefined {
  return details
    .match(new RegExp(`${label}:\\s*([^\\r\\n]+)`, "i"))?.[1]
    ?.trim();
}

function normalizeValidationErrorRows(rows: ValidationErrorRow[]): {
  rows: ValidationErrorRow[];
  repeatedHeaders: number;
  duplicates: number;
} {
  const unique = new Map<string, ValidationErrorRow>();
  let repeatedHeaders = 0;
  let duplicates = 0;
  for (const row of rows) {
    const isHeader =
      /^row\s*$/i.test(row.row.trim()) &&
      /^data\s*preview\s*$/i.test(row.dataPreview.trim()) &&
      /^(?:errors?|error details)\s*$/i.test(row.errorDetails.trim());
    if (isHeader) {
      repeatedHeaders++;
      continue;
    }
    const key = `${row.row}\n${row.dataPreview}\n${row.errorDetails}`;
    if (unique.has(key)) {
      duplicates++;
      continue;
    }
    unique.set(key, row);
  }
  return { rows: [...unique.values()], repeatedHeaders, duplicates };
}

function formatDataPreview(value: string): string {
  const formatted = value.replace(
    /(?<!^)(?=[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*:\s)/g,
    "\n",
  );
  return escapeHtml(formatted).replace(/\r?\n/g, "<br>");
}

function getFailedStepTitles(steps: TestResult["steps"]): string[] {
  return steps.flatMap((step) => [
    ...(step.error ? [step.title] : []),
    ...getFailedStepTitles(step.steps),
  ]);
}

function moduleNameForSpec(specName: string): string {
  if (/components/i.test(specName)) return "Components";
  if (/jobs?/i.test(specName)) return "Jobs";
  if (/spares?/i.test(specName)) return "Spares";
  if (/stores?/i.test(specName)) return "Stores";
  if (/locations?/i.test(specName)) return "Locations";
  return "Data";
}

function importModeForSpec(specName: string): string {
  if (/add[-_ ]?only/i.test(specName)) return "Add Only";
  if (/update[-_ ]?only/i.test(specName)) return "Update Only";
  if (/add[-_ ]?(?:and|\+)?[-_ ]?update/i.test(specName)) return "Add + Update";
  return "Not applicable";
}

function readBulkImportFileAttempts(
  attachments: TestResult["attachments"],
  bodyFor: (
    attachment: TestResult["attachments"][number],
  ) => Buffer | undefined,
): BulkImportFileAttempt[] {
  return attachments
    .filter((attachment) =>
      attachment.name.startsWith("Bulk Import File Attempt - "),
    )
    .flatMap((attachment) => {
      try {
        const body = bodyFor(attachment);
        if (!body) return [];
        const attempt = JSON.parse(body.toString()) as BulkImportFileAttempt;
        return attempt.fileName ? [attempt] : [];
      } catch {
        return [];
      }
    });
}

function simplifyValidationError(
  message: string,
  title: string,
  businessSteps: string[],
  failedSteps: string[],
): string {
  const moduleName = moduleNameForSpec(title);
  const explicitFailure = businessSteps.find((step) =>
    /(?:^|\r?\n)Status:\s*FAIL\b/i.test(step),
  );
  if (explicitFailure) {
    const stepName =
      explicitFailure.match(/^(?:Step\s+\d+\s+-\s+)?([^\r\n]+)/)?.[1] ?? title;
    const expected =
      explicitFailure
        .match(/(?:^|\r?\n)Expected:\s*([^\r\n]+)/i)?.[1]
        ?.trim() ?? "The business validation should pass.";
    const actual =
      explicitFailure
        .match(
          /(?:^|\r?\n)Actual:\s*([\s\S]*?)(?=\r?\n(?:Status:|Expected:)|$)/i,
        )?.[1]
        ?.trim() ?? "The business validation failed.";
    return [
      "VALIDATION ERROR",
      `Module: ${moduleName}`,
      `Validation Type: ${/partial/i.test(title) ? "Partial" : "Complete"}`,
      `Step: ${stepName}`,
      "",
      "Expected:",
      expected,
      "",
      "Actual:",
      actual,
      "",
      "Status: FAILED",
    ].join("\n");
  }
  const failedBusinessStep = failedSteps.find(isBusinessStep);
  const lastBusinessStep = businessSteps.at(-1);
  const stepName =
    (failedBusinessStep ?? lastBusinessStep ?? title).match(
      /^(?:Step\s+\d+\s+-\s+)?([^\r\n]+)/,
    )?.[1] ?? title;
  const technicalReason = message
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*at\s/.test(line))
    .slice(0, 8)
    .join("\n");
  return [
    "VALIDATION ERROR",
    `Module: ${moduleName}`,
    `Validation Type: ${/partial/i.test(title) ? "Partial" : "Complete"}`,
    `Step: ${stepName}`,
    "",
    "Expected:",
    `${stepName} should complete successfully.`,
    "",
    "Actual:",
    `${stepName} did not complete successfully.`,
    "",
    "Reason:",
    technicalReason || "No additional Playwright error message was available.",
    "",
    "Status: FAILED",
  ].join("\n");
}

function ensureAuditReport(
  specName: string,
  rows: ResultRow[],
  startedAt: Date,
): void {
  const auditPath = path.resolve("reports", "audit", `${specName}.html`);
  // Data-validation scenarios can write a richer audit file during the test.
  // Keep that file unchanged. Otherwise, use the same standard audit renderer
  // for every spec, including bulk-import and future specs.
  if (
    fs.existsSync(auditPath) &&
    fs.statSync(auditPath).mtimeMs >= startedAt.getTime()
  )
    return;

  const details = rows
    .flatMap((row) => row.attachments)
    .filter((attachment) =>
      /audit summary|post-import validation summary/i.test(attachment.name),
    )
    .map((attachment) => attachment.body)
    .join("\n");
  const readNumber = (labels: string[]) => {
    for (const label of labels) {
      const value = details.match(new RegExp(`${label}:\\s*(\\d+)`, "i"))?.[1];
      if (value !== undefined) return Number(value);
    }
    return 0;
  };
  const failedRow = rows.find(
    (row) => row.status === "failed" || row.status === "timedOut",
  );
  const moduleName = moduleNameForSpec(specName);
  const comparisonRecords = new Set(
    rows.flatMap((row) => row.comparisons).map((item) => item.recordCode),
  );
  const checked =
    readNumber(["Audited", "Records Checked", "Checked", "Jobs validated"]) ||
    comparisonRecords.size;
  const matched = readNumber(["Matched", "Records Matched"]);
  const imported = readNumber([
    "Successfully Imported",
    "Successfully imported/expected Job records",
    "Application valid rows",
    "Expected post-import records",
  ]);
  const attemptedFiles = [
    ...new Set(
      rows
        .flatMap((row) => row.uploadedFiles)
        .map((attempt) => attempt.fileName),
    ),
  ];
  const excelFile =
    details
      .match(/(?:Source File|Source workbook|Excel):\s*([^\r\n]+)/i)?.[1]
      ?.trim() ??
    (attemptedFiles.length
      ? attemptedFiles.join(", ")
      : "Upload did not complete");
  const comparisonError = rows
    .flatMap((row) => row.comparisons)
    .find((item) => item.status === "ERROR");
  const failureEvidence =
    comparisonError?.evidence ??
    failedRow?.evidence.find((item) => /failure/i.test(item.name));
  generateStandardAuditReport({
    dataType: moduleName,
    fileName: `${specName}.html`,
    vessel: config.vesselName,
    excelFile,
    uploadedBy: config.username,
    validationType: /partially/i.test(specName) ? "Partial" : "Complete",
    successfullyImported: imported,
    recordsSelected:
      readNumber(["Expected records", "Records Selected"]) || checked,
    recordsAttempted: comparisonRecords.size || checked,
    recordsChecked: checked,
    recordsMatched: matched,
    identifierColumns: ["Record Code"],
    additionalMetadata: {
      "Import Mode":
        rows
          .flatMap((row) => row.uploadedFiles)
          .find((attempt) => attempt.importMode)?.importMode ??
        importModeForSpec(specName),
      ...(attemptedFiles.length
        ? { "Uploaded File": attemptedFiles.join(", ") }
        : {}),
    },
    missingRecords: [],
    fieldMismatches: [],
    automationIssues: failedRow
      ? [
          {
            identifiers: {
              "Record Code": comparisonError?.recordCode ?? "Scenario",
            },
            failedStep: comparisonError?.field ?? "Validation execution",
            expected:
              comparisonError?.expected ?? "Validation should complete.",
            actual: comparisonError?.actual ?? failedRow.error,
            reason:
              comparisonError?.reason ??
              "The scenario stopped before the normal audit report could be generated.",
            evidence: failureEvidence,
          },
        ]
      : [],
  });
}
