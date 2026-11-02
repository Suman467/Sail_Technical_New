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
import {
  COMPONENT_EXPECTED_RESULT_ANNOTATION,
  COMPONENT_SCENARIO_STEP_ANNOTATION,
  COMPONENT_STEP_ACTUAL_PREFIX,
  COMPONENT_VALIDATION_SCREENSHOT_PREFIX,
} from "./componentValidationEvidence";
import { generateStandardAuditReport, reportModuleFolder, type AuditScenarioExecution } from "./standardAuditReport";
import { businessFailureActual, classifyCaseOutcome, deferEmbeddedImages, failureStage, overallExecutionStatus, unfinishedStepActual } from "./reportingStandards";

/** Where a business step ran: shared suite setup, per-test setup, the test body, or after-test restore. */
type StepPhase = "suite-setup" | "test-setup" | "test" | "teardown";
/** One recorded business step, kept in completion order with its own outcome. */
type TimelineStep = {
  title: string;
  failed: boolean;
  /** The step was still running when the test ended (for example at a timeout). */
  unfinished: boolean;
  errorMessage: string;
  phase: StepPhase;
  /** First line of the most recent failed business step nested inside this one. */
  failedDescendant?: string;
};

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
  moduleFolder: string;
  title: string;
  tags: string[];
  annotations: string[];
  status: string;
  duration: number;
  error: string;
  steps: string[];
  failedSteps: string[];
  timeline: TimelineStep[];
  /** Scenario wrapper steps are kept separately so they can supply the overall result without duplicating child actions. */
  scenarioTimeline: TimelineStep[];
  /** Playwright's expected status; 'skipped' only for an intentional test.skip(). */
  expectedStatus: string;
  rawError: string;
  scenarioSteps: string[];
  declaredExpected?: string;
  stepActuals: Record<string, string>;
  stdout: string;
  uploadedFiles: BulkImportFileAttempt[];
  historyDetails?: string;
  componentStepScreenshots: (ReportAttachment & { stepTitle: string })[];
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
    const scenarioSteps = test.annotations
      .filter((annotation) => annotation.type === COMPONENT_SCENARIO_STEP_ANNOTATION)
      .map((annotation) => annotation.description ?? "");
    const isScenarioSummary = (title: string) => scenarioSteps.includes(title.split(/\r?\n/, 1)[0].trim());
    const businessSteps = getBusinessStepTitles(result.steps).filter((title) => !isScenarioSummary(title));
    const failedSteps = getFailedStepTitles(result.steps);
    this.rows.set(test.id, {
      specName: getSpecReportName(test.location.file),
      moduleFolder: reportModuleFolder(getSpecReportName(test.location.file), test.location.file),
      title: test.title,
      tags: test.tags,
      annotations: test.annotations
        .filter((annotation) =>
          annotation.type !== COMPONENT_SCENARIO_STEP_ANNOTATION &&
          annotation.type !== COMPONENT_EXPECTED_RESULT_ANNOTATION)
        .map((annotation) => annotation.description)
        .filter((description): description is string => Boolean(description)),
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
      timeline: collectTimeline(result.steps, "test").filter((item) => !isScenarioSummary(item.title)),
      scenarioTimeline: collectTimeline(result.steps, "test").filter((item) => isScenarioSummary(item.title)),
      expectedStatus: test.expectedStatus,
      rawError: technicalDetailsFor(result),
      scenarioSteps,
      declaredExpected: test.annotations.find(
        (annotation) => annotation.type === COMPONENT_EXPECTED_RESULT_ANNOTATION,
      )?.description,
      stepActuals: Object.fromEntries(
        result.attachments.flatMap((attachment) => {
          if (!attachment.name.startsWith(COMPONENT_STEP_ACTUAL_PREFIX)) return [];
          const body = bodyFor(attachment);
          return body
            ? [[attachment.name.slice(COMPONENT_STEP_ACTUAL_PREFIX.length), body.toString()]]
            : [];
        }),
      ),
      stdout: result.stdout.map((chunk) => chunk.toString()).join(""),
      uploadedFiles: readBulkImportFileAttempts(result.attachments, bodyFor),
      historyDetails: (() => {
        const attachment = result.attachments.find(
          (item) => item.name === "Latest import history record",
        );
        return attachment ? bodyFor(attachment)?.toString() : undefined;
      })(),
      componentStepScreenshots: result.attachments.flatMap((attachment) => {
        if (!attachment.name.startsWith(COMPONENT_VALIDATION_SCREENSHOT_PREFIX))
          return [];
        const body = bodyFor(attachment);
        if (!attachment.contentType.startsWith("image/") || !body) return [];
        return [
          {
            name: attachment.name,
            stepTitle: attachment.name.slice(
              COMPONENT_VALIDATION_SCREENSHOT_PREFIX.length,
            ),
            contentType: attachment.contentType,
            body: body.toString("base64"),
          },
        ];
      }),
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
          attachment.name.startsWith("Bulk Import File Attempt - ") ||
          attachment.name.startsWith(COMPONENT_STEP_ACTUAL_PREFIX)
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
      const moduleFolder = specRows[0]?.moduleFolder ?? reportModuleFolder(specName);
      const moduleDirectory = path.resolve(validationDirectory, moduleFolder);
      const reportPath = path.resolve(moduleDirectory, `${specName}.html`);
      if (path.dirname(reportPath) !== moduleDirectory) {
        throw new Error(
          `Validation report resolved outside reports/validation: ${reportPath}`,
        );
      }
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        deferEmbeddedImages(renderValidationReport(specName, specRows, this.startedAt)),
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

function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function renderSpecReportBase(
  specName: string,
  rows: ResultRow[],
  startedAt: Date,
): string {
  const outcomes = rows.map((row) => classifyCaseOutcome(row.status, row.expectedStatus, row.annotations.some(Boolean), row.annotations.at(-1)));
  const passed = outcomes.filter((status) => status === "passed").length;
  const failed = outcomes.filter((status) => status === "failed").length;
  const skipped = outcomes.filter((status) => status === "skipped").length;
  const notExecuted = outcomes.filter((status) => status === "not-executed").length;
  const total = rows.length;
  const passPercent = total === 0 ? 0 : Math.round((passed / total) * 100);
  const reportStatus = ({ PASSED: "PASS", FAILED: "FAIL", INCOMPLETE: "INCOMPLETE", SKIPPED: "SKIPPED" } as const)[overallExecutionStatus({ failed, notExecuted, skipped, total })];
  const components = rows[0]?.moduleFolder === "components" ? buildComponentsReport(rows) : undefined;
  const consolidateCommonSetup = !components && /components/i.test(specName) && rows.length > 1;
  const commonSetup = new Map<string, ParsedBusinessStep>();
  if (consolidateCommonSetup) {
    for (const row of rows) {
      row.steps.forEach((title, stepIndex) => {
        const parsed = parseBusinessStep(title, stepIndex, row);
        if (isSetupOrNavigationStep(parsed) && /^(?:pass|passed)$/i.test(parsed.status)) {
          commonSetup.set(parsed.title.trim().toLowerCase(), parsed);
        }
      });
    }
  }
  const commonSetupRows = components
    ? components.commonSetup.map((item) => `<tr><td>${escapeHtml(item.number)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.actual)}</td><td class="${item.status === "PASS" ? "pass" : item.status === "FAIL" ? "fail" : "not-run"}">${item.status}</td></tr>`).join("")
    : [...commonSetup.values()].map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.actual)}</td><td class="pass">PASS</td></tr>`).join("");
  const commonSetupHeader = components
    ? "<th>Step</th><th>Execution Step</th><th>Expected</th><th>Actual</th><th>Status</th>"
    : "<th>Execution Step</th><th>Expected</th><th>Actual</th><th>Status</th>";
  const commonSetupSection = commonSetupRows ? `<details class="setup-panel"><summary>Common Setup / Initial Navigation</summary>${components ? "<p>Shared authentication and initial navigation performed once for this run and reused by every test case below.</p>" : ""}<div class="table-scroll"><table class="business-steps"><thead><tr>${commonSetupHeader}</tr></thead><tbody>${commonSetupRows}</tbody></table></div></details>` : "";
  const reportRows = commonSetupSection + rows.map((row, index) => renderResultRow(row, index, consolidateCommonSetup, components?.cases[index])).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(specName)} Execution Report</title><style>body{font:16px system-ui;margin:32px;color:#17202a}h1{color:${failed ? "#b42318" : notExecuted ? "#8a5a00" : "#167c3a"}}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d5dd;padding:8px;text-align:left;vertical-align:top}th{background:#eef2f6}.card,button{display:inline-block;margin:4px;padding:12px 18px;background:#eef2f6;border:1px solid #d0d5dd;border-radius:6px}img{display:block;max-width:900px;margin-top:12px}.step-screenshot-link{display:inline-block;margin:8px 16px 4px 0}.step-screenshot{width:280px;max-height:180px;object-fit:cover;border:1px solid #d0d5dd;border-radius:4px}pre{white-space:pre-wrap}.pass{color:#167c3a}.fail{color:#b42318}.not-run{color:#8a5a00}.technical pre{background:#f6f8fa;border:1px solid #d0d5dd;padding:8px;font-size:13px}.business-steps{table-layout:fixed}.business-steps th:nth-child(1){width:8%}.business-steps th:nth-child(2){width:27%}.business-steps th:nth-child(3){width:27%}.business-steps th:nth-child(4){width:28%}.business-steps th:nth-child(5){width:10%}</style></head><body><h1>${escapeHtml(specName)} — ${reportStatus}</h1><p>${startedAt.toLocaleString()} | ${escapeHtml(config.baseUrl)}</p><div class="card">Total: ${total}</div><div class="card">Passed: ${passed}</div><div class="card">Failed: ${failed}</div><div class="card">Skipped: ${skipped}</div><div class="card">Pass: ${passPercent}%</div><h2>Execution Results</h2><p>Green means the check passed. Red means the check needs attention. A failed check includes its business-level result and evidence where available.</p><p><button onclick="show('all')">All</button><button onclick="show('passed')">Passed</button><button onclick="show('failed')">Failed</button></p><table><thead><tr><th>No.</th><th>Test / Scenario and Execution Details</th><th>Result</th><th>Time</th></tr></thead><tbody>${reportRows}</tbody></table><script>function show(status){document.querySelectorAll('tr[data-status]').forEach(row=>row.hidden=status!=='all'&&!row.dataset.status.includes(status));}</script></body></html>`;
}

