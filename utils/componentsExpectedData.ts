import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';

export type ExpectedComponentRecord =
  Record<string, unknown>;

export interface ExpectedComponentData {
  sourceWorkbook: string;
  sheet: string;
  rowCount: number;
  records: ExpectedComponentRecord[];
}

type ComponentsImportResult = {
  workbookName: string;
  workbookSha256: string;
  vesselName: string;
  rejectedWorkbookRows: number[];
  acceptedRecordCount: number;
};

const COMPONENTS_DATA_FOLDER = path.join(
  'test-data',
  'components-validation',
);

const IMPORT_RESULT_FILE = 'components-import-result.json';

export function getComponentsWorkbook(): string {
  const folder = path.resolve(process.cwd(), COMPONENTS_DATA_FOLDER);

  if (!fs.existsSync(folder)) {
    throw new Error(`Components input folder was not found: ${folder}`);
  }

  const files = fs.readdirSync(folder)
    .filter((file) => /\.(xlsx|xls)$/i.test(file))
    .sort();

  if (files.length !== 1) {
    throw new Error(
      files.length === 0
        ? `No Excel workbook was found in: ${folder}`
        : `Multiple Excel workbooks were found in ${folder}. Please keep only one workbook for the Components validation run. Found: ${files.join(', ')}`,
    );
  }

  return path.join(folder, files[0]);
}

function workbookHash(workbookPath: string): string {
  return createHash('sha256').update(fs.readFileSync(workbookPath)).digest('hex');
}

function importResultPath(workbookPath: string): string {
  return path.join(path.dirname(workbookPath), IMPORT_RESULT_FILE);
}

export function saveComponentsImportResult(
  workbookPath: string,
  vesselName: string,
  rejectedWorkbookRows: number[],
  acceptedRecordCount: number,
): void {
  const result: ComponentsImportResult = {
    workbookName: path.basename(workbookPath),
    workbookSha256: workbookHash(workbookPath),
    vesselName,
    rejectedWorkbookRows: [...new Set(rejectedWorkbookRows)].sort((a, b) => a - b),
    acceptedRecordCount,
  };

  fs.writeFileSync(importResultPath(workbookPath), JSON.stringify(result, null, 2), 'utf8');
}

export function loadImportedExpectedComponentData(
  workbookPath: string,
  vesselName: string,
): ExpectedComponentData {
  const resultFile = importResultPath(workbookPath);
  if (!fs.existsSync(resultFile)) {
    throw new Error(
      `No persisted Components import result was found at ${resultFile}. Run the Components bulk-upload scenario once before independent verification.`,
    );
  }

  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as ComponentsImportResult;
  if (
    result.workbookName !== path.basename(workbookPath) ||
    result.workbookSha256 !== workbookHash(workbookPath) ||
    result.vesselName !== vesselName
  ) {
    throw new Error(
      'The persisted Components import result does not match the current workbook and configured vessel. Run the Components bulk-upload scenario before independent verification.',
    );
  }

  const workbookData = loadExpectedComponentData(workbookPath);
  const rejectedRows = new Set(result.rejectedWorkbookRows);
  const records = workbookData.records.filter((_, index) => !rejectedRows.has(index + 2));

  if (records.length !== result.acceptedRecordCount) {
    throw new Error(
      `Persisted accepted record count (${result.acceptedRecordCount}) does not match the reconstructed count (${records.length}).`,
    );
  }

  return { ...workbookData, rowCount: records.length, records };
}

/**
 * Converts Excel values into a consistent string representation
 * for comparisons between Excel and the application UI.
 */
export function normalizeExpectedText(
  value: unknown,
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes Running Hours values so Excel numbers,
 * UI numbers and blank values can be compared consistently.
 */
export function normalizeRunningHours(
  value: unknown,
): string | null {
  const normalized =
    normalizeExpectedText(value);

  if (!normalized) {
    return null;
  }

  const numericValue =
    Number(normalized.replace(/,/g, ''));

  if (
    Number.isFinite(numericValue)
  ) {
    return String(numericValue);
  }

  return normalized;
}

/**
 * Loads the expected component data from the SAME
 * workbook that is uploaded to the application.
 *
 * There is deliberately no fixed filename and no
 * fixed row count in this function.
 */
export function loadExpectedComponentData(
  workbookPath: string,
): ExpectedComponentData {
  if (!workbookPath) {
    throw new Error(
      'A Components workbook path is required.',
    );
  }

  if (!fs.existsSync(workbookPath)) {
    throw new Error(
      `Components workbook was not found: ${workbookPath}`,
    );
  }

  const workbook =
    XLSX.readFile(workbookPath, {
      cellDates: false,
    });

  const sheetName = 'Data';

  if (
    !workbook.SheetNames.includes(
      sheetName,
    )
  ) {
    throw new Error(
      `The workbook "${path.basename(workbookPath)}" does not contain a "${sheetName}" sheet. ` +
        `Available sheets: ${workbook.SheetNames.join(', ')}`,
    );
  }

  const worksheet =
    workbook.Sheets[sheetName];

  if (!worksheet) {
    throw new Error(
      `The "${sheetName}" worksheet could not be read from "${path.basename(workbookPath)}".`,
    );
  }

  /*
   * defval keeps empty cells represented consistently.
   *
   * raw: false makes Excel values available as
   * display-like strings, which is useful for
   * comparing codes/names with the UI.
   */
  const records =
    XLSX.utils.sheet_to_json<ExpectedComponentRecord>(
      worksheet,
      {
        defval: '',
        raw: false,
      },
    );

  /*
   * The row count comes directly from the current
   * workbook. Nothing is hard-coded.
   */
  const rowCount = records.length;

  if (rowCount === 0) {
    throw new Error(
      `The "${sheetName}" sheet in "${path.basename(workbookPath)}" does not contain any data rows.`,
    );
  }

  return {
    sourceWorkbook:
      path.basename(workbookPath),
    sheet: sheetName,
    rowCount,
    records,
  };
}
