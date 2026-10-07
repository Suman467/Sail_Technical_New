// Models the Technical Work Orders page.
// The page heading is the stable business indicator for this destination.
import { expect, type Locator, type Page } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { WorkOrderApprovalPage } from './WorkOrderApprovalPage';
import { UnplannedWorkOrderFormPage } from './UnplannedWorkOrderFormPage';

/**
 * Models the Work Orders screen and the list actions used to review and manage work orders.
 */
export class WorkOrderPage extends BasePage {
  protected readonly path = routes.workOrder;
  protected readonly pageName = 'Work Orders';
  protected readonly pageLoadedIndicator: Locator;
  // Tab names exactly as the app shows them (the first tab is labelled "Scheduled").
  public readonly tabNames = ['Scheduled', 'Due', 'Overdue', 'Postponed', 'Unplanned', 'Pending Approval', 'Completed'];
  private readonly vesselDropdown: Locator;
  private readonly listFooter: Locator;

  /**
   * What this does: Creates the Work Orders page object and captures the key selectors used on the screen.
   * When it's used: Before interacting with a work-order table or the filters on that page.
   * @param page - The Playwright page instance for the Work Orders screen.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole('heading', { name: 'Work Orders (W.O)', exact: true });
    this.vesselDropdown = page.getByRole('combobox').first();
    this.listFooter = page.getByText(/Showing \d+ - \d+ of \d+ work orders/);
  }

  /**
   * What this does: Returns the tab locator for a named work-order filter.
   * When it's used: When opening or checking a status tab.
   * @param name - The tab name to look up.
   * @returns The locator for that tab.
   */
  public tab(name: string): Locator {
    return this.page.getByRole('button').filter({ hasText: new RegExp(`^${name}(?:\\d+)?$`) });
  }

  /**
   * What this does: Chooses a vessel and waits for the work-order list to refresh.
   * When it's used: Before checking counts or opening a filtered work-order list.
   * @param name - The vessel name to select.
   * @returns Nothing
   */
  public async selectVessel(name = config.vesselName): Promise<void> {
    await this.vesselDropdown.click();
    await Promise.all([
      this.page.waitForResponse((response) => response.url().includes('/technical/api/work-orders') && response.request().method() === 'GET' && response.status() === 200),
      this.page.getByRole('option', { name, exact: true }).click(),
    ]);
  }

  /**
   * What this does: Opens the unplanned work order form so a new item can be created.
   * When it's used: When starting a new unplanned work order.
   * @returns The unplanned work-order form page object.
   */
  public async clickUnplannedWO(): Promise<UnplannedWorkOrderFormPage> {
    await this.page.getByRole('button', { name: 'Unplanned W.O', exact: true }).click();
    return new UnplannedWorkOrderFormPage(this.page);
  }

  /**
   * What this does: Reads the number shown in a tab label for a status filter.
   * When it's used: To compare a tab's total with the visible result list.
   * @param name - The status tab to read.
   * @returns The number shown in that tab label.
   */
  public async tabCount(name: string): Promise<number> {
    return this.numberFromText(await this.tab(name).innerText());
  }

