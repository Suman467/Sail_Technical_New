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

const robNumber = (value: string): number | undefined => {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

/** Reads Location A and Location B ROB from the Stores grid Location cell, shown as "@ A / B". */
export function parseStoreLocationRob(locationCell: unknown): { locationA: string; locationB: string } {
  const match = String(locationCell ?? '').match(/@\s*([^/]*?)\s*\/\s*(.*?)\s*$/);
  return { locationA: normalizeStoreRob(match?.[1]), locationB: normalizeStoreRob(match?.[2]) };
}

/**
 * Stores ROB rule: UI Total ROB must equal UI Location A ROB + Location B ROB.
 * The uploaded Excel Total ROB is reported for information only; a blank Excel total is equivalent to zero.
 */
export function compareStoreRob(excelTotalValue: unknown, uiTotalValue: unknown, uiLocationCell: unknown): StoreRobComparison {
  const excelTotal = normalizeStoreRob(excelTotalValue);
  const uiTotal = normalizeStoreRob(uiTotalValue);
  const { locationA, locationB } = parseStoreLocationRob(uiLocationCell);
  const a = robNumber(locationA);
  const b = robNumber(locationB);
  const total = robNumber(uiTotal);
  const excelLabel = excelTotal || '<blank>';
  const observed = `Location A ROB ${locationA || '<blank>'}, Location B ROB ${locationB || '<blank>'}, UI Total ROB ${uiTotal || '<blank>'}, Excel Total ROB ${excelLabel}`;

  if (a === undefined || b === undefined || total === undefined) {
    const invalid = [['Location A ROB', a], ['Location B ROB', b], ['UI Total ROB', total]]
      .filter(([, value]) => value === undefined).map(([label]) => label);
    return {
      expected: 'Location A ROB, Location B ROB and UI Total ROB should be numeric so Total ROB can be calculated',
      actual: `${observed} (UI Location cell: "${String(uiLocationCell ?? '').trim() || '<blank>'}")`,
      matches: false,
      reason: `Validation issue: the ROB calculation could not be verified because ${invalid.join(', ')} ${invalid.length === 1 ? 'is' : 'are'} missing or not numeric in the UI.`,
    };
  }

  const calculated = Number((a + b).toFixed(6));
  const expected = `${calculated} (Location A ROB ${a} + Location B ROB ${b})`;
  if (Math.abs(total - calculated) > 1e-6) {
    return {
      expected,
      actual: uiTotal,
      matches: false,
      reason: `UI Total ROB is incorrect. Expected calculated total ${calculated} (Location A ROB ${a} + Location B ROB ${b}), but the UI shows Total ROB ${total}. Excel Total ROB: ${excelLabel}.`,
    };
  }

  const excelNumber = excelTotal === '' ? 0 : robNumber(excelTotal);
  if (excelNumber === undefined || Math.abs(excelNumber - calculated) > 1e-6) {
    const note = 'UI Total ROB is correct. Total ROB in the uploaded Excel file is incorrect.';
    return {
      expected,
      actual: `${uiTotal} — ${note} (Excel Total ROB: ${excelLabel})`,
      matches: true,
      reason: `${note} Location A ROB ${a} + Location B ROB ${b} = ${calculated}; UI Total ROB ${total}; Excel Total ROB ${excelLabel}.`,
    };
  }
  return {
    expected,
    actual: uiTotal,
    matches: true,
    reason: `UI Total ROB equals Location A ROB + Location B ROB (${a} + ${b} = ${calculated}). Excel Total ROB ${excelTotal === '' ? '<blank>, treated as 0,' : excelTotal} also agrees.`,
  };
}
