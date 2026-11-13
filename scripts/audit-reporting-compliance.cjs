const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const testsRoot = path.join(root, 'tests');
const strict = process.argv.includes('--strict');

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(target) : entry.name.endsWith('.spec.ts') ? [target] : [];
  });
}

const rows = filesIn(testsRoot)
  .filter((file) => !file.includes(`${path.sep}reporting${path.sep}`))
  .map((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file).replaceAll('\\', '/');
    const wrapper = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?import\s+['"].+\.spec['"];?\s*$/m.test(source)
      && !/\btest\s*\(/.test(source);
    const pureCalculation = /@reporting-non-ui\b/.test(source);
    if (wrapper || pureCalculation) return { relative, issues: [], exemption: wrapper ? 'wrapper entry point' : 'pure calculation test' };
    const mutation = /\b(?:save|update|edit|create|delete|import|upload|bulk|cancel|set total|add delta)\b/i.test(source);
    const sharedApi = /executionEvidence|componentValidationEvidence/.test(source);
    const scenario = /\b(?:executionScenario|componentScenario)\s*\(/.test(source);
    const observedSteps = /\b(?:executionActionStep|componentActionStep|executionValidationStep|componentValidationStep|executionObservedCheck|componentObservedCheck)\s*\(/.test(source);
    const comparison = /attachRunningHoursComparison|validation comparison data|Comparison Data/i.test(source);
    const issues = [];
    if (!sharedApi) issues.push('shared evidence API not imported');
    if (!scenario) issues.push('scenario Expected Result not declared through the shared API');
    if (!observedSteps) issues.push('no shared observed business steps/screenshots');
    if (mutation && !comparison) issues.push('no initial/input/final comparison attachment');
    return { relative, issues };
  });

const incomplete = rows.filter((row) => row.issues.length);
const exemptions = rows.filter((row) => row.exemption);
console.log(`Reporting compliance audit: ${rows.length - incomplete.length}/${rows.length} spec files satisfy the static shared-evidence checks or a documented non-UI/wrapper exemption.`);
if (exemptions.length) console.log(`Documented exemptions: ${exemptions.map((row) => `${row.relative} (${row.exemption})`).join(', ')}`);
for (const row of incomplete) console.log(`- ${row.relative}: ${row.issues.join('; ')}`);
if (strict && incomplete.length) process.exitCode = 1;
