// Models the Technical Work Orders page.
// The page heading is the stable business indicator for this destination.
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { WorkOrderApprovalPage } from './WorkOrderApprovalPage';
import { UnplannedWorkOrderFormPage } from './UnplannedWorkOrderFormPage';

/** One Work Orders list row, keyed by column header, and the tab that listed it. */
export type WorkOrderListMatch = { tab: string; values: Record<string, string>; rowText: string };

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
    if ((await this.vesselDropdown.textContent() ?? '').includes(name)) return;
    await this.vesselDropdown.click();
    await Promise.all([
      this.page.waitForResponse((response) => response.url().includes('/technical/api/work-orders') && response.request().method() === 'GET' && response.status() === 200),
      this.page.getByRole('option', { name, exact: true }).click(),
    ]);
    await expect(this.vesselDropdown, `Vessel ${name} should be selected on Work Orders`).toContainText(name);
  }

  /** Searches the current Work Order tab and returns every displayed data row. */
  public async searchRows(text: string): Promise<Locator> {
    const search = this.page.getByPlaceholder('Search work orders...');
    await expect(search, 'The Work Orders search should be available').toBeVisible();
    await search.fill(text);
    const rows = this.page.locator('[role="row"]:has([role="gridcell"])');
    await expect.poll(() => rows.count(), { message: `Work Order search for ${text} should return a row` }).toBeGreaterThan(0);
    return rows;
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
      // The API status does not always equal the tab label (the "Scheduled"
      // tab requests status=Planned), so wait for the list request itself.
      await Promise.all([
        this.page.waitForResponse((response) => this.isWorkOrderListResponse(response)),
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
   * Searches each status tab for one exact Work Order Number and returns the
   * tab it was listed under with its row values keyed by column header.
   * Returns undefined when no tab lists it.
   */
  public async findWorkOrder(workOrderNumber: string): Promise<WorkOrderListMatch | undefined> {
    return (await this.locateWorkOrder(workOrderNumber)).found;
  }

  /**
   * Searches the preferred tab first and then every other visible status tab
   * for one exact Work Order Number, waiting for each filtered list to finish
   * loading. The tab is a scheduling group and the Status column is the
   * record's own status, so both are returned separately.
   */
  public async locateWorkOrder(
    workOrderNumber: string,
    firstTab = 'Scheduled',
  ): Promise<{ found?: WorkOrderListMatch; searchedTabs: string[] }> {
    const searchedTabs: string[] = [];
    for (const tabName of [firstTab, ...this.tabNames.filter((name) => name !== firstTab)]) {
      if (!(await this.tab(tabName).first().isVisible().catch(() => false))) continue;
      await this.openTab(tabName);
      searchedTabs.push(tabName);
      const row = await this.searchExactWorkOrder(workOrderNumber);
      if (row) return { found: { tab: tabName, ...row }, searchedTabs };
    }
    return { searchedTabs };
  }

  /**
   * Enters an exact Work Order Number in the current tab, waits for that
   * search request and for the table to show either only matching rows or the
   * empty-list message, and returns the exact row's values when listed.
   */
  public async searchExactWorkOrder(workOrderNumber: string): Promise<Omit<WorkOrderListMatch, 'tab'> | undefined> {
    const search = this.page.getByPlaceholder('Search work orders...');
    await expect(search, 'The Work Orders search should be available').toBeVisible();
    if (await search.inputValue() !== workOrderNumber) {
      await Promise.all([
        this.page.waitForResponse((response) => this.isWorkOrderListResponse(response)
          && new URL(response.url()).searchParams.get('search') === workOrderNumber),
        search.fill(workOrderNumber),
      ]);
    }
    const rows = this.page.locator('[role="row"]:has([role="gridcell"])');
    const emptyList = this.page.getByText('No work orders found for the selected filters.').filter({ visible: true }).first();
    await expect.poll(async () => {
      if (await emptyList.isVisible().catch(() => false)) return true;
      const texts = await rows.allInnerTexts();
      return texts.length > 0 && texts.every((text) => text.includes(workOrderNumber));
    }, { message: `The Work Orders table should finish loading the search for ${workOrderNumber}` }).toBe(true);
    await expect(this.listFooter, 'The Work Orders list should finish loading').toBeVisible();

    const numberCell = this.page.locator('[role="gridcell"][col-id="workOrderNo"]')
      .filter({ hasText: new RegExp(`^\\s*${workOrderNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });
    const row = rows.filter({ has: numberCell }).first();
    if (!(await row.count())) return undefined;
    // Column order in the DOM can differ from the header order, so values are
    // matched to headers by the grid's column id rather than by position.
    const read = (cells: Locator) => cells.evaluateAll((elements) => elements.map((element) => [
      element.getAttribute('col-id') ?? '',
      (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ] as [string, string]));
    const headers = new Map(await read(this.page.getByRole('columnheader')));
    const cells = await read(row.getByRole('gridcell'));
    const values = Object.fromEntries(cells.filter(([id]) => headers.get(id)).map(([id, text]) => [headers.get(id)!, text]));
    return { values, rowText: cells.map(([, text]) => text).join(' | ') };
  }

  private isWorkOrderListResponse(response: Response): boolean {
    return new URL(response.url()).pathname.endsWith('/technical/api/work-orders')
      && response.request().method() === 'GET'
      && response.status() === 200;
  }

  /**
   * Searches every Work Orders status tab for rows associated with an exact
   * automation Job Code. This is read-only and is used before Generate WO so a
   * rerun cannot create a duplicate planned or active work order.
   */
  public async findWorkOrdersByJobCode(jobCode: string): Promise<Array<{ tab: string; values: Record<string, string>; rowText: string }>> {
    const search = this.page.getByPlaceholder('Search work orders...');
    const matches: Array<{ tab: string; values: Record<string, string>; rowText: string }> = [];
    for (const tabName of this.tabNames) {
      if (!(await this.tab(tabName).first().isVisible().catch(() => false))) continue;
      if (!(await this.openTab(tabName).then(() => true, () => false))) continue;
      await expect(search, 'The Work Orders search should be available').toBeVisible();
      await search.fill(jobCode);
      const rows = this.page.locator('[role=row]:has([role=gridcell])');
      await expect.poll(async () => (await rows.allInnerTexts()).every((text) =>
        !text.trim() || text.toLowerCase().includes(jobCode.toLowerCase())), {
        message: `Work Order search results for Job ${jobCode} should finish filtering`,
      }).toBe(true);
      const headers = (await this.page.getByRole('columnheader').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
      for (let index = 0; index < await rows.count(); index += 1) {
        const cells = (await rows.nth(index).getByRole('gridcell').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
        const rowText = cells.join(' | ');
        if (!rowText.toLowerCase().includes(jobCode.toLowerCase())) continue;
        const values = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] ?? '']).filter(([header]) => header));
        matches.push({ tab: tabName, values, rowText });
      }
      await search.fill('');
    }
    return matches;
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
