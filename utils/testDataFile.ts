import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

/**
 * Finds one test-data file under a project-root-relative folder.
 * Files are sorted by name so adding more than one file keeps selection deterministic.
 */
export function getFirstFileFromFolder(folderPath: string): string {
  const absoluteFolder = path.resolve(projectRoot, folderPath);
  if (
    !fs.existsSync(absoluteFolder) ||
    !fs.statSync(absoluteFolder).isDirectory()
  ) {
    throw new Error(`Test-data folder does not exist: ${absoluteFolder}`);
  }

  const fileNames = fs
    .readdirSync(absoluteFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));
  if (!fileNames.length) {
    throw new Error(
      `No regular test-data files were found in: ${absoluteFolder}`,
    );
  }

  return path.join(absoluteFolder, fileNames[0]);
}

export type BulkImportDataModule = "Components" | "Job" | "Spares" | "Stores";

/** Resolves every configured file without deciding whether the application should accept it. */
export function listBulkImportFilesInFolder(folderPath: string): string[] {
  const absoluteFolder = path.resolve(projectRoot, folderPath);
  if (
    !fs.existsSync(absoluteFolder) ||
    !fs.statSync(absoluteFolder).isDirectory()
  ) {
    throw new Error(
      `Bulk-import test-data folder does not exist: ${absoluteFolder}`,
    );
  }
  const files = fs
    .readdirSync(absoluteFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("~$"))
    .map((entry) => path.join(absoluteFolder, entry.name))
    .sort((first, second) => first.localeCompare(second));
  if (!files.length)
    throw new Error(
      `No bulk-import input files were found in ${absoluteFolder}.`,
    );
  return files;
}

export function listBulkImportFiles(module: BulkImportDataModule): string[] {
  return listBulkImportFilesInFolder(
    path.join("test-data", "bulk-import", module),
  );
}

export function resolveSingleExcelFile(
  folderPath: string,
  purpose: string,
): string {
  const absoluteFolder = path.resolve(projectRoot, folderPath);
  if (
    !fs.existsSync(absoluteFolder) ||
    !fs.statSync(absoluteFolder).isDirectory()
  ) {
    throw new Error(`${purpose} folder does not exist: ${absoluteFolder}`);
  }

  const fileNames = fs
    .readdirSync(absoluteFolder, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith("~$") &&
        /\.(xlsx|xls)$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((first, second) => first.localeCompare(second));

  if (fileNames.length === 0) {
    throw new Error(
      `No Excel workbook (.xlsx or .xls) was found for ${purpose} in: ${absoluteFolder}`,
    );
  }
  if (fileNames.length > 1) {
    throw new Error(
      `Multiple Excel workbooks were found for ${purpose} in ${absoluteFolder}. Keep exactly one workbook. Found: ${fileNames.join(", ")}`,
    );
  }

  return path.join(absoluteFolder, fileNames[0]);
}