/** Adds the project-wide status summary, filters, and scan-friendly layout. */
function renderSpecReport(
  specName: string,
  rows: ResultRow[],
  startedAt: Date,
): string {
  const outcomes = rows.map((row) => classifyCaseOutcome(row.status, row.expectedStatus, row.annotations.some(Boolean), row.annotations.at(-1)));
  const total = outcomes.length;
  const passed = outcomes.filter((status) => status === "passed").length;
  const failed = outcomes.filter((status) => status === "failed").length;
  const skipped = outcomes.filter((status) => status === "skipped").length;
  const notExecuted = outcomes.filter((status) => status === "not-executed").length;
  return renderSpecReportBase(specName, rows, startedAt)
    .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
    .replace('<table><thead><tr><th>No.</th><th>Test / Scenario and Execution Details</th><th>Result</th><th>Time</th></tr></thead><tbody>', '<section class="test-cases">')
    .replace('</tbody></table><script>function show(status)', '</section><script>function show(status)')
    .replace('<div class="card">Total:', '<div class="card">Total Test Cases:')
    .replace(
      /(<div class="card">Skipped: \d+<\/div>)/,
      `$1<div class="card">Not Executed: ${notExecuted}</div>`,
    )
    .replace(
      '<p><button onclick="show(\'all\')">All</button><button onclick="show(\'passed\')">Passed</button><button onclick="show(\'failed\')">Failed</button></p>',
      `<div class="toolbar"><div class="filters"><button onclick="show('all')">All (${total})</button><button onclick="show('passed')">Passed (${passed})</button><button onclick="show('failed')">Failed (${failed})</button><button onclick="show('skipped')">Skipped (${skipped})</button><button onclick="show('not-executed')">Not Executed (${notExecuted})</button></div><div class="expand-controls"><button onclick="toggleAll(true)">Expand All</button><button onclick="toggleAll(false)">Collapse All</button></div></div><p id="empty-state" hidden>No test cases match this filter.</p>`,
    )
    // Replaces the whole statement: inserting a second statement inside the forEach
    // callback is a syntax error that disabled every filter and Expand/Collapse All.
    .replace(
      "document.querySelectorAll('tr[data-status]').forEach(row=>row.hidden=status!=='all'&&!row.dataset.status.includes(status));",
      "document.querySelectorAll('.test-case[data-status]').forEach(row=>{row.hidden=status!=='all'&&row.dataset.status!==status});document.getElementById('empty-state').hidden=!!document.querySelector('.test-case:not([hidden])');",
    )
    .replace('</script></body>', "function toggleAll(open){document.querySelectorAll('.test-case:not([hidden])').forEach(card=>card.open=open)}</script></body>")
    .replace(
      '</style></head>',
      `*{box-sizing:border-box}body{line-height:1.5;background:#f4f6f8;margin:0;padding:24px}body>h1,body>h2,body>p,body>.card,body>.summary,body>.toolbar,body>#empty-state,body>.test-cases,body>.setup-panel{max-width:1480px;margin-left:auto;margin-right:auto}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card strong{display:block;font-size:24px}.toolbar{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.filters,.expand-controls{display:flex;gap:8px;flex-wrap:wrap}.test-cases{margin-top:16px}.setup-panel,.test-case{background:#fff;border:1px solid #d0d5dd;border-radius:10px;margin:12px 0;box-shadow:0 1px 2px rgba(16,24,40,.05)}.setup-panel{padding:14px}.setup-panel>summary,.technical>summary,.evidence-panel>summary{font-weight:700;cursor:pointer}.test-case>summary{list-style:none;cursor:pointer;padding:14px 16px}.test-case>summary::-webkit-details-marker{display:none}.case-header{display:grid;grid-template-columns:minmax(0,1fr) auto auto 18px;gap:12px;align-items:center}.chevron::before{content:'›';font-size:24px}.test-case[open] .chevron::before{display:block;transform:rotate(90deg)}.case-title{font-size:16px;font-weight:700;min-width:0}.case-id{display:inline-block;margin-right:10px;color:#175cd3;white-space:nowrap}.status,.duration{white-space:nowrap;font-weight:700}.status{padding:4px 9px;border-radius:999px;background:#eef2f6}.status.passed{color:#167c3a;background:#ecfdf3}.status.failed{color:#b42318;background:#fef3f2}.status.skipped,.status.not-executed{color:#8a5a00;background:#fffaeb}.case-body{padding:0 16px 16px}.tags{color:#667085}.result-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin:4px 0 16px}.result-box{min-width:0;padding:14px;border:1px solid #d0d5dd;border-radius:8px;background:#f8fafc}.result-box h3{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#667085}.result-box p{margin:0;overflow-wrap:break-word}.table-scroll{width:100%;overflow-x:auto;margin:10px 0 4px}.table-scroll table{min-width:820px;table-layout:fixed}.business-steps th:nth-child(1){width:6%}.business-steps th:nth-child(2){width:22%}.business-steps th:nth-child(3){width:28%}.business-steps th:nth-child(4){width:34%}.business-steps th:nth-child(5){width:10%}.business-steps th,.business-steps td:first-child,.business-steps td:last-child{white-space:nowrap}.business-steps td{overflow-wrap:break-word}.technical,.evidence-panel{margin-top:14px;border:1px solid #d0d5dd;border-radius:8px;padding:10px}.technical pre{overflow-wrap:break-word}.evidence-panel img{width:min(320px,100%);height:180px;object-fit:cover;border-radius:8px}@media(max-width:700px){body{padding:8px}.case-header{grid-template-columns:minmax(0,1fr) auto 18px}.duration{grid-column:1/-1;font-size:13px;color:#667085}.result-grid{grid-template-columns:1fr}.case-body{padding:0 10px 12px}.test-case>summary{padding:12px 10px}}</style></head>`,
    );
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
  const overallOutcomes = rows.map((row) => classifyCaseOutcome(row.status, row.expectedStatus, row.annotations.some(Boolean), row.annotations.at(-1)));
  const overallStatus = overallExecutionStatus({
    failed: overallOutcomes.filter((status) => status === "failed").length,
    notExecuted: overallOutcomes.filter((status) => status === "not-executed").length,
    skipped: overallOutcomes.filter((status) => status === "skipped").length,
    total: overallOutcomes.length,
  });
  const importMode =
    fileAttempts.find((attempt) => attempt.importMode)?.importMode ??
    importModeForSpec(specName);
  const uploadedFiles = [
    ...new Set(fileAttempts.map((attempt) => attempt.fileName)),
  ];
  // Components reports name the vessels and users the run actually used.
  const isComponents = rows[0]?.moduleFolder === "components";
  const componentVessels = isComponents ? runtimeVessels(rows) : [];
  const vesselLabel = componentVessels.length > 1 ? "Vessels" : "Vessel";
  const vessels = componentVessels.length ? componentVessels.join(", ") : config.vesselName;
  const users = [config.username];
  if (isComponents && rows.some((row) => row.timeline.some((step) => step.title.includes(config.automationUser2Username))))
    users.push(config.automationUser2Username);
  const uploadedFileInformation = uploadedFiles.length
    ? `<br><strong>Uploaded File:</strong> ${uploadedFiles.map(escapeHtml).join(", ")}`
    : "";
  const executionInformation = `<h2>Execution Information</h2><p><strong>Module:</strong> ${escapeHtml(moduleName)}<br><strong>Validation Type:</strong> ${validationType}<br><strong>${vesselLabel}:</strong> ${escapeHtml(vessels)}<br><strong>Import Mode:</strong> ${escapeHtml(importMode)}${uploadedFileInformation}<br><strong>Logged-in User${users.length === 1 ? "" : "s"}:</strong> ${escapeHtml(users.join(", "))}<br><strong>Execution Date:</strong> ${escapeHtml(startedAt.toLocaleString())}<br><strong>Overall Status:</strong> ${overallStatus}</p>`;
  return renderSpecReport(specName, rows, startedAt)
    .replace(
      `<title>${escapeHtml(specName)} Execution Report</title>`,
      `<title>${escapeHtml(moduleName.toUpperCase())} VALIDATION REPORT</title>`,
    )
    .replace(
      `<h1>${escapeHtml(specName)} —`,
      `<h1>${escapeHtml(moduleName.toUpperCase())} VALIDATION REPORT —`,
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
  return steps.flatMap((step) => [
    ...(step.category === "test.step" && isBusinessStep(step.title)
      ? [step.title]
      : []),
    ...getBusinessStepTitles(step.steps),
  ]);
}

function expectedForStep(name: string): string {
  const cleanName = name.replace(/[.]+$/, "");
  if (/^login page is open$/i.test(cleanName))
    return "The application should display the login page so the configured user can authenticate.";
  if (/^audit dashboard page is open$/i.test(cleanName))
    return "After authentication, the application should display the Audit Dashboard.";
  if (/^components page is open$/i.test(cleanName))
    return "The application should display the Components page with the configured vessel and its component tree available.";
  if (/components page is shown/i.test(cleanName))
    return "The application should display the Components page with its vessel and component controls available.";
  if (/components list is shown/i.test(cleanName))
    return "The Components page should display the component tree for the selected vessel.";
  if (/component count matches/i.test(cleanName))
    return "The displayed component count should equal the number of component rows visible in the tree.";
  if (/open (?:the )?add component form/i.test(cleanName))
    return "The application should open a blank Add Component form for the selected vessel and parent.";
  if (/saving with empty mandatory fields/i.test(cleanName))
    return "The application should reject the save and identify the mandatory fields that are empty.";
  if (/component is created with valid data/i.test(cleanName))
    return "The application should save one component containing the valid data entered in the form.";
  if (/component .+ is visible in the list/i.test(cleanName))
    return `${cleanName.replace(/^Component/i, "The saved component")} after the component tree refreshes.`;
  if (/open component .+ for editing/i.test(cleanName))
    return "The application should open the selected component in Edit mode with its saved values displayed.";
  if (/component .+ can be edited/i.test(cleanName))
    return "The application should save the permitted component changes without changing its identity.";
  if (/component .+ shows the updated name/i.test(cleanName))
    return "The reopened component should display the newly saved component name.";
  if (/^log in/i.test(cleanName))
    return "User should successfully log in to the application.";
  if (/^(?:open|navigate to)\b/i.test(cleanName))
    return `The application should display the page or form requested by this step: ${cleanName}.`;
  if (/^select\b/i.test(cleanName))
    return `${cleanName} should be selected successfully.`;
  if (/^(?:upload|import)\b/i.test(cleanName))
    return `The application should process the configured test data for this step: ${cleanName}.`;
  if (/^(?:verify|validate|confirm|check)\b/i.test(cleanName))
    return `${cleanName} should match the expected application result.`;
  if (/^(?:read|capture)\b/i.test(cleanName))
    return `${cleanName} should return the application data required by the scenario.`;
  if (/^(?:fill|enter|answer)\b/i.test(cleanName))
    return `${cleanName} should accept the configured test data.`;
  if (/^(?:save|submit|approve|create|edit)\b/i.test(cleanName))
    return `The application should persist the requested data change described by this step: ${cleanName}.`;
  if (/\b(?:omit|missing|without|empty|required|mandatory)\b/i.test(cleanName))
    return `The application should enforce the required-field behavior described by "${cleanName}" and prevent invalid data from being saved.`;
  if (/\bdelete\b/i.test(cleanName))
    return `${cleanName} should remove only the intended record and confirm that it no longer exists.`;
  return `For "${cleanName}", the application should complete the named action and display the resulting component data or validation state.`;
}

function actualForStep(name: string, failed: boolean): string {
  const cleanName = name.replace(/[.]+$/, "");
  if (failed)
    return `During "${cleanName}", the required component data or validation state was not observed.`;
  if (/^login page is open$/i.test(cleanName))
    return "The login page was displayed and was available for authentication.";
  if (/^audit dashboard page is open$/i.test(cleanName))
    return "Authentication succeeded and the Audit Dashboard was displayed.";
  if (/^components page is open$/i.test(cleanName))
    return "The Components page displayed the configured vessel and its component tree.";
  if (/components page is shown/i.test(cleanName))
    return "The Components page was displayed with its vessel and component controls available.";
  if (/components list is shown/i.test(cleanName))
    return "The component tree was displayed for the selected vessel.";
  if (/component count matches/i.test(cleanName))
    return "The displayed component count matched the number of visible component rows.";
  if (/open (?:the )?add component form/i.test(cleanName))
    return "The Add Component form opened for the selected vessel and parent.";
  if (/saving with empty mandatory fields/i.test(cleanName))
    return "The save was rejected and mandatory-field validation was displayed.";
  if (/component is created with valid data/i.test(cleanName))
    return "One component was saved with the valid data entered in the form.";
  if (/component .+ is visible in the list/i.test(cleanName))
    return `${cleanName.replace(/^Component/i, "The saved component")} after the tree refreshed.`;
  if (/open component .+ for editing/i.test(cleanName))
    return "The selected component opened in Edit mode with its saved values displayed.";
  if (/component .+ can be edited/i.test(cleanName))
    return "The permitted component changes were saved without changing the component identity.";
  if (/component .+ shows the updated name/i.test(cleanName))
    return "The reopened component displayed the newly saved name.";
  return failed
    ? `During "${cleanName}", the required component data or validation state was not observed.`
    : `The "${cleanName}" action completed and its resulting application state was displayed.`;
}

function expectedForScenario(title: string): string {
  const scenario = title.replace(/^CMP-\d+\s*-\s*/i, "").trim();
  if (/change parent to another valid same-vessel parent/i.test(scenario))
    return "The component should move to another valid parent in the same vessel while its code, name, vessel, and other saved details remain unchanged, and no duplicate should be created.";
  if (/duplicate component code/i.test(scenario))
    return "The application should reject the duplicate component code and must not create another component with that code in the tested vessel scope.";
  if (/duplicate component name/i.test(scenario))
    return "The application should apply its component-name uniqueness rule and must not create an invalid duplicate component.";
  if (/circular|descendant as parent/i.test(scenario))
    return "The application should reject a parent selection that would create a circular component hierarchy and leave the existing hierarchy unchanged.";
  if (/cross-vessel parent/i.test(scenario))
    return "The application should reject a parent from another vessel and must not create or move the component outside its vessel hierarchy.";
  if (/parent.*(?:does not exist|missing|invalid)/i.test(scenario))
    return "The application should reject the unavailable parent and must not save the component with an invalid parent relationship.";
  if (/^omit\b/i.test(scenario))
    return `When ${scenario.replace(/^omit\s+/i, "")} is omitted, the application should reject the save, display the relevant validation message, and create no component.`;
  if (/^create\b/i.test(scenario))
    return `The application should ${scenario.toLowerCase()} and display the saved component with the configured values in the correct vessel hierarchy.`;
  if (/search|filter/i.test(scenario))
    return `The Components tree should ${scenario.toLowerCase()} and display only records that satisfy the selected search or filter.`;
  return `The Components application should enforce this specific business behavior: ${scenario}.`;
}

function stripAnsi(value: string): string {
  const escapeCharacter = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "g"), "");
}

