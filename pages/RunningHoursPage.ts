/* global document, HTMLElement */

import { expect, type Locator, type Page } from '@playwright/test';

import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';

export type RunningHoursUiRow = {
  componentName: string;
  componentCode: string;
  componentCategory: string;
  runningHours: string;
  inheritedRh: string;
};

/** One Running Hours grid row read by column id, including its Last Updated value. */
export type RunningHoursGridRow = {
  rowIndex: number;
  componentName: string;
  componentCode: string;
  componentCategory: string;
  runningHours: string;
  lastUpdated: string;
  inheritedRh: string;
};

/** The Running Hours footer: "Showing N components" or, while filtered, "Showing N of T components". */
export type RunningHoursCount = { shown: number; total: number; text: string };

/** The rows and footer count shown after a Running Hours component search settles. */
export type RunningHoursSearchResult = RunningHoursCount & { rows: RunningHoursGridRow[] };

const COMPONENT_COUNT = /^Showing\s+([\d,]+)(?:\s+of\s+([\d,]+))?\s+components?$/;

/**
 * Models the Running Hours overview screen in the Technical > PMS module.
 * The page reads the rendered grid only; it does not call application APIs.
 */
export class RunningHoursPage extends BasePage {
  protected readonly path = routes.runningHours;
  protected readonly pageName = 'Running Hours';
  protected readonly pageLoadedIndicator: Locator;

  private readonly vesselDropdown: Locator;
  private readonly overviewTab: Locator;
  private readonly runningHoursTable: Locator;
  private readonly overviewDataRows: Locator;
  private readonly componentSearchField: Locator;
  private readonly componentCount: Locator;

  public constructor(page: Page) {
    super(page);

    this.pageLoadedIndicator = page.getByRole('heading', {
      name: 'Running Hours',
      exact: true,
    });

    this.vesselDropdown = page.getByRole('combobox').first();

    this.overviewTab = page
      .getByRole('tab', { name: 'Overview', exact: true })
      .or(page.getByRole('button', { name: 'Overview', exact: true }));

    // The application renders a role="grid", not a <table>.
    this.runningHoursTable = page.getByRole('grid').first();
    this.overviewDataRows = this.runningHoursTable.locator(
      '[role="row"]:has([role="cell"], [role="gridcell"], td)',
    );
    this.componentSearchField = page.getByPlaceholder('Search Component', { exact: true });
    this.componentCount = page.getByText(COMPONENT_COUNT);
  }

  /** Waits for the Running Hours heading without recording a report step. */
  public async waitForScreen(): Promise<void> {
    await expect(this.page, 'The Running Hours page should open').toHaveURL(new RegExp(`${routes.runningHours}(?:[?#]|$)`));
    await expect(this.pageLoadedIndicator, 'The Running Hours heading should be displayed').toBeVisible();
  }

  /** Returns the vessel currently shown in the Running Hours vessel selector once it has hydrated. */
  public async selectedVesselName(): Promise<string> {
    // Other PMS pages use the same selector position; never read or change theirs.
    await this.waitForScreen();
    let selected = '';
    await expect.poll(async () => {
      selected = (await this.vesselDropdown.textContent())?.trim() ?? '';
      return selected;
    }, { message: 'The Running Hours vessel selection should finish loading' }).not.toMatch(/^(?:select\s+vessel)?$/i);
    return selected;
  }

  /** Reads the vessel names offered by the selector and closes it again. */
  public async vesselOptions(): Promise<string[]> {
    await this.waitForScreen();
    await this.vesselDropdown.click();
    const options = this.page.getByRole('option');
    await expect(options.first(), 'The Running Hours vessel list should open').toBeVisible();
    const names = (await options.allInnerTexts()).map((name) => name.trim()).filter(Boolean);
    await this.page.keyboard.press('Escape');
    await expect(options.first(), 'The Running Hours vessel list should close').toBeHidden();
    return names;
  }

