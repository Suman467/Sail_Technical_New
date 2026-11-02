import { expect, test, type BrowserContext, type Page, type Request, type Response } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ComponentsPage, type SelectedComponentIdentity } from '../../pages/ComponentsPage';
import { readAppNotification } from '../../utils/appNotification';
import {
  attachFailureScreenshot,
  componentActionStep,
  componentNotExecutedStep,
  componentObservedCheck,
  componentScenario,
  componentValidationStep,
} from '../../utils/componentValidationEvidence';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../../utils/componentsSession';
import { config } from '../../utils/config';
import { recordMissingTreePrerequisite, searchComponentTree, type TreeComponentVisit } from '../../utils/componentTreeSearch';

// The component is chosen at runtime from the vessel's tree for each scenario; no component code or name is configured.
const vessel = config.vesselName;
const sectionTitle = 'G. Drawings & Manuals';
const documentsApi = '/technical/api/component-documents';
const componentsApi = '/technical/api/components';
/** CMP-154 boundary: exactly 25 MiB. */
const boundaryBytes = 26_214_400;
/** CMP-157 message exactly as specified by the manual tester, including its grammar. */
const unsavedComponentMessage = 'Documents will be available after component is created';
const deleteConfirmation = (name: string) => `Are you sure you want to delete "${name}"?`;

const validFolder = path.resolve('test-data', 'Drawings & Manuals', 'Valid file');
const unsupportedFolder = path.resolve('test-data', 'Drawings & Manuals', 'unsupported file');

type TestFile = { name: string; path: string; size: number; extension: string };
type SectionCategory = { index: number; name: string; used: number; capacity: number; uploadEnabled: boolean; accept: string[] };
type SectionDocument = { id: string; category: string; categoryIndex: number; name: string; size: string };
type SectionState = { categories: SectionCategory[]; documents: SectionDocument[] };
type SavedDocument = { id?: string; fileName?: string; componentCode?: string; notes?: string; fileSize?: number };
type UploadAttempt = {
  chooserMultiple: boolean;
  requestSent: boolean;
  status?: number;
  saved?: SavedDocument;
  responseText?: string;
  notification: string;
};

const step = (title: string, expected: string, actual = 'Recorded after the validation completes.') =>
  `${title}\nExpected: ${expected}\nActual: ${actual}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Business text for a failed action, with the raw diagnostic kept below it for Technical Details. */
const businessError = (observed: string, error: unknown) =>
  /Observed Application Result:/i.test(errorText(error)) ? error : new Error(`Observed Application Result:\n${observed}\n\n${errorText(error)}`);

const listFiles = (folder: string): TestFile[] => (fs.existsSync(folder) ? fs.readdirSync(folder) : [])
  .map((name) => ({ name, path: path.join(folder, name) }))
  .filter((file) => fs.statSync(file.path).isFile())
  .map((file) => ({ ...file, size: fs.statSync(file.path).size, extension: path.extname(file.name).toLowerCase() }))
  .sort((a, b) => a.name.localeCompare(b.name));
const sizeText = (bytes: number) => (bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(2)} MiB, ${bytes.toLocaleString('en-US')} bytes`
  : `${(bytes / 1024).toFixed(1)} KB, ${bytes.toLocaleString('en-US')} bytes`);
const documentText = (document: SectionDocument) => `${document.name} [${document.category}${document.size ? `, ${document.size}` : ''}]`;
const documentsText = (documents: SectionDocument[]) => (documents.length ? documents.map(documentText).join('; ') : 'no documents');
const categoriesText = (categories: SectionCategory[]) =>
  categories.map((category) => `${category.name} ${category.used}/${category.capacity}${category.uploadEnabled ? '' : ' (Upload unavailable)'}`).join(', ');
const hasCapacity = (category: SectionCategory) => category.uploadEnabled && category.used < category.capacity;

/** Documents added, removed, or moved between two readings of Section G. */
const compareDocuments = (before: SectionDocument[], after: SectionDocument[]) => {
  const beforeById = new Map(before.map((document) => [document.id, document]));
  const afterById = new Map(after.map((document) => [document.id, document]));
  const removed = before.filter((document) => !afterById.has(document.id));
  const added = after.filter((document) => !beforeById.has(document.id));
  const changed = before.filter((document) => {
    const current = afterById.get(document.id);
    return current && (current.name !== document.name || current.category !== document.category);
  });
  const differences = [
    ...removed.map((document) => `${documentText(document)} is no longer listed`),
    ...added.map((document) => `${documentText(document)} was added`),
    ...changed.map((document) => `${documentText(document)} now shows ${documentText(afterById.get(document.id)!)}`),
  ];
  return { removed, added, changed, unchanged: !differences.length, differences };
};