  /**
   * What this does: Opens a tab and waits until the table finishes loading that status list.
   * When it's used: When switching between work-order status groups.
   * @param name - The tab to open.
   * @returns Nothing
   */
  public async openTab(name: string): Promise<void> {
    const tab = this.tab(name);
    const selected = (await tab.getAttribute('class'))?.includes('bg-[#52baf3]') ?? false;
    if (!selected) {
      await Promise.all([
        this.page.waitForResponse((response) => {
          const status = new URL(response.url()).searchParams.get('status');
          return response.url().includes('/technical/api/work-orders') && response.status() === 200 && status === name;
        }),
        tab.click(),
      ]);
    }
    await expect(tab, `${name} should be selected`).toHaveClass(/bg-\[#52baf3\]/);
    await expect(this.listFooter, `${name} list should finish loading`).toBeVisible();
  }

  /**
   * What this does: Reads the total shown in the footer for the currently displayed list.
   * When it's used: To compare the footer count with the tab count.
   * @returns The total number shown in the list footer.
   */
  public async footerCount(): Promise<number> {
    return this.numberFromText(await this.listFooter.innerText());
  }

  /**
   * What this does: Finds the highest work-order sequence number currently visible in the list.
   * When it's used: To calculate the next expected number for a newly created work order.
   * @returns The largest work-order number currently shown.
   */
  public async highestWorkOrderNumber(): Promise<number> {
    const rows = this.page.locator('[role="row"]:has([role="gridcell"])');
    const numbers: number[] = [];
    for (let index = 0; index < await rows.count(); index++) {
      const value = await rows.nth(index).getByRole('gridcell').nth(1).innerText();
      const sequence = value.match(/-(\d+)$/)?.[1];
      if (sequence) numbers.push(Number(sequence));
    }
    return Math.max(...numbers, 0);
  }

  /**
   * What this does: Finds the table row for a specific work-order number.
   * When it's used: To locate an exact record for assertions or editing.
   * @param number - The work-order number to search for.
   * @returns The locator for the matching row.
   */
  public findRowByWorkOrderNumber(number: number): Locator {
    const workOrderCell = this.page.getByRole('gridcell', { name: new RegExp(`-${String(number).padStart(3, '0')}\\b`) });
    return this.page.getByRole('row').filter({ has: workOrderCell }).last();
  }

  /**
   * What this does: Reads the status value from a work-order row.
   * When it's used: To check whether a work order is Draft, Pending Approval, or another state.
   * @param row - The row to inspect.
   * @returns The row's status text.
   */
  public async statusOf(row: Locator): Promise<string> {
    return row.getByRole('gridcell').nth(5).innerText();
  }

  /**
   * What this does: Reads the work-order number from a row.
   * When it's used: To display or compare a specific work-order reference.
   * @param row - The row to inspect.
   * @returns The work-order number text.
   */
  public async workOrderNumberOf(row: Locator): Promise<string> {
    return row.getByRole('gridcell').nth(1).innerText();
  }

  /**
   * What this does: Opens the edit form for a selected work-order row.
   * When it's used: When a tester needs to update the saved work-order details.
   * @param row - The work-order row to edit.
   * @returns The unplanned work-order form page object.
   */
  public async openForEdit(row: Locator): Promise<UnplannedWorkOrderFormPage> {
    await row.getByRole('button', { name: 'Edit Template', exact: true }).click();
    return new UnplannedWorkOrderFormPage(this.page);
  }

  /**
   * What this does: Searches for a work order and opens its approval detail page.
   * When it's used: After a work order has been submitted and needs approval action.
   * @param workOrderNumber - The number to search for before opening the record.
   * @returns The approval page for that work order.
   */
  public async openSearchResult(workOrderNumber: string): Promise<WorkOrderApprovalPage> {
    const searchBox = this.page.getByPlaceholder('Search work orders...');
    const result = this.page.getByRole('gridcell', { name: workOrderNumber, exact: true });
    await searchBox.fill(workOrderNumber);
    await expect(result, `Work Order ${workOrderNumber} should appear in search results`).toBeVisible();
    await Promise.all([this.page.waitForURL(/\/technical\/pms\/work-order\/[^/]+$/), result.click()]);
    return new WorkOrderApprovalPage(this.page);
  }

  /**
   * What this does: Pulls the last number from a text string so counts can be compared reliably.
   * When it's used: On footer and tab labels that contain numbers like “of 12 work orders”.
   * @param text - The text containing the numeric count.
   * @returns The last number found in the text, or zero if there is none.
   */
  private numberFromText(text: string): number {
    return Number(text.match(/\d+/g)?.at(-1) ?? 0);
  }
}