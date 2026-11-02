import fs from "node:fs";
import path from "node:path";
import { deferEmbeddedImages, type OverallExecutionStatus } from "./reportingStandards";

export type AuditIdentifiers = Record<string, string>;
export type AuditIssue = { identifiers: AuditIdentifiers; issue: string };
export type AuditMismatch = {
  identifiers: AuditIdentifiers;
  field: string;
  expected: string;
  actual: string;
  reason: string;
};
export type AuditAutomationIssue = {
  identifiers: AuditIdentifiers;
  failedStep: string;
  expected: string;
  actual: string;
  reason: string;
  evidence?: { name: string; contentType: string; body: string };
};
export type AuditScenarioResult = {
  id: string;
  name: string;
  status: "PASSED" | "FAILED" | "SKIPPED" | "NOT EXECUTED";
  /** Scenario-level Expected/Actual Result and diagnostics (kept out of the findings). */
  expected?: string;
  actual?: string;
  technical?: string;
  durationMs?: number;
  evidence?: { name: string; contentType: string; body: string }[];
  findings: {
    step: string;
    expected: string;
    actual: string;
    status: "PASS" | "FAIL" | "NOT RUN" | "NOT EXECUTED";
  }[];
};

function formatDuration(milliseconds = 0): string {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
export type AuditScenarioExecution = {
  module: string;
  specName: string;
  users: string[];
  vessels: string[];
  executionDate: Date;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  notExecuted?: number;
  overallStatus: OverallExecutionStatus;
  commonSetup?: AuditScenarioResult["findings"];
  testCases: AuditScenarioResult[];
};
export type AuditValidationComparison = {
  recordCode: string;
  recordName?: string;
  field: string;
  expected: string;
  actual: string;
  status: string;
  reason?: string;
};
export type StandardAuditData = {
  dataType: string;
  fileName: string;
  /** Report folder already resolved from the spec location; derived from fileName/dataType when omitted. */
  moduleFolder?: string;
  vessel: string;
  excelFile: string;
  uploadedBy: string;
  validationType: string;
  successfullyImported: number;
  recordsSelected?: number;
  recordsAttempted?: number;
  recordsChecked: number;
  recordsMatched: number;
  missingRecords: AuditIssue[];
  fieldMismatches: AuditMismatch[];
  automationIssues?: AuditAutomationIssue[];
  identifierColumns: string[];
  additionalMetadata?: Record<string, string>;
  scenarioExecution?: AuditScenarioExecution;
  validationComparisons?: AuditValidationComparison[];
};

const escapeHtml = (value: unknown) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Resolves the shared module folder without changing report filenames or HTML. */
export function reportModuleFolder(fileName: string, source = ""): string {
  const value = `/${source}/${fileName}`.replace(/\\/g, "/").toLowerCase();
  if (value.includes("/bulk-import/")) return "bulk-import";
  // Components UI scenarios stay Components reports even when their name
  // mentions Running Hours (for example the Section C scenarios).
  if (value.includes("/tests/components/")) return "components";
  if (value.includes("/running-hours/") || /running[-_ ]?hours/.test(value))
    return "running-hours";
  if (value.includes("/components/")) return "components";
  if (value.includes("/jobs/") || /jobs?/.test(value)) return "jobs";
  if (value.includes("/spares/") || /spares?/.test(value)) return "spares";
  if (value.includes("/stores/") || /stores?|verify-stores/.test(value))
    return "stores";
  if (value.includes("/location/") || /locations?/.test(value))
    return "locations";
  if (/bulkdataimport|components-(?:add|update)/.test(value))
    return "bulk-import";
  if (/components?|component-/.test(value)) return "components";
  return "general";
}

export function generateStandardAuditReport(data: StandardAuditData): string {
  const directory = path.resolve(
    process.cwd(),
    "reports",
    "audit",
    data.moduleFolder ?? reportModuleFolder(data.fileName, data.dataType),
  );
  fs.mkdirSync(directory, { recursive: true });
  const reportPath = path.join(directory, data.fileName);
  const automation = data.automationIssues ?? [];
  const key = (ids: AuditIdentifiers) =>
    data.identifierColumns.map((column) => ids[column] ?? "").join("\n");
  const issueCount = new Set([
    ...data.missingRecords.map((item) => key(item.identifiers)),
    ...data.fieldMismatches.map((item) => key(item.identifiers)),
    ...automation.map((item) => key(item.identifiers)),
  ]).size;
  const auditPassed = automation.length === 0;
  const validationStatus = !auditPassed
    ? "INCOMPLETE"
    : issueCount
      ? "COMPLETED WITH ISSUES"
      : "PASSED";
  const headers = data.identifierColumns
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("");
  const cells = (ids: AuditIdentifiers) =>
    data.identifierColumns
      .map((column) => `<td>${escapeHtml(ids[column] ?? "")}</td>`)
      .join("");
  const missingRows = data.missingRecords
    .map(
      (item, index) =>
        `<tr><td>${index + 1}</td>${cells(item.identifiers)}<td>${escapeHtml(item.issue)}</td></tr>`,
    )
    .join("");
  const mismatchRows = data.fieldMismatches
    .map(
      (item, index) =>
        `<tr><td>${index + 1}</td>${cells(item.identifiers)}<td>${escapeHtml(item.field)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.actual)}</td><td>${escapeHtml(item.reason)}</td></tr>`,
    )
    .join("");
  const automationRows = automation
    .map(
      (item, index) =>
        `<tr><td>${index + 1}</td>${cells(item.identifiers)}<td>${escapeHtml(item.failedStep)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.actual)}</td><td>${escapeHtml(item.reason)}</td></tr>`,
    )
    .join("");
  const metadata = Object.entries(data.additionalMetadata ?? {})
    .map(
      ([label, value]) =>
        `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
    )
    .join("");
  const selected = data.recordsSelected ?? data.recordsChecked;
  const attempted = data.recordsAttempted ?? data.recordsChecked;
  const type = data.dataType.toUpperCase();
  const finalMessage = auditPassed
    ? "Audit execution completed."
    : `Audit execution did not complete because validation encountered ${automation.length} automation/execution issue${automation.length === 1 ? "" : "s"}.`;
  const scenario = data.scenarioExecution;
  const hasScenarioResults = Boolean(scenario?.testCases.some((testCase) => testCase.expected));
  const scenarioRows =
    scenario?.testCases
      .map(
        (testCase, index) => {
          const status = testCase.status.toLowerCase().replace(/\s+/g, "-");
          const findings = testCase.findings.map((finding, findingIndex) => `<tr><td>${findingIndex + 1}</td><td>${escapeHtml(finding.step)}</td><td>${escapeHtml(finding.expected)}</td><td>${escapeHtml(finding.actual)}</td><td class="${finding.status === "PASS" ? "ok" : finding.status === "FAIL" ? "issue" : "pending"}">${finding.status}</td></tr>`).join("");
          const evidence = (testCase.evidence ?? []).map((item) => { const source = `data:${item.contentType};base64,${item.body}`; return `<figure><figcaption>${escapeHtml(item.name)}</figcaption><a href="${source}" target="_blank" rel="noopener"><img alt="${escapeHtml(item.name)}" src="${source}"></a></figure>`; }).join("");
          return `<details class="test-case" data-status="${status}"><summary><span class="case-header"><span class="case-title"><span class="case-number">${index + 1}</span><span class="case-id">${escapeHtml(testCase.id)}</span>${escapeHtml(testCase.name)}</span><span class="status ${status}">${testCase.status}</span><span class="duration">${formatDuration(testCase.durationMs)}</span><span class="chevron" aria-hidden="true"></span></span></summary><div class="case-body">${hasScenarioResults ? `<div class="result-grid"><section class="result-box"><h3>Expected Result</h3><p>${escapeHtml(testCase.expected ?? "")}</p></section><section class="result-box"><h3>Actual Result</h3><p>${escapeHtml(testCase.actual ?? "")}</p></section></div>` : ""}${findings ? `<div class="table-scroll"><table class="business-steps"><thead><tr><th>Step</th><th>Execution Step</th><th>Expected Result</th><th>Actual Result</th><th>Status</th></tr></thead><tbody>${findings}</tbody></table></div>` : "<p>No business execution steps were recorded.</p>"}${evidence ? `<details class="evidence-panel"><summary>Screenshots and Evidence</summary>${evidence}</details>` : ""}${testCase.technical ? `<details class="technical"><summary>Technical Details</summary><pre>${escapeHtml(testCase.technical)}</pre></details>` : ""}</div></details>`;
        },
      )
      .join("") ?? "";
  const commonSetupRows =
    scenario?.commonSetup
      ?.map(
        (finding) =>
          `<tr><td>${escapeHtml(finding.step)}</td><td>${escapeHtml(finding.expected)}</td><td>${escapeHtml(finding.actual)}</td><td class="${finding.status === "PASS" ? "ok" : finding.status === "FAIL" ? "issue" : ""}">${finding.status}</td></tr>`,
      )
      .join("") ?? "";
  const comparisonRows = (data.validationComparisons ?? [])
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.recordCode)}</td><td>${escapeHtml(item.recordName ?? "")}</td><td>${escapeHtml(item.field)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.actual)}</td><td class="${item.status === "PASS" ? "ok" : "issue"}">${escapeHtml(item.status)}</td><td>${escapeHtml(item.reason ?? "")}</td></tr>`,
    )
    .join("");
  const comparisonSection = comparisonRows
    ? `<h2>VALIDATION FINDINGS</h2><table><thead><tr><th>Record Code</th><th>Record Name</th><th>Field</th><th>Expected</th><th>Actual</th><th>Status</th><th>Reason</th></tr></thead><tbody>${comparisonRows}</tbody></table>`
    : "";
  const scenarioContent = scenario
    ? `<section class="report-meta"><div><span>Module</span><strong>${escapeHtml(scenario.module)}</strong></div><div><span>Vessel</span><strong>${escapeHtml(scenario.vessels.join(", ") || "Not specified")}</strong></div><div><span>Execution Date</span><strong>${escapeHtml(scenario.executionDate.toLocaleString())}</strong></div><div><span>Logged-in User${scenario.users.length === 1 ? "" : "s"}</span><strong>${escapeHtml(scenario.users.join(", "))}</strong></div><div><span>Overall Status</span><strong class="${scenario.overallStatus === "PASSED" ? "ok" : "issue"}">${scenario.overallStatus}</strong></div></section><p class="suite-name"><strong>Spec / Test Suite:</strong> ${escapeHtml(scenario.specName)}</p><h2>EXECUTION SUMMARY</h2><section class="summary"><div class="card">Total<strong>${scenario.total}</strong></div><div class="card ok">Passed<strong>${scenario.passed}</strong></div><div class="card ${scenario.failed ? "issue" : "ok"}">Failed<strong>${scenario.failed}</strong></div><div class="card">Skipped<strong>${scenario.skipped}</strong></div><div class="card pending">Not Executed<strong>${scenario.notExecuted ?? 0}</strong></div><div class="card">Pass Percentage<strong>${scenario.total ? Math.round(scenario.passed / scenario.total * 100) : 0}%</strong></div></section><div class="toolbar"><div class="filters"><button class="active" onclick="show('all',this)">All (${scenario.total})</button><button onclick="show('passed',this)">Passed (${scenario.passed})</button><button onclick="show('failed',this)">Failed (${scenario.failed})</button><button onclick="show('skipped',this)">Skipped (${scenario.skipped})</button><button onclick="show('not-executed',this)">Not Executed (${scenario.notExecuted ?? 0})</button></div><div class="expand-controls"><button onclick="toggleAll(true)">Expand All</button><button onclick="toggleAll(false)">Collapse All</button></div></div><p id="empty-state" hidden>No test cases match this filter.</p><h2>TEST CASE RESULTS</h2><section class="test-cases">${scenarioRows}</section><h2>OVERALL EXECUTION</h2><section class="final"><p>Total Test Cases: ${scenario.total}</p><p>Passed: ${scenario.passed}</p><p>Failed: ${scenario.failed}</p><p>Skipped: ${scenario.skipped}</p><p>Not Executed: ${scenario.notExecuted ?? 0}</p><p>Overall Execution: ${scenario.overallStatus}</p></section>`
    : "";
  const importContent = `<p><strong>Vessel:</strong> ${escapeHtml(data.vessel)}</p><p><strong>Excel File:</strong> ${escapeHtml(data.excelFile)}</p><p><strong>Uploaded By:</strong> ${escapeHtml(data.uploadedBy)}</p><p><strong>Audit Date:</strong> ${escapeHtml(new Date().toLocaleString())}</p><p><strong>Validation Type:</strong> ${escapeHtml(data.validationType)}</p>${metadata}<h2>AUDIT SUMMARY</h2><section class="summary"><div class="card">Successfully Imported Records: ${data.successfullyImported}</div><div class="card">Records Selected: ${selected}</div><div class="card">Records Attempted: ${attempted}</div><div class="card">Records Matched: ${data.recordsMatched}</div><div class="card">Records With Issues: ${issueCount}</div><div class="card">Missing Records: ${data.missingRecords.length}</div><div class="card">Field Mismatches: ${data.fieldMismatches.length}</div><div class="card">Automation Errors: ${automation.length}</div><div class="card ${auditPassed ? "ok" : "issue"}">Audit Execution: ${auditPassed ? "PASSED" : "FAILED"}</div><div class="card ${validationStatus === "PASSED" ? "ok" : "issue"}">Data Validation: ${validationStatus}</div></section>${comparisonSection}<h2>RECORDS WITH ISSUES</h2>${missingRows ? `<table><thead><tr><th>No.</th>${headers}<th>Issue</th></tr></thead><tbody>${missingRows}</tbody></table>` : `<p>No missing ${escapeHtml(data.dataType)} records found.</p>`}<h2>FIELD MISMATCHES</h2>${mismatchRows ? `<table><thead><tr><th>No.</th>${headers}<th>Field</th><th>Expected</th><th>Actual</th><th>Reason</th></tr></thead><tbody>${mismatchRows}</tbody></table>` : "<p>No field mismatches found.</p>"}<h2>AUTOMATION / EXECUTION ISSUES</h2>${automationRows ? `<table><thead><tr><th>No.</th>${headers}<th>Failed Step</th><th>Expected</th><th>Actual</th><th>Reason</th><th>Evidence</th></tr></thead><tbody>${automationRows}</tbody></table>` : "<p>No automation or execution issues found.</p>"}<h2>FINAL RESULT</h2><section class="final"><p>Successfully Imported: ${data.successfullyImported}</p><p>Selected for Validation: ${selected}</p><p>Attempted: ${attempted}</p><p>Matched: ${data.recordsMatched}</p><p>Require Review: ${issueCount}</p><p>${escapeHtml(finalMessage)}</p></section>`;
  const executionPassed = scenario
    ? scenario.overallStatus === "PASSED"
    : auditPassed;
  const hasImportContent = Boolean(
    data.excelFile ||
    data.validationComparisons?.length ||
    data.additionalMetadata?.["Uploaded File"],
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(type)} DATA AUDIT REPORT</title><style>body{font:16px system-ui;margin:32px;color:#17202a;line-height:1.45}main{max-width:1500px;margin:auto}h1{text-align:center;color:#175cd3}h2{margin-top:30px;border-bottom:1px solid #ccc}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.card{padding:12px;border:1px solid #ccc;background:#f8fafc}.card strong{display:block;font-size:24px;margin-top:4px}button{margin:4px;padding:9px 14px;border:1px solid #ccc;border-radius:6px;cursor:pointer}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eef2f6}.ok{color:#167c3a}.issue{color:#b42318}.pending{color:#8a5a00}.final{padding:14px;background:${executionPassed ? "#f0fdf4" : "#fff1f0"};border-left:4px solid ${executionPassed ? "#167c3a" : "#b42318"};margin-bottom:24px}img{max-width:520px;height:auto}pre.technical{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;border:1px solid #ccc;padding:8px;font-size:13px}</style></head><body><main><h1>${escapeHtml(type)} DATA AUDIT REPORT</h1>${scenarioContent}${hasImportContent ? importContent : ""}<script>function show(status,button){let visible=0;document.querySelectorAll('.test-case[data-status]').forEach(card=>{card.hidden=status!=='all'&&card.dataset.status!==status;if(!card.hidden)visible++});document.querySelectorAll('.filters button').forEach(item=>item.classList.remove('active'));if(button)button.classList.add('active');const empty=document.getElementById('empty-state');if(empty)empty.hidden=visible>0}function toggleAll(open){document.querySelectorAll('.test-case:not([hidden])').forEach(card=>card.open=open)}</script></main></body></html>`;
  const reportHtml = commonSetupRows
    ? html.replace(
        "<h2>EXECUTION SUMMARY</h2>",
        `<details class="setup-panel"><summary>Common Setup / Initial Navigation</summary><div class="table-scroll"><table class="setup-table"><thead><tr><th>Step</th><th>Expected</th><th>Actual</th><th>Status</th></tr></thead><tbody>${commonSetupRows}</tbody></table></div></details><h2>EXECUTION SUMMARY</h2>`,
      )
    : html;
  fs.writeFileSync(
    reportPath,
    deferEmbeddedImages(reportHtml.replace(
      "<th>Reason</th><th>Evidence</th>",
      "<th>Reason</th>",
    ).replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">')
      .replace('</style></head>', `*{box-sizing:border-box}body{margin:0;padding:24px;background:#f4f6f8;color:#101828}main{width:min(1480px,100%)}.report-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;padding:16px;background:#fff;border:1px solid #d0d5dd;border-radius:12px}.report-meta div{min-width:0}.report-meta span{display:block;color:#667085;font-size:12px;text-transform:uppercase}.report-meta strong{display:block;overflow-wrap:break-word}.suite-name{color:#475467}.toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin:18px 0}.filters,.expand-controls{display:flex;flex-wrap:wrap;gap:8px}.filters button,.expand-controls button{margin:0;background:#fff}.filters button.active{background:#175cd3;color:#fff;border-color:#175cd3}#empty-state{padding:24px;text-align:center;background:#fff;border:1px dashed #98a2b3;border-radius:10px}.setup-panel,.test-case{background:#fff;border:1px solid #d0d5dd;border-radius:10px;margin:12px 0;box-shadow:0 1px 2px rgba(16,24,40,.05)}.setup-panel{padding:14px}.setup-panel>summary,.technical>summary,.evidence-panel>summary{font-weight:700;cursor:pointer}.test-case>summary{list-style:none;cursor:pointer;padding:14px 16px}.test-case>summary::-webkit-details-marker{display:none}.case-header{display:grid;grid-template-columns:minmax(0,1fr) auto auto 18px;gap:12px;align-items:center}.chevron::before{content:'›';display:block;font-size:24px;line-height:1;transition:transform .15s}.test-case[open] .chevron::before{transform:rotate(90deg)}.case-title{font-size:16px;font-weight:700;min-width:0}.case-number{color:#667085;margin-right:8px}.case-id{display:inline-block;color:#175cd3;margin-right:10px;white-space:nowrap}.status,.duration{white-space:nowrap;font-weight:700}.status{padding:4px 9px;border-radius:999px;background:#eef2f6}.status.passed{color:#167c3a;background:#ecfdf3}.status.failed{color:#b42318;background:#fef3f2}.status.skipped,.status.not-executed{color:#8a5a00;background:#fffaeb}.case-body{padding:0 16px 16px}.result-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;margin:4px 0 16px}.result-box{min-width:0;padding:14px;border:1px solid #d0d5dd;border-radius:8px;background:#f8fafc}.result-box h3{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#667085}.result-box p{margin:0;overflow-wrap:break-word}.table-scroll{width:100%;overflow-x:auto;margin:10px 0 4px}.table-scroll table{min-width:820px;table-layout:fixed}.business-steps th:nth-child(1){width:6%}.business-steps th:nth-child(2){width:22%}.business-steps th:nth-child(3){width:28%}.business-steps th:nth-child(4){width:34%}.business-steps th:nth-child(5){width:10%}.business-steps th,.business-steps td:first-child,.business-steps td:last-child{white-space:nowrap}.business-steps td{overflow-wrap:break-word}.technical,.evidence-panel{margin-top:14px;border:1px solid #d0d5dd;border-radius:8px;padding:10px}.technical pre{white-space:pre-wrap;overflow-wrap:break-word;background:#f6f8fa;padding:10px}figure{display:inline-block;vertical-align:top;width:min(320px,100%);margin:12px 12px 0 0}figure img{display:block;width:100%;height:180px;object-fit:cover;border:1px solid #d0d5dd;border-radius:8px}@media(max-width:700px){body{padding:8px}.case-header{grid-template-columns:minmax(0,1fr) auto 18px}.duration{grid-column:1/-1;font-size:13px;color:#667085}.result-grid{grid-template-columns:1fr}.case-body{padding:0 10px 12px}.test-case>summary{padding:12px 10px}}</style></head>`)),
    "utf8",
  );
  return reportPath;
}
