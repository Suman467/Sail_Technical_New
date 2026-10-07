import { expect, type Locator, type Page } from '@playwright/test';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { WorkOrderPage } from './WorkOrderPage';

/**
 * Models the approval screen used to review and approve a work order.
 */
export class WorkOrderApprovalPage extends BasePage {
  protected readonly path = routes.workOrder;
  protected readonly pageName = 'Work Order Approval';
  protected readonly pageLoadedIndicator: Locator;
  private readonly approverRemarksField: Locator;
  private readonly approveButton: Locator;

  /**
   * What this does: Creates the approval page object and stores the approval form selectors.
   * When it's used: When a test opens a work order that needs approval.
   * @param page - The Playwright page instance for the approval screen.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole('button', { name: 'Approve', exact: true });
    this.approverRemarksField = page.getByTestId('input-ce-approval-remarks');
    this.approveButton = page.getByRole('button', { name: 'Approve', exact: true });
  }

  /**
   * What this does: Fills in the approval remarks field before the work order is approved.
   * When it's used: When a reviewer is adding notes to the approval step.
   * @param remarks - The text to add to the approval comment box.
   * @returns Nothing
   */
  public async enterApprovalRemarks(remarks: string): Promise<void> {
    await this.approverRemarksField.scrollIntoViewIfNeeded();
    await this.approverRemarksField.fill(remarks);
  }

  /**
   * What this does: Confirms the approval button is enabled and submits the approval action.
   * When it's used: At the final step of approving a work order.
   * @returns The Work Orders page after approval completes.
   */
  public async approve(): Promise<WorkOrderPage> {
    await expect(this.approveButton).toBeEnabled();
    await Promise.all([
      this.page.waitForURL(/\/technical\/pms\/work-orders$/),
      this.approveButton.click(),
    ]);
    return new WorkOrderPage(this.page);
  }
}