import * as XLSX from "xlsx";
import {
  normalizeExpectedText,
  normalizeRunningHours,
} from "./componentsExpectedData";
import { getFirstFileFromFolder } from "./testDataFile";

export type ExpectedJobRecord = Record<string, unknown>;

/** Resolves the configured Job validation input without predicting application acceptance. */
export function getJobsValidationWorkbook(): string {
  return getFirstFileFromFolder("test-data/job-validation");
}

export function loadExpectedJobs(workbookPath: string): ExpectedJobRecord[] {
  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const sheetName = workbook.SheetNames.includes("Vessel_Job")
    ? "Vessel_Job"
    : workbook.SheetNames[0];
  const worksheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!worksheet)
    throw new Error(
      `No readable worksheet was found in Job validation workbook: ${workbookPath}`,
    );

  const records = XLSX.utils.sheet_to_json<ExpectedJobRecord>(worksheet, {
    defval: "",
    raw: false,
  });
  const relevant = records.filter(
    (record) =>
      normalizeExpectedText(record["Component Code"]) &&
      normalizeExpectedText(record["Job Code"]),
  );
  if (!relevant.length) {
    throw new Error(
      `No relevant Job rows with both Component Code and Job Code were found in: ${workbookPath}`,
    );
  }
  return relevant;
}

export function normalizeJobText(value: unknown): string {
  return normalizeExpectedText(value).toLowerCase();
}

export function normalizeJobDate(value: unknown): string {
  const text = normalizeExpectedText(value);
  if (!text) return "";
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 0) {
    const parsed = XLSX.SSF.parse_date_code(serial);
    if (parsed)
      return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return text.toLowerCase();
}

export function normalizeJobHour(value: unknown): string {
  return normalizeRunningHours(value) ?? "";
}

export function normalizeJobFrequency(value: unknown, unit?: unknown): string {
  const rawValue = normalizeExpectedText(value);
  const rawUnit = normalizeExpectedText(unit);
  const combined =
    rawUnit && !/[a-z]/i.test(rawValue) ? `${rawValue} ${rawUnit}` : rawValue;
  const match = combined.match(
    /^([\d.]+)\s*(years?|yrs?|months?|mos?|weeks?|wks?|days?|hours?|hrs?|rh)$/i,
  );
  if (!match) return normalizeJobText(combined).replace(/\s+/g, " ");
  const amount = Number(match[1]);
  const normalizedUnit = match[2].toLowerCase();
  if (/^y/.test(normalizedUnit)) {
    const months = amount * 12;
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  if (/^(?:h|rh)/.test(normalizedUnit))
    return `${amount} hour${amount === 1 ? "" : "s"}`;
  if (/^(?:w)/.test(normalizedUnit))
    return `${amount} week${amount === 1 ? "" : "s"}`;
  if (/^d/.test(normalizedUnit))
    return `${amount} day${amount === 1 ? "" : "s"}`;
  return `${amount} month${amount === 1 ? "" : "s"}`;
}
