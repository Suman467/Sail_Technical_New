/* global HTMLElement, requestAnimationFrame */
import { expect, type Locator, type Page } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { snapshotSpareGrid, spareRowFromSnapshot, type ComponentSpareRow } from './ComponentsPage';

/** Result of searching one exact Part Code in the Spares Inventory grid. */
export type SparesModuleSearch = {
  /** Rows whose Part Code equals the searched code exactly, read across every grid column. */
  exact: ComponentSpareRow[];
  /** Rows the search returned on the displayed page, including partial matches. */
  returned: number;
  /** The grid's own count text, for example "Showing 1 - 1 of 1 spares". */
  countText: string;
  /** True when the grid reports more results than the displayed page holds. */
  morePages: boolean;
};

export class SparesPage extends BasePage {
  protected readonly path = routes.spares;
  protected readonly pageName = 'Spares';
  protected readonly pageLoadedIndicator: Locator;
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole('heading', { name: 'Spares Inventory', exact: true });
  }
  public async selectVessel(name = config.vesselName): Promise<void> {
    await this.page.getByRole('combobox').first().click();
    await this.page.getByRole('option', { name, exact: true }).click();
  }
  private get vesselSelector(): Locator {
    const labelled = this.page.getByText('Vessel:', { exact: true }).locator('..').getByRole('combobox');
    return labelled.or(this.page.getByRole('combobox').first()).first();
  }

  private get searchField(): Locator {
    return this.page.getByRole('textbox', { name: 'Search parts or components...' })
      .or(this.page.getByPlaceholder('Search parts or components...')).first();
  }

  private get inventoryGrid(): Locator {
    return this.page.locator('.ag-root-wrapper').filter({ has: this.page.getByRole('columnheader', { name: /^Part Code/ }) }).first();
  }

  private get countLabel(): Locator {
    return this.page.getByText(/^Showing\s+\d+\s*-\s*\d+\s+of\s+\d+\s+spares?$/i).first();
  }

  /**
   * Opens Spares Inventory in the current authenticated tab and waits for its grid.
   * Asserts directly rather than through expectToBeOnPage, so the caller's business
   * step is not followed by a separate generic page-open row.
   */
  public async openInventory(): Promise<void> {
    await this.page.goto(this.path, { waitUntil: 'domcontentloaded' });
    await expect(this.page, 'The Spares module should open').toHaveURL(this.path);
    await expect(this.pageLoadedIndicator, 'The Spares Inventory page should be ready').toBeVisible({ timeout: 30_000 });
    await expect(this.inventoryGrid, 'The Spares Inventory grid should be displayed').toBeVisible({ timeout: 30_000 });
  }

  /** The Spares module keeps its own vessel; selects the requested one only when another is shown. */
  public async ensureVessel(name: string): Promise<{ before: string; changed: boolean }> {
    const selector = this.vesselSelector;
    await expect.poll(async () => (await selector.innerText()).trim(), {
      message: 'The Spares vessel selector should finish loading', timeout: 30_000,
    }).not.toBe('');
    const before = (await selector.innerText()).replace(/\s+/g, ' ').trim();
    if (before === name) return { before, changed: false };
    await selector.click();
    const option = this.page.getByRole('option', { name, exact: true });
    await expect(option, `Vessel ${name} should be offered in the Spares module`).toBeVisible({ timeout: 30_000 });
    await option.click();
    await expect(selector, `The Spares module should switch to Vessel ${name}`).toContainText(name);
    await this.waitForGridToSettle(`The Spares Inventory grid should reload for Vessel ${name}`);
    return { before, changed: true };
  }

  /** Displayed text of the vessel selector, Criticality, Rotation Item and Stock filters. */
  public async readFilters(): Promise<string[]> {
    return (await this.page.getByRole('combobox').allInnerTexts()).map((value) => value.replace(/\s+/g, ' ').trim());
  }

  /**
   * Searches one Part Code and waits until every returned row contains it (or the
   * grid is empty), then reads all columns of the rows whose Part Code is exact.
   */
  public async searchExactPartCode(partCode: string): Promise<SparesModuleSearch> {
    const needle = partCode.trim().toLowerCase();
    await this.searchField.fill(partCode);
    await expect(this.searchField).toHaveValue(partCode);
    const grid = this.inventoryGrid;
    let settled = '';
    let stable = 0;
    await expect.poll(async () => {
      const snapshot = await snapshotSpareGrid(grid, false);
      const rows = snapshot.rows.map((row) => spareRowFromSnapshot(snapshot, row)).filter((row) => row.partCode || row.partName);
      const filtered = rows.every((row) => `${row.partCode} ${row.partName} ${row.componentName} ${row.partNumber}`.toLowerCase().includes(needle));
      const signature = `${await this.countLabel.innerText().catch(() => '')}|${rows.map((row) => row.partCode).join(',')}`;
      stable = filtered && signature === settled ? stable + 1 : 0;
      settled = signature;
      return stable;
    }, { message: `The Spares search for ${partCode} should finish filtering`, timeout: 20_000, intervals: [250, 250, 500] })
      .toBeGreaterThanOrEqual(2);
    const snapshot = await snapshotSpareGrid(grid, true);
    const rows = snapshot.rows.map((row) => spareRowFromSnapshot(snapshot, row)).filter((row) => row.partCode || row.partName);
    const countText = (await this.countLabel.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const [, last, total] = countText.match(/(\d+)\s+of\s+(\d+)/i) ?? [];
    return {
      exact: rows.filter((row) => row.partCode.trim().toLowerCase() === needle),
      returned: rows.length,
      countText,
      morePages: Boolean(total) && Number(total) > Number(last),
    };
  }

  /** Scrolls the grid right until the Stock column is displayed, for evidence screenshots. */
  public async revealStockColumn(): Promise<boolean> {
    return this.inventoryGrid.evaluate(async (node) => {
      // ag-grid drives the center columns from its horizontal scrollbar; scrolling
      // only the center viewport is undone on the next render, so both are moved.
      const bar = node.querySelector<HTMLElement>('.ag-body-horizontal-scroll-viewport');
      const center = node.querySelector<HTMLElement>('.ag-center-cols-viewport');
      const scroller = [bar, center].find((item) => item && item.scrollWidth > item.clientWidth + 1);
      if (!scroller) return Boolean(node.querySelector('[role="columnheader"][col-id="stockStatus"]'));
      const scrollTo = (left: number) => {
        for (const item of [bar, center]) if (item) item.scrollLeft = left;
      };
      const frames = async () => { for (let index = 0; index < 3; index += 1) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); };
      const visible = () => {
        const header = node.querySelector<HTMLElement>('[role="columnheader"][col-id="stockStatus"]')
          ?? [...node.querySelectorAll<HTMLElement>('[role="columnheader"]')].find((item) => /^Stock$/i.test(item.innerText.trim()));
        if (!header) return false;
        const area = (center ?? scroller).getBoundingClientRect();
        const box = header.getBoundingClientRect();
        return box.left >= area.left - 1 && box.right <= area.right + 1;
      };
      const max = scroller.scrollWidth - scroller.clientWidth;
      for (let left = 0; !visible(); left = Math.min(left + Math.max(scroller.clientWidth * 0.5, 50), max)) {
        scrollTo(left);
        await frames();
        if (left >= max) break;
      }
      return visible();
    });
  }

  /** Clears the Part Code search so the module is left unfiltered. */
  public async clearSearch(): Promise<void> {
    if (await this.searchField.inputValue().catch(() => '')) {
      await this.searchField.fill('');
      await expect(this.searchField).toHaveValue('');
    }
  }

  private async waitForGridToSettle(message: string): Promise<void> {
    let previous = '';
    let stable = 0;
    await expect.poll(async () => {
      const current = `${await this.countLabel.innerText().catch(() => '')}|${await this.inventoryGrid.locator('[role="row"][row-id]').count()}`;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      return stable;
    }, { message, timeout: 30_000, intervals: [250, 250, 500] }).toBeGreaterThanOrEqual(2);
  }

  public async readSpareByPartCode(partCode: string, componentCode: string): Promise<ComponentSpareRow | null> {
    const search = this.page.getByRole('textbox', { name: 'Search parts or components...' });
    const table = this.page.locator('[role="grid"], table').filter({ hasText: 'Part Code' }).first();
    await expect(table, 'The Spares records table should be visible').toBeVisible();
    const tableTextBeforeSearch = await table.innerText();
    if (await search.count()) {
      await search.fill(partCode);
      await expect(search).toHaveValue(partCode);
      if (!tableTextBeforeSearch.toLowerCase().includes(partCode.toLowerCase())) {
        await expect.poll(async () => table.innerText(), {
          message: `The Spares table should respond to the search for ${partCode}`,
          timeout: 10_000,
          intervals: [200, 300, 500],
        }).not.toBe(tableTextBeforeSearch);
      }
    }
    let previousTableText: string | undefined;
    let stableChecks = 0;
    await expect.poll(async () => {
      const currentTableText = await table.innerText();
      stableChecks = currentTableText === previousTableText ? stableChecks + 1 : 0;
      previousTableText = currentTableText;
      return stableChecks;
    }, {
      message: `The Spares search results for ${partCode} should finish updating`,
      timeout: 10_000,
      intervals: [200, 300, 500],
    }).toBeGreaterThanOrEqual(2);
    const headers = (await table.locator('[role="columnheader"], thead th').allInnerTexts()).map((value) => value.trim().toLowerCase());
    const rows = table.locator('[role="row"], tbody tr');
    for (let index = 0; index < await rows.count(); index += 1) {
      const values = (await rows.nth(index).locator('[role="gridcell"], td').allInnerTexts()).map((value) => value.trim());
      const valueFor = (pattern: RegExp) => {
        const column = headers.findIndex((header) => pattern.test(header));
        return column >= 0 ? values[column] ?? '' : '';
      };
      if (valueFor(/^part code$/i).toLowerCase() !== partCode.toLowerCase()) continue;
      const displayedComponentCode = valueFor(/^component code$/i);
      if (displayedComponentCode && displayedComponentCode.toLowerCase() !== componentCode.toLowerCase()) continue;
      return {
        partCode: valueFor(/^part code$/i),
        partName: valueFor(/^part name$/i),
        componentName: valueFor(/^component(?: name)?$/i),
        partNumber: valueFor(/^part number$/i),
        rob: valueFor(/^rob$|total rob/i),
        min: valueFor(/^min(?:imum)?$/i),
        stock: valueFor(/^stock$/i),
        location: valueFor(/^location$/i),
      };
    }
    return null;
  }
}
