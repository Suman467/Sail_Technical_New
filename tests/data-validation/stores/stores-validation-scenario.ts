import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../../../fixtures/baseFixture';
import type { AuditDashboardPage } from '../../../pages/AuditDashboardPage';
import type { StoreType } from '../../../pages/StoresPage';
import { TechnicalPage } from '../../../pages/TechnicalPage';
import { config } from '../../../utils/config';
import { generateStandardAuditReport } from '../../../utils/standardAuditReport';
import { compareStoreRob, normalizeStoreText, type StoreWorkbook } from '../../../utils/storesExpectedData';
import { runBulkDataImportScenario } from '../../bulk-import/bulkDataImportScenario';

type StoreIssue = { itemCode: string; itemName: string; storeType: StoreType; issue: string };
type StoreMismatch = { itemCode: string; field: string; expected: string; actual: string; reason: string };
export type StoreValidationResult = { successfullyImported: number; totalChecked: number; matched: number; missing: StoreIssue[]; mismatches: StoreMismatch[]; sourceWorkbook: string };

export async function runStoresValidation(options: {
  page: Page;
  auditDashboardPage: AuditDashboardPage;
  workbook: StoreWorkbook;
  limit?: number;
}): Promise<StoreValidationResult> {
  test.setTimeout(0);
  const { page, auditDashboardPage, workbook, limit } = options;
  const importResult = await runBulkDataImportScenario(page, auditDashboardPage, {
    module: 'stores', mode: 'addAndUpdate', storeType: workbook.storeType,
    expectedResult: { outcome: 'import', rowErrors: 'skip-and-import' },
  }, workbook.filePath);
  expect(importResult.imported, `${workbook.storeType} workbook should contain accepted records.`).toBe(true);
  const rejectedRows = new Set(importResult.rejectedWorkbookRows);
  const importedRecords = workbook.records.filter((_, index) => !rejectedRows.has(index + 2));
  const records = limit === undefined ? importedRecords : importedRecords.slice(0, limit);
  if (!records.length) throw new Error(`Application validation did not accept any ${workbook.storeType} records.`);

  const storesPage = await new TechnicalPage(page).goToStores();
  await storesPage.expectToBeOnPage();
  await storesPage.selectVessel(config.vesselName);
  await storesPage.selectStoreType(workbook.storeType);

  const missing: StoreIssue[] = [];
  const mismatches: StoreMismatch[] = [];
  const reportComparisons: Array<{ recordCode: string; recordName: string; field: string; expected: string; actual: string; status: 'PASS' | 'MISMATCH' | 'MISSING'; reason?: string }> = [];
  for (const record of records) {
    const itemCode = String(record['Item Code']).trim();
    const itemName = String(record['Item Name']).trim();
    const actual = await storesPage.readRecord(itemCode);
    if (!actual) {
      missing.push({ itemCode, itemName, storeType: workbook.storeType, issue: `Record not found in ${workbook.storeType} tab` });
      reportComparisons.push({ recordCode: itemCode, recordName: itemName, field: 'Store record', expected: 'Record should exist in UI', actual: 'Record not found in UI', status: 'MISSING', reason: `The record was not found in the ${workbook.storeType} tab.` });
      await test.info().attach(`Failure Screenshot - Store ${itemCode} - record not found`, { body: await page.screenshot(), contentType: 'image/png' });
      continue;
    }
    const robComparison = compareStoreRob(record['Total ROB'], actual.rob);
    const comparisons: Array<{ field: string; expected: string; actual: string; matches?: boolean; reason?: string }> = [
      { field: identifierLabel(workbook.storeType), expected: normalizeStoreText(record['Item Code']), actual: normalizeStoreText(actual.itemCode) },
      { field: nameLabel(workbook.storeType), expected: normalizeStoreText(record['Item Name']), actual: normalizeStoreText(actual.itemName) },
      { field: categoryLabel(workbook.storeType), expected: normalizeStoreText(record.Category), actual: normalizeStoreText(actual.category) },
      { field: 'UOM', expected: normalizeStoreText(record.UOM), actual: normalizeStoreText(actual.uom) },
      { field: 'ROB', ...robComparison },
    ];
    for (const comparison of comparisons) {
      const { field, expected, actual: actualValue } = comparison;
      const matches = comparison.matches ?? expected === actualValue;
      const reason = comparison.reason ?? (matches ? undefined : 'Normalized values differ.');
      reportComparisons.push({ recordCode: itemCode, recordName: itemName, field, expected: expected || '<blank>', actual: actualValue || '<blank>', status: matches ? 'PASS' : 'MISMATCH', reason });
      if (!matches) {
        mismatches.push({ itemCode, field, expected: expected || '<blank>', actual: actualValue || '<blank>', reason: reason ?? 'Normalized values differ.' });
        await test.info().attach(`Failure Screenshot - Store ${itemCode} - ${field} mismatch`, { body: await page.screenshot(), contentType: 'image/png' });
      }
    }
  }

  const issueCodes = new Set([...missing.map((item) => item.itemCode), ...mismatches.map((item) => item.itemCode)]);
  const matched = records.length - issueCodes.size;
  const result: StoreValidationResult = {
    successfullyImported: importedRecords.length,
    totalChecked: records.length,
    matched,
    missing,
    mismatches,
    sourceWorkbook: path.basename(workbook.filePath),
  };
  await test.info().attach(`${workbook.storeType} post-import validation summary`, {
    body: [`Excel: ${result.sourceWorkbook}`, `Successfully imported: ${result.successfullyImported}`, `Checked: ${result.totalChecked}`, `Matched: ${result.matched}`, `Missing: ${result.missing.length}`, `Field mismatches: ${result.mismatches.length}`].join('\n'),
    contentType: 'text/plain',
  });
  await test.info().attach(`${workbook.storeType} post-import screenshot`, { body: await page.screenshot(), contentType: 'image/png' });
  await test.info().attach(`${workbook.storeType} validation comparison data`, { body: JSON.stringify(reportComparisons), contentType: 'application/json' });

  const partial = limit !== undefined;
  const reportPath = generateStandardAuditReport({
    dataType: 'Store',
    fileName: `store-${workbook.storeType.toLowerCase()}-${partial ? 'partial' : 'complete'}-audit.html`,
    vessel: config.vesselName,
    excelFile: result.sourceWorkbook,
    uploadedBy: config.username,
    validationType: partial ? `Partial - first ${limit} successfully imported records` : 'Complete',
    successfullyImported: result.successfullyImported,
    recordsChecked: result.totalChecked,
    recordsMatched: result.matched,
    identifierColumns: ['Item Code'],
    additionalMetadata: { 'Store Type': workbook.storeType },
    missingRecords: result.missing.map((item) => ({ identifiers: { 'Item Code': item.itemCode }, issue: item.issue })),
    fieldMismatches: result.mismatches.map((item) => ({ identifiers: { 'Item Code': item.itemCode }, field: item.field, expected: item.expected, actual: item.actual, reason: item.reason })),
  });
  await test.info().attach(`${workbook.storeType} audit report`, { path: reportPath, contentType: 'text/html' });

  await test.step(`Compare imported ${workbook.storeType} Excel records with the matching Stores UI tab`, async () => {
    expect(result.missing, `Every accepted ${workbook.storeType} record should exist in the matching UI tab.`).toEqual([]);
    expect(result.mismatches, `Every accepted ${workbook.storeType} record should match its Excel values.`).toEqual([]);
  });
  return result;
}

function identifierLabel(type: StoreType): string {
  return type === 'Lubes' ? 'Lube Grade' : type === 'Chemicals' ? 'Chem Code' : 'Item Code';
}
function nameLabel(type: StoreType): string {
  return type === 'Lubes' ? 'Lube Type' : type === 'Chemicals' ? 'Chemical Name' : 'Item Name';
}
function categoryLabel(type: StoreType): string {
  return type === 'Lubes' ? 'Application' : type === 'Chemicals' ? 'Application Area' : 'Stores Category';
}
