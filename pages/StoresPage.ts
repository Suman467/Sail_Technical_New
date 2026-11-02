import { expect, type Locator, type Page } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';

export type StoreType = 'Stores' | 'Lubes' | 'Chemicals' | 'Others';
/** `locationRob` is the grid Location cell text, which shows Location A and Location B ROB as "@ A / B". */
export type StoreUiRecord = { itemCode: string; itemName: string; category: string; uom: string; rob: string; locationRob: string };

export class StoresPage extends BasePage {
  protected readonly path = routes.stores;
  protected readonly pageName = 'Stores';
  protected readonly pageLoadedIndicator: Locator;

  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole('heading', { name: 'Stores Inventory', exact: true });
  }

  public async selectVessel(name = config.vesselName): Promise<void> {
    const vessel = this.page.getByRole('combobox').first();
    await vessel.click();
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect(vessel, `The Stores vessel should be ${name}`).toContainText(name);
  }

  public async selectStoreType(storeType: StoreType): Promise<void> {
    await this.page.getByRole('button', { name: storeType, exact: true }).click();
    await expect(
      this.page.getByRole('heading', { name: `${storeType} Inventory`, exact: true }),
      `The ${storeType} inventory should finish opening`,
    ).toBeVisible();
  }

  public async readRecord(itemCode: string): Promise<StoreUiRecord | null> {
    const search = this.page.getByRole('textbox', { name: 'Search' });
    const grid = this.page.getByRole('grid').first();
    await expect(grid, 'The Stores inventory grid should be visible').toBeVisible();
    await search.fill(itemCode);
    await expect(search).toHaveValue(itemCode);
    await expect.poll(async () => Boolean(await this.findVisibleRecord(grid, itemCode)), {
      message: `The Stores search results should include exact Item Code ${itemCode}`,
      timeout: 10_000,
      intervals: [200, 300, 500],
    }).toBe(true).catch(() => undefined);
    return this.findVisibleRecord(grid, itemCode);
  }

  private async findVisibleRecord(grid: Locator, itemCode: string): Promise<StoreUiRecord | null> {
    const headers = (await grid.getByRole('columnheader').allInnerTexts()).map((value) => value.trim().toLowerCase());
    const rows = grid.getByRole('row');
    const normalizedExpectedCode = itemCode.replace(/\s+/g, '').trim().toLowerCase();
    for (let index = 1; index < await rows.count(); index += 1) {
      const values = (await rows.nth(index).getByRole('gridcell').allInnerTexts()).map((value) => value.replace(/\s+/g, ' ').trim());
      const valueFor = (patterns: RegExp[]) => {
        const column = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
        return column >= 0 ? values[column] ?? '' : '';
      };
      const actualCode = valueFor([/^item code$/, /^lube grade$/, /^chem code$/]);
      const normalizedActualCode = actualCode.replace(/\s+/g, '').trim().toLowerCase();
      if (normalizedActualCode !== normalizedExpectedCode) continue;
      return {
        itemCode: actualCode,
        itemName: valueFor([/^item name$/, /^lube type$/, /^chemical name$/]),
        category: valueFor([/^stores category$/, /^category$/, /^application$/, /^application area$/]),
        uom: valueFor([/^uom$/]),
        rob: valueFor([/^rob$/]),
        locationRob: valueFor([/^location$/]),
      };
    }
    return null;
  }
}
