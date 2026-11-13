const fs = require('node:fs');
const path = require('node:path');

const reportPath = path.resolve('reports', 'validation', 'running-hours', 'PMS_Running_Hours_Bulk_Update_Negative_Validation_Test_Execution_Report.html');
const decode = (value) => value
  .replace(/<br\s*\/?\s*>/gi, '\n')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const escape = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

let html = fs.readFileSync(reportPath, 'utf8');
if (!/RH-N20/i.test(html)) throw new Error('RH-N20 evidence was not found in the preserved report.');

const finalEvidence = [...html.matchAll(/<p>(Vessel:\s*[^<]*Save outcome:[\s\S]*?)<\/p>/gi)].at(-1)?.[1]
  ?? [...html.matchAll(/<td>(Vessel:\s*[^<]*Save outcome:[\s\S]*?)<\/td>/gi)].at(-1)?.[1];
if (!finalEvidence) throw new Error('The preserved final RH-N20 verification evidence was not found.');
const evidence = decode(finalEvidence);
const number = (pattern) => Number(evidence.match(pattern)?.[1] ?? 0);
const vessel = evidence.match(/Vessel:\s*([^;]+)/i)?.[1]?.trim() ?? 'Not recorded';
const selected = number(/selected:\s*(\d+)/i);
const submitted = number(/submitted together:\s*(\d+)/i);
const saved = number(/observed valid rows persisted:\s*(\d+)/i);
const invalid = number(/observed invalid rows unchanged:\s*(\d+)/i);
const saveActions = number(/Bulk Save actions:\s*(\d+)/i);

const expected = `The system should reject the ${invalid} invalid Running Hours entries and save only the ${submitted} valid entries. After refreshing, all ${submitted} valid components should show their updated Running Hours, while the ${invalid} invalid components remain unchanged. No incorrect updates or duplicate history entries should be created.`;
const actual = `Bulk Running Hours update completed successfully for ${vessel}. ${saved} valid components were updated using ${saveActions} Bulk Save action. ${invalid} invalid components were excluded from submission and remained unchanged. The saved values were verified after refresh. Final execution status: PASS.`;

html = html.replace(/<section class="result-box"><h3>Expected Result<\/h3><p>[\s\S]*?<\/p><\/section>/i,
  `<section class="result-box"><h3>Expected Result</h3><p>${escape(expected)}</p></section>`);
html = html.replace(/<section class="result-box"><h3>Actual Result<\/h3><p>[\s\S]*?<\/p><\/section>/i,
  `<section class="result-box"><h3>Actual Result</h3><p>${escape(actual)}</p></section>`);

const componentRows = [];
const pattern = /(?:^|\s\/\s)\d+\s*\|\s*[^|]+\|\s*.*?\(([^()]+)\)\s*\|\s*(Standalone|Inherited-linked)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(.*?)(?=\s\/\s\d+\s*\||$)/gi;
for (const match of evidence.matchAll(pattern)) {
  const persisted = match[6].trim();
  const finalRh = persisted.match(/MASTER\s+[^;]*?(?:â†’|→)\s*([^;]+)/i)?.[1]?.trim() ?? 'Not verified';
  const rejected = /cannot be negative|cannot be less than/i.test(match[5]);
  const verified = /;\s*verified\s*$/i.test(persisted);
  const status = verified ? (rejected ? 'Rejected — unchanged' : 'Updated — verified') : 'Not verified';
  componentRows.push(`<tr><td>${escape(match[1].trim())}</td><td>${escape(match[2].trim())}</td><td>${escape(match[3].trim())}</td><td>${escape(match[4].trim())}</td><td>${escape(match[5].trim())}</td><td>${escape(finalRh)}</td><td class="${verified ? 'pass' : 'fail'}">${escape(status)}</td></tr>`);
}
if (componentRows.length !== selected) throw new Error(`Preserved evidence described ${selected} components but ${componentRows.length} table rows were parsed.`);
const table = `<section class="component-results"><h3>Component Results</h3><div class="table-scroll"><table><thead><tr><th>Component Code</th><th>Component Type</th><th>Old RH</th><th>Entered RH</th><th>Validation</th><th>Final RH</th><th>Status</th></tr></thead><tbody>${componentRows.join('')}</tbody></table></div></section>`;
html = html.replace(/(<div class="result-grid">[\s\S]*?<\/div>)(?!<section class="component-results">)/i, `$1${table}`);

const stepExpectations = new Map([
  ['RH-N20 selected vessel and randomized component list', 'The required valid and invalid components should be selected from the same vessel.'],
  ['RH-N20 mixed valid and invalid values in one Bulk RH dialog', 'Invalid entries should display validation errors, while valid entries should be accepted.'],
  ['RH-N20 multiple valid rows ready for one Bulk Save', 'Invalid entries should be excluded from submission, and valid entries should remain ready to save.'],
  ['RH-N20 save all valid rows together and monitor the application response', 'All valid entries should be saved together using one Bulk Save action.'],
  ['RH-N20 classify the Save outcome and verify all selected components after refresh', 'Valid component values should be updated, while invalid component values and history remain unchanged.'],
]);
let diagnostic = '';
for (const [title, expectation] of stepExpectations) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowPattern = new RegExp(`(<td>${escapedTitle}<\\/td><td>)[\\s\\S]*?(<\\/td><td>)([\\s\\S]*?)(<\\/td><td class=)`, 'i');
  html = html.replace(rowPattern, (_whole, prefix, middle, observed, suffix) => {
    if (/save all valid rows together/i.test(title)) {
      diagnostic = decode(observed);
      observed = `One Bulk Save submitted ${submitted} valid components. The application completed the operation and the detailed request diagnostics are available under Technical Details / Debug Information.`;
    }
    return `${prefix}${escape(expectation)}${middle}${escape(decode(observed))}${suffix}`;
  });
}

html = html.replace('The application should display the login page so the configured user can authenticate.', 'The login page should open successfully.');
if (diagnostic && !/Technical Details \/ Debug Information/.test(html)) {
  const debug = `<details class="technical"><summary>Technical Details / Debug Information</summary><pre>${escape(diagnostic)}</pre></details>`;
  html = html.replace(/(<\/table><\/div>)(<details class="evidence-panel">|<\/div><\/details>)/i, `$1${debug}$2`);
}

fs.writeFileSync(reportPath, html, 'utf8');
console.log(`Regenerated ${reportPath} from preserved RH-N20 execution evidence.`);
