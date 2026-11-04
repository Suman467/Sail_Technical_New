import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type BrowserContext, type Download, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import type { ComponentFormPage } from '../../pages/ComponentFormPage';
import type { ComponentDetailField, ComponentsPage, ComponentTreeRow } from '../../pages/ComponentsPage';
import { readTrackedComponents } from '../../utils/componentCreationTracker';
import { attachFailureScreenshot, componentActionStep, componentNotExecutedStep, componentObservedCheck, componentScenario, componentValidationStep, ScenarioPlan, type PlannedStep } from '../../utils/componentValidationEvidence';
import { forgetComponentsViewState, openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';

type ExportRow = Record<string, string>;
/** One downloaded export and what the workbook contained. */
type ExportedWorkbook = {
  vessel: string;
  file: string;
  filename: string;
  feedback: string;
  /** The test machine's local date when Export was clicked and when the download finished. */
  localDates: string[];
  utcDate: string;
  sheetNames: string[];
  headers: string[];
  rows: ExportRow[];
  /** Component Code cells not stored as text, which could lose leading zeros. */
  nonTextCodes: string[];
};
type ExportAttempt = { downloads: Download[]; feedback: string; localDates: string[]; utcDate: string };
type Column = { column: string; field: ComponentDetailField };
type SavedDetails = { code: string; name: string; values: Record<string, string | undefined> };

const vessel = config.vesselName;
const emptyVessel = config.emptyVessel;
const worksheet = 'Vessel_Component';
const filenamePattern = /^components_export_(\d{4}-\d{2}-\d{2})\.xlsx$/;
const sectionA = 'A. Component Information';
const sectionB = 'B. Fleet Component Information';
/** The export columns the application writes, in order. */
const exportColumns = [
  'Fleet Equipment Code', 'Fleet Equipment Name', 'Parent Component Code', 'Component Code', 'Component Name', 'Component Category',
  'Maker', 'Maker Code', 'Model', 'Model Code', 'Serial No', 'Drawing No', 'Location', 'Criticality', 'Condition Based',
  'Installation Date', 'Commissioned Date', 'Rating', 'Equipment / System Department', 'Class item', 'IS Active', 'Vessel Code',
  'IS Parent', 'Notes', 'RH Counter Type', 'RH Counter Source', 'Running Hours', 'Last Updated',
];
const a = (label: string): ComponentDetailField => ({ section: sectionA, label });
const b = (label: string): ComponentDetailField => ({ section: sectionB, label });
/** Export columns the Component details panel also shows, with the label it uses. */
const comparedColumns: Column[] = [
  { column: 'Fleet Equipment Code', field: b('Fleet Equipment Code') },
  { column: 'Fleet Equipment Name', field: b('Fleet Component Name') },
  { column: 'Parent Component Code', field: a('Parent Component Code') },
  { column: 'Component Code', field: a('Component Code') },
  { column: 'Component Name', field: a('Component Name') },
  { column: 'Component Category', field: a('Component Category') },
  { column: 'Maker', field: a('Maker') },
  { column: 'Maker Code', field: b('Maker Code') },
  { column: 'Model', field: a('Model') },
  { column: 'Model Code', field: b('Model Code') },
  { column: 'Serial No', field: a('Serial No.') },
  { column: 'Drawing No', field: a('Drawing No') },
  { column: 'Location', field: a('Location') },
  { column: 'Criticality', field: a('Criticality') },
  { column: 'Condition Based', field: a('Condition Based') },
  { column: 'Installation Date', field: a('Installation Date') },
  { column: 'Commissioned Date', field: a('Commissioned Date') },
  { column: 'Rating', field: a('Rating') },
  { column: 'Equipment / System Department', field: a('Equipment / System Department') },
  { column: 'Class item', field: a('Class Item') },
  { column: 'IS Active', field: b('Is Active') },
  { column: 'IS Parent', field: b('Is Parent') },
  { column: 'Notes', field: a('Notes / Technical Information') },
];
const notCompared = 'Vessel Code (exported as an internal vessel identifier; the details panel shows the Vessel Name), the running-hours columns and Last Updated (shown in a separate section)';
const flagColumns = ['Criticality', 'Condition Based', 'Class item', 'IS Active', 'IS Parent'];
const flagColumnsCompared = comparedColumns.filter((item) => flagColumns.includes(item.column));
/** CMP-192 compares the descriptive fields; the Yes/No flags are validated by CMP-194. */
const detailColumnsCompared = comparedColumns.filter((item) => !flagColumns.includes(item.column));
// Replacement workers in one run share the run-scoped authentication file, so a workbook
// exported earlier in the run is reused instead of exporting again.
const workbookRecord = process.env.COMPONENTS_AUTH_STATE_PATH ? `${process.env.COMPONENTS_AUTH_STATE_PATH}.export.json` : undefined;
const runId = path.basename(process.env.COMPONENTS_AUTH_STATE_PATH ?? `worker-${process.ppid}`).replace(/[^a-z0-9]+/gi, '-');
const downloadFolder = path.resolve('.tmp', 'components-export', runId);

const step = (title: string, expected: string) => `${title}\nExpected: ${expected}\nActual: Recorded after the validation completes.`;
const list = (values: string[], none = 'none') => (values.length ? values.join(', ') : none);
const pad = (value: number) => String(value).padStart(2, '0');
const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A dash shown for an empty detail counts as empty. */
const blank = (value: string) => (/^[-—–]$/.test(value.trim()) ? '' : value);
/** Reads dd-mm-yyyy, dd-Mon-yyyy and ISO dates as yyyy-mm-dd; anything else is not a date. */
const asDate = (value: string) => {
  const numeric = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (numeric) return `${numeric[3]}-${numeric[2]}-${numeric[1]}`;
  const named = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (named && months.includes(named[2].toLowerCase())) return `${named[3]}-${pad(months.indexOf(named[2].toLowerCase()) + 1)}-${pad(Number(named[1]))}`;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
};
/** Yes/No flags may be written as TRUE/FALSE; an empty cell stays empty and never counts as No. */
const asFlag = (value: string) => (/^(yes|true|1)$/i.test(value) ? 'Yes' : /^(no|false|0)$/i.test(value) ? 'No' : value);
const comparable = (column: string, value: string) => {
  const text = oneLine(blank(value));
  if (flagColumns.includes(column)) return asFlag(text);
  return asDate(text) ?? text;
};

test.describe('CMP-191 to CMP-199 - Component export', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;
  let shared: ExportedWorkbook | undefined;

  const exportButton = () => page.getByRole('button', { name: 'Export', exact: true });
  const exportFeedback = () => page.locator('li, [role="status"], [role="alert"]').filter({ hasText: /Export Successful|Component Export Failed/ }).last();

  const refresh = async () => {
    const load = async () => {
      await forgetComponentsViewState(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await components.expectToBeOnPage();
      await components.clearComponentSearch();
      await components.selectVessel(vessel);
      await components.expectTreeLoaded();
    };
    await load().catch(load);
  };

  // ---------- Export and workbook reading ----------

  /** Clicks Export once and captures the application's feedback and any download it starts. */
  const clickExport = async (expectDownload: boolean): Promise<ExportAttempt> => {
    const downloads: Download[] = [];
    const collect = (download: Download) => downloads.push(download);
    page.on('download', collect);
    try {
      const localDates = [localDate()];
      const utcDate = new Date().toISOString().slice(0, 10);
      await exportButton().click();
      await expect(exportFeedback(), 'The application should report the export result').toBeVisible({ timeout: 30_000 });
      const feedback = oneLine(await exportFeedback().innerText());
      // A download starts together with the success message; a refused export is still given time to start one.
      await expect.poll(() => downloads.length, { timeout: expectDownload && /Export Successful/i.test(feedback) ? 30_000 : 5_000 })
        .toBeGreaterThan(0).catch(() => undefined);
      localDates.push(localDate());
      return { downloads, feedback, localDates: [...new Set(localDates)], utcDate };
    } finally {
      page.off('download', collect);
    }
  };

  const readWorkbook = (file: string) => {
    const book = XLSX.readFile(file);
    const sheet = book.Sheets[worksheet];
    const headers = sheet ? (XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false })[0] ?? []).map(String) : [];
    const rows = sheet
      ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false })
        .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value)])))
      : [];
    const codeColumn = headers.indexOf('Component Code');
    const nonTextCodes: string[] = [];
    if (sheet && codeColumn >= 0) {
      const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
      for (let row = 1; row <= range.e.r; row++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: codeColumn })] as XLSX.CellObject | undefined;
        if (cell && cell.t !== 's') nonTextCodes.push(String(cell.v));
      }
    }
    return { sheetNames: book.SheetNames, headers, rows, nonTextCodes };
  };

  /** Saves a downloaded export, attaches its summary as evidence and reads the workbook. */
  const saveExport = async (attempt: ExportAttempt, exportedVessel: string): Promise<ExportedWorkbook> => {
    const download = attempt.downloads[0];
    expect(await download.failure(), 'The export download should complete').toBeNull();
    const filename = download.suggestedFilename();
    await fs.mkdir(downloadFolder, { recursive: true });
    const file = path.join(downloadFolder, `${Date.now()}-${filename}`);
    await download.saveAs(file);
    const workbook: ExportedWorkbook = { vessel: exportedVessel, file, filename, feedback: attempt.feedback, localDates: attempt.localDates, utcDate: attempt.utcDate, ...readWorkbook(file) };
    await test.info().attach(`Download evidence - ${filename}`, {
      contentType: 'text/plain',
      body: [
        `Vessel: ${exportedVessel}`, `Downloaded file: ${filename}`, `Saved to: ${file}`, `Application message: ${attempt.feedback}`,
        `Worksheets: ${list(workbook.sheetNames)}`, `Rows in ${worksheet}: ${workbook.rows.length}`, `Columns: ${list(workbook.headers)}`,
        `First rows: ${workbook.rows.slice(0, 5).map((row) => `${row['Component Code']} ${row['Component Name']}`).join('; ')}`,
      ].join('\n'),
    });
    return workbook;
  };

  const exportedCount = (feedback: string) => Number(/Exported (\d+) components?/i.exec(feedback)?.[1] ?? Number.NaN);
  const rowFor = (workbook: ExportedWorkbook, code: string) => workbook.rows.find((row) => row['Component Code'] === code);
  const workbookIsValid = (workbook: ExportedWorkbook | undefined): workbook is ExportedWorkbook =>
    Boolean(workbook && workbook.vessel === vessel && workbook.sheetNames.includes(worksheet) && workbook.rows.length);

  const exportSteps = (label: string) => ({
    exported: { title: `Click Export for Vessel ${vessel}${label}`, expected: `The application should report a successful export and download an XLSX file for Vessel ${vessel}${label}.` },
    opened: { title: 'Open the downloaded workbook', expected: `The downloaded file should be a readable workbook containing worksheet ${worksheet}.` },
  });
  const exportedActual = (attempt: ExportAttempt) => (attempt.downloads.length
    ? `The application showed "${attempt.feedback}" and downloaded ${attempt.downloads[0].suggestedFilename()}.`
    : `The application showed "${attempt.feedback}" and no file was downloaded.`);
  const openedActual = (workbook: ExportedWorkbook) =>
    `${workbook.filename} opened as a workbook with worksheet(s) ${list(workbook.sheetNames)}; ${worksheet} holds ${workbook.rows.length} component row(s).`;

  /** Exports the current view and reads the downloaded workbook as two recorded steps. */
  const exportAndOpen = async (plan: ScenarioPlan, steps: ReturnType<typeof exportSteps>) => {
    plan.begin(steps.exported.title);
    const attempt = await componentActionStep(steps.exported.title, steps.exported.expected, async () => {
      const result = await clickExport(true);
      expect(result.downloads.length, `Observed Application Result: Export showed "${result.feedback}" and no file was downloaded.`).toBeGreaterThan(0);
      return result;
    }, exportedActual, { page });
    plan.begin(steps.opened.title);
    return componentActionStep(steps.opened.title, steps.opened.expected, () => saveExport(attempt, vessel), openedActual);
  };

  const recordShared = async (workbook: ExportedWorkbook) => {
    shared = workbook;
    if (workbookRecord) await fs.writeFile(workbookRecord, JSON.stringify(workbook), 'utf8');
  };
  const savedShared = async () => shared ?? (workbookRecord
    ? fs.readFile(workbookRecord, 'utf8').then((text) => JSON.parse(text) as ExportedWorkbook).catch(() => undefined)
    : undefined);

  /**
   * Returns the workbook CMP-191 exported in this run when it is still valid; otherwise this
   * scenario exports its own copy, recorded as its own steps.
   */
  const workbookStep = { title: `Use the ${worksheet} workbook exported for Vessel ${vessel}`, expected: `A readable export of Vessel ${vessel} should be available, reused from CMP-191 when valid.` };
  const sharedWorkbook = async (plan: ScenarioPlan): Promise<ExportedWorkbook> => {
    const saved = await savedShared();
    const exists = saved ? await fs.access(saved.file).then(() => true, () => false) : false;
    plan.begin(workbookStep.title);
    if (workbookIsValid(saved) && exists) {
      shared = saved;
      await componentObservedCheck(page, workbookStep.title, workbookStep.expected,
        { passed: true, actual: `Reused ${saved.filename}, exported by CMP-191 with ${saved.rows.length} row(s) in worksheet ${worksheet}.` });
      return saved;
    }
    await componentObservedCheck(page, workbookStep.title, workbookStep.expected,
      { passed: true, actual: 'No valid export from CMP-191 was available in this run, so this scenario exported the register itself.' });
    const workbook = await exportAndOpen(plan, exportSteps(''));
    expect(workbook.sheetNames, `Observed Application Result: the workbook contained ${list(workbook.sheetNames)} instead of ${worksheet}.`).toContain(worksheet);
    await recordShared(workbook);
    return workbook;
  };

  // ---------- Reading saved component details ----------

  const automationCodes = async () => new Set((await readTrackedComponents()).filter((item) => item.vessel === vessel).map((item) => item.code));

  /** Opens a component by code and reads the saved values of the given export columns. */
  const readSaved = async (code: string, columns: Column[]): Promise<SavedDetails> => {
    const identity = await components.searchAndSelectComponentByCode(code);
    expect(`${identity.code} in ${identity.vesselName}`, `Observed Application Result: Component Details showed ${identity.code} in Vessel ${identity.vesselName}.`).toBe(`${code} in ${vessel}`);
    const values: SavedDetails['values'] = {};
    for (const item of columns) values[item.column] = await components.readSelectedComponentDetail(item.field).catch(() => undefined);
    return { code: identity.code, name: identity.name, values };
  };
  const readStep = (code: string, what: string): PlannedStep => ({
    title: `Open Component ${code} and read its saved ${what}`,
    expected: `Component ${code} should open in Vessel ${vessel} and show its saved ${what}.`,
  });
  const savedActual = (columns: Column[]) => (saved: SavedDetails) =>
    `Component ${saved.code} (${saved.name}) showed ${columns.map((item) => `${item.column} "${saved.values[item.column] ?? 'unreadable'}"`).join(', ')}.`;

  type Mismatch = { code: string; column: string; saved: string; exported: string };
  const compare = (saved: SavedDetails, row: ExportRow | undefined, columns: Column[]) => {
    const mismatches: Mismatch[] = [];
    const unreadable: string[] = [];
    let matched = 0;
    for (const item of columns) {
      const value = saved.values[item.column];
      if (value === undefined) { unreadable.push(`${saved.code} ${item.column}`); continue; }
      const exported = row?.[item.column] ?? '';
      if (comparable(item.column, value) === comparable(item.column, exported)) matched++;
      else mismatches.push({ code: saved.code, column: item.column, saved: oneLine(value) || '(empty)', exported: oneLine(exported) || '(blank)' });
    }
    return { mismatches, unreadable, matched };
  };
  const mismatchText = (items: Mismatch[]) => items.map((item) => `${item.code} ${item.column}: saved "${item.saved}", exported "${item.exported}"`).join('; ');

  // ---------- Hooks ----------

  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(5 * 60_000);
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
  });

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    await forgetComponentsViewState(page);
    await restoreComponentsPage(page, components, vessel);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  /** Records every remaining planned step as NOT EXECUTED with the reason, then skips the test. */
  const notExecuted = async (plan: ScenarioPlan, planned: PlannedStep[], reason: string): Promise<never> => {
    for (const item of planned) {
      plan.begin(item.title);
      await componentNotExecutedStep(item.title, item.expected, reason);
    }
    test.skip(true, `NOT EXECUTED: ${reason}`);
    throw new Error(reason);
  };

  // ---------- Scenarios ----------

  test('CMP-191 - Export Nonempty Component Register', componentScenario(`Exporting the Vessel ${vessel} component register should download a readable XLSX workbook whose ${worksheet} worksheet holds the expected export columns and the vessel's component records, without changing any saved component.`), async () => {
    test.setTimeout(6 * 60_000);
    const download = exportSteps('');
    const steps = {
      register: { title: `Confirm the Vessel ${vessel} component register is loaded`, expected: `The Components register of Vessel ${vessel} should finish loading and show its component tree.` },
      sample: { title: 'Select an existing component and record its saved details before export', expected: `An existing component of Vessel ${vessel} should open and show its saved details.` },
      ...download,
      structure: { title: `Verify worksheet ${worksheet}, its columns and component records`, expected: `Worksheet ${worksheet} should contain the ${exportColumns.length} export columns and one row per exported component, matching the count reported by the application, with codes stored as text.` },
      unchanged: { title: 'Refresh and confirm the saved register is unchanged', expected: 'After a refresh, the component register and the recorded component should show the same saved details as before the export.' },
      verify: { title: `Verify the export of Vessel ${vessel} is complete and changed nothing`, expected: `A readable ${worksheet} workbook with the vessel's component records should be downloaded, and the saved register should be unchanged.` },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      plan.begin(steps.register.title);
      const registerBefore = await componentActionStep(steps.register.title, steps.register.expected, async () => {
        await components.clearComponentSearch();
        await components.expectTreeLoaded();
        return (await components.readTreeRowsWithCoverage()).rows;
      }, (rows) => `Vessel ${vessel} showed ${rows.length} tree row(s): ${rows.map((row) => row.code).join(', ')}.`, { page });

      // The first shown component of the vessel is used, as a tester would pick one.
      plan.begin(steps.sample.title);
      const before = await componentActionStep(steps.sample.title, steps.sample.expected, async () => {
        const automation = await automationCodes();
        const tried = new Set<string>();
        // Classification rows carry no Vessel Name; selecting one shows its children next.
        while (tried.size < 10) {
          const row = (await components.readTreeRowsWithCoverage()).rows.find((item) => !tried.has(item.code) && !automation.has(item.code));
          if (!row) break;
          tried.add(row.code);
          const identity = await components.selectTreeComponent(row);
          if (identity.vesselName === vessel) return readSaved(identity.code, comparedColumns);
        }
        throw new Error(`Observed Application Result: none of the tree rows ${list([...tried])} opened a component of Vessel ${vessel}.`);
      }, savedActual(comparedColumns), { page });

      const workbook = await exportAndOpen(plan, download);
      plan.begin(steps.structure.title);
      const structure = {
        missing: exportColumns.filter((column) => !workbook.headers.includes(column)),
        extra: workbook.headers.filter((column) => !exportColumns.includes(column)),
        reported: exportedCount(workbook.feedback),
        withoutCode: workbook.rows.filter((row) => !row['Component Code']).length,
        sampleRow: rowFor(workbook, before.code),
      };
      const structureProblems = [
        ...(!workbook.sheetNames.includes(worksheet) ? [`worksheet ${worksheet} is missing; the workbook holds ${list(workbook.sheetNames)}`] : []),
        ...(structure.missing.length ? [`column(s) ${structure.missing.join(', ')} are missing`] : []),
        ...(structure.extra.length ? [`unexpected column(s) ${structure.extra.join(', ')} are present`] : []),
        ...(!workbook.rows.length ? ['the worksheet holds no component rows'] : []),
        ...(workbook.rows.length !== structure.reported ? [`the worksheet holds ${workbook.rows.length} row(s) but the application reported ${Number.isNaN(structure.reported) ? 'no count' : structure.reported}`] : []),
        ...(structure.withoutCode ? [`${structure.withoutCode} row(s) have no Component Code`] : []),
        ...(workbook.nonTextCodes.length ? [`Component Code(s) ${workbook.nonTextCodes.slice(0, 10).join(', ')} are stored as numbers, which can drop leading zeros`] : []),
        ...(!structure.sampleRow ? [`recorded component ${before.code} is not in the export`] : []),
      ];
      await componentObservedCheck(page, steps.structure.title, steps.structure.expected, {
        passed: !structureProblems.length,
        actual: structureProblems.length
          ? `${structureProblems.join('; ')}.`
          : `Worksheet ${worksheet} held all ${exportColumns.length} columns (${workbook.headers.join(', ')}) and ${workbook.rows.length} component row(s), matching "${workbook.feedback}"; every Component Code is stored as text; recorded component ${before.code} is row ${workbook.rows.indexOf(structure.sampleRow!) + 2}.`,
      });
      if (!structureProblems.length) await recordShared(workbook);

      plan.begin(steps.unchanged.title);
      const after = await componentActionStep(steps.unchanged.title, steps.unchanged.expected, async () => {
        await refresh();
        const rows = (await components.readTreeRowsWithCoverage()).rows;
        return { rows, saved: await readSaved(before.code, comparedColumns) };
      }, (state) => `After refresh, Vessel ${vessel} showed ${state.rows.length} tree row(s) and ${savedActual(comparedColumns)(state.saved)}`, { page });

      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const changed = comparedColumns.filter((item) => after.saved.values[item.column] !== before.values[item.column])
          .map((item) => `${item.column} changed from "${before.values[item.column] ?? 'unreadable'}" to "${after.saved.values[item.column] ?? 'unreadable'}"`);
        const problems = [
          ...structureProblems,
          ...(after.rows.map((row) => row.code).join('|') !== registerBefore.map((row) => row.code).join('|') ? [`the tree rows changed from ${registerBefore.map((row) => row.code).join(', ')} to ${after.rows.map((row) => row.code).join(', ')}`] : []),
          ...changed.map((change) => `Component ${before.code} ${change}`),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return workbook;
      }, { actual: (result) => `${result.filename} was downloaded and read: worksheet ${worksheet} holds ${result.rows.length} component row(s) with all ${exportColumns.length} columns; after the export the register and Component ${before.code} were unchanged.` });
    });
  });

  test('CMP-192 - Compare Export With Saved Register Data', componentScenario(`For existing components of Vessel ${vessel}, the exported codes, names, parent, fleet equipment, category, department, maker, model, serial, drawing, location, dates, rating and notes should equal the saved component details. The Yes/No fields are validated in CMP-194.`), async () => {
    test.setTimeout(8 * 60_000);
    const choose = { title: 'Choose existing components to compare from the export', expected: `Up to three existing components of Vessel ${vessel} with the most filled descriptive export columns should be chosen; components created by automation are excluded.` };
    const verify = { title: 'Compare exported values with the saved component details', expected: `Each exported value of ${list(detailColumnsCompared.map((item) => item.column))} should equal the saved value shown in the Component details. Not compared here: the Yes/No fields ${list(flagColumns)} (validated in CMP-194), ${notCompared}.` };
    const plan = new ScenarioPlan([workbookStep, choose, verify]);
    await plan.run(async () => {
      const workbook = await sharedWorkbook(plan);
      plan.begin(choose.title);
      const automation = await automationCodes();
      const filled = (row: ExportRow) => detailColumnsCompared.filter((item) => oneLine(row[item.column] ?? '')).length;
      const chosen = workbook.rows.filter((row) => row['Component Code'] && !automation.has(row['Component Code']))
        .sort((first, second) => filled(second) - filled(first)).slice(0, 3);
      await componentObservedCheck(page, choose.title, choose.expected, {
        passed: chosen.length > 0,
        actual: chosen.length ? `Chose ${chosen.map((row) => `${row['Component Code']} (${filled(row)} of ${detailColumnsCompared.length} compared columns filled)`).join(', ')} from ${workbook.filename}.` : 'The export held no existing component rows to compare.',
      });
      if (!chosen.length) throw new Error('Observed Application Result: the export held no existing component rows to compare.');
      const results: Array<ReturnType<typeof compare>> = [];
      for (const row of chosen) {
        const saved = await componentActionStep(readStep(row['Component Code'], 'details').title, readStep(row['Component Code'], 'details').expected,
          () => readSaved(row['Component Code'], detailColumnsCompared), savedActual(detailColumnsCompared), { page });
        results.push(compare(saved, row, detailColumnsCompared));
      }
      plan.begin(verify.title);
      await componentValidationStep(page, step(verify.title, verify.expected), async () => {
        const mismatches = results.flatMap((result) => result.mismatches);
        const unreadable = results.flatMap((result) => result.unreadable);
        expect([...mismatches.map((item) => `${item.code} ${item.column}`), ...unreadable.map((item) => `${item} unreadable`)],
          `Observed Application Result: ${[mismatchText(mismatches), unreadable.length ? `saved value unreadable for ${unreadable.join(', ')}` : ''].filter(Boolean).join('; ')}.`).toEqual([]);
        return results;
      }, { actual: (items) => `All ${items.reduce((sum, item) => sum + item.matched, 0)} compared values of ${chosen.map((row) => row['Component Code']).join(', ')} in ${workbook.filename} equal the saved details.` });
    });
  });

  test('CMP-193 - Export Component With Parent Reference', componentScenario(`An existing child component of Vessel ${vessel} should be exported with the same Parent Component Code the application shows for it, and that parent should also be in the export.`), async () => {
    test.setTimeout(5 * 60_000);
    const choose = { title: 'Choose an existing child component from the export', expected: `An existing component of Vessel ${vessel} with a parent that is also exported should be chosen.` };
    const verify = { title: 'Verify the exported Parent Component Code', expected: 'The exported Parent Component Code should equal the parent shown in the Component details, and the parent should be an exported component.' };
    const plan = new ScenarioPlan([workbookStep, choose, verify]);
    await plan.run(async () => {
      const workbook = await sharedWorkbook(plan);
      plan.begin(choose.title);
      const automation = await automationCodes();
      const codes = new Set(workbook.rows.map((row) => row['Component Code']));
      const depth = (row: ExportRow) => row['Component Code'].split('.').length;
      const child = workbook.rows.filter((row) => row['Parent Component Code'] && codes.has(row['Parent Component Code']) && !automation.has(row['Component Code']))
        .sort((first, second) => depth(second) - depth(first))[0];
      await componentObservedCheck(page, choose.title, choose.expected, {
        passed: Boolean(child),
        actual: child ? `Chose ${child['Component Code']} (${child['Component Name']}), exported with Parent Component Code ${child['Parent Component Code']}.` : 'The export held no existing component whose parent is also exported.',
      });
      if (!child) throw new Error('Observed Application Result: the export held no existing component whose parent is also exported.');
      const parentColumns = comparedColumns.filter((item) => ['Component Code', 'Parent Component Code'].includes(item.column));
      const read = readStep(child['Component Code'], 'Component Code and Parent Component Code');
      const saved = await componentActionStep(read.title, read.expected, () => readSaved(child['Component Code'], parentColumns), savedActual(parentColumns), { page });
      plan.begin(verify.title);
      await componentValidationStep(page, step(verify.title, verify.expected), async () => {
        const parent = saved.values['Parent Component Code'] ?? '';
        const problems = [
          ...(parent !== child['Parent Component Code'] ? [`the application shows parent "${parent || 'none'}" but the export shows "${child['Parent Component Code']}"`] : []),
          ...(saved.values['Component Code'] !== child['Component Code'] ? [`the application shows code "${saved.values['Component Code']}" but the export shows "${child['Component Code']}"`] : []),
          ...(!codes.has(parent) ? [`parent ${parent || '(none)'} is not an exported component`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return parent;
      }, { actual: (parent) => `Component ${child['Component Code']} shows parent ${parent} in the application and is exported with Parent Component Code ${child['Parent Component Code']}; parent ${parent} (${rowFor(workbook, parent)?.['Component Name'] ?? ''}) is also in ${workbook.filename}.` });
    });
  });

  test('CMP-194 - Export True/False Component Flags', componentScenario(`For existing components of Vessel ${vessel} saved with Yes and No values, the exported Criticality, Condition Based, Class Item, Is Active and Is Parent should equal the saved values, with No written explicitly and never left blank.`), async () => {
    test.setTimeout(8 * 60_000);
    const choose = { title: 'Choose existing components holding Yes and No flag values', expected: `Existing components of Vessel ${vessel} should be chosen so that each flag is checked with a saved Yes and a saved No where such components exist.` };
    const verify = {
  title: 'Verify the exported flag values against the saved values',
  expected: 'Class item Yes should export as TRUE and No as blank. All other flags should match their saved Yes or No values, with No never exported as blank.'
};
    const coverage = { title: 'Confirm every flag was checked with both a saved Yes and a saved No', expected: 'Each of the five flags should have been compared for at least one component saved with Yes and one saved with No.' };
    const plan = new ScenarioPlan([workbookStep, choose, verify, coverage]);
    await plan.run(async () => {
      const workbook = await sharedWorkbook(plan);
      plan.begin(choose.title);
      const automation = await automationCodes();
      const pairs = flagColumns.flatMap((column) => ['Yes', 'No'].map((value) => `${column}=${value}`));
      // A blank exported flag may hide a saved No, so it is a candidate for No.
      const offers = (row: ExportRow) => pairs.filter((pair) => {
        const [column, value] = pair.split('=');
        const exported = asFlag(oneLine(row[column] ?? ''));
        return exported === value || (value === 'No' && exported === '');
      });
      const candidates = workbook.rows.filter((row) => row['Component Code'] && !automation.has(row['Component Code']));
      const chosen: ExportRow[] = [];
      const open = new Set(pairs);
      while (open.size && chosen.length < 6) {
        const best = candidates.filter((row) => !chosen.includes(row))
          .map((row) => ({ row, gain: offers(row).filter((pair) => open.has(pair)).length }))
          .sort((first, second) => second.gain - first.gain)[0];
        if (!best?.gain) break;
        chosen.push(best.row);
        offers(best.row).forEach((pair) => open.delete(pair));
      }
      await componentObservedCheck(page, choose.title, choose.expected, {
        passed: chosen.length > 0,
        actual: chosen.length
          ? `Chose ${chosen.map((row) => `${row['Component Code']} (exported ${flagColumns.map((column) => `${column} "${row[column] || 'blank'}"`).join(', ')})`).join('; ')}.${open.size ? ` No exported row offered ${[...open].join(', ')}.` : ''}`
          : 'The export held no existing component rows.',
      });
      if (!chosen.length) throw new Error('Observed Application Result: the export held no existing component rows.');
      const results: Array<{ saved: SavedDetails; row: ExportRow }> = [];
      for (const row of chosen) {
        const read = readStep(row['Component Code'], 'flag values');
        results.push({ row, saved: await componentActionStep(read.title, read.expected, () => readSaved(row['Component Code'], flagColumnsCompared), savedActual(flagColumnsCompared), { page }) });
      }
      // Coverage counts only values the application itself showed as saved Yes or No.
      const covered = new Set(results.flatMap(({ saved }) => flagColumns.map((column) => `${column}=${asFlag(oneLine(saved.values[column] ?? ''))}`)));
      const missing = pairs.filter((pair) => !covered.has(pair));
      const representations = flagColumns.map((column) => `${column} as ${list([...new Set(workbook.rows.map((row) => row[column] || 'blank'))])}`).join('; ');
      plan.begin(verify.title);
      await componentValidationStep(page, step(verify.title, verify.expected), async () => {


        const problems = results.flatMap(({ saved, row }) => flagColumns.flatMap((column) => {
  const value = asFlag(oneLine(saved.values[column] ?? ''));
  const exported = oneLine(row[column] ?? '');

  if (saved.values[column] === undefined)
    return [`${saved.code} ${column}: the saved value could not be read`];

  // Special export rule for Class item only
  if (column === 'Class item') {
    const matches =
      (value === 'Yes' && exported.toUpperCase() === 'TRUE') ||
      (value === 'No' && exported === '');

    return matches
      ? []
      : [`${saved.code} ${column}: saved "${value}", exported "${exported || 'blank'}"`];
  }

  // Existing validation for all other flags
  if (value === 'No' && !exported)
    return [`${saved.code} ${column}: saved No was exported as a blank cell`];

  return asFlag(exported) === value
    ? []
    : [`${saved.code} ${column}: saved "${value || 'empty'}", exported "${exported || 'blank'}"`];
}));





        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return results;
      }, { actual: (items) => `All flag values of ${items.map(({ saved }) => saved.code).join(', ')} were exported as saved. The workbook writes ${representations}.` });
      plan.begin(coverage.title);
      if (missing.length) {
        await notExecuted(plan, [coverage], `missing prerequisite - no existing component of Vessel ${vessel} chosen from the export is saved with ${missing.join(', ')}, so those values could not be checked; no test data was created.`);
      }
      await componentObservedCheck(page, coverage.title, coverage.expected, { passed: true, actual: `Every flag was compared for a component saved with Yes and one saved with No: ${pairs.join(', ')}.` });
    });
  });

  test('CMP-195 - Export Filename and Worksheet Name', componentScenario(`The downloaded export should be an XLSX workbook named components_export_YYYY-MM-DD.xlsx with the export date, readable and containing worksheet ${worksheet}.`), async () => {
    test.setTimeout(5 * 60_000);
    const verify = { title: 'Verify the export filename, date, extension and worksheet', expected: `The file should be named components_export_YYYY-MM-DD.xlsx with the date the export was made, have the .xlsx extension, open as a workbook and contain worksheet ${worksheet}.` };
    const plan = new ScenarioPlan([workbookStep, verify]);
    await plan.run(async () => {
      const workbook = await sharedWorkbook(plan);
      plan.begin(verify.title);
      await componentValidationStep(page, step(verify.title, verify.expected), async () => {
        const date = filenamePattern.exec(workbook.filename)?.[1];
        const signature = (await fs.readFile(workbook.file)).subarray(0, 2).toString('latin1');
        const problems = [
          ...(!date ? [`the file is named ${workbook.filename}, not components_export_YYYY-MM-DD.xlsx`] : []),
          ...(date && !workbook.localDates.includes(date) ? [`the file name carries ${date} while the export was made on ${workbook.localDates.join(' / ')} (the application uses the UTC date ${workbook.utcDate})`] : []),
          ...(path.extname(workbook.filename).toLowerCase() !== '.xlsx' ? [`the extension is ${path.extname(workbook.filename) || 'missing'}`] : []),
          ...(signature !== 'PK' ? ['the file is not an XLSX (zip) package'] : []),
          ...(!workbook.sheetNames.includes(worksheet) ? [`the workbook holds ${list(workbook.sheetNames)} instead of ${worksheet}`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        return date!;
      }, { actual: (date) => `The download was named ${workbook.filename}: export date ${date} matches the day the export was made, extension .xlsx, a readable XLSX package with worksheet(s) ${list(workbook.sheetNames)}.` });
    });
  });

  test('CMP-196 - Export Empty Vessel', componentScenario(`Exporting Vessel ${emptyVessel}, which has no components, should not download a spreadsheet and should show a clear message that there are no components to export.`), async () => {
    test.setTimeout(4 * 60_000);
    const steps = {
      select: { title: `Select Vessel ${emptyVessel}`, expected: `Vessel ${emptyVessel} should be selected and its component register should finish loading.` },
      empty: { title: `Confirm Vessel ${emptyVessel} has no saved components`, expected: `With every top-level category opened, Vessel ${emptyVessel} should show only its categories and no components beneath them.` },
      button: { title: 'Inspect the Export button', expected: 'The Export button should be displayed; whether it is enabled is recorded.' },
      click: { title: `Click Export once for Vessel ${emptyVessel}`, expected: 'The application should respond to the export request.' },
      verify: { title: `Verify no spreadsheet is downloaded for Vessel ${emptyVessel} and the user is told why`, expected: 'No file should be downloaded. If Export can be clicked, the application should clearly state that there are no components to export; if it is disabled, no export can start.' },
    };
    const plan = new ScenarioPlan(Object.values(steps));
    await plan.run(async () => {
      plan.begin(steps.select.title);
      await componentActionStep(steps.select.title, steps.select.expected, async () => {
        await components.clearComponentSearch();
        await components.selectVessel(emptyVessel);
        await components.expectTreeLoaded();
      }, () => `Vessel ${emptyVessel} was selected and its register finished loading.`, { page });
      plan.begin(steps.empty.title);
      const rows = await componentActionStep(steps.empty.title, steps.empty.expected, async () => {
        // Each category is opened one by one; a category without components shows nothing beneath it.
        await components.expandTreeLevels(3);
        return (await components.readTreeRowsWithCoverage()).rows;
      }, (shown) => `Vessel ${emptyVessel} showed ${shown.length} row(s): ${list(shown.map((row) => `${row.code}${row.depth ? ` (level ${row.depth + 1})` : ''}`))}.`, { page });
      const nested = rows.filter((row) => row.depth > 0);
      if (nested.length) {
        await notExecuted(plan, [steps.button, steps.click, steps.verify], `missing prerequisite - Vessel ${emptyVessel} is not empty: it shows component(s) ${nested.map((row) => row.code).join(', ')}. No component was deleted.`);
      }
      plan.begin(steps.button.title);
      const enabled = await componentActionStep(steps.button.title, steps.button.expected, async () => {
        await expect(exportButton(), 'The Export button should be displayed').toBeVisible();
        return exportButton().isEnabled();
      }, (state) => `The Export button was displayed and ${state ? 'enabled' : 'disabled'}.`, { page });
      plan.begin(steps.click.title);
      let attempt: ExportAttempt = { downloads: [], feedback: '', localDates: [], utcDate: '' };
      if (enabled) {
        attempt = await componentActionStep(steps.click.title, steps.click.expected, () => clickExport(false), exportedActual, { page });
      } else {
        await componentNotExecutedStep(steps.click.title, steps.click.expected, 'the Export button was disabled, so it could not be clicked.');
      }
      plan.begin(steps.verify.title);
      await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
        const problems = [
          ...(attempt.downloads.length ? [`the file ${attempt.downloads[0].suggestedFilename()} was downloaded`] : []),
          ...(enabled && !/no components/i.test(attempt.feedback) ? [`the application showed "${attempt.feedback}" instead of a no-components message`] : []),
        ];
        expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
      }, { actual: () => (enabled ? `No file was downloaded and the application showed "${attempt.feedback}".` : 'The Export button was disabled, so no export could start and no file was downloaded; no message explaining why was shown.') });
    });
  });

  // ---------- CMP-198: text that a spreadsheet could read as a formula ----------

  const notesLabel = 'Notes / Technical Information';
  const formulaPrefixValues = ['=UAT', '+UAT', '-UAT', '@UAT'];
  /** Tree rows CMP-198 may open while choosing its components; no full traversal is made. */
  const treeScanLimit = 20;
  const shown = (value: string) => (value === '' ? '(empty)' : `"${oneLine(value)}"`);

  /**
   * Picks the first editable components straight from the Component Tree in tree order, as a tester
   * would, whatever their Notes hold. Category rows are opened, never edited, and inactive rows are skipped.
   */
  const selectEditableFromTree = async () => {
    const editButton = page.getByRole('button', { name: 'Edit Component', exact: true });
    await components.clearComponentSearch();
    await components.expectTreeLoaded();
    const tried = new Set<string>();
    const chosen: Array<{ code: string; name: string }> = [];
    while (tried.size < treeScanLimit && chosen.length < formulaPrefixValues.length) {
      const row = (await components.readTreeRowsWithCoverage()).rows.find((item) => !tried.has(item.code) && !/\(Inactive\)/i.test(item.rawText));
      if (!row) break;
      tried.add(row.code);
      const identity = await components.selectTreeComponent(row);
      // Classification rows carry no Vessel Name and no Edit Component action.
      if (identity.vesselName === vessel && await editButton.isVisible()) chosen.push({ code: identity.code, name: identity.name });
      if (await components.treeComponentExpansionState(row.code) === 'collapsed') await components.expandTreeComponent(row.code);
    }
    return { tried: [...tried], chosen };
  };

  /** Opens the selected component's Edit form once it has loaded its saved values. */
  const openEdit = async (code: string): Promise<ComponentFormPage> => {
    await components.searchAndSelectComponentByCode(code);
    const form = await components.openSelectedComponentForEdit();
    await form.expectEditReady(code);
    return form;
  };
  /** Reads the saved Notes exactly as the Edit form holds them, then leaves without saving. */
  const readSavedNotes = async (code: string) => {
    const form = await openEdit(code);
    const value = await form.controlValue(notesLabel);
    await form.back();
    return value;
  };

  type NotesCell = { address: string; value: string; type: string; formula?: string };
  /** Reads the Notes cell of each code straight from the worksheet, without evaluating anything. */
  const readNotesCells = (file: string, codes: string[]) => {
    const sheet = XLSX.readFile(file, { cellFormula: true }).Sheets[worksheet];
    const cells = new Map<string, NotesCell>();
    if (!sheet) return cells;
    const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
    const header = (column: number) => String((sheet[XLSX.utils.encode_cell({ r: 0, c: column })] as XLSX.CellObject | undefined)?.v ?? '');
    let codeColumn = -1;
    let notesColumn = -1;
    for (let column = range.s.c; column <= range.e.c; column++) {
      if (header(column) === 'Component Code') codeColumn = column;
      if (header(column) === 'Notes') notesColumn = column;
    }
    if (codeColumn < 0 || notesColumn < 0) return cells;
    for (let row = 1; row <= range.e.r; row++) {
      const code = String((sheet[XLSX.utils.encode_cell({ r: row, c: codeColumn })] as XLSX.CellObject | undefined)?.v ?? '');
      if (!codes.includes(code)) continue;
      const address = XLSX.utils.encode_cell({ r: row, c: notesColumn });
      const cell = sheet[address] as XLSX.CellObject | undefined;
      cells.set(code, { address, value: cell?.v === undefined ? '' : String(cell.v), type: cell?.t ?? 'empty', formula: cell?.f });
    }
    return cells;
  };
  const cellTypeText = (cell: NotesCell) => (cell.formula
    ? `a formula (=${cell.formula})`
    : ({ s: 'text', str: 'formula text result', n: 'number', b: 'true/false', d: 'date', e: 'error', z: 'blank', empty: 'blank (no cell)' } as Record<string, string>)[cell.type] ?? cell.type);

  test('CMP-198 - Export Text Beginning with =, +, -, or @', componentScenario(`Notes / Technical Information values "=UAT", "+UAT", "-UAT" and "@UAT" saved on four existing editable components of Vessel ${vessel} should be exported exactly as plain text cells, never as spreadsheet formulas, and each component's original Notes should be restored afterwards.`), async () => {
    test.setTimeout(15 * 60_000);
    const download = exportSteps(' with the test Notes values');
    const steps = {
      select: { title: 'Select four existing editable components from the Component Tree', expected: `Four different existing active components of Vessel ${vessel} offering Edit Component should be selected directly from the tree, with their code and name recorded; each original Notes value is recorded exactly when its Edit form opens.` },
      ...Object.fromEntries(formulaPrefixValues.map((value, index) => [`enter${index}`, {
        title: `Open Edit and enter ${value} in ${notesLabel}`,
        expected: `The Edit form of the ${['first', 'second', 'third', 'fourth'][index]} selected component should open with its original Notes recorded; "${value}" should be entered if Notes is blank, or replace the existing Notes, before Save.`,
      }])),
      ...Object.fromEntries(formulaPrefixValues.map((value, index) => [`saved${index}`, {
        title: `Refresh and confirm Notes ${value} was saved`,
        expected: `After a refresh, the component given "${value}" should show exactly "${value}" in ${notesLabel}.`,
      }])),
      ...download,
      ...Object.fromEntries(formulaPrefixValues.map((value, index) => [`cell${index}`, {
        title: `Verify the exported Notes ${value} is a plain text cell`,
        expected: `The component's row should be in worksheet ${worksheet} with Notes exactly "${value}", stored as text and not as a formula.`,
      }])),
      verify: { title: 'Verify all four Notes values were exported exactly as plain text', expected: `"=UAT", "+UAT", "-UAT" and "@UAT" should each be saved, exported exactly and stored as text, with no Notes cell stored as a formula.` },
    } as Record<string, PlannedStep>;
    const plan = new ScenarioPlan(Object.values(steps));
    type Target = { code: string; name: string; value: string; original?: string; saved?: string; cell?: NotesCell };
    const targets: Target[] = [];
    let failure: unknown;
    try {
      await plan.run(async () => {
        plan.begin(steps.select.title);
        const selection = await componentActionStep(steps.select.title, steps.select.expected, selectEditableFromTree,
          (state) => `Selected ${state.chosen.length} component(s) from the tree: ${list(state.chosen.map((item) => `${item.code} (${item.name})`))}. ${state.tried.length} tree row(s) opened in tree order (${state.tried.join(', ')}).`, { page });
        if (selection.chosen.length < formulaPrefixValues.length) {
          await notExecuted(plan, Object.values(steps).filter((item) => item !== steps.select),
            `missing prerequisite - four editable components of Vessel ${vessel} are needed, but only ${selection.chosen.length} ${selection.chosen.length === 1 ? 'was' : 'were'} found among the first ${selection.tried.length} tree row(s) opened. No component was created or edited.`);
        }
        selection.chosen.forEach((item, index) => targets.push({ ...item, value: formulaPrefixValues[index] }));

        for (const [index, target] of targets.entries()) {
          plan.begin(steps[`enter${index}`].title);
          const form = await componentActionStep(steps[`enter${index}`].title, steps[`enter${index}`].expected, async () => {
            const opened = await openEdit(target.code);
            target.original = await opened.controlValue(notesLabel);
            await opened.fillOptional({ [notesLabel]: target.value });
            return opened;
          }, () => `Component ${target.code} (${target.name}) opened in Edit; ${target.original
            ? `${notesLabel} held "${oneLine(target.original)}", which was replaced with "${target.value}"`
            : `${notesLabel} was blank, and "${target.value}" was entered`}.`, { page });
          await form.saveValid();
          await refresh();
        }

        await refresh();
        for (const [index, target] of targets.entries()) {
          plan.begin(steps[`saved${index}`].title);
          target.saved = await componentActionStep(steps[`saved${index}`].title, steps[`saved${index}`].expected, () => readSavedNotes(target.code),
            (saved) => `After refresh, Component ${target.code} (${target.name}) showed ${notesLabel} ${shown(saved)}${saved === target.value ? '' : ` instead of "${target.value}"`}.`, { page });
        }

        await refresh();
        const workbook = await exportAndOpen(plan, download);
        const cells = readNotesCells(workbook.file, targets.map((target) => target.code));
        await test.info().attach(`Workbook evidence - Notes cells in ${workbook.filename}`, {
          contentType: 'text/plain',
          body: targets.map((target) => {
            const cell = cells.get(target.code);
            return cell
              ? `${target.code}: cell ${cell.address}, stored as ${cellTypeText(cell)}, value ${shown(cell.value)}${cell.formula ? `, formula =${cell.formula}` : ''}`
              : `${target.code}: no row in worksheet ${worksheet}`;
          }).join('\n'),
        });
        for (const [index, target] of targets.entries()) {
          const cell = cells.get(target.code);
          target.cell = cell;
          plan.begin(steps[`cell${index}`].title);
          await componentObservedCheck(page, steps[`cell${index}`].title, steps[`cell${index}`].expected, {
            passed: Boolean(cell && cell.value === target.value && cell.type === 's' && !cell.formula),
            actual: `Component ${target.code} (${target.name}): original Notes ${shown(target.original ?? '')}; test value "${target.value}"; saved after refresh ${shown(target.saved ?? '')}; ${cell
              ? `exported in cell ${cell.address} as ${shown(cell.value)}, stored as ${cellTypeText(cell)}.`
              : `no row for ${target.code} was found in worksheet ${worksheet} of ${workbook.filename}.`}`,
          }, { screenshot: 'failure' });
        }

        plan.begin(steps.verify.title);
        await componentValidationStep(page, step(steps.verify.title, steps.verify.expected), async () => {
          const problems = targets.flatMap((target) => [
            ...(target.saved !== target.value ? [`${target.code} saved ${shown(target.saved ?? '')} instead of "${target.value}"`] : []),
            ...(!target.cell ? [`${target.code} was missing from the export`] : [
              ...(target.cell.value !== target.value ? [`${target.code} was exported as ${shown(target.cell.value)} instead of "${target.value}"`] : []),
              ...(target.cell.formula ? [`${target.code} Notes cell ${target.cell.address} was stored as formula =${target.cell.formula}`] : target.cell.type !== 's' ? [`${target.code} Notes cell ${target.cell.address} was stored as ${cellTypeText(target.cell)} instead of text`] : []),
            ]),
          ]);
          expect(problems, `Observed Application Result: ${problems.join('; ')}.`).toEqual([]);
        }, { actual: () => `${targets.map((target) => `${target.code} exported "${target.value}" as text in cell ${target.cell!.address}`).join('; ')}; no Notes cell was stored as a formula.` });
      });
    } catch (error) {
      failure = error;
    }

    // Every component whose Edit form was opened gets its original Notes back, even after a failure.
    const restoreProblems: string[] = [];
    const touched = targets.filter((target) => target.original !== undefined);
    for (const target of touched) {
      const title = `Restore original ${notesLabel} of Component ${target.code}`;
      await componentActionStep(title, `Component ${target.code} (${target.name}) should be saved again with its original Notes ${shown(target.original!)}.`, async () => {
        await refresh();
        const form = await openEdit(target.code);
        const current = await form.controlValue(notesLabel);
        if (current === target.original) {
          await form.back();
          return `Component ${target.code} already held its original Notes ${shown(target.original!)}, so nothing was saved.`;
        }
        await form.fillOptional({ [notesLabel]: target.original! });
        await form.saveValid();
        return `Component ${target.code} held ${shown(current)} and was saved with its original Notes ${shown(target.original!)}.`;
      }, (actual) => actual, { page }).catch((error: unknown) => {
        restoreProblems.push(`${target.code} could not be saved back to ${shown(target.original!)}`);
        if (!failure) failure = error;
      });
    }
    if (touched.length) await refresh();
    for (const target of touched) {
      const title = `Refresh and confirm original ${notesLabel} of Component ${target.code} is restored`;
      const restored = await componentActionStep(title, `After a refresh, Component ${target.code} should show its original Notes ${shown(target.original!)}.`,
        () => readSavedNotes(target.code), (value) => `After refresh, Component ${target.code} showed Notes ${shown(value)}.`, { page }).catch(() => undefined);
      if (restored !== target.original) restoreProblems.push(`${target.code} showed ${restored === undefined ? 'unreadable Notes' : shown(restored)} instead of its original ${shown(target.original!)}`);
    }
    if (touched.length) {
      await componentObservedCheck(page, 'After-test restore: verify original Notes of all edited components', `Every edited component should show its original ${notesLabel} after the test.`, {
        passed: !restoreProblems.length,
        actual: restoreProblems.length ? `Restoration failed: ${restoreProblems.join('; ')}.` : `The original Notes of ${touched.map((target) => target.code).join(', ')} were restored and confirmed after refresh.`,
      });
    }
    if (failure) throw failure;
    if (restoreProblems.length) throw new Error(`Observed Application Result: the test Notes values were verified, but restoring the original Notes failed: ${restoreProblems.join('; ')}.`);
  });

  test('CMP-199 - Export With Filters Applied', componentScenario(`With the Critical Only filter applied in Vessel ${vessel}, Export should still download the complete unfiltered vessel component register: every full-register Component Code exactly once, with no missing or unexpected codes and the same total row count.`), async () => {
    test.setTimeout(10 * 60_000);
    const filtered = exportSteps(' with Critical Only applied');
    const steps = {
      full: { title: `Record the complete unfiltered component register of Vessel ${vessel}`, expected: `A readable unfiltered export should provide the complete register and every Component Code used as the reference for the filtered export.` },
      filter: { title: 'Apply Critical Item = Critical Only and verify the active filter', expected: 'The Components page should display Critical Item: Critical Only before Export is clicked.' },
      ...filtered,
      compare: { title: 'Compare the filtered export with the complete unfiltered register', expected: 'Although Critical Only remains active, the export should contain every full-register Component Code exactly once, no missing or unexpected codes, and the same row count as the complete unfiltered register.' },
    };
    const plan = new ScenarioPlan([workbookStep, ...Object.values(steps)]);
    await plan.run(async () => {
      const full = await sharedWorkbook(plan);
      plan.begin(steps.full.title);
      const fullRegister = await componentActionStep(steps.full.title, steps.full.expected, async () => {
        await refresh();
        return full.rows.map((row) => row['Component Code']);
      }, (codes) => `The unfiltered export ${full.filename}, worksheet ${worksheet}, held ${full.rows.length} component row(s) and ${new Set(codes).size} unique Component Code(s).`, { page });
      plan.begin(steps.filter.title);
      const activeFilter = await componentActionStep(steps.filter.title, steps.filter.expected, async () => {
        await components.applyCriticalFilter('Critical Only');
        const value = await components.criticalFilterValue();
        expect(value, 'Observed Application Result: the Critical Item filter should display Critical Only before Export').toContain('Critical Only');
        return value;
      }, (value) => `The Components page displayed the active filter as ${value}.`, { page });
      const exported = await exportAndOpen(plan, filtered);
      plan.begin(steps.compare.title);
      const exportedRegister = exported.rows.map((row) => row['Component Code']);
      const fullCodes = new Set(fullRegister);
      const exportedCodes = new Set(exportedRegister);
      const missing = [...fullCodes].filter((code) => !exportedCodes.has(code));
      const unexpected = [...exportedCodes].filter((code) => !fullCodes.has(code));
      const frequencies = new Map<string, number>();
      exportedRegister.forEach((code) => frequencies.set(code, (frequencies.get(code) ?? 0) + 1));
      const duplicates = [...frequencies.entries()].filter(([, count]) => count > 1).map(([code, count]) => `${code} (${count} rows)`);
      const sample = (codes: string[]) => (codes.length > 20 ? `${codes.slice(0, 20).join(', ')} and ${codes.length - 20} more` : list(codes));
      await componentValidationStep(page, step(steps.compare.title, steps.compare.expected), async () => {
        expect(
          { missing, unexpected, duplicates, exportedCount: exported.rows.length },
          `Observed Application Result: active filter ${activeFilter}; complete register ${full.rows.length} row(s); filtered export ${exported.rows.length} row(s); missing codes ${sample(missing)}; unexpected codes ${sample(unexpected)}; duplicate codes ${sample(duplicates)}.`,
        ).toEqual({ missing: [], unexpected: [], duplicates: [], exportedCount: full.rows.length });
      }, { actual: () => `Active filter: ${activeFilter}. Complete unfiltered register: ${full.rows.length} row(s). Filtered export ${exported.filename}: ${exported.rows.length} row(s). Missing Component Codes: ${sample(missing)}. Unexpected Component Codes: ${sample(unexpected)}. Duplicate Component Codes: ${sample(duplicates)}. The filtered export matched the complete vessel register.` });
    });
  });
});