  /**
   * Selects a vessel only when it is not already selected (returns undefined
   * then). The application requests a vessel's Running Hours only the first
   * time in a session and reuses that data afterwards, so the request is
   * awaited when it is made and its occurrence is returned.
   */
  public async selectVesselAndWaitForData(name: string): Promise<{ requested: boolean } | undefined> {
    if (await this.selectedVesselName() === name) return undefined;
    await this.vesselDropdown.click();
    const option = this.page.getByRole('option', { name, exact: true });
    await expect(option, `Vessel ${name} should be offered in the Running Hours vessel list`).toBeVisible();
    const request = this.page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/technical/api/running-hours/parents')
      && response.request().method() === 'GET', { timeout: 5_000 }).then((response) => response, () => undefined);
    await option.click();
    const response = await request;
    expect(response?.ok() ?? true, `The Running Hours data request for Vessel ${name} should succeed`).toBe(true);
    await expect(this.vesselDropdown, `Vessel ${name} should be selected in Running Hours`).toHaveText(name);
    return { requested: Boolean(response) };
  }

  /**
   * Reads every Running Hours row by column id. The grid renders only the rows
   * in view, so its own scrolling body is scrolled from top to bottom and each
   * row is collected once by its row index.
   */
  public async readAllRows(): Promise<RunningHoursGridRow[]> {
    const viewport = this.runningHoursTable.locator('.ag-body-viewport').first();
    const rows = new Map<number, RunningHoursGridRow>();
    const readRendered = () => this.runningHoursTable.evaluate((grid) => {
      const byIndex = new Map<number, Record<string, string>>();
      for (const row of Array.from(grid.querySelectorAll('[role="row"][row-index]'))) {
        const index = Number(row.getAttribute('row-index'));
        const cells = byIndex.get(index) ?? {};
        // Pinned columns render a row's cells in separate row elements with the same index.
        for (const cell of Array.from(row.querySelectorAll('[role="gridcell"][col-id]'))) {
          cells[cell.getAttribute('col-id') ?? ''] = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
        byIndex.set(index, cells);
      }
      return [...byIndex.entries()];
    });
    const position = () => viewport.evaluate((node) => ({ top: node.scrollTop, height: node.clientHeight, total: node.scrollHeight }));

    const collect = async () => {
      for (const [rowIndex, cells] of await readRendered()) {
        rows.set(rowIndex, {
          rowIndex,
          componentName: cells.component ?? '',
          componentCode: cells.sfiCode ?? '',
          componentCategory: cells.componentCategory ?? '',
          runningHours: cells.runningHours ?? '',
          lastUpdated: cells.lastUpdated ?? '',
          inheritedRh: cells.inheritedCount ?? '',
        });
      }
    };

    if (!(await viewport.count())) {
      await collect();
      return [...rows.values()].sort((first, second) => first.rowIndex - second.rowIndex);
    }
    // aria-rowcount counts the header row as well as every (filtered) data row.
    const declared = Number(await this.runningHoursTable.getAttribute('aria-rowcount')) - 1;
    const expected = Number.isFinite(declared) && declared >= 0 ? declared : undefined;
    const complete = () => expected !== undefined && rows.size >= expected;
    await viewport.evaluate((node) => { node.scrollTop = 0; });
    for (let pass = 0; pass < 200; pass += 1) {
      await collect();
      const { top, height, total } = await position();
      if (complete() || top + height >= total - 1) break;
      const seen = rows.size;
      await viewport.evaluate((node) => { node.scrollTop += Math.max(node.clientHeight * 0.8, 1); });
      // Wait for rows the grid says exist below to render, rather than a fixed delay.
      await expect.poll(async () => {
        await collect();
        const now = await position();
        return rows.size > seen || complete() || now.top + now.height >= now.total - 1;
      }, { message: 'The next Running Hours rows should render while scrolling', timeout: 10_000 }).toBe(true);
    }
    await viewport.evaluate((node) => { node.scrollTop = 0; });
    return [...rows.values()].sort((first, second) => first.rowIndex - second.rowIndex);
  }

  /** Waits until the footer count has stayed unchanged for a moment and returns it. */
  public async readComponentCount(): Promise<RunningHoursCount> {
    let last = '';
    let since = Date.now();
    await expect.poll(async () => {
      const text = (await this.componentCount.first().innerText().catch(() => '')).trim();
      if (text !== last) {
        last = text;
        since = Date.now();
      }
      return Boolean(last) && Date.now() - since >= 1_500;
    }, { message: 'The Running Hours component count should finish loading', timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
    const match = COMPONENT_COUNT.exec(last)!;
    const shown = Number(match[1].replace(/,/g, ''));
    return { shown, total: match[2] ? Number(match[2].replace(/,/g, '')) : shown, text: last };
  }

  /**
   * Types a search term and waits for the filtered table to settle: the
   * displayed rows all contain the term, or the footer reports none.
   */
  public async searchComponents(term: string): Promise<RunningHoursSearchResult> {
    await expect(this.componentSearchField, 'The Running Hours component search should be available').toBeVisible();
    await this.componentSearchField.fill(term);
    await expect(this.componentSearchField).toHaveValue(term);
    const lowerTerm = term.toLowerCase();
    await expect.poll(async () => {
      const text = (await this.componentCount.first().innerText().catch(() => '')).trim();
      if (/^Showing\s+0\b/.test(text)) return true;
      const names = await this.overviewDataRows.evaluateAll((rows) =>
        rows.map((row) => row.querySelector('[role="gridcell"], [role="cell"], td')?.textContent ?? ''));
      return names.length > 0 && names.every((name) => name.toLowerCase().includes(lowerTerm));
    }, { message: `The Running Hours search for "${term}" should finish filtering`, timeout: 15_000 }).toBe(true);
    const count = await this.readComponentCount();
    return { ...count, rows: await this.readAllRows() };
  }

  /** Clears the component search and returns the settled, unfiltered count. */
  public async clearComponentSearch(): Promise<RunningHoursCount> {
    await this.componentSearchField.fill('');
    await expect(this.componentSearchField).toHaveValue('');
    await expect(this.componentCount.first(), 'The unfiltered Running Hours count should return').not.toContainText(' of ');
    return this.readComponentCount();
  }

  /**
   * Selects the vessel and waits until the Running Hours screen is ready again.
   */
  public async selectVessel(name = config.vesselName): Promise<void> {
    await expect(
      this.pageLoadedIndicator,
      'The Running Hours page should be ready before selecting a vessel',
    ).toBeVisible();

    await this.vesselDropdown.click();

    await this.page.getByRole('option', {
      name,
      exact: true,
    }).click();

    await expect(this.vesselDropdown).toHaveText(name);

    await expect(
      this.overviewTab,
      'The Running Hours Overview tab should remain available after vessel selection',
    ).toBeVisible();
  }

  /**
   * Reads every rendered Running Hours row from the UI.
   * If the grid uses an internal scroll container, the method scrolls it
   * and collects each unique component code before returning to the top.
   */
  public async readOverviewRows(
    options: { allowEmpty?: boolean } = {},
  ): Promise<RunningHoursUiRow[]> {
    // The footer is authoritative, even if the empty grid still says loading.
    // Restart the quiet period whenever the count changes or disappears.
    const componentCount = this.page.getByText(/^Showing\s+[\d,]+\s+components?$/);
    let currentCount = -1;
    let unchangedSince = Date.now();

    await expect.poll(async () => {
      if (!await componentCount.isVisible()) {
        currentCount = -1;
        unchangedSince = Date.now();
        return false;
      }
      const text = await componentCount.innerText();
       const match = /^Showing\s+([\d,]+)\s+components?$/.exec(text.trim());
      const count = match ? Number(match[1].replace(/,/g, '')) : -1;
      if (count !== currentCount || count < 0) {
        currentCount = count;
        unchangedSince = Date.now();
      }
      return currentCount >= 0 && Date.now() - unchangedSince >= 2_000;
    }, {
      message: 'The Running Hours footer component count should settle',
      timeout: 15_000,
      intervals: [100, 250, 500],
    }).toBe(true);

    if (currentCount === 0) {
      expect(
        options.allowEmpty,
        'Running Hours is empty; pass allowEmpty only when the scenario validates whether zero rows are expected.',
      ).toBe(true);
      return [];
    }

    await expect(this.runningHoursTable).toBeVisible();
    await expect(this.overviewDataRows.first(),
      'A non-zero component count should render Running Hours rows',
    ).toBeVisible();

    const rowsByCode = new Map<string, RunningHoursUiRow>();

    const readSnapshot = async () =>
      this.page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(
          '[role="grid"]',
        );

        if (!grid) {
          return {
            rows: [] as RunningHoursUiRow[],
            scrollTop: 0,
            clientHeight: 0,
            scrollHeight: 0,
            hasScroller: false,
          };
        }

        const headerCells = Array.from(
          grid.querySelectorAll<HTMLElement>(
            '[role="columnheader"]',
          ),
        );

        const headers = headerCells.map((cell) =>
          cell.innerText.trim().toLowerCase(),
        );

        const indexOf = (
          pattern: RegExp,
          startAt = 0,
        ): number =>
          headers.findIndex(
            (header, index) =>
              index >= startAt && pattern.test(header),
          );

        const nameIndex = indexOf(/component\s*name/);

        const componentPlaceholderIndexes = headers
          .map((header, index) => ({ header, index }))
          .filter(
            ({ header, index }) =>
              index > nameIndex &&
              /component\s*(?:code|category|c\s*\.{2,}|\.{2,}|c…)/.test(
                header,
              ),
          )
          .map(({ index }) => index);

        const codeIndex =
          indexOf(/component\s*code/, nameIndex + 1) >= 0
            ? indexOf(/component\s*code/, nameIndex + 1)
            : componentPlaceholderIndexes[0];

        const categoryIndex =
          indexOf(/component\s*category/, nameIndex + 1) >= 0
            ? indexOf(/component\s*category/, nameIndex + 1)
            : componentPlaceholderIndexes.find(
                (index) => index !== codeIndex,
              );

        const runningHoursIndex = indexOf(/running\s*hours/);
        const inheritedIndex = indexOf(/inherited\s*rh/);

        const resolvedCodeIndex = codeIndex ?? 1;
        const resolvedCategoryIndex = categoryIndex ?? 2;

        const rowElements = Array.from(
          grid.querySelectorAll<HTMLElement>('[role="row"]'),
        ).filter(
          (row) =>
            !row.querySelector('[role="columnheader"]'),
        );

        const rows = rowElements
          .map((row) => {
            const cells = Array.from(
              row.querySelectorAll<HTMLElement>(
                '[role="cell"], [role="gridcell"], td',
              ),
            ).map((cell) => cell.innerText.trim());

            return {
              componentName:
                cells[nameIndex >= 0 ? nameIndex : 0] ?? '',
              componentCode:
                cells[resolvedCodeIndex] ?? '',
              componentCategory:
                cells[resolvedCategoryIndex] ?? '',
              runningHours:
                cells[
                  runningHoursIndex >= 0
                    ? runningHoursIndex
                    : 3
                ] ?? '',
              inheritedRh:
                cells[
                  inheritedIndex >= 0
                    ? inheritedIndex
                    : 6
                ] ?? '',
            };
          })
          .filter(
            (row) =>
              row.componentCode ||
              row.componentName,
          );

        // The application can render a virtualized grid. The grid itself
        // may be the scroll container, so check it before its ancestors.
        let scroller: HTMLElement | null = grid;

        while (scroller && scroller !== document.body) {
          if (
            scroller.scrollHeight >
            scroller.clientHeight + 1
          ) {
            break;
          }

          scroller = scroller.parentElement;
        }

        if (!scroller || scroller === document.body) {
          scroller = null;
        }

        return {
          rows,
          scrollTop: scroller?.scrollTop ?? 0,
          clientHeight: scroller?.clientHeight ?? 0,
          scrollHeight: scroller?.scrollHeight ?? 0,
          hasScroller: Boolean(scroller),
        };
      });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const snapshot = await readSnapshot();

      for (const row of snapshot.rows) {
        const code = row.componentCode.trim();

        if (code) {
          rowsByCode.set(code, row);
        }
      }

      if (
        !snapshot.hasScroller ||
        snapshot.scrollTop + snapshot.clientHeight >=
          snapshot.scrollHeight - 2
      ) {
        break;
      }

      const previousScrollTop = snapshot.scrollTop;

      await this.page.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(
          '[role="grid"]',
        );

        if (!grid) {
          return;
        }

        let scroller: HTMLElement | null = grid;

        while (scroller && scroller !== document.body) {
          if (
            scroller.scrollHeight >
            scroller.clientHeight + 1
          ) {
            break;
          }

          scroller = scroller.parentElement;
        }

        if (
          scroller &&
          scroller !== document.body
        ) {
          scroller.scrollTop = Math.min(
            scroller.scrollTop +
              Math.max(scroller.clientHeight * 0.8, 1),
            scroller.scrollHeight,
          );
        }
      });

      await this.page.waitForTimeout(150);

      const afterScroll = await readSnapshot();

      if (
        afterScroll.scrollTop <= previousScrollTop &&
        afterScroll.rows.every(
          (row) =>
            !row.componentCode ||
            rowsByCode.has(row.componentCode.trim()),
        )
      ) {
        break;
      }
    }

    await this.page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(
        '[role="grid"]',
      );

      if (!grid) {
        return;
      }

      let scroller: HTMLElement | null = grid;

      while (scroller && scroller !== document.body) {
        if (
          scroller.scrollHeight >
          scroller.clientHeight + 1
        ) {
          break;
        }

        scroller = scroller.parentElement;
      }

      if (
        scroller &&
        scroller !== document.body
      ) {
        scroller.scrollTop = 0;
      }
    });

    return [...rowsByCode.values()];
  }}
