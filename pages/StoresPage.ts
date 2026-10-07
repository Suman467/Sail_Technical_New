import { expect, type Locator, type Page } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';

export type StoreType = 'Stores' | 'Lubes' | 'Chemicals' | 'Others';
export type StoreUiRecord = { itemCode: string; itemName: string; category: string; uom: string; rob: string };

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
  }

  public async selectStoreType(storeType: StoreType): Promise<void> {
    await this.page.getByRole('button', { name: storeType, exact: true }).click();
  }

  public async readRecord(itemCode: string): Promise<StoreUiRecord | null> {
    const search = this.page.getByRole('textbox', { name: 'Search' });
    await search.fill(itemCode);
    const grid = this.page.getByRole('grid').first();
    await expect(grid, 'The Stores inventory grid should be visible').toBeVisible();
    await this.page.waitForTimeout(500);
    const headers = (await grid.getByRole('columnheader').allInnerTexts()).map((value) => value.trim().toLowerCase());
    const rows = grid.getByRole('row');
    for (let index = 1; index < await rows.count(); index += 1) {
      const values = (await rows.nth(index).getByRole('gridcell').allInnerTexts()).map((value) => value.replace(/\s+/g, ' ').trim());
      const valueFor = (patterns: RegExp[]) => {
        const column = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
        return column >= 0 ? values[column] ?? '' : '';
      };
      const actualCode = valueFor([/^item code$/, /^lube grade$/, /^chem code$/]);
      if (actualCode.toLowerCase() !== itemCode.toLowerCase()) continue;
      return {
        itemCode: actualCode,
        itemName: valueFor([/^item name$/, /^lube type$/, /^chemical name$/]),
        category: valueFor([/^stores category$/, /^application$/, /^application area$/]),
        uom: valueFor([/^uom$/]),
        rob: valueFor([/^rob$/]),
      };
    }
    return null;
  }
}
