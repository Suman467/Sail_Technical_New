import * as XLSX from 'xlsx';
import { normalizeExpectedText, normalizeRunningHours } from './componentsExpectedData';
import { resolveSingleExcelFile } from './testDataFile';

export type ExpectedSpareRecord = Record<string, unknown>;

export function getSparesValidationWorkbook(): string {
  return resolveSingleExcelFile('test-data/spare-validation', 'Spares post-import validation');
}

export function loadExpectedSpares(workbookPath: string): ExpectedSpareRecord[] {
  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const sheetName = workbook.SheetNames.includes('Spares') ? 'Spares' : workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) throw new Error(`No readable worksheet was found in Spares validation workbook: ${workbookPath}`);
  const records = XLSX.utils.sheet_to_json<ExpectedSpareRecord>(sheet, { defval: '', raw: false });
  const relevant = records.filter((record) => normalizeExpectedText(record['Part Code']) && normalizeExpectedText(record['Component Code']));
  if (!relevant.length) throw new Error(`No Spares rows with both Part Code and Component Code were found in: ${workbookPath}`);
  return relevant;
}

export function normalizeSpareText(value: unknown): string {
  return normalizeExpectedText(value).toLowerCase();
}

export function normalizeSpareRob(value: unknown): string {
  return normalizeRunningHours(value) ?? '';
}

function normalizeSpareComponentName(value: unknown): string {
  return normalizeSpareText(value)
    .replace(/[/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function componentNamesMatch(expected: unknown, actual: unknown): boolean {
  const expectedName = normalizeSpareComponentName(expected);
  const actualName = normalizeSpareComponentName(actual);
  if (expectedName === actualName) return true;
  if (!expectedName || !actualName) return false;
  const shorter = expectedName.length < actualName.length ? expectedName : actualName;
  const longer = expectedName.length < actualName.length ? actualName : expectedName;
  return shorter.length >= 5 && longer.startsWith(shorter) && /[\s/(),-]/.test(longer.charAt(shorter.length));
}
