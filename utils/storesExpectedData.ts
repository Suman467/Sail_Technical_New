import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { StoreType } from '../pages/StoresPage';

export type ExpectedStoreRecord = Record<string, unknown>;
export type StoreWorkbook = { filePath: string; storeType: StoreType; records: ExpectedStoreRecord[] };

const typeFromFileName = (fileName: string): StoreType => {
  const normalized = fileName.toLowerCase();
  if (normalized.includes('chemical')) return 'Chemicals';
  if (normalized.includes('lube')) return 'Lubes';
  if (normalized.includes('other')) return 'Others';
  if (normalized.includes('store')) return 'Stores';
  throw new Error(`Cannot determine Store Type from workbook name: ${fileName}`);
};

export function getStoresValidationWorkbooks(): StoreWorkbook[] {
  const folder = path.resolve(process.cwd(), 'test-data', 'stores-validation');
  if (!fs.existsSync(folder)) throw new Error(`Stores validation folder does not exist: ${folder}`);
  const files = fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('~$') && /\.(xlsx|xls)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error(`No Stores validation Excel workbooks were found in: ${folder}`);
  const seen = new Set<StoreType>();
  return files.map((fileName) => {
    const storeType = typeFromFileName(fileName);
    if (seen.has(storeType)) throw new Error(`Multiple Stores validation workbooks resolve to Store Type ${storeType}. Keep one workbook per Store Type.`);
    seen.add(storeType);
    const filePath = path.join(folder, fileName);
    const workbook = XLSX.readFile(filePath, { cellDates: false });
    const sheet = workbook.Sheets.Vessel_Store;
    if (!sheet) throw new Error(`${fileName} does not contain the required Vessel_Store sheet.`);
    const records = XLSX.utils.sheet_to_json<ExpectedStoreRecord>(sheet, { defval: '', raw: false });
    if (!records.length) throw new Error(`${fileName} does not contain Store records.`);
    return { filePath, storeType, records };
  });
}

export const normalizeStoreText = (value: unknown): string => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
export const normalizeStoreRob = (value: unknown): string => {
  const text = normalizeStoreText(value).replace(/,/g, '');
  if (!text) return '';
  const numeric = Number(text);
  return Number.isFinite(numeric) ? String(numeric) : text;
};

export type StoreRobComparison = {
  expected: string;
  actual: string;
  matches: boolean;
  reason?: string;
};

/** Applies the Stores-only ROB rule that blank Excel and UI numeric zero are equivalent. */
export function compareStoreRob(expectedValue: unknown, actualValue: unknown): StoreRobComparison {
  const expected = normalizeStoreRob(expectedValue);
  const actual = normalizeStoreRob(actualValue);
  if (expected === '' && actual === '0') {
    return {
      expected,
      actual,
      matches: true,
      reason: 'Blank Excel value and UI zero are treated as equivalent.',
    };
  }
  return {
    expected,
    actual,
    matches: expected === actual,
  };
}