test.describe('CMP-150 to CMP-157 - Component Drawings & Manuals', () => {
  let context: BrowserContext;
  let page: Page;
  let components: ComponentsPage;

  test.beforeAll(async ({ browser }) => {
    ({ context, page, components } = await openPrimaryComponentsSession(browser));
    await components.selectVessel(vessel);
    await components.expectTreeLoaded();
  });

  test.afterEach(async ({ browser }, testInfo) => {
    void browser;
    await attachFailureScreenshot(page, testInfo);
    // Refreshes Components between scenarios; uploaded documents are never removed automatically.
    await restoreComponentsPage(page, components, vessel);
  });

  test.afterAll(async () => context?.close());

  /** The saved component chosen from the tree for the running scenario. */
  let selected: SelectedComponentIdentity | undefined;
  test.beforeEach(() => {
    selected = undefined;
  });
  const componentRef = () => (selected ? `Component ${selected.code} (${selected.name})` : 'the selected component');
  const selectedCode = () => selected?.code ?? '';

  // ---- Section G of a saved component ----
  const section = () => page.getByTestId('B7.G');
  const categoryRow = (index: number) => section().getByTestId(`row-document-${index}`);
  const documentIcon = (id: string) => section().getByTestId(`doc-icon-${id}`);
  const popupName = (id: string) => documentIcon(id).locator('span[title]').first();

  const openPopup = async (id: string) => {
    if (!(await popupName(id).isVisible().catch(() => false))) await documentIcon(id).locator(':scope > div').first().click();
    await expect(popupName(id), `The details popup of document ${id} should open`).toBeVisible({ timeout: 5_000 });
  };
  const closePopup = async (id: string) => {
    if (!(await popupName(id).isVisible().catch(() => false))) return;
    await documentIcon(id).locator(':scope > div').first().click();
    if (await popupName(id).isVisible().catch(() => false)) await page.keyboard.press('Escape');
    if (await popupName(id).isVisible().catch(() => false)) await section().getByText(sectionTitle, { exact: true }).hover();
    await expect(popupName(id), `The details popup of document ${id} should close`).toBeHidden({ timeout: 5_000 });
  };
  const readDocument = async (id: string) => {
    await openPopup(id);
    const name = ((await popupName(id).getAttribute('title')) ?? '').trim();
    const size = (await documentIcon(id).locator('span').nth(1).innerText().catch(() => '')).trim();
    await closePopup(id);
    return { name, size };
  };

  /** Reads every category row of Section G and, unless `withDocuments` is false, the filename of each listed document. */
  const readSection = async (withDocuments = true): Promise<SectionState> => {
    const categories: SectionCategory[] = [];
    const documents: SectionDocument[] = [];
    for (const row of await section().locator('[data-testid^="row-document-"]').all()) {
      const index = Number((await row.getAttribute('data-testid'))?.replace('row-document-', ''));
      const name = (await row.locator(':scope > span').first().innerText()).trim();
      const counter = (await row.locator(':scope > div:last-child > span').last().innerText().catch(() => '')).trim();
      const [used, capacity] = counter.split('/').map((value) => Number(value.trim()));
      const upload = row.getByTestId(`btn-upload-document-${index}`);
      const uploadEnabled = await upload.isVisible().catch(() => false) && await upload.isEnabled().catch(() => false);
      const accept = ((await row.locator('input[type="file"]').first().getAttribute('accept').catch(() => null)) ?? '')
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      categories.push({ index, name, used, capacity, uploadEnabled, accept });
      const ids = await row.locator('[data-testid^="doc-icon-"]').evaluateAll((icons) => icons.map((icon) => icon.getAttribute('data-testid')!.replace('doc-icon-', '')));
      if (withDocuments) for (const id of ids) documents.push({ id, category: name, categoryIndex: index, ...(await readDocument(id)) });
    }
    return { categories, documents };
  };

  const openSectionG = async (withDocuments = true, timeout = 30_000): Promise<SectionState> => {
    await expect(section(), `${sectionTitle} should be displayed for ${componentRef()}`).toBeVisible({ timeout });
    await section().scrollIntoViewIfNeeded();
    const firstRow = section().locator('[data-testid^="row-document-"]').first();
    if (!(await firstRow.isVisible().catch(() => false))) await section().getByText(sectionTitle, { exact: true }).click();
    await expect(firstRow, `${sectionTitle} should list its document categories`).toBeVisible({ timeout: 15_000 });
    return readSection(withDocuments);
  };

  /**
   * Walks the vessel's Components tree with the shared tree walk (parent, then its
   * children and subchildren) and selects the first saved child component whose
   * Section G offers the upload capacity the scenario needs. When none does, the
   * first child component that shows Section G at all is used, and the scenario
   * reports the full categories itself. With no Section G anywhere, the scenario
   * is reported NOT EXECUTED; no component is ever created.
   */
  const selectComponentStep = async (need: 'every category' | 'any category') => {
    const preferred = need === 'every category'
      ? 'free upload capacity in every Section G category'
      : 'free upload capacity in at least one Section G category';
    let fallback: { visit: TreeComponentVisit; categories: SectionCategory[] } | undefined;
    const search = await searchComponentTree(page, components, async (visit) => {
      // Top-level rows are groups; the walk expands them and checks their children and subchildren.
      if (visit.depth === 0) return undefined;
      selected = visit.identity;
      const state = await openSectionG(false, 10_000).catch(() => undefined);
      if (!state?.categories.length) return undefined;
      const enough = need === 'every category' ? state.categories.every(hasCapacity) : state.categories.some(hasCapacity);
      if (enough) return state.categories;
      fallback ??= { visit, categories: state.categories };
      return undefined;
    }, Number.POSITIVE_INFINITY);

    let identity = search.match?.visit.identity;
    let categories = search.match?.result;
    if (!search.match && fallback) {
      const candidate = fallback;
      identity = await componentActionStep(`Reopen Component ${candidate.visit.code} (${candidate.visit.identity.name})`,
        `No inspected component had ${preferred}, so the first component with Section G, ${candidate.visit.code}, should be selected again.`,
        () => components.searchAndSelectComponentByCode(candidate.visit.code),
        (value) => `Component Details loaded Code ${value.code}, Name ${value.name}, Vessel ${value.vesselName}.`, { page });
      categories = candidate.categories;
    }
    if (!identity || !categories) {
      selected = undefined;
      const reason = await recordMissingTreePrerequisite(page, search, vessel, `a saved child component displays Section ${sectionTitle}`);
      test.skip(true, `NOT EXECUTED: ${reason}`);
      throw new Error(reason);
    }
    selected = identity;
    const vesselName = identity.vesselName && identity.vesselName !== '—' ? identity.vesselName : vessel;
    await componentObservedCheck(page, 'Record the dynamically selected component',
      `A saved component of Vessel ${vessel} with Section ${sectionTitle} and ${preferred} should be selected from the Components tree and used for this whole scenario.`,
      {
        passed: true,
        actual: `Selected Vessel: ${vesselName}; Selected Component Code: ${identity.code}; Selected Component Name: ${identity.name}. `
          + `Section G: ${categoriesText(categories)}. ${search.visited.length} component(s) were inspected in the tree`
          + (search.match ? '.' : `; none had ${preferred}, so the first component with Section G was used and full categories are reported by the scenario.`),
      }, { screenshot: 'failure' });
    return identity;
  };
  const openSectionStep = () => componentActionStep(
    `Open Section ${sectionTitle}`,
    `Section ${sectionTitle} of ${componentRef()} should list its document categories, each with its Upload control, document count and current documents.`,
    openSectionG,
    (state) => `Section G showed ${state.categories.length} categories (${categoriesText(state.categories)}) and ${state.documents.length} existing document(s): ${documentsText(state.documents)}.`,
    { page },
  );
  /** Reloads the browser page and reopens the same component's Section G in the same session. */
  const refreshSectionStep = (expected: string) => componentActionStep(
    `Refresh the page and reopen Section ${sectionTitle} of ${componentRef()}`,
    expected,
    async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await components.expectToBeOnPage();
      await components.selectVessel(vessel);
      const identity = await components.searchAndSelectComponentByCode(selectedCode());
      // The refresh must reopen the same dynamically selected component.
      if (identity.code !== selected?.code || identity.name !== selected.name) {
        throw new Error(`Observed Application Result:\nAfter the refresh, Component Details showed ${identity.code} (${identity.name}) instead of the selected ${componentRef()}.`);
      }
      return { identity, state: await openSectionG() };
    },
    ({ identity, state }) => `After the refresh, Component ${identity.code} (${identity.name}) in Vessel ${identity.vesselName} reopened without a new login; Section G showed ${categoriesText(state.categories)} and ${state.documents.length} document(s): ${documentsText(state.documents)}.`,
    { page },
  );

  /** Records every request to the document and component APIs while a scenario runs. */
  const watchRequests = () => {
    const requests: Request[] = [];
    const listener = (request: Request) => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() !== 'GET' && (pathname.startsWith(documentsApi) || pathname === componentsApi)) requests.push(request);
    };
    page.on('request', listener);
    return {
      documentUploads: () => requests.filter((request) => request.method() === 'POST' && new URL(request.url()).pathname === documentsApi),
      componentCreates: () => requests.filter((request) => request.method() === 'POST' && new URL(request.url()).pathname === componentsApi),
      stop: () => page.off('request', listener),
    };
  };

  /**
   * Clicks Upload in one category and chooses the file in the browser file picker.
   * Waits up to `responseTimeout` for the upload response; when the application
   * reports something without uploading, it keeps observing for `observeAfterMessage`.
   */
  const uploadThroughPicker = async (category: SectionCategory, file: TestFile, responseTimeout: number, observeAfterMessage = 0): Promise<UploadAttempt> => {
    let response: Response | undefined;
    let requestSent = false;
    const onRequest = (request: Request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === documentsApi) requestSent = true;
    };
    page.on('request', onRequest);
    try {
      const posted = page.waitForResponse((candidate) => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname === documentsApi, { timeout: responseTimeout })
        .then((value) => { response = value; }, () => undefined);
      const chooserOpened = page.waitForEvent('filechooser', { timeout: 10_000 });
      await categoryRow(category.index).getByTestId(`btn-upload-document-${category.index}`).click();
      const chooser = await chooserOpened;
      await chooser.setFiles(file.path);
      let notification = '';
      if (observeAfterMessage) {
        notification = await Promise.race([posted.then(() => ''), readAppNotification(page, responseTimeout)]);
        if (!response) await Promise.race([posted, page.waitForTimeout(observeAfterMessage)]);
      } else {
        await posted;
      }
      if (response || !notification) notification = await readAppNotification(page, response ? 8_000 : 2_000) || notification;
      const responseText = response ? await response.text().catch(() => '') : undefined;
      let saved: SavedDocument | undefined;
      try {
        const body = responseText ? JSON.parse(responseText) as Record<string, unknown> : undefined;
        if (body && body.id !== undefined) {
          saved = { id: String(body.id), fileName: String(body.fileName ?? ''), componentCode: String(body.componentCode ?? ''), notes: String(body.notes ?? ''), fileSize: Number(body.fileSize) };
        }
      } catch {
        // A non-JSON response is reported through its status and text.
      }
      return { chooserMultiple: chooser.isMultiple(), requestSent, status: response?.status(), saved, responseText, notification };
    } finally {
      page.off('request', onRequest);
    }
  };

  /** Opens a document's popup, clicks Preview and keeps the downloaded file for comparison. */
  const previewDocument = async (id: string) => {
    await openPopup(id);
    const downloadStarted = page.waitForEvent('download', { timeout: 120_000 });
    await documentIcon(id).getByTestId(`btn-view-document-${id}`).click();
    const download = await downloadStarted;
    const target = test.info().outputPath('downloads', `${id}-${download.suggestedFilename()}`);
    await download.saveAs(target);
    const failure = await download.failure();
    await closePopup(id).catch(() => page.keyboard.press('Escape'));
    return { suggestedName: download.suggestedFilename(), target, failure, bytes: fs.statSync(target).size };
  };
  const sameContent = (downloaded: string, source: TestFile) => fs.readFileSync(downloaded).equals(fs.readFileSync(source.path));

  const assertNoFailures = (failures: string[], diagnostics: string[]) =>
    expect(failures, [...failures, '', 'Technical details:', ...diagnostics].join('\n')).toEqual([]);

  test('CMP-150 + CMP-151 - Upload a document to each category and open it', componentScenario(
    'CMP-150: each valid file uploaded to Section G. Drawings & Manuals should be associated with its selected category and with the saved component selected from the Components tree of the vessel, and stay there after Section G is refreshed. '
      + 'CMP-151: each uploaded document should open or download with its own filename and exactly the uploaded contents, never another component\'s document.'), async () => {
    test.setTimeout(10 * 60_000);
    const failures150: string[] = [];
    const failures151: string[] = [];
    const diagnostics: string[] = [];
    const uploaded: Array<{ category: SectionCategory; file: TestFile; saved: SavedDocument & { id: string }; displayed?: string }> = [];
    await selectComponentStep('every category');
    let before: SectionState;
    try {
      before = await openSectionStep();
    } catch (error) {
      for (const [title, expected] of [
        ['Upload one valid file to each Section G category', 'Each category should accept one valid file and list it under that category.'],
        ['Open or download each uploaded document', 'Each document should download with its own filename and contents.'],
        [`Refresh the page and reopen Section ${sectionTitle} of ${componentRef()}`, 'Every uploaded document should remain under its category after refresh.'],
        ['Confirm the CMP-150 result', 'Every uploaded file should remain associated with its selected category and Component.'],
        ['Confirm the CMP-151 result', 'Every uploaded document should open or download with its own filename and contents.'],
      ]) await componentNotExecutedStep(title, expected, 'Section G of the saved component could not be opened, so no document was uploaded or opened.');
      throw error;
    }

    // One valid file per category, varied by format; the exact 25 MiB file is reserved for CMP-154.
    const accept = before.categories[0]?.accept ?? [];
    const candidates = listFiles(validFolder).filter((file) => file.size !== boundaryBytes && accept.includes(file.extension));
    const byFormat = accept.map((extension) => candidates.find((file) => file.extension === extension)).filter((file): file is TestFile => Boolean(file));
    const files = [...byFormat, ...candidates.filter((file) => !byFormat.includes(file))];
    await componentObservedCheck(page, 'Select one valid test file for each Section G category',
      `The folder "Valid file" should contain a different file with a permitted format (${accept.join(', ')}) for each of the ${before.categories.length} categories.`,
      {
        passed: files.length >= before.categories.length,
        actual: `${candidates.length} valid file(s) other than the 25 MiB boundary file were found; assigned: `
          + `${before.categories.map((category, index) => `${category.name} ← ${files[index] ? `${files[index].name} (${sizeText(files[index].size)})` : 'no file available'}`).join('; ')}.`,
      }, { screenshot: 'failure' });

    for (const [index, category] of before.categories.entries()) {
      const file = files[index];
      const title = `Upload ${file?.name ?? 'a valid file'} to ${category.name}`;
      const expected = `Choosing ${file?.name ?? 'a valid file'} under ${category.name} should upload it to ${componentRef()} and list it under ${category.name}.`;
      if (!file || !hasCapacity(category)) {
        const reason = !file
          ? 'the Valid file folder has no further file with a permitted format for this category'
          : `${category.name} already holds ${category.used} of ${category.capacity} documents, so it cannot accept another upload until documents are removed manually`;
        failures150.push(`${category.name}: ${reason}.`);
        await componentNotExecutedStep(title, expected, `${reason}.`);
        continue;
      }
      let attempt: UploadAttempt;
      try {
        attempt = await componentActionStep(title, expected, async () => {
          const result = await uploadThroughPicker(category, file, 120_000);
          if (!result.status) throw new Error(`Observed Application Result:\nNo upload response was received within two minutes after ${file.name} was chosen under ${category.name}.${result.notification ? ` The application displayed: "${result.notification}".` : ''}`);
          if (result.status >= 400 || !result.saved?.id) {
            throw new Error(`Observed Application Result:\nThe upload of ${file.name} under ${category.name} was not saved (server status ${result.status})${result.notification ? `; the application displayed: "${result.notification}"` : ''}.\n\n${result.responseText ?? ''}`);
          }
          await expect(categoryRow(category.index).getByTestId(`doc-icon-${result.saved.id}`), `The uploaded document should be listed under ${category.name}`).toBeVisible({ timeout: 15_000 });
          return result;
        }, (result) => `The server saved "${result.saved!.fileName}" (${result.saved!.fileSize?.toLocaleString('en-US')} bytes) for Component ${result.saved!.componentCode} with category "${result.saved!.notes}"; `
          + `${result.notification ? `the application displayed "${result.notification}"` : 'no notification was displayed'}; a new document was listed under ${category.name}.`, { page });
      } catch (error) {
        failures150.push(`${category.name}: ${file.name} could not be uploaded.`);
        diagnostics.push(`Upload ${file.name} to ${category.name}: ${errorText(error)}`);
        await componentNotExecutedStep(`Verify ${file.name} under ${category.name}`, `The uploaded document should show its filename under ${category.name}.`, 'the upload did not complete.');
        await componentNotExecutedStep(`Open or download ${file.name} from ${category.name}`, 'The document should download with its own filename and contents.', 'the upload did not complete.');
        continue;
      }
      const saved = attempt.saved as SavedDocument & { id: string };
      const record: (typeof uploaded)[number] = { category, file, saved };
      uploaded.push(record);

      // CMP-150: filename and category as listed for this component.
      const verifyTitle = `Verify ${file.name} under ${category.name} (CMP-150)`;
      const verifyExpected = `${category.name} should list the uploaded document with a filename identifying ${file.name}, saved for ${componentRef()} under category ${category.name}, and no other category should list it.`;
      try {
        const shown = await readDocument(saved.id);
        const elsewhere: string[] = [];
        for (const other of before.categories.filter((item) => item.index !== category.index)) {
          if (await categoryRow(other.index).getByTestId(`doc-icon-${saved.id}`).count()) elsewhere.push(other.name);
        }
        const issues = [
          !shown.name.endsWith(file.name) && `the listed filename "${shown.name}" does not identify ${file.name}`,
          shown.name !== saved.fileName && `the listed filename "${shown.name}" differs from the saved filename "${saved.fileName}"`,
          saved.componentCode !== selectedCode() && `the server saved it for Component ${saved.componentCode} instead of ${selectedCode()}`,
          saved.notes !== category.name && `the server saved category "${saved.notes}" instead of "${category.name}"`,
          elsewhere.length > 0 && `it is also listed under ${elsewhere.join(', ')}`,
        ].filter((issue): issue is string => Boolean(issue));
        record.displayed = shown.name;
        if (issues.length) failures150.push(`${category.name}: ${issues.join('; ')}.`);
        await componentObservedCheck(page, verifyTitle, verifyExpected, {
          passed: !issues.length,
          actual: `${category.name} listed "${shown.name}" (${shown.size}); the server saved it for Component ${saved.componentCode} with category "${saved.notes}"`
            + (issues.length ? `. Difference: ${issues.join('; ')}.` : '; no other category listed it.'),
        });
      } catch (error) {
        failures150.push(`${category.name}: the details of the uploaded ${file.name} could not be read.`);
        diagnostics.push(`Read ${file.name} under ${category.name}: ${errorText(error)}`);
        await componentObservedCheck(page, verifyTitle, verifyExpected, { passed: false, actual: `The document details popup of the uploaded ${file.name} under ${category.name} did not open, so its listed filename could not be read.` });
      }

      // CMP-151: open/download the same document.
      const openTitle = `Open or download ${file.name} from ${category.name} (CMP-151)`;
      const openExpected = `Preview should open or download "${record.displayed ?? saved.fileName}" itself, with exactly the ${file.size.toLocaleString('en-US')} bytes of ${file.name} uploaded to ${componentRef()}.`;
      try {
        const opened = await previewDocument(saved.id);
        const contentMatches = !opened.failure && sameContent(opened.target, file);
        const issues = [
          opened.failure && `the download did not complete (${opened.failure})`,
          opened.suggestedName !== saved.fileName && `the downloaded filename was "${opened.suggestedName}" instead of "${saved.fileName}"`,
          !opened.failure && !contentMatches && `the downloaded contents (${opened.bytes.toLocaleString('en-US')} bytes) differ from the uploaded ${file.name} (${file.size.toLocaleString('en-US')} bytes)`,
        ].filter((issue): issue is string => Boolean(issue));
        if (issues.length) failures151.push(`${category.name}: ${issues.join('; ')}.`);
        await componentObservedCheck(page, openTitle, openExpected, {
          passed: !issues.length,
          actual: `Preview downloaded "${opened.suggestedName}" (${opened.bytes.toLocaleString('en-US')} bytes)`
            + (issues.length ? `. Difference: ${issues.join('; ')}.` : `, byte-for-byte identical to the uploaded ${file.name}.`),
        });
      } catch (error) {
        failures151.push(`${category.name}: ${file.name} could not be opened or downloaded.`);
        diagnostics.push(`Preview ${file.name} under ${category.name}: ${errorText(error)}`);
        await componentObservedCheck(page, openTitle, openExpected, { passed: false, actual: `Clicking Preview for "${saved.fileName}" under ${category.name} did not open or download the document.` });
      }
    }

    // CMP-150 persistence after refresh.
    if (uploaded.length) {
      try {
        const { state } = await refreshSectionStep(`After a refresh, Section G of ${componentRef()} should still list the ${uploaded.length} uploaded document(s), each under the category it was uploaded to.`);
        for (const item of uploaded) {
          const listed = state.documents.find((document) => document.id === item.saved.id);
          const issues = [
            !listed && 'it is no longer listed',
            listed && listed.category !== item.category.name && `it is now listed under ${listed.category}`,
            listed && listed.name !== item.saved.fileName && `its filename now shows "${listed.name}"`,
          ].filter((issue): issue is string => Boolean(issue));
          if (issues.length) failures150.push(`After refresh, ${item.saved.fileName}: ${issues.join('; ')}.`);
          await componentObservedCheck(page, `Recheck ${item.file.name} under ${item.category.name} after refresh (CMP-150)`,
            `After refresh, "${item.saved.fileName}" should still be listed under ${item.category.name} of ${componentRef()}.`,
            {
              passed: !issues.length,
              actual: listed
                ? `After refresh, "${listed.name}" (${listed.size}) was listed under ${listed.category} of ${componentRef()}${issues.length ? `. Difference: ${issues.join('; ')}.` : '.'}`
                : `After refresh, "${item.saved.fileName}" was no longer listed in Section G of ${componentRef()}.`,
            }, { screenshot: 'failure' });
        }
      } catch (error) {
        failures150.push('Section G could not be reopened after refresh, so the uploaded documents were not rechecked.');
        diagnostics.push(`Refresh Section G: ${errorText(error)}`);
        for (const item of uploaded) {
          await componentNotExecutedStep(`Recheck ${item.file.name} under ${item.category.name} after refresh (CMP-150)`,
            `After refresh, "${item.saved.fileName}" should still be listed under ${item.category.name}.`, 'Section G could not be reopened after the refresh.');
        }
      }
    } else {
      await componentNotExecutedStep(`Refresh the page and reopen Section ${sectionTitle} of ${componentRef()}`,
        'Every uploaded document should remain under its category after refresh.', 'no document was uploaded, so there was nothing to recheck.');
    }

    const result150 = failures150.length
      ? `FAIL — ${failures150.join(' ')}`
      : `PASS — ${uploaded.map((item) => `"${item.saved.fileName}" under ${item.category.name}`).join('; ')} were associated with ${componentRef()} and remained after refresh.`;
    const result151 = failures151.length
      ? `FAIL — ${failures151.join(' ')}`
      : `PASS — each of the ${uploaded.length} uploaded document(s) downloaded with its own filename and byte-for-byte identical contents.`;
    await componentObservedCheck(page, 'Confirm the CMP-150 result: documents stay with their category and component',
      'Each uploaded file should be associated with its selected category and with the saved component.', { passed: !failures150.length, actual: result150 }, { screenshot: 'failure' });
    await componentObservedCheck(page, 'Confirm the CMP-151 result: documents open or download correctly',
      'Each document should open or download correctly without showing another component\'s document.', { passed: !failures151.length, actual: result151 }, { screenshot: 'failure' });
    await componentValidationStep(page, step('Verify the CMP-150 and CMP-151 results',
      'CMP-150 and CMP-151 should both pass: every uploaded document stays under its selected category of the saved component, and opens or downloads as its own file with its own contents.'), async () => {
      assertNoFailures([...failures150.map((item) => `CMP-150: ${item}`), ...failures151.map((item) => `CMP-151: ${item}`)], diagnostics);
    }, { actual: () => `CMP-150 ${result150} CMP-151 ${result151}` });
  });

  test('CMP-152 - Delete a test document as an authorized user', componentScenario(
    'Deleting the dedicated test document uploaded by this scenario should ask for confirmation naming that document, remove only that document after confirmation, and leave every other Section G document unchanged after refresh.'), async () => {
    test.setTimeout(5 * 60_000);
    const failures: string[] = [];
    const diagnostics: string[] = [];
    await selectComponentStep('any category');
    let state: SectionState;
    try {
      state = await openSectionStep();
    } catch (error) {
      for (const [title, expected] of [
        ['Upload a dedicated test document for deletion', 'A dedicated test document should be uploaded.'],
        ['Delete the dedicated test document', 'Only the dedicated test document should be deleted.'],
      ]) await componentNotExecutedStep(title, expected, 'Section G of the saved component could not be opened.');
      throw error;
    }

    // The smallest valid file, in the category with the most free space, is the dedicated deletion document.
    const file = listFiles(validFolder).filter((item) => item.size !== boundaryBytes && (state.categories[0]?.accept ?? []).includes(item.extension))
      .sort((a, b) => a.size - b.size)[0];
    const category = [...state.categories].reverse().filter(hasCapacity).sort((a, b) => (b.capacity - b.used) - (a.capacity - a.used))[0];
    if (!file || !category) {
      const reason = !file ? 'the Valid file folder has no file with a permitted format' : 'every Section G category is already full, so no dedicated test document can be uploaded';
      await componentNotExecutedStep('Upload a dedicated test document for deletion', 'A dedicated test document should be uploaded.', `${reason}; no existing document is deleted instead.`);
      await componentValidationStep(page, step('Verify that only the dedicated test document was deleted', 'Only the dedicated test document should be deleted.'), async () => {
        assertNoFailures([`Prerequisite missing: ${reason}.`], diagnostics);
      });
      return;
    }

    const upload = await componentActionStep(`Upload dedicated test document ${file.name} to ${category.name}`,
      `Choosing ${file.name} under ${category.name} should upload a new document that this scenario alone created, so it can be deleted without touching existing documents.`,
      async () => {
        const result = await uploadThroughPicker(category, file, 120_000);
        if (!result.status || result.status >= 400 || !result.saved?.id) {
          throw new Error(`Observed Application Result:\nThe dedicated test document ${file.name} was not saved under ${category.name}${result.status ? ` (server status ${result.status})` : ' (no upload response was received)'}${result.notification ? `; the application displayed: "${result.notification}"` : ''}.`);
        }
        await expect(categoryRow(category.index).getByTestId(`doc-icon-${result.saved.id}`)).toBeVisible({ timeout: 15_000 });
        return result.saved as SavedDocument & { id: string };
      },
      (saved) => `The server saved "${saved.fileName}" for Component ${saved.componentCode} with category "${saved.notes}", and it was listed under ${category.name}.`, { page });

    const baseline = await componentActionStep(`Record the dedicated test document and the other Section G documents`,
      `The dedicated test document's filename and category, and every other document listed in Section G, should be recorded before deletion.`,
      async () => {
        const current = await readSection();
        const target = current.documents.find((document) => document.id === upload.id);
        if (!target) throw new Error(`Observed Application Result:\nThe dedicated test document "${upload.fileName}" was not listed in Section G before deletion.`);
        return { target, others: current.documents.filter((document) => document.id !== upload.id) };
      },
      ({ target, others }) => `Dedicated test document: "${target.name}" under ${target.category} (${target.size}). Other documents kept for comparison: ${others.length} — ${documentsText(others)}.`);

    let dialogMessage: string | undefined;
    let deleteStatus: number | undefined;
    let notification = '';
    const expectedMessage = deleteConfirmation(baseline.target.name);
    try {
      await componentActionStep(`Click Delete for "${baseline.target.name}" only`,
        `Clicking Delete on the dedicated test document "${baseline.target.name}" should ask for confirmation before anything is deleted.`,
        async () => {
          const dialogShown = new Promise<void>((resolve) => {
            page.once('dialog', async (dialog) => {
              dialogMessage = dialog.message();
              // Confirm only the exact dedicated document; any other confirmation is dismissed.
              if (dialogMessage === expectedMessage) await dialog.accept();
              else await dialog.dismiss();
              resolve();
            });
          });
          const deleted = page.waitForResponse((response) => response.request().method() === 'DELETE' && new URL(response.url()).pathname === `${documentsApi}/${upload.id}`, { timeout: 30_000 })
            .then((response) => { deleteStatus = response.status(); }, () => undefined);
          await openPopup(upload.id);
          await documentIcon(upload.id).getByTestId(`btn-delete-document-${upload.id}`).click();
          await Promise.race([dialogShown, page.waitForTimeout(10_000)]);
          if (dialogMessage === expectedMessage) {
            await deleted;
            notification = await readAppNotification(page);
          }
          return dialogMessage;
        },
        (message) => (message ? `A confirmation dialog appeared: "${message}".` : 'No confirmation dialog appeared within 10 seconds.'), { page });
    } catch (error) {
      diagnostics.push(`Delete click: ${errorText(error)}`);
      failures.push(`The Delete control of "${baseline.target.name}" could not be used.`);
    }

    const dialogMatches = dialogMessage === expectedMessage;
    if (!dialogMatches) failures.push(dialogMessage ? `The confirmation dialog showed "${dialogMessage}" instead of "${expectedMessage}", so deletion was not confirmed.` : 'No confirmation dialog appeared before deletion.');
    await componentObservedCheck(page, 'Verify the delete confirmation dialog',
      `The confirmation should name only the dedicated test document: "${expectedMessage}"`,
      { passed: dialogMatches, actual: dialogMessage ? `The dialog showed "${dialogMessage}".` : 'No confirmation dialog was displayed.' });

    if (dialogMatches) {
      const confirmed = deleteStatus !== undefined && deleteStatus < 400;
      if (!confirmed) failures.push(`After confirmation, the deletion of "${baseline.target.name}" was not completed${deleteStatus ? ` (server status ${deleteStatus})` : ' (no deletion response was received)'}.`);
      await componentObservedCheck(page, `Confirm deletion of "${baseline.target.name}"`,
        `Confirming should delete "${baseline.target.name}" and report the deletion.`,
        { passed: confirmed, actual: `Deletion was confirmed; the server ${deleteStatus ? `responded with status ${deleteStatus}` : 'did not respond'}${notification ? ` and the application displayed "${notification}"` : ' and no notification was displayed'}.` });
    } else {
      await componentNotExecutedStep(`Confirm deletion of "${baseline.target.name}"`, `Confirming should delete "${baseline.target.name}".`, 'the confirmation dialog did not name the dedicated test document, so it was dismissed.');
    }

    try {
      const { state: after } = await refreshSectionStep(`After a refresh, "${baseline.target.name}" should be absent and every other document should still be listed unchanged.`);
      const stillListed = after.documents.find((document) => document.id === upload.id);
      if (stillListed) failures.push(`After refresh, "${stillListed.name}" was still listed under ${stillListed.category}.`);
      await componentObservedCheck(page, `Verify "${baseline.target.name}" is absent after refresh`,
        `"${baseline.target.name}" should no longer be listed under ${baseline.target.category}.`,
        { passed: !stillListed, actual: stillListed ? `"${stillListed.name}" was still listed under ${stillListed.category}.` : `"${baseline.target.name}" was no longer listed in Section G; ${after.categories.find((item) => item.index === category.index)?.name} showed ${after.categories.find((item) => item.index === category.index)?.used}/${category.capacity}.` });
      const comparison = compareDocuments(baseline.others, after.documents.filter((document) => document.id !== upload.id));
      if (!comparison.unchanged) failures.push(`Other Section G documents changed: ${comparison.differences.join('; ')}.`);
      await componentObservedCheck(page, 'Verify the other Section G documents are unchanged',
        `The ${baseline.others.length} other document(s) should remain listed with the same filenames and categories.`,
        { passed: comparison.unchanged, actual: comparison.unchanged ? `All ${baseline.others.length} other document(s) remained unchanged: ${documentsText(baseline.others)}.` : `Difference: ${comparison.differences.join('; ')}.` });
    } catch (error) {
      failures.push('Section G could not be reopened after refresh, so the deletion was not verified.');
      diagnostics.push(`Refresh after delete: ${errorText(error)}`);
      await componentNotExecutedStep(`Verify "${baseline.target.name}" is absent after refresh`, 'The deleted document should be absent.', 'Section G could not be reopened after the refresh.');
      await componentNotExecutedStep('Verify the other Section G documents are unchanged', 'Other documents should be unchanged.', 'Section G could not be reopened after the refresh.');
    }

    await componentValidationStep(page, step('Verify that only the dedicated test document was deleted',
      `Only "${baseline.target.name}" should be deleted, after a confirmation naming it, and all other documents should remain.`), async () => {
      assertNoFailures(failures, diagnostics);
    }, { actual: () => `After confirming "${dialogMessage}", only "${baseline.target.name}" was removed from ${baseline.target.category}; the other ${baseline.others.length} document(s) remained unchanged after refresh.` });
  });

  test('CMP-153 - Cancel the file picker without choosing a file', componentScenario(
    'Opening Upload in Section G and cancelling the file picker without choosing a file should upload nothing, leave every existing document unchanged, and keep Section G usable.'), async () => {
    test.setTimeout(4 * 60_000);
    const failures: string[] = [];
    const diagnostics: string[] = [];
    await selectComponentStep('any category');
    const before = await openSectionStep();
    const category = before.categories.find(hasCapacity) ?? before.categories[0];
    const watcher = watchRequests();
    try {
      const chooser = await componentActionStep(`Click Upload in ${category.name} and cancel the file picker`,
        `The browser file picker should open from ${category.name}; closing it without choosing a file should not start an upload.`,
        async () => {
          const opened = page.waitForEvent('filechooser', { timeout: 10_000 });
          await categoryRow(category.index).getByTestId(`btn-upload-document-${category.index}`).click();
          const picker = await opened;
          // No file is chosen: the picker is closed without a selection, exactly as Cancel does.
          await page.waitForTimeout(3_000);
          return { multiple: picker.isMultiple(), notification: await readAppNotification(page, 2_000) };
        },
        (value) => `The file picker opened (${value.multiple ? 'multiple files allowed' : 'single file'}) and was closed without choosing a file; ${value.notification ? `the application displayed "${value.notification}"` : 'no message was displayed'}.`, { page });

      const uploads = watcher.documentUploads();
      if (uploads.length) failures.push(`${uploads.length} upload request(s) were sent although no file was chosen.`);
      if (chooser.notification) failures.push(`The application displayed "${chooser.notification}" although no file was chosen.`);
      await componentObservedCheck(page, 'Verify no document was uploaded',
        'No upload should start and no upload message should appear when the file picker is cancelled.',
        { passed: !uploads.length && !chooser.notification, actual: `${uploads.length} upload request(s) were sent${chooser.notification ? ` and the application displayed "${chooser.notification}"` : ' and no upload message was displayed'}.` });

      const after = await readSection();
      const comparison = compareDocuments(before.documents, after.documents);
      const counts = after.categories.map((item) => `${item.name} ${item.used}/${item.capacity}`).join(', ');
      if (!comparison.unchanged) failures.push(`Section G documents changed: ${comparison.differences.join('; ')}.`);
      await componentObservedCheck(page, 'Verify the existing documents are unchanged',
        `Section G should still list the same ${before.documents.length} document(s) with the same counts (${categoriesText(before.categories)}).`,
        { passed: comparison.unchanged, actual: comparison.unchanged ? `Section G still listed the same ${after.documents.length} document(s); counts: ${counts}.` : `Difference: ${comparison.differences.join('; ')}; counts: ${counts}.` });

      // Usable: every Upload control is still enabled and the picker opens again.
      const usable = await componentActionStep('Confirm Section G remains usable',
        `Every Upload control should remain available, and Upload in ${category.name} should open the file picker again.`,
        async () => {
          const enabled = after.categories.filter((item) => item.uploadEnabled).map((item) => item.name);
          const reopened = page.waitForEvent('filechooser', { timeout: 10_000 }).then(() => true, () => false);
          await categoryRow(category.index).getByTestId(`btn-upload-document-${category.index}`).click();
          return { enabled, reopened: await reopened };
        },
        (value) => `Upload was available in ${value.enabled.length} of ${after.categories.length} categories (${value.enabled.join(', ') || 'none'}); clicking Upload in ${category.name} ${value.reopened ? 'opened the file picker again, which was closed without a selection' : 'did not open the file picker'}.`, { page });
      if (!usable.reopened) failures.push(`Upload in ${category.name} did not open the file picker again after the cancel.`);
      const fullCategories = after.categories.filter((item) => !item.uploadEnabled && item.used < item.capacity);
      if (fullCategories.length) failures.push(`Upload became unavailable in ${fullCategories.map((item) => item.name).join(', ')} although they were not full.`);
      await page.waitForTimeout(1_500);
      if (watcher.documentUploads().length > uploads.length) failures.push('An upload request was sent after the second file picker was closed without a file.');
    } catch (error) {
      diagnostics.push(errorText(error));
      throw error;
    } finally {
      watcher.stop();
    }

    await componentValidationStep(page, step('Verify that cancelling the file picker changed nothing',
      'Cancelling the file picker should not upload or change any document, and Section G should remain usable.'), async () => {
      assertNoFailures(failures, diagnostics);
    }, { actual: () => `No upload was sent, the same ${before.documents.length} document(s) remained (${categoriesText(before.categories)}), and Upload still opened the file picker.` });
  });

  test('CMP-154 - Upload a PDF of exactly 25 MiB', componentScenario(
    'A valid PDF of exactly 26,214,400 bytes (25 MiB) should not be rejected only because its size equals the allowed limit; once uploaded it should stay listed with its filename and category after refresh and download with identical contents.'), async () => {
    test.setTimeout(12 * 60_000);
    const failures: string[] = [];
    const diagnostics: string[] = [];
    const remaining = async (reason: string) => {
      for (const [title, expected] of [
        ['Upload the 25 MiB PDF', 'The application should accept the 25 MiB PDF.'],
        [`Refresh the page and reopen Section ${sectionTitle} of ${componentRef()}`, 'The uploaded PDF should remain listed after refresh.'],
        ['Verify the 25 MiB PDF filename, category and contents', 'The PDF should be listed with its filename and category and download with identical contents.'],
      ]) await componentNotExecutedStep(title, expected, reason);
    };

    const boundaryFile = listFiles(validFolder).find((file) => file.extension === '.pdf' && file.size === boundaryBytes);
    await componentObservedCheck(page, 'Verify the selected PDF is exactly 25 MiB',
      `The folder "Valid file" should contain a PDF of exactly ${boundaryBytes.toLocaleString('en-US')} bytes (25 MiB).`,
      {
        passed: Boolean(boundaryFile),
        actual: boundaryFile
          ? `${boundaryFile.name} is exactly ${boundaryFile.size.toLocaleString('en-US')} bytes (25 MiB).`
          : `No PDF of exactly ${boundaryBytes.toLocaleString('en-US')} bytes was found; PDFs present: ${listFiles(validFolder).filter((file) => file.extension === '.pdf').map((file) => `${file.name} (${file.size.toLocaleString('en-US')} bytes)`).join(', ') || 'none'}.`,
      }, { screenshot: 'failure' });
    if (!boundaryFile) {
      await remaining('the required exact 25 MiB PDF test file is missing; no replacement file is substituted.');
      await componentValidationStep(page, step('Verify the 25 MiB boundary upload', 'The 25 MiB PDF should be accepted.'), async () => {
        assertNoFailures([`Prerequisite missing: no PDF of exactly ${boundaryBytes} bytes in the Valid file folder.`], diagnostics);
      });
      return;
    }

    await selectComponentStep('any category');
    const before = await openSectionStep();
    const category = [...before.categories].filter(hasCapacity).sort((a, b) => (b.capacity - b.used) - (a.capacity - a.used))[0];
    if (!category) {
      await remaining('every Section G category is already full, so the 25 MiB PDF could not be uploaded.');
      await componentValidationStep(page, step('Verify the 25 MiB boundary upload', 'The 25 MiB PDF should be accepted.'), async () => {
        assertNoFailures([`Prerequisite missing: every Section G category is full (${categoriesText(before.categories)}).`], diagnostics);
      });
      return;
    }

    let attempt: UploadAttempt | undefined;
    try {
      attempt = await componentActionStep(`Upload ${boundaryFile.name} (25 MiB) to ${category.name}`,
        `Choosing ${boundaryFile.name} (exactly 25 MiB) under ${category.name} should pass browser-side validation and be saved by the server for ${componentRef()}.`,
        () => uploadThroughPicker(category, boundaryFile, 8 * 60_000, 10_000),
        (result) => `${result.requestSent ? 'The browser sent the file to the server' : 'The browser did not send the file to the server'}; `
          + `${result.status ? `the server responded with status ${result.status}${result.saved?.id ? ` and saved "${result.saved.fileName}" (${result.saved.fileSize?.toLocaleString('en-US')} bytes) with category "${result.saved.notes}"` : ''}` : 'no server response was received'}; `
          + `${result.notification ? `the application displayed "${result.notification}"` : 'no message was displayed'}.`, { page });
    } catch (error) {
      diagnostics.push(`Upload ${boundaryFile.name}: ${errorText(error)}`);
    }

    const accepted = Boolean(attempt?.status && attempt.status < 400 && attempt.saved?.id);
    const browserBlocked = attempt && !attempt.requestSent;
    if (!accepted) {
      failures.push(browserBlocked
        ? `The browser did not send the 25 MiB PDF to the server${attempt?.notification ? `; it displayed "${attempt.notification}"` : ''}.`
        : `The server did not accept the 25 MiB PDF${attempt?.status ? ` (status ${attempt.status})` : ''}${attempt?.notification ? `; the application displayed "${attempt.notification}"` : ''}.`);
    }
    await componentObservedCheck(page, 'Verify the 25 MiB PDF is not rejected because of its size',
      `A valid PDF of exactly ${boundaryBytes.toLocaleString('en-US')} bytes is at the supported limit and should not be rejected for its size.`,
      {
        passed: accepted,
        actual: !attempt
          ? 'The upload attempt did not complete, so no browser or server result was observed.'
          : accepted
            ? `The 25 MiB PDF was accepted: server status ${attempt.status}, saved as "${attempt.saved!.fileName}" (${attempt.saved!.fileSize?.toLocaleString('en-US')} bytes).`
            : `${browserBlocked ? 'Browser-side validation stopped the upload' : `The server responded with status ${attempt.status ?? 'none'}`}${attempt.notification ? `; the application displayed "${attempt.notification}"` : ''}.`
              + `${attempt.responseText ? ` Server response: ${attempt.responseText.slice(0, 300)}` : ''}`,
      });

    if (accepted) {
      const saved = attempt!.saved as SavedDocument & { id: string };
      try {
        const { state } = await refreshSectionStep(`After a refresh, "${saved.fileName}" should still be listed under ${category.name}.`);
        const listed = state.documents.find((document) => document.id === saved.id);
        const opened = listed ? await previewDocument(saved.id) : undefined;
        const contentMatches = Boolean(opened && !opened.failure && sameContent(opened.target, boundaryFile));
        const issues = [
          !listed && 'it was no longer listed',
          listed && listed.category !== category.name && `it was listed under ${listed.category}`,
          listed && !listed.name.endsWith(boundaryFile.name) && `its filename showed "${listed.name}"`,
          opened && opened.suggestedName !== saved.fileName && `it downloaded as "${opened.suggestedName}"`,
          opened && !contentMatches && `the downloaded contents (${opened.bytes.toLocaleString('en-US')} bytes) differ from the uploaded file`,
        ].filter((issue): issue is string => Boolean(issue));
        if (issues.length) failures.push(`After refresh, the 25 MiB PDF: ${issues.join('; ')}.`);
        await componentObservedCheck(page, 'Verify the 25 MiB PDF filename, category and contents',
          `"${saved.fileName}" should be listed under ${category.name} and download with exactly ${boundaryBytes.toLocaleString('en-US')} bytes identical to ${boundaryFile.name}.`,
          {
            passed: !issues.length,
            actual: listed
              ? `"${listed.name}" (${listed.size}) was listed under ${listed.category}; Preview downloaded "${opened?.suggestedName}" (${opened?.bytes.toLocaleString('en-US')} bytes)${contentMatches ? ', byte-for-byte identical to the uploaded PDF' : ''}${issues.length ? `. Difference: ${issues.join('; ')}.` : '.'}`
              : `"${saved.fileName}" was not listed in Section G after refresh.`,
          });
      } catch (error) {
        failures.push('The uploaded 25 MiB PDF could not be rechecked after refresh.');
        diagnostics.push(`Recheck 25 MiB PDF: ${errorText(error)}`);
        await componentNotExecutedStep('Verify the 25 MiB PDF filename, category and contents', 'The PDF should be listed and downloadable.', 'Section G or the document could not be reopened after refresh.');
      }
    } else {
      await componentNotExecutedStep(`Refresh the page and reopen Section ${sectionTitle} of ${componentRef()}`, 'The uploaded PDF should remain listed after refresh.', 'the 25 MiB PDF was not uploaded.');
      await componentNotExecutedStep('Verify the 25 MiB PDF filename, category and contents', 'The PDF should be listed and downloadable.', 'the 25 MiB PDF was not uploaded.');
    }

    await componentValidationStep(page, step('Verify the 25 MiB boundary upload',
      'The 25 MiB PDF should be accepted at the size boundary and remain listed with its filename, category and identical contents.'), async () => {
      assertNoFailures(failures, diagnostics);
    }, { actual: () => `The 25 MiB PDF ${boundaryFile.name} was accepted (server status ${attempt?.status}), listed under ${category.name} after refresh, and downloaded with identical contents.` });
  });

  test('CMP-155 - Reject an unsupported file format', componentScenario(
    'Choosing a file whose format is not permitted should be blocked with a message explaining the permitted formats, without any upload-success message, and no document should be added to Section G.'), async () => {
    test.setTimeout(5 * 60_000);
    const failures: string[] = [];
    const diagnostics: string[] = [];
    await selectComponentStep('any category');
    const before = await openSectionStep();
    const category = before.categories.find(hasCapacity) ?? before.categories[0];
    const permitted = category.accept;
    const unsupported = listFiles(unsupportedFolder).filter((file) => !permitted.includes(file.extension)).sort((a, b) => a.size - b.size);
    const file = unsupported[0];
    await componentObservedCheck(page, 'Select an unsupported file from the "unsupported file" folder',
      `The folder should contain a file whose format is not permitted by Section G (${permitted.join(', ')}).`,
      {
        passed: Boolean(file),
        actual: file
          ? `Selected ${file.name} (${file.extension}, ${sizeText(file.size)}); unsupported formats available: ${unsupported.map((item) => item.name).join(', ')}.`
          : `Every file in the folder has a permitted format (${listFiles(unsupportedFolder).map((item) => item.name).join(', ') || 'folder empty'}).`,
      }, { screenshot: 'failure' });
    if (!file) {
      for (const title of ['Attempt to upload the unsupported file', 'Verify the unsupported file is blocked']) {
        await componentNotExecutedStep(title, 'The unsupported file should be rejected.', 'no file with an unsupported format exists in the test folder; no replacement is generated.');
      }
      await componentValidationStep(page, step('Verify the unsupported file was rejected', 'The unsupported file should be rejected.'), async () => {
        assertNoFailures(['Prerequisite missing: no unsupported-format file in the test folder.'], diagnostics);
      });
      return;
    }

    const attempt = await componentActionStep(`Attempt to upload ${file.name} to ${category.name}`,
      `Choosing ${file.name} under ${category.name} should be blocked because ${file.extension} is not a permitted format.`,
      () => uploadThroughPicker(category, file, 60_000, 8_000),
      (result) => `${result.requestSent ? `The file was sent to the server, which responded with status ${result.status ?? 'none'}${result.saved?.id ? ` and saved "${result.saved.fileName}"` : ''}` : 'The file was not sent to the server'}; `
        + `${result.notification ? `the application displayed "${result.notification}"` : 'no message was displayed'}.`, { page });

    const created = Boolean(attempt.saved?.id);
    await page.waitForTimeout(1_000);
    const listedNow = (await readSection()).documents;
    const added = compareDocuments(before.documents, listedNow).added;
    if (created || added.length) failures.push(`The unsupported file was added to Section G${attempt.saved?.fileName ? ` as "${attempt.saved.fileName}"` : ''}.`);
    await componentObservedCheck(page, 'Verify the application blocks the unsupported format',
      `${file.name} should not be uploaded to ${componentRef()}.`,
      {
        passed: !created && !added.length,
        actual: !created && !added.length
          ? `${file.name} was not added${attempt.requestSent ? `; the server rejected it with status ${attempt.status ?? 'none'}` : '; the file was not sent to the server'}.`
          : `${file.name} was accepted: ${attempt.saved?.fileName ? `the server saved "${attempt.saved.fileName}"` : ''}${added.length ? ` Section G now lists ${documentsText(added)}` : ''}.`,
      });

    const message = attempt.notification;
    const guidance = /format|type|support|allow|permit|\.?pdf|docx?|jpe?g|png/i.test(message);
    if (!message) failures.push('No validation message was displayed for the unsupported file.');
    else if (!guidance) failures.push(`The message "${message}" does not explain the permitted formats.`);
    await componentObservedCheck(page, 'Capture the unsupported-format validation message',
      `A message should state that ${file.extension} is not supported and indicate the permitted formats (${permitted.join(', ')}).`,
      { passed: Boolean(message) && guidance, actual: message ? `The application displayed: "${message}".` : 'No validation message was displayed.' });

    const falseSuccess = /success|uploaded/i.test(message) && !/not|fail|invalid|unsupported/i.test(message);
    if (falseSuccess) failures.push(`A success message was displayed for the unsupported file: "${message}".`);
    await componentObservedCheck(page, 'Verify no false upload-success message appears',
      'No message should claim that the unsupported file was uploaded.',
      { passed: !falseSuccess, actual: falseSuccess ? `The application displayed a success message: "${message}".` : `No upload-success message was displayed${message ? `; the only message was "${message}"` : ''}.` });

    try {
      const { state: after } = await refreshSectionStep(`After a refresh, Section G should still list the same ${before.documents.length} document(s) and no ${file.extension} document.`);
      const comparison = compareDocuments(before.documents, after.documents);
      const unsupportedListed = after.documents.filter((document) => document.name.toLowerCase().endsWith(file.extension));
      if (!comparison.unchanged) failures.push(`After refresh, Section G changed: ${comparison.differences.join('; ')}.`);
      await componentObservedCheck(page, 'Verify no unsupported document was added and existing documents are unchanged',
        `No ${file.extension} document should be listed, and the ${before.documents.length} existing document(s) should be unchanged.`,
        {
          passed: comparison.unchanged && !unsupportedListed.length,
          actual: comparison.unchanged
            ? `After refresh, Section G listed the same ${after.documents.length} document(s) and no ${file.extension} document (${categoriesText(after.categories)}).`
            : `After refresh: ${comparison.differences.join('; ')}.`,
        });
    } catch (error) {
      failures.push('Section G could not be reopened after refresh, so the documents were not rechecked.');
      diagnostics.push(`Refresh after unsupported upload: ${errorText(error)}`);
      await componentNotExecutedStep('Verify no unsupported document was added and existing documents are unchanged', 'No unsupported document should be listed.', 'Section G could not be reopened after the refresh.');
    }

    await componentValidationStep(page, step('Verify the unsupported file was rejected',
      `${file.name} should be rejected with permitted-format guidance, with no success message and no document added.`), async () => {
      assertNoFailures(failures, diagnostics);
    }, { actual: () => `${file.name} was rejected with the message "${message}", no success message appeared, and Section G was unchanged after refresh.` });
  });

  test('CMP-157 - Section G before the component is saved', componentScenario(
    `On an unsaved Add Component form, Section G should display exactly "${unsavedComponentMessage}" and offer no document upload until the component is created; leaving the form should create no component and attach no document.`), async () => {
    test.setTimeout(4 * 60_000);
    const failures: string[] = [];
    const diagnostics: string[] = [];
    const watcher = watchRequests();
    try {
      const form = await componentActionStep('Click Add Component without saving',
        `The Add Component form should open for Vessel ${vessel}; it is not saved, so no component is created.`,
        async () => {
          const opened = await components.openComponentForAdd();
          await expect(page.getByText('A. Component Information', { exact: true }), 'The Add Component form should open').toBeVisible({ timeout: 15_000 });
          return opened;
        },
        () => `The Add Component form opened for Vessel ${vessel} with A. Component Information displayed; nothing was entered or saved.`, { page });

      const sectionState = await componentActionStep(`Open Section ${sectionTitle} on the unsaved form`,
        `Section ${sectionTitle} should be displayed on the unsaved Add Component form.`,
        async () => {
          const heading = page.getByText(sectionTitle, { exact: true }).filter({ visible: true }).first();
          await expect(heading, `${sectionTitle} should be displayed on the Add Component form`).toBeVisible({ timeout: 15_000 });
          await heading.scrollIntoViewIfNeeded();
          // Reads the smallest block around the heading that holds the section's own content.
          return heading.evaluate((node) => {
            const title = (node as HTMLElement).innerText.trim();
            let block: HTMLElement | null = node as HTMLElement;
            while (block?.parentElement && block.parentElement.innerText.trim() === title) block = block.parentElement;
            block = block?.parentElement ?? null;
            if (!block) return { lines: [] as string[], uploadControls: [] as string[], fileInputs: 0, enabledFileInputs: 0, documents: 0, isolated: false };
            const lines = block.innerText.split('\n').map((line) => line.trim()).filter((line) => line && line !== title);
            const uploadControls = [...block.querySelectorAll('button, [role="button"]')]
              .filter((control) => /upload/i.test((control as HTMLElement).innerText))
              .map((control) => `${(control as HTMLElement).innerText.trim()} (${(control as HTMLButtonElement).disabled ? 'disabled' : 'enabled'})`);
            const inputs = [...block.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
            return {
              lines,
              uploadControls,
              fileInputs: inputs.length,
              enabledFileInputs: inputs.filter((input) => !input.disabled).length,
              documents: block.querySelectorAll('[data-testid^="doc-icon-"]').length,
              isolated: !/A\. Component Information/.test(block.innerText),
            };
          });
        },
        (value) => `Section ${sectionTitle} was displayed; its content read: ${value.lines.length ? value.lines.map((line) => `"${line}"`).join(', ') : 'no text'}.`, { page });

      const shownMessage = sectionState.lines.join(' ');
      const exactMessage = sectionState.isolated && sectionState.lines.includes(unsavedComponentMessage);
      if (!exactMessage) failures.push(`Section G showed ${shownMessage ? `"${shownMessage}"` : 'no message'} instead of exactly "${unsavedComponentMessage}".`);
      await componentObservedCheck(page, 'Verify the unsaved-component documents message',
        `Section G should display exactly "${unsavedComponentMessage}".`,
        { passed: exactMessage, actual: shownMessage ? `Section G displayed "${shownMessage}"${exactMessage ? ', which matches exactly.' : `, which does not exactly match "${unsavedComponentMessage}".`}` : 'Section G displayed no message.' });

      const uploadAvailable = sectionState.uploadControls.some((control) => control.endsWith('(enabled)')) || sectionState.enabledFileInputs > 0;
      if (uploadAvailable || !sectionState.isolated) failures.push(sectionState.isolated ? `Document upload was available before saving: ${sectionState.uploadControls.join(', ') || `${sectionState.enabledFileInputs} file input(s)`}.` : 'Section G content could not be separated from the rest of the form, so the upload restriction could not be confirmed.');
      await componentObservedCheck(page, 'Verify document upload is unavailable before saving',
        'The unsaved component should offer no Upload control or file selection in Section G.',
        {
          passed: !uploadAvailable && sectionState.isolated,
          actual: `Section G offered ${sectionState.uploadControls.length ? `Upload control(s): ${sectionState.uploadControls.join(', ')}` : 'no Upload control'} and ${sectionState.fileInputs} file input(s)${sectionState.enabledFileInputs ? ` (${sectionState.enabledFileInputs} enabled)` : ''}.`,
        });

      const uploads = watcher.documentUploads();
      if (uploads.length || sectionState.documents) failures.push(`${uploads.length} document upload request(s) were sent and ${sectionState.documents} document(s) were listed for the unsaved component.`);
      await componentObservedCheck(page, 'Verify no document was uploaded or attached',
        'No document should be uploaded to or listed for the unsaved component.',
        { passed: !uploads.length && !sectionState.documents, actual: `${uploads.length} document upload request(s) were sent and ${sectionState.documents} document(s) were listed in Section G.` });

      await componentActionStep('Exit the unsaved Add Component form without saving',
        'Leaving the form should return to the Components page without creating a component.',
        async () => {
          await form.back();
          return watcher.componentCreates().length;
        },
        (creates) => `The form was closed without saving and the Components page was displayed; ${creates} component create request(s) were sent.`, { page });
      const creates = watcher.componentCreates();
      if (creates.length) failures.push(`${creates.length} component create request(s) were sent although the form was not saved.`);
      await componentObservedCheck(page, 'Verify no component was created',
        'No component should be created because the form was never saved.',
        { passed: !creates.length, actual: `${creates.length} component create request(s) were sent while the unsaved form was open and closed.` }, { screenshot: 'failure' });
    } catch (error) {
      diagnostics.push(errorText(error));
      throw businessError('The unsaved Add Component form could not be checked completely.', error);
    } finally {
      watcher.stop();
    }

    await componentValidationStep(page, step('Verify Section G before the component is created',
      `Section G should show exactly "${unsavedComponentMessage}" and offer no upload until the component is created.`), async () => {
      assertNoFailures(failures, diagnostics);
    }, { actual: () => `Section G displayed exactly "${unsavedComponentMessage}", offered no upload, and no document or component was created.` });
  });
});
