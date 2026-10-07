import { expect, type Locator, type Page } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import type { ComponentSpareRow } from './ComponentsPage';

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
  public async readSpareByPartCode(partCode: string, componentCode: string): Promise<ComponentSpareRow | null> {
    const search = this.page.getByRole('textbox', { name: 'Search parts or components...' });
    if (await search.count()) await search.fill(partCode);
    const table = this.page.locator('[role="grid"], table').filter({ hasText: 'Part Code' }).first();
    await expect(table, 'The Spares records table should be visible').toBeVisible();
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
      return { partCode: valueFor(/^part code$/i), partName: valueFor(/^part name$/i), componentName: valueFor(/^component(?: name)?$/i), partNumber: valueFor(/^part number$/i), rob: valueFor(/^rob$|total rob/i) };
    }
    return null;
  }
}
