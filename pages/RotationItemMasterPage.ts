import { expect, type Locator, type Page } from '@playwright/test';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';

export type RotationItemRow = { stamp: string; name: string; status: string; installedOn: string };

/**
 * Models PMS > Admin > Master Data > Rotation Item Master List, which shows the
 * real status (Spare, In Store, Installed, Retired) of every vessel stamp.
 */
export class RotationItemMasterPage extends BasePage {
  protected readonly path = routes.bulkDataImportPage;
  protected readonly pageName = 'Rotation Item Master List';
  protected readonly pageLoadedIndicator: Locator;

  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByTestId('text-rotation-items-header');
  }

  /** Opens the master list through the PMS Admin Master Data screen and selects a vessel. */
  public async openForVessel(vessel: string): Promise<void> {
    await this.page.goto(routes.bulkDataImportPage, { waitUntil: 'domcontentloaded' });
    // The PMS Admin tab bar does not expose a button role; use its exact label.
    await this.page.getByText('Master Data', { exact: true }).filter({ visible: true }).first().click();
    await this.page.getByText('Rotation Item Master List', { exact: true }).filter({ visible: true }).click();
    await expect(this.pageLoadedIndicator, 'The Rotation Item Master List should open').toBeVisible();
    await this.page.getByTestId('select-rotation-vessel').click();
    await this.page.getByRole('option', { name: vessel, exact: true }).click();
    await expect(this.page.getByTestId('select-rotation-vessel'), `Vessel ${vessel} should be selected`).toContainText(vessel);
    await expect(this.rows().first(), `Rotation items for Vessel ${vessel} should load`).toBeVisible();
  }

  /** Reads every stamp row currently listed for the selected vessel. */
  public async readStamps(): Promise<RotationItemRow[]> {
    return this.rows().evaluateAll((rows) => rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').trim());
      return { stamp: cells[1] ?? '', name: cells[2] ?? '', status: cells[3] ?? '', installedOn: cells[4] ?? '' };
    }));
  }

  private rows(): Locator {
    return this.page.locator('[data-testid^="row-rotation-item-"]');
  }
}