function businessText(value: string, fallback: string): string {
  const withoutAnsi = stripAnsi(value).trim();
  const businessOnly = withoutAnsi
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:Error:|TimeoutError:|Locator:|Call log:|at\s|expect\(|Received:|Expected:|Timeout:|\d+\s*\|)/i.test(line))
    .join("\n")
    .trim();
  return businessOnly || fallback;
}

function errorSection(error: string, label: string): string | undefined {
  return error
    .match(new RegExp(`(?:^|\\r?\\n)${label}:\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\r?\\n(?:Expected|Actual|Technical Reason|Reason|Status):|$)`, "i"))?.[1]
    ?.trim();
}

function technicalReason(error: string): string {
  return errorSection(error, "Technical Reason") ?? errorSection(error, "Reason") ?? "";
}

function explainTechnicalFailure(error: string): string {
  const reason = stripAnsi(technicalReason(error) || error);
  const observedApplicationResult = reason
    .match(/Observed Application Result:\s*\r?\n([^\r\n]+)/i)?.[1]
    ?.trim();
  if (observedApplicationResult) return observedApplicationResult;
  const seconds = reason.match(/Timeout\s+(\d+)ms/i)?.[1];
  const readableSeconds = seconds ? `${Number(seconds) / 1000} seconds` : "the allowed time";
  const received = reason.match(/Received(?: string)?:\s*[^\S\r\n]*["']?([^\r\n"']*)/i)?.[1]?.trim();
  const expected = reason.match(/Expected(?: substring)?:\s*[^\S\r\n]*["']?([^\r\n"']*)/i)?.[1]?.trim();
  const assertionContext = reason
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .find((line) => line && !/^(?:Error:|TimeoutError:|expect\(|Locator:|Expected(?: substring)?:|Received(?: string)?:|Timeout:|Call log:|-)/i.test(line));
  if (expected !== undefined && received !== undefined) {
    const subject = assertionContext && !/[{}()[\]]/.test(assertionContext)
      ? assertionContext.replace(/[.:]+$/, "")
      : "The application value";
    return `${subject} was "${received || "empty"}" instead of the expected value "${expected || "empty"}".`;
  }
  if (/toHaveValue/i.test(reason) && received !== undefined)
    return `The field contained "${received}" rather than the value required by this check, so the later business assertions were not reached.`;
  if (/locator\.inputValue|inputValue/i.test(reason))
    return `The test could not read the required field within ${readableSeconds}. The field was not verified and the remaining business validation was not reached.`;
  if (/TimeoutError|exceeded|timed out/i.test(reason))
    return `${assertionContext ? `${assertionContext} was not available` : 'The required application element or state was not available'} within ${readableSeconds}; no later application result was observed.`;
  if (/ERR_NETWORK_ACCESS_DENIED/i.test(reason))
    return "The application login page could not be opened because network access was denied. No component was opened or changed, so the component validation was not performed.";
  const firstLine = reason.split(/\r?\n/).find((line) => line.trim() && !/^(?:Error:|expect\(|Locator:|Call log:|\s*at\s)/i.test(line.trim()))?.trim();
  return firstLine
    ? `The check ended while verifying: ${firstLine}. No later application result was observed.`
    : "No application message or value was captured for the failed check.";
}

function failureActualForStep(row: ResultRow, stepName?: string): string {
  const recorded = errorSection(row.error, "Actual");
  const fallback = explainTechnicalFailure(row.error);
  const parentMove = stepName?.match(/^Move\s+(\S+)\s+from Parent\s+(\S+)\s+to Parent\s+(\S+)/i);
  const reason = stripAnsi(technicalReason(row.error) || row.error);
  const receivedParent = reason.match(/Received(?: string)?:\s*["']?([^\r\n"']+)/i)?.[1]?.trim();
  const expectedParent = reason.match(/Expected(?: substring)?:\s*["']?([^\r\n"']+)/i)?.[1]?.trim();
  if (parentMove && receivedParent && expectedParent) {
    return `Component ${parentMove[1]} still shows Parent ${receivedParent} instead of the expected Parent ${expectedParent}.`;
  }
  return recorded && !/did not complete successfully\.?$/i.test(recorded)
    ? businessText(recorded, fallback)
    : fallback;
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
  const expected = businessText(
    content.match(/(?:^|\r?\n)Expected:\s*([^\r\n]+)/i)?.[1]?.trim() ??
    expectedForStep(name),
    expectedForStep(name),
  );
  const details = content
    .match(
      /(?:^|\r?\n)Details:\s*([\s\S]*?)(?=\r?\n(?:Status:|Expected:|Actual:)|$)/i,
    )?.[1]
    ?.trim();
  const failed = row.failedSteps.some(
    (failedTitle) =>
      failedTitle === title || failedTitle.startsWith(`Step ${number} -`),
  );
  const recordedActual = content
    .match(
      /(?:^|\r?\n)Actual:\s*([\s\S]*?)(?=\r?\n(?:Status:|Expected:)|$)/i,
    )?.[1]
    ?.trim();
  let actual = businessText(
    recordedActual ??
    details ??
    actualForStep(name, failed),
    actualForStep(name, failed),
  );
  const actualContainsObservedMessage = /\b(?:displayed|returned|responded with):\s*["“]/i.test(recordedActual ?? "");
  if (failed && !actualContainsObservedMessage && !/^FAIL(?:ED)?$/i.test(explicitStatus ?? ""))
    actual = failureActualForStep(row, name);
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

type ParsedBusinessStep = ReturnType<typeof parseBusinessStep>;

function isSetupOrNavigationStep(step: ParsedBusinessStep): boolean {
  return /^(?:initial setup - (?:select vessel|verify component tree)|log in|login|(?:audit dashboard|components) page is open|open (?:the )?(?:dashboard|audit dashboard|components page)|navigate to (?:the )?(?:dashboard|module|page))\b/i.test(
    step.title.trim(),
  );
}

function explicitlyValidatesSetup(title: string): boolean {
  return /\b(?:login|sign[- ]?in|navigation|navigate|page load(?:ing)?|open components|vessel selection|select vessel|switch vessel)\b/i.test(
    title,
  );
}

function findingForParsedStep(step: ParsedBusinessStep) {
  return {
    step: step.title,
    expected: step.expected,
    actual: step.actual,
    status: (/^(?:pass|passed)$/i.test(step.status)
      ? "PASS"
      : /^(?:not run|skipped)$/i.test(step.status)
        ? "NOT RUN"
        : "FAIL") as "PASS" | "FAIL" | "NOT RUN",
  };
}

function scenarioDescription(
  row: ResultRow,
  parsedSteps: ParsedBusinessStep[],
): { expected: string; actual: string; technical: string } {
  const meaningful = parsedSteps.filter((step) => !isSetupOrNavigationStep(step));
  const failedStep = parsedSteps.find((step) => /^FAIL(?:ED)?$/i.test(step.status));
  const representative = failedStep ?? meaningful.at(-1) ?? parsedSteps.at(-1);
  const expected = representative?.expected ?? expectedForScenario(row.title);
  if (row.status === "passed") {
    return {
      expected,
      actual:
        representative?.actual ??
        actualForStep(row.title, false),
      technical: "",
    };
  }
  if (row.status === "skipped") {
    const reason = row.annotations.find(Boolean) ?? errorSection(row.error, "Actual");
    const blocked = /block(?:ed)?/i.test(`${reason ?? ""} ${row.error}`);
    return {
      expected,
      actual: reason
        ? `The test was ${blocked ? "blocked" : "skipped"}; the application behavior was not exercised. Reason: ${reason}`
        : `The test was ${blocked ? "blocked" : "skipped"}; no application result was observed.`,
      technical: stripAnsi(technicalReason(row.error)),
    };
  }
  const reachedBusinessStep = Boolean(meaningful.length);
  return {
    expected,
    actual: reachedBusinessStep
      ? failedStep?.actual ?? failureActualForStep(row)
      : explainTechnicalFailure(row.error),
    technical: stripAnsi(technicalReason(row.error)),
  };
}

/**
 * Flattens business steps in completion order: a step that groups other steps is
 * recorded after them, because its result is only known once they finish.
 */
function collectTimeline(steps: TestStep[], phase: StepPhase): TimelineStep[] {
  return steps.flatMap((step) => {
    const stepPhase = step.category === "hook" ? phaseForHook(step.title, phase) : phase;
    const nested = collectTimeline(step.steps, stepPhase);
    if (step.category !== "test.step" || !isBusinessStep(step.title)) return nested;
    const failedDescendant = [...nested].reverse().find((item) => item.failed || item.unfinished);
    return [
      ...nested,
      {
        title: step.title,
        failed: Boolean(step.error),
        unfinished: step.duration < 0,
        errorMessage: stripAnsi(step.error?.message ?? ""),
        phase: stepPhase,
        failedDescendant: failedDescendant?.title.split(/\r?\n/, 1)[0],
      },
    ];
  });
}

function phaseForHook(title: string, current: StepPhase): StepPhase {
  if (/beforeAll/i.test(title)) return "suite-setup";
  if (/after(?:Each|All)? hook|After Hooks|Worker Cleanup/i.test(title)) return "teardown";
  if (/beforeEach|Before Hooks/i.test(title)) return current === "suite-setup" ? current : "test-setup";
  return current;
}

/** Keeps the Playwright diagnostics for the separate Technical Details section only. */
function technicalDetailsFor(result: TestResult): string {
  const errors = result.errors.length ? result.errors : result.error ? [result.error] : [];
  return errors
    .map((error) => {
      const lines = stripAnsi(error.message ?? error.value ?? "")
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, 20);
      const location = error.location
        ? `Location: ${path.relative(process.cwd(), error.location.file)}:${error.location.line}`
        : "";
      return [...lines, location].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

type ComponentsStatus = "PASS" | "FAIL" | "NOT EXECUTED";
type ComponentsReportStep = ParsedBusinessStep & {
  status: ComponentsStatus;
  /** Original execution-step title, used to match validation screenshots. */
  screenshotKey: string;
  /** Full recorded step text, including any explicit Status line. */
  rawTitle: string;
  phase: StepPhase;
  repeated: number;
};
type ComponentsScenario = { expected: string; actual: string; technical: string };
type ComponentsCase = { steps: ComponentsReportStep[]; scenario: ComponentsScenario };
type ComponentsReport = { commonSetup: ComponentsReportStep[]; cases: ComponentsCase[] };

const GENERIC_CONFIRMATION =
  /^(?:login page is open|audit dashboard page is open|components page is open)$/i;
const LOGIN_STEP = /^(?:log ?in|login)\b/i;

function isGenericConfirmation(title: string): boolean {
  return GENERIC_CONFIRMATION.test(title.trim());
}

function readableDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return seconds >= 60 && seconds % 60 === 0
    ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}`
    : `${seconds} seconds`;
}

/** Explains a failed check in business language; raw diagnostics stay in Technical Details. */
function describeFailedCheck(errorMessage: string): string {
  const message = stripAnsi(errorMessage).replace(/^\s*(?:Error|TimeoutError):\s*/i, "").trim();
  const observed = message.match(/Observed Application Result:\s*\r?\n([\s\S]+?)(?:\r?\n\s*\r?\n|$)/i)?.[1]?.trim();
  if (observed) return observed
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:Location:|at\s|\w.*\.spec\.ts:\d)/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const testTimeout = message.match(/Test timeout of (\d+)ms exceeded/i)?.[1];
  if (testTimeout)
    return `The scenario reached its time limit (${readableDuration(Number(testTimeout))}) before this step finished; no result was observed for it.`;
  const navigationTimeout = message.match(/page\.(?:goto|reload|waitForURL)[^\r\n]*?Timeout (\d+)ms/i)?.[1];
  if (navigationTimeout)
    return `The application page did not finish loading within ${readableDuration(Number(navigationTimeout))}, so this step could not continue.`;
  if (/Target page, context or browser has been closed|Test ended/i.test(message))
    return "The browser page closed before this step could finish; no result was observed for it.";
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const received = message.match(/Received(?: string| array| value)?:\s*(.+)/i)?.[1]?.trim();
  const expectedValue = message.match(/Expected(?: substring| string| pattern| value)?:\s*(.+)/i)?.[1]?.trim();
  const readableValue = (value?: string) =>
    value && !/^\[|^\{|^\/|<|Object\.|locator|getBy|^(?:true|false)$/i.test(value) ? value.replace(/^"|"$/g, "") : undefined;
  const timeout = message.match(/Timeout:?\s*(\d+)ms/i)?.[1];
  const workOrderFailure = message.match(/Work Order generation[^\r\n]*HTTP\s+\d+:\s*(\{[^\r\n]+\})/i)?.[1];
  if (workOrderFailure) {
    try {
      const parsed = JSON.parse(workOrderFailure) as { error?: string; message?: string };
      const feedback = parsed.error ?? parsed.message;
      if (feedback) return `The application displayed: ${feedback} No work order was created.`;
    } catch {
      // The original diagnostic remains available in Technical Details.
    }
  }
  const isCodeLike = (line: string) =>
    /expect\(|locator|getBy|\)\.to|Call log|^\s*at\s|\.ts:\d|^\w+\.\w+(?:\.\w+)?:/i.test(line);
  const customMessage = first && !isCodeLike(first) ? first.replace(/[.:]+$/, "") : "";
  // A plain thrown error already states the business problem in its own words.
  if (customMessage && !/expect\(/i.test(message)) return `${customMessage}.`;
  if (customMessage) {
    const value = readableValue(received);
    // A list of plain values (for example tree codes) is shown as a readable list.
    const listed = received?.match(/^\[(.*)\]$/)?.[1];
    const listedValues = listed !== undefined && !/[{}]/.test(listed)
      ? listed.split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean)
      : undefined;
    const suffix = listedValues
      ? ` The application showed: ${listedValues.length ? listedValues.join(", ") : "no values"}.`
      : value !== undefined
      ? ` The application showed "${value || "empty"}".`
      : timeout
        ? ` The expected state did not appear within ${readableDuration(Number(timeout))}.`
        : "";
    return `Check not met: ${customMessage}.${suffix}`;
  }
  const expected = readableValue(expectedValue);
  const actual = readableValue(received);
  if (actual && /^(?:No validation message|The application displayed no validation message)/i.test(actual))
    return `${actual.replace(/\.?$/, ".")} The expected validation message was not shown.`;
  if (actual !== undefined && expected !== undefined)
    return `The application showed "${actual || "empty"}" where "${expected || "empty"}" was expected.`;
  if (actual !== undefined)
    return `The application showed "${actual || "empty"}", which did not meet the expected result.`;
  if (timeout || /timeout|exceeded|timed out/i.test(message))
    return `A required screen element or result did not appear within ${timeout ? readableDuration(Number(timeout)) : "the allowed time"}, so this step could not be completed.`;
  return "The step stopped before its expected result was confirmed. See Technical Details for the diagnostic message.";
}

function parseTimelineStep(step: TimelineStep, row: ResultRow): ComponentsReportStep {
  const lines = step.title.split(/\r?\n/);
  const name = lines[0].replace(/^Step\s+\d+\s+-\s+/, "").trim();
  const content = lines.slice(1).join("\n");
  const expected = businessText(
    content.match(/(?:^|\r?\n)Expected:\s*([^\r\n]+)/i)?.[1]?.trim() ?? expectedForStep(name),
    expectedForStep(name),
  );
  const recordedActual = content
    .match(/(?:^|\r?\n)Actual:\s*([\s\S]*?)(?=\r?\n(?:Status:|Expected:)|$)/i)?.[1]
    ?.trim();
  const explicitStatus = content.match(/(?:^|\r?\n)Status:\s*([^\r\n]+)/i)?.[1]?.trim();
  let status: ComponentsStatus = "PASS";
  let actual: string;
  if (explicitStatus && /^(?:not run|not executed|skipped)$/i.test(explicitStatus)) {
    status = "NOT EXECUTED";
    actual = businessText(recordedActual ?? "", "NOT EXECUTED; the browser did not reach this action.");
  } else if (explicitStatus && /^fail(?:ed)?$/i.test(explicitStatus)) {
    status = "FAIL";
    actual = businessText(recordedActual ?? "", describeFailedCheck(step.errorMessage));
  } else if (step.unfinished) {
    status = "FAIL";
    const timeoutMs = row.rawError.match(/Test timeout of (\d+)ms/i)?.[1];
    actual = unfinishedStepActual(timeoutMs ? Number(timeoutMs) : undefined);
  } else if (step.failed) {
    status = "FAIL";
    const observedBeforeCheck = /\b(?:displayed|returned|responded with):\s*["“]/i.test(recordedActual ?? "");
    if (step.failedDescendant && !observedBeforeCheck)
      actual = `Not confirmed: execution stopped at the earlier action "${step.failedDescendant}".`;
    else if (observedBeforeCheck)
      actual = `${businessText(recordedActual ?? "", "")} ${describeFailedCheck(step.errorMessage)}`.trim();
    else actual = describeFailedCheck(step.errorMessage);
  } else {
    actual = businessText(row.stepActuals[name] ?? recordedActual ?? "", actualForStep(name, false));
  }
  // A page closed by Playwright at the time limit is reported as the time limit, its real cause.
  const timeLimit = row.rawError.match(/Test timeout of (\d+)ms exceeded/i)?.[1];
  if (status === "FAIL" && timeLimit && /browser page closed before this step/i.test(actual))
    actual = `The scenario reached its time limit (${readableDuration(Number(timeLimit))}) while this step was still running; no result was observed for it.`;
  if (status === "FAIL") actual = businessFailureActual(name, expected, actual);
  return { number: "", title: name, rawTitle: step.title, expected, actual, status, screenshotKey: name, phase: step.phase, repeated: 1 };
}

/**
 * Builds the Components report once for both the validation and audit outputs:
 * shared setup appears once, later setup is labelled as recovery, and every
 * remaining action keeps its own Expected/Actual/Status in completion order.
 */
function buildComponentsReport(rows: ResultRow[]): ComponentsReport {
  const consolidate = rows.length > 1;
  const commonSetup: ComponentsReportStep[] = [];
  const commonSetupKeys = new Set<string>();
  let initialSetupTaken = false;
  let loginSeen = false;

  const cases = rows.map((row): ComponentsCase => {
    const keepSetupInline = !consolidate || explicitlyValidatesSetup(row.title);
    const parsed = row.timeline.map((step) => parseTimelineStep(step, row));
    const hasSetup = parsed.some((step) => step.phase === "suite-setup" || step.phase === "test-setup");
    const isInitialSetup = hasSetup && !initialSetupTaken;
    if (hasSetup) initialSetupTaken = true;
    const steps: ComponentsReportStep[] = [];

    for (const step of parsed) {
      const generic = isGenericConfirmation(step.title);
      const isLogin = LOGIN_STEP.test(step.title);
      const passed = step.status === "PASS";
      if (step.phase === "suite-setup" || step.phase === "test-setup") {
        if (isInitialSetup || (step.phase === "test-setup" && !(isLogin && loginSeen))) {
          // First authentication/navigation: shown once under Common Setup.
          if (isLogin) loginSeen = true;
          if (consolidate) {
            // Only identical generic page confirmations are de-duplicated; real
            // setup actions such as vessel or parent selection are all kept.
            const key = step.title.toLowerCase();
            if (!generic || !passed || !commonSetupKeys.has(key)) {
              if (generic) commonSetupKeys.add(key);
              commonSetup.push(step);
            }
          }
          if (keepSetupInline || !passed || (!generic && !isInitialSetup)) steps.push(step);
          continue;
        }
        // Setup repeated later in the run means the worker or session was replaced.
        if (isLogin) {
          steps.push({ ...step, title: `Session recovery / additional authentication — ${step.title}` });
          continue;
        }
        if (generic && passed) {
          // Recovery is infrastructure evidence, not a business action in the
          // scenario. Do not add it to the execution-step table.
          continue;
        }
        // The replacement worker repeats the suite's vessel/tree readiness
        // checks internally. The single recovery row above is sufficient;
        // these are not new scenario actions or additional initial setup.
        if (passed && /^initial setup - (?:select vessel|verify component tree)\b/i.test(step.title)) continue;
        steps.push({
          ...step,
          title: step.phase === "suite-setup" ? `Session recovery — ${step.title}` : step.title,
        });
        continue;
      }
      if (step.phase === "teardown") {
        if (generic && passed) continue;
        // After a timeout the test body can still record its planned NOT EXECUTED
        // steps while Playwright runs the after-hooks; they belong to the scenario.
        if (/\r?\nStatus:/i.test(step.rawTitle)) {
          steps.push({ ...step, phase: "test" });
          continue;
        }
        steps.push({ ...step, title: `After-test restore — ${step.title}` });
        continue;
      }
      if (generic && passed && !explicitlyValidatesSetup(row.title)) continue;
      steps.push(step);
    }

    const merged = mergeConsecutiveRepeats(steps, row);
    merged.forEach((step, index) => {
      step.number = String(index + 1);
    });
    const scenarioStep = row.scenarioTimeline
      .map((step) => parseTimelineStep(step, row))
      .at(-1);
    return { steps: merged, scenario: componentsScenario(row, merged, scenarioStep) };
  });
  const mergedSetup = mergeConsecutiveRepeats(commonSetup);
  mergedSetup.forEach((step, index) => {
    step.number = String(index + 1);
  });
  return { commonSetup: mergedSetup, cases };
}

/** Shows an identical action repeated back-to-back once, stating how many times it ran. */
function mergeConsecutiveRepeats(steps: ComponentsReportStep[], row?: ResultRow): ComponentsReportStep[] {
  const hasScreenshot = (step: ComponentsReportStep) =>
    Boolean(row?.componentStepScreenshots.some((image) => image.stepTitle === step.screenshotKey));
  const merged: ComponentsReportStep[] = [];
  for (const step of steps) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.title === step.title &&
      previous.expected === step.expected &&
      previous.status === step.status &&
      previous.phase === step.phase &&
      previous.actual.replace(/ \(Performed \d+ times consecutively.*$/, "") === step.actual &&
      !hasScreenshot(step)
    ) {
      previous.repeated += 1;
      previous.actual = `${step.actual} (Performed ${previous.repeated} times consecutively with the same result.)`;
      continue;
    }
    merged.push({ ...step });
  }
  return merged;
}

function componentsScenario(
  row: ResultRow,
  steps: ComponentsReportStep[],
  recordedScenarioStep?: ComponentsReportStep,
): ComponentsScenario {
  const scenarioKey = row.scenarioSteps.at(-1);
  const scenarioStep = recordedScenarioStep ?? (scenarioKey
    ? [...steps].reverse().find((step) => step.screenshotKey === scenarioKey)
    : undefined);
  const expected = scenarioStep?.expected ?? row.declaredExpected ?? expectedForScenario(row.title);
  const technical = row.rawError;
  if (row.status === "passed") {
    const lastTestStep = [...steps].reverse().find((step) => step.phase === "test");
    return {
      expected,
      actual: scenarioStep?.actual ?? lastTestStep?.actual ?? "The scenario completed; no business step was recorded.",
      technical: "",
    };
  }
  if (row.status === "skipped") {
    // Playwright appends the dynamic test.skip() reason after suite metadata.
    // Use the last annotation so a selected-component annotation cannot mask
    // the actual prerequisite or policy reason for the skipped outcome.
    const reason = row.annotations.at(-1);
    const completedTestSteps = steps.filter((step) => step.phase === "test" && step.status === "PASS");
    const lastCompletedStep = completedTestSteps.at(-1);
    // A skip the test did not ask for means Playwright stopped the group after its shared setup failed.
    const groupSetupFailed = row.expectedStatus !== "skipped" && !reason;
    return {
      expected,
      actual: lastCompletedStep
        ? `The workflow executed ${completedTestSteps.length} completed business step${completedTestSteps.length === 1 ? "" : "s"}. Last observed result: ${lastCompletedStep.actual} Final outcome classification remains SKIPPED because ${reason ?? "the final policy-dependent validation was intentionally not asserted"}.`
        : groupSetupFailed
        ? "NOT EXECUTED — this scenario did not run because the shared setup for this test group failed in an earlier test case (see the first failed test case above). No application behavior was exercised."
        : reason
          ? `NOT EXECUTED — the scenario was skipped: ${reason}`
          : "NOT EXECUTED — the scenario was skipped; no application result was observed.",
      technical,
    };
  }
  const firstFailure = steps.find((step) => step.status === "FAIL");
  const notExecuted = steps.filter((step) => step.status === "NOT EXECUTED").length;
  const unreached = scenarioStep
    ? ""
    : " The scenario's overall validation did not complete.";
  const pending = notExecuted
    ? ` ${notExecuted} planned validation${notExecuted === 1 ? " was" : "s were"} NOT EXECUTED.`
    : "";
  if (firstFailure) {
    const stage = failureStage(firstFailure.title, firstFailure.phase);
    // Scenarios that record one check per record keep running after a failed check; only say
    // execution stopped when no later step ran.
    const later = steps.slice(steps.indexOf(firstFailure) + 1).filter((step) => step.status === "PASS" || step.status === "FAIL");
    const failedCount = steps.filter((step) => step.status === "FAIL").length;
    const continued = `${failedCount} step${failedCount === 1 ? "" : "s"} failed in total; execution continued after the first failure and ${later.length} later step${later.length === 1 ? " was" : "s were"} completed.`;
    return {
      expected,
      actual: later.length
        ? `The first failure was at step ${firstFailure.number} "${firstFailure.title}" (${stage}): ${firstFailure.actual} ${continued}${unreached}${pending}`
        : `Execution stopped during ${stage} at step ${firstFailure.number} "${firstFailure.title}": ${firstFailure.actual}${unreached}${pending}`,
      technical,
    };
  }
  const lastStep = steps.at(-1);
  return {
    expected,
    actual: `${describeFailedCheck(row.rawError)}${lastStep ? ` The failure occurred after step ${lastStep.number} "${lastStep.title}".` : " No business step had completed."}${unreached}${pending}`,
    technical,
  };
}

/** Vessels actually used at runtime, in the order they appear in the recorded steps. */
function runtimeVessels(rows: ResultRow[]): string[] {
  const text = rows.flatMap((row) => [...row.timeline.map((step) => step.title), ...row.steps]).join("\n");
  const found = new Set<string>();
  for (const match of text.matchAll(/Vessel ([A-Z0-9_][\w-]*)/g)) found.add(match[1]);
  return [...found].filter((vessel) => /\d|_/.test(vessel));
}

function renderResultRow(
  row: ResultRow,
  index: number,
  suppressCommonSetup = false,
  componentsCase?: ComponentsCase,
): string {
  let parsedSteps: (ParsedBusinessStep & { screenshotKey?: string })[] = componentsCase
    ? componentsCase.steps
    : row.steps.map((title, stepIndex) => parseBusinessStep(title, stepIndex, row));
  if (!componentsCase && row.moduleFolder === "components" && !explicitlyValidatesSetup(row.title)) {
    const recordedSetup = new Set<string>();
    parsedSteps = parsedSteps.filter((parsed) => {
      if (!isSetupOrNavigationStep(parsed) || !/^(?:pass|passed)$/i.test(parsed.status)) return true;
      if (suppressCommonSetup) return false;
      const key = parsed.title.trim().toLowerCase();
      if (recordedSetup.has(key)) return false;
      recordedSetup.add(key);
      return true;
    });
  }
  if (!parsedSteps.length) {
    parsedSteps.push({
      number: "1",
      title: row.title,
      expected: componentsCase?.scenario.expected ?? expectedForScenario(row.title),
      actual:
        componentsCase?.scenario.actual ??
        (row.status === "passed"
          ? "The application produced the scenario result recorded by the completed validation."
          : row.status === "skipped"
            ? "The test was skipped; no application result was observed."
            : explainTechnicalFailure(row.error)),
      status:
        row.status === "passed"
          ? "PASS"
          : row.status === "skipped"
            ? "NOT RUN"
            : "FAIL",
    });
  }
  parsedSteps.forEach((step, index) => {
    step.number = String(index + 1);
  });
  const validationSummary = readValidationSummary(
    parsedSteps.map((step) => step.actual).join("\n"),
  );
  let failureEvidenceShown = false;
  const steps = parsedSteps
    .map((step) => {
      const status = /^(?:pass|passed)$/i.test(step.status)
        ? "PASS"
        : /^(?:not run|not executed|skipped)$/i.test(step.status)
          ? componentsCase ? "NOT EXECUTED" : "NOT RUN"
          : "FAIL";
      const stepText = `${step.expected}\n${step.actual}`;
      const code =
        stepText.match(/Record\s+\d+\s+of\s+\d+:\s*([\w.-]+)/i)?.[1] ??
        stepText.match(/Component Code:\s*([\w.-]+)/i)?.[1];
      // Components failure evidence is shown once, beneath the first failed action.
      const failureEvidence =
        status === "FAIL" && !failureEvidenceShown
          ? row.evidence.find(
              (item) =>
                /failure/i.test(item.name) &&
                (componentsCase !== undefined || !code || item.name.includes(code)),
            )
          : undefined;
      if (failureEvidence && componentsCase) failureEvidenceShown = true;
      const evidenceRow = failureEvidence
        ? `<tr><td></td><td colspan="4"><strong>Failure Evidence</strong><figure><figcaption>${escapeHtml(failureEvidence.name)}</figcaption><img alt="${escapeHtml(failureEvidence.name)}" src="data:${failureEvidence.contentType};base64,${failureEvidence.body}"></figure></td></tr>`
        : "";
      const screenshotKey = step.screenshotKey ?? step.title;
      const componentScreenshots = row.componentStepScreenshots
        .filter((image) => image.stepTitle === screenshotKey)
        .map(
          (image) =>
            `<a class="step-screenshot-link" href="data:${image.contentType};base64,${image.body}" target="_blank" rel="noopener" download="${escapeHtml(screenshotFileName(step.title))}"><img class="step-screenshot" alt="Screenshot for ${escapeHtml(step.title)}" src="data:${image.contentType};base64,${image.body}"><span>Open full-size screenshot</span></a>`,
        )
        .join("");
      const componentScreenshotRow = componentScreenshots
        ? `<tr><td></td><td colspan="4"><strong>Validation Screenshot</strong>${componentScreenshots}</td></tr>`
        : "";
      return `<tr><td>${escapeHtml(step.number)}</td><td>${escapeHtml(step.title)}</td><td>${escapeHtml(step.expected)}</td><td>${escapeHtml(step.actual).replace(/\r?\n/g, "<br>")}</td><td class="${status === "PASS" ? "pass" : status === "FAIL" ? "fail" : "not-run"}">${status}</td></tr>${componentScreenshotRow}${evidenceRow}`;
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
    .filter((image) => !/failure/i.test(image.name) || (componentsCase && !failureEvidenceShown))
    .map(
      (image) =>
        `<figure><figcaption>${escapeHtml(image.name)}</figcaption><img alt="${escapeHtml(image.name)}" src="data:${image.contentType};base64,${image.body}"></figure>`,
    )
    .join("");
  const evidenceSection = evidence
    ? `<details class="evidence-panel"><summary>Screenshots and Evidence</summary>${evidence}</details>`
    : "";
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
  const scenario = componentsCase?.scenario ?? scenarioDescription(row, parsedSteps);
  const technical = scenario.technical && !componentsCase
    ? `<details class="technical"><summary>Technical Details</summary><pre>${escapeHtml(scenario.technical)}</pre></details>`
    : "";
  // Components diagnostics live in their own section after the business steps.
  const componentsTechnical = scenario.technical && componentsCase
    ? `<details class="technical"><summary>Technical Details</summary><pre>${escapeHtml(scenario.technical)}</pre></details>`
    : "";
  const caseOutcome = classifyCaseOutcome(row.status, row.expectedStatus, row.annotations.some(Boolean), row.annotations.at(-1));
  const resultLabel = caseOutcome === "not-executed" ? "NOT EXECUTED" : caseOutcome.toUpperCase();
  const testId = row.title.match(/\b[A-Z]+-\d+\b/)?.[0] ?? `Test ${index + 1}`;
  const scenarioName = row.title.replace(new RegExp(`^\\s*${testId}\\s*[-:â€”–]?\\s*`, "i"), "") || row.title;
  return `<details class="test-case" data-status="${caseOutcome}"><summary><span class="case-header"><span class="case-title"><span class="case-id">${escapeHtml(testId)}</span>${escapeHtml(scenarioName)}</span><span class="status ${caseOutcome}">${resultLabel}</span><span class="duration">${formatDuration(row.duration)}</span><span class="chevron" aria-hidden="true"></span></span></summary><div class="case-body"><p class="tags">${escapeHtml(row.tags.join(", "))}</p><div class="result-grid"><section class="result-box"><h3>Expected Result</h3><p>${escapeHtml(scenario.expected)}</p></section><section class="result-box"><h3>Actual Result</h3><p>${escapeHtml(scenario.actual).replace(/\r?\n/g, "<br>")}</p></section></div><div class="table-scroll"><table class="business-steps"><thead><tr><th>Step</th><th>Execution Step</th><th>Expected Result</th><th>Actual Result</th><th>Status</th></tr></thead><tbody>${steps}</tbody></table></div>${componentsTechnical}${technical}${comparisonTable}${validation}${history}${details}${attentionSection}${evidenceSection}</div></details>`;
}

function screenshotFileName(stepTitle: string): string {
  const safeTitle = stepTitle.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "");
  return `${safeTitle || "components-validation"}.png`;
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
          /(?:^|\r?\n)Actual:\s*([\s\S]*?)(?=\r?\n(?:Status:|Expected:|Technical (?:Reason|Details):|Reason:)|$)/i,
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
  const recordedStep = failedBusinessStep ?? lastBusinessStep;
  const stepName =
    (recordedStep ?? "Setup or navigation").match(
      /^(?:Step\s+\d+\s+-\s+)?([^\r\n]+)/,
    )?.[1] ?? "Setup or navigation";
  const expected =
    recordedStep
      ?.match(/(?:^|\r?\n)Expected:\s*([^\r\n]+)/i)?.[1]
      ?.trim() ??
    (recordedStep
      ? expectedForStep(stepName)
      : expectedForScenario(title));
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
    expected,
    "",
    "Actual:",
    recordedStep
      ? explainTechnicalFailure(technicalReason)
      : explainTechnicalFailure(technicalReason),
    "",
    "Technical Reason:",
    technicalReason || "No additional Playwright error message was available.",
    "",
    "Status: FAILED",
  ].join("\n");
}

function scenarioExecutionForRows(
  specName: string,
  moduleFolder: string,
  rows: ResultRow[],
  startedAt: Date,
): AuditScenarioExecution {
  const runtimeText = rows.flatMap((row) => [row.title, ...row.steps, ...row.attachments.map((item) => item.body)]).join("\n");
  const users = new Set<string>([config.username]);
  if (runtimeText.includes(config.automationUser2Username)) users.add(config.automationUser2Username);
  const vessels = new Set<string>();
  for (const vessel of [config.vesselName, config.vesselA, config.vesselB, config.emptyVessel]) if (runtimeText.includes(vessel)) vessels.add(vessel);
  if (moduleFolder === "components") {
    const report = buildComponentsReport(rows);
    const auditStatus = (status: ComponentsStatus) => status;
    const componentVessels = runtimeVessels(rows);
    const componentCases = rows.map((row, index) => {
      const item = report.cases[index];
      return {
        id: row.title.match(/\b[A-Z]+-\d+\b/)?.[0] ?? "—",
        name: row.title,
        status: ({ passed: "PASSED", failed: "FAILED", skipped: "SKIPPED", "not-executed": "NOT EXECUTED" } as const)[classifyCaseOutcome(row.status, row.expectedStatus, row.annotations.some(Boolean), row.annotations.at(-1))],
        expected: item.scenario.expected,
        actual: item.scenario.actual,
        technical: item.scenario.technical || undefined,
        durationMs: row.duration,
        evidence: row.evidence.map(({ name, contentType, body }) => ({ name, contentType, body })),
        findings: item.steps.map((step) => ({
          step: `${step.number}. ${step.title}`,
          expected: step.expected,
          actual: step.actual,
          status: auditStatus(step.status),
        })),
      };
    });
    const passedCount = componentCases.filter((item) => item.status === "PASSED").length;
    const failedCount = componentCases.filter((item) => item.status === "FAILED").length;
    const skippedCount = componentCases.filter((item) => item.status === "SKIPPED").length;
    const notExecutedCount = componentCases.filter((item) => item.status === "NOT EXECUTED").length;
    return {
      module: "Components",
      specName,
      users: [...users],
      vessels: componentVessels.length ? componentVessels : [...vessels],
      executionDate: startedAt,
      total: componentCases.length,
      passed: passedCount,
      failed: failedCount,
      skipped: skippedCount,
      notExecuted: notExecutedCount,
      overallStatus: overallExecutionStatus({ failed: failedCount, notExecuted: notExecutedCount, skipped: skippedCount, total: componentCases.length }),
      commonSetup: report.commonSetup.length
        ? report.commonSetup.map((step) => ({
            step: `${step.number}. ${step.title}`,
            expected: step.expected,
            actual: step.actual,
            status: auditStatus(step.status),
          }))
        : undefined,
      testCases: componentCases,
    };
  }
  const consolidateCommonSetup = moduleFolder === "components" && rows.length > 1;
  const commonSetup: AuditScenarioExecution["commonSetup"] = [];
  const commonSetupKeys = new Set<string>();
  let initialLoginRecorded = false;
  const testCases = rows.map((row) => ({
    id: row.title.match(/\b[A-Z]+-\d+\b/)?.[0] ?? "—",
    name: row.title,
    status: ({ passed: "PASSED", failed: "FAILED", skipped: "SKIPPED", "not-executed": "NOT EXECUTED" } as const)[classifyCaseOutcome(row.status, row.expectedStatus, row.annotations.some(Boolean), row.annotations.at(-1))],
    durationMs: row.duration,
    evidence: row.evidence.map(({ name, contentType, body }) => ({ name, contentType, body })),
    findings: row.steps.flatMap((title, index) => {
      const parsed = parseBusinessStep(title, index, row);
      const finding = findingForParsedStep(parsed);
      if (moduleFolder !== "components" || explicitlyValidatesSetup(row.title) || !isSetupOrNavigationStep(parsed) || finding.status !== "PASS") return [finding];
      const isLogin = /^(?:log in|login)\b/i.test(parsed.title.trim());
      const key = parsed.title.trim().toLowerCase();
      if (isLogin && initialLoginRecorded) {
        return [{ ...finding, step: `Session recovery / additional authentication — ${finding.step}` }];
      }
      if (commonSetupKeys.has(key)) return [];
      commonSetupKeys.add(key);
      if (isLogin) initialLoginRecorded = true;
      if (consolidateCommonSetup) {
        commonSetup.push(finding);
        return [];
      }
      return [finding];
    }),
  }));
  const passed = testCases.filter((item) => item.status === "PASSED").length;
  const failed = testCases.filter((item) => item.status === "FAILED").length;
  const skipped = testCases.filter((item) => item.status === "SKIPPED").length;
  const notExecuted = testCases.filter((item) => item.status === "NOT EXECUTED").length;
  return {
    module: moduleFolder.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "),
    specName,
    users: [...users],
    vessels: [...vessels],
    executionDate: startedAt,
    total: testCases.length,
    passed,
    failed,
    skipped,
    notExecuted,
    overallStatus: overallExecutionStatus({ failed, notExecuted, skipped, total: testCases.length }),
    commonSetup: commonSetup.length ? commonSetup : undefined,
    testCases,
  };
}

function ensureAuditReport(
  specName: string,
  rows: ResultRow[],
  startedAt: Date,
): void {
  const moduleFolder = rows[0]?.moduleFolder ?? reportModuleFolder(specName);
  const auditPath = path.resolve("reports", "audit", moduleFolder, `${specName}.html`);
  // Always finish the spec-named audit from the completed Playwright results.
  // Any in-test audit data is retained through its attachments/comparisons,
  // while the final report gains accurate case counts and execution status.
  void auditPath;

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
  const moduleName = moduleFolder
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
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
  const hasImportAuditEvidence = Boolean(
    attemptedFiles.length || details.trim() || rows.some((row) => row.comparisons.length),
  );
  if (!hasImportAuditEvidence) {
    const allRuntimeText = rows
      .flatMap((row) => [row.title, ...row.steps, ...row.attachments.map((item) => item.body)])
      .join("\n");
    const users = new Set<string>([config.username]);
    if (allRuntimeText.includes(config.automationUser2Username)) {
      users.add(config.automationUser2Username);
    }
    const vessels = new Set<string>();
    for (const configuredVessel of [config.vesselName, config.vesselA, config.vesselB, config.emptyVessel]) {
      if (allRuntimeText.includes(configuredVessel)) vessels.add(configuredVessel);
    }
    const testCases = rows.map((row) => {
      const findings = row.steps.map((title, index) => {
        const parsed = parseBusinessStep(title, index, row);
        return {
          step: parsed.title,
          expected: parsed.expected,
          actual: parsed.actual,
          status: (/^(?:pass|passed)$/i.test(parsed.status)
            ? "PASS"
            : /^(?:not run|skipped)$/i.test(parsed.status)
              ? "NOT RUN"
              : "FAIL") as "PASS" | "FAIL" | "NOT RUN",
        };
      });
      const id = row.title.match(/\b[A-Z]+-\d+\b/)?.[0] ?? "—";
      return {
        id,
        name: row.title,
        status: (row.status === "passed"
          ? "PASSED"
          : row.status === "skipped"
            ? "SKIPPED"
            : "FAILED") as "PASSED" | "FAILED" | "SKIPPED",
        findings,
      };
    });
    void testCases;
    const module = moduleFolder
      .split("-")
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
    generateStandardAuditReport({
      dataType: module,
      fileName: `${specName}.html`,
      moduleFolder,
      vessel: "",
      excelFile: "",
      uploadedBy: config.username,
      validationType: "Scenario execution",
      successfullyImported: 0,
      recordsChecked: 0,
      recordsMatched: 0,
      identifierColumns: ["Test Case"],
      missingRecords: [],
      fieldMismatches: [],
      scenarioExecution: scenarioExecutionForRows(
        specName,
        moduleFolder,
        rows,
        startedAt,
      ),
    });
    return;
  }
  const comparisonError = rows
    .flatMap((row) => row.comparisons)
    .find((item) => item.status === "ERROR");
  const failureEvidence =
    comparisonError?.evidence ??
    failedRow?.evidence.find((item) => /failure/i.test(item.name));
  const failedScenario = failedRow
    ? scenarioDescription(
        failedRow,
        failedRow.steps.map((title, index) => parseBusinessStep(title, index, failedRow)),
      )
    : undefined;
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
    missingRecords: rows.flatMap((row) => row.comparisons)
      .filter((item) => item.status === "MISSING")
      .map((item) => ({ identifiers: { "Record Code": item.recordCode }, issue: item.reason ?? `${item.field} was missing.` })),
    fieldMismatches: rows.flatMap((row) => row.comparisons)
      .filter((item) => item.status === "MISMATCH" || item.status === "ERROR")
      .map((item) => ({ identifiers: { "Record Code": item.recordCode }, field: item.field, expected: item.expected, actual: item.actual, reason: item.reason ?? "Expected and actual values did not match." })),
    automationIssues: failedRow
      ? [
          {
            identifiers: {
              "Record Code": comparisonError?.recordCode ?? "Scenario",
            },
            failedStep: comparisonError?.field ?? "Validation execution",
            expected:
              comparisonError?.expected ?? failedScenario?.expected ?? expectedForScenario(failedRow.title),
            actual: comparisonError?.actual ?? failedScenario?.actual ?? "No application result was recorded.",
            reason:
              comparisonError?.reason ??
              `The "${failedRow.title}" validation did not reach its recorded expected state. Technical diagnostics are available separately in the validation report.`,
            evidence: failureEvidence,
          },
        ]
      : [],
    validationComparisons: rows.flatMap((row) => row.comparisons),
    scenarioExecution: scenarioExecutionForRows(specName, moduleFolder, rows, startedAt),
  });
}
