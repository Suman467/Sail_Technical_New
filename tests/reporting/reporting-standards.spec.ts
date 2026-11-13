import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { generateStandardAuditReport } from '../../utils/standardAuditReport';
import { runningHoursReportIdentity } from '../../utils/SimpleReporter';
import { businessFailureActual, classifyCaseOutcome, evaluateEvidenceCompliance, failureStage, unfinishedStepActual } from '../../utils/reportingStandards';

test.describe('Shared reporting standards', () => {
  test('uses the consolidated Running Hours filename for RH-P03 and RH-P04', () => {
    const identity = runningHoursReportIdentity([
      'RH-P03 - Set Total',
      'RH-P04 - Add Delta',
    ], new Date(2026, 10, 5, 14, 7, 9));

    expect(identity).toEqual({
      title: 'PMS Running Hours – Set Total, Add Delta & Inherited Hours Validation',
      fileStem: 'PMS_Running_Hours_Test_Execution_Report',
    });
  });

  test('adapts the Running Hours report identity to the scenarios actually supplied', () => {
    const identity = runningHoursReportIdentity([
      'RH-P02 - Running Hours values match Components Section C across vessels and components',
    ], new Date(2026, 10, 5, 14, 7, 9));

    expect(identity.title).toBe('PMS Running Hours – Cross-Module Numeric Running Hours Validation');
    expect(identity.fileStem).toBe('PMS_Running_Hours_Test_Execution_Report');
  });

  test('classifies PASS, FAIL, SKIPPED, and NOT EXECUTED separately', () => {
    expect(classifyCaseOutcome('passed', 'passed', false)).toBe('passed');
    expect(classifyCaseOutcome('failed', 'passed', false)).toBe('failed');
    expect(classifyCaseOutcome('skipped', 'skipped', true)).toBe('skipped');
    expect(classifyCaseOutcome('skipped', 'passed', false)).toBe('not-executed');
  });

  test('labels representative failure stages in business language', () => {
    expect(failureStage('Initial setup - Select Vessel A', 'suite-setup')).toBe('common setup or navigation');
    expect(failureStage('Enter Criticality Yes', 'test')).toBe('data entry or field interaction');
    expect(failureStage('Click Save for Component C1', 'test')).toBe('Save operation');
    expect(failureStage('Refresh and verify saved Department', 'test')).toBe('refresh or persistence verification');
  });

  test('adds attempted action and expected outcome without technical diagnostics', () => {
    const actual = businessFailureActual(
      'Change Criticality from No to Yes',
      'Criticality should display Yes before Save.',
      'The application continued to display No.',
    );
    expect(actual).toContain('The automation attempted to change Criticality from No to Yes');
    expect(actual).toContain('continued to display No');
    expect(actual).toContain('Criticality should display Yes before Save');
    expect(actual).not.toMatch(/locator|expect\(|Call log|\.ts:/i);
  });

  test('reports a timed-out unfinished step as failed with no observed result', () => {
    const actual = unfinishedStepActual(60_000);
    expect(actual).toContain('still running');
    expect(actual).toContain('60 seconds');
    expect(actual).toContain('no result was observed');
    expect(actual).not.toContain('PASS');
  });

  test('identifies every mandatory evidence gap without changing the underlying case outcome', () => {
    const issues = evaluateEvidenceCompliance({
      outcome: 'passed', hasDeclaredExpected: false, stepCount: 1,
      stepsMissingExpected: ['Save record'], stepsMissingActual: ['Save record'],
      stepsMissingScreenshot: ['Save record'], requiresComparison: true,
      comparisonCount: 0, hasFinalVerification: false,
    });
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('no declared business Expected Result'),
      expect.stringContaining('Expected Results are missing'),
      expect.stringContaining('Observed Actual Results are missing'),
      expect.stringContaining('Step screenshots are missing'),
      expect.stringContaining('no initial/input/final comparison evidence'),
      expect.stringContaining('no recorded final business verification'),
    ]));
  });

  test('accepts complete evidence and requires an exact reason for skipped cases', () => {
    expect(evaluateEvidenceCompliance({
      outcome: 'passed', hasDeclaredExpected: true, stepCount: 2,
      stepsMissingExpected: [], stepsMissingActual: [], stepsMissingScreenshot: [],
      requiresComparison: true, comparisonCount: 1, hasFinalVerification: true,
    })).toEqual([]);
    expect(evaluateEvidenceCompliance({
      outcome: 'skipped', hasDeclaredExpected: true, stepCount: 0,
      stepsMissingExpected: [], stepsMissingActual: [], stepsMissingScreenshot: [],
      requiresComparison: false, comparisonCount: 0, hasFinalVerification: false,
    })).toEqual(['The skipped or blocked case has no recorded reason.']);
  });

  test('renders consistent audit totals, filters, findings, and technical details', async ({ page }) => {
    const fileName = 'shared-report-ui-sample.html';
    const reportPath = path.resolve('reports', 'audit', 'general', fileName);
    generateStandardAuditReport({
        dataType: 'Reporting', fileName, vessel: '', excelFile: '', uploadedBy: 'Unit test',
        validationType: 'Focused', successfullyImported: 0, recordsChecked: 0, recordsMatched: 0,
        missingRecords: [], fieldMismatches: [], identifierColumns: [],
        scenarioExecution: {
          module: 'Reporting', specName: 'reporting-standards-unit', users: ['Unit test'], vessels: [],
          executionDate: new Date('2026-10-21T00:00:00Z'), total: 4, passed: 1, failed: 1,
          skipped: 1, notExecuted: 1, overallStatus: 'FAILED', commonSetup: [{
            step: '1. Open test workspace', expected: 'The workspace should open.',
            actual: 'The workspace opened.', status: 'PASS',
          }],
          testCases: [
            { id: 'RPT-001', name: 'Passed responsive example', status: 'PASSED', durationMs: 3250, expected: 'A value should persist without compressing the report layout.', actual: 'The value persisted and the scenario completed.', findings: [{ step: 'Save the configured value', expected: 'The application should save it.', actual: 'The application saved it.', status: 'PASS' }] },
            { id: 'RPT-002', name: 'Failed example with evidence', status: 'FAILED', durationMs: 74250, expected: 'Save should succeed.', actual: 'Save returned a conflict.', technical: 'Synthetic diagnostic kept outside business results.', evidence: [{ name: 'Failure evidence', contentType: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="100%" height="100%" fill="#fee4e2"/><text x="30" y="120" font-size="28">Representative failure evidence</text></svg>').toString('base64') }], findings: [{ step: 'Submit the record', expected: 'The application should save the record.', actual: 'The application displayed a conflict.', status: 'FAIL' }] },
            { id: 'RPT-003', name: 'Skipped example', status: 'SKIPPED', durationMs: 0, expected: 'The intentional scenario should be identified.', actual: 'The scenario was intentionally skipped.', findings: [] },
            { id: 'RPT-004', name: 'Not executed example', status: 'NOT EXECUTED', durationMs: 0, expected: 'The scenario should run after setup.', actual: 'Setup failed before the scenario began.', findings: [{ step: 'Verify the saved record', expected: 'The record should be visible.', actual: 'The validation was not reached.', status: 'NOT EXECUTED' }] },
          ],
        },
    });
    const html = fs.readFileSync(reportPath, 'utf8');
    expect(html).toContain('Not Executed: 1');
    expect(html).toContain("show('not-executed',this)");
    expect(html).toContain('data-status="not-executed"');
    expect(html).toContain('Common Setup / Initial Navigation');
    expect(html).toContain('class="test-case"');
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('Technical Details');
    expect(html).toContain('Screenshots and Evidence');
    expect(html).toContain('1 min 14 s');
    expect(html).toContain('Expand All');
    expect(html).toContain('Collapse All');
    expect(html).toContain('Failed (1)');
    expect(html).toContain('No test cases match this filter.');
    expect(html).not.toContain('data-status="passed" open');
    expect(html).not.toContain('<table><thead><tr><th>No.</th><th>Test Case ID</th>');
    expect(html).toContain('Synthetic diagnostic kept outside business results.');
    await page.setViewportSize({ width: 520, height: 900 });
    await page.goto(`file:///${reportPath.replace(/\\/g, '/')}`);
    await expect(page.locator('.test-case[open]')).toHaveCount(0);
    expect(await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator('.table-scroll').first().evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Failed (1)', exact: true }).click();
    await expect(page.locator('.test-case:not([hidden])')).toHaveCount(1);
    await expect(page.locator('.test-case:not([hidden])')).toContainText('RPT-002');
    await page.getByRole('button', { name: 'Expand All', exact: true }).click();
    await expect(page.locator('.test-case:not([hidden])[open]')).toHaveCount(1);
  });
});
