import { expect, type Locator, type Page } from '@playwright/test';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { WorkOrderPage } from './WorkOrderPage';

/**
 * Models the form used to create and submit an unplanned work order.
 */
export class UnplannedWorkOrderFormPage extends BasePage {
  private readonly rankHierarchy = ['Deck Cadet', 'Master'];
  protected readonly path = routes.unplannedWorkOrderForm;
  protected readonly pageName = 'Unplanned Work Order Form';
  protected readonly pageLoadedIndicator: Locator;
  private readonly jobTitleField: Locator;
  private readonly componentNameField: Locator;
  private readonly componentCodeField: Locator;
  private readonly assignedField: Locator;
  private readonly approverField: Locator;
  private readonly criticalityField: Locator;
  private readonly departmentField: Locator;
  private readonly descriptionField: Locator;
  private readonly ppeField: Locator;
  private readonly startDateField: Locator;
  private readonly startTimeField: Locator;
  private readonly completionDateField: Locator;
  private readonly completionTimeField: Locator;
  private readonly totalTimeField: Locator;
  private readonly performedByField: Locator;
  private readonly teamSizeField: Locator;
  private readonly workCarriedOutField: Locator;
  private readonly saveButton: Locator;
  private readonly submitButton: Locator;
  private readonly riskAssessmentNA: Locator;
  private readonly safetyChecklistNA: Locator;
  private readonly operationalFormsNA: Locator;

  /**
   * What this does: Creates the unplanned work order page object and stores the field locators it uses.
   * When it's used: Before filling out a new unplanned work order.
   * @param page - The Playwright page instance for the work order form.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole('heading', { name: 'Work Order Form — Unplanned', exact: true });
    this.jobTitleField = page.getByTestId('WOF.A1.4');
    this.componentNameField = page.locator('[role="combobox"]').nth(0);
    this.componentCodeField = page.getByTestId('WOF.A1.8');
    this.assignedField = page.locator('[role="combobox"]').nth(2);
    this.approverField = page.locator('[role="combobox"]').nth(3);
    this.criticalityField = page.locator('[role="combobox"]').nth(4);
    this.departmentField = page.getByTestId('WOF.A1.29');
    this.descriptionField = page.getByTestId('WOF.A1.35');
    this.ppeField = page.getByTestId('textarea-ppe-requirements');
    this.startDateField = page.getByTestId('WOF.B2.6');
    this.startTimeField = page.getByTestId('WOF.B2.8');
    this.completionDateField = page.getByTestId('WOF.B2.10');
    this.completionTimeField = page.getByTestId('WOF.B2.12');
    this.totalTimeField = page.getByTestId('WOF.B2.18');
    this.performedByField = page.getByTestId('WOF.B2.14');
    this.teamSizeField = page.getByTestId('WOF.B2.16');
    this.workCarriedOutField = page.getByTestId('textarea-work-carried-out');
    this.saveButton = page.getByRole('button', { name: 'Save', exact: true });
    this.submitButton = page.getByRole('button', { name: 'Submit Work Order', exact: true });
    this.riskAssessmentNA = page.locator('input[name="riskAssessment"][value="NA"]');
    this.safetyChecklistNA = page.locator('input[name="safetyChecklists"][value="NA"]');
    this.operationalFormsNA = page.locator('input[name="operationalForms"][value="NA"]');
  }

  /**
   * What this does: Opens the component picker and returns the first available component name.
   * When it's used: Before selecting a component for the work order.
   * @returns The first component name in the list.
   */
  public async firstComponentName(): Promise<string> {
    await this.componentNameField.click();
    return (await this.page.getByRole('option').first().innerText()).trim();
  }

  /**
   * What this does: Picks a component from the dropdown and waits for the component code to fill.
   * When it's used: After the component name is chosen so the rest of the form can be filled.
   * @param name - The component name to select.
   * @returns Nothing
   */
  public async selectComponent(name: string): Promise<void> {
    await this.componentNameField.click();
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect.poll(() => this.componentCodeField.inputValue()).toBeTruthy();
  }

  /**
   * What this does: Fills the job details required for a valid unplanned work order.
   * When it's used: When creating a new unplanned work order record.
   * @returns Nothing
   */
  public async fillJobDetails(): Promise<void> {
    await this.jobTitleField.fill('Automated Test Work Order');
    await this.departmentField.fill('Engine Department');
    await this.descriptionField.fill('Verify unplanned work order creation and approval submission.');
    await this.ppeField.fill('Safety glasses');
    await this.criticalityField.click();
    await this.page.getByRole('option').first().click();
  }

  /**
   * What this does: Chooses an assigned user and approver whose ranks are in the correct order.
   * When it's used: When producing a valid work order that needs approver and assignee validation.
   * @returns The assigned and approver values plus their rank positions.
   */
  public async selectAssignedAndApprover(): Promise<{ assigned: string; approver: string; assignedRank: number; approverRank: number }> {
    await this.assignedField.click();
    const available = (await this.page.getByRole('option').allTextContents()).map((value) => value.trim());
    const assigned = this.rankHierarchy.find((rank) => available.includes(rank)) ?? '';
    await this.page.getByRole('option', { name: assigned, exact: true }).click();
    await this.approverField.click();
    const approver = this.rankHierarchy.find((rank) => rank !== assigned && available.includes(rank)) ?? '';
    await this.page.getByRole('option', { name: approver, exact: true }).click();
    return { assigned, approver, assignedRank: this.rankHierarchy.indexOf(assigned), approverRank: this.rankHierarchy.indexOf(approver) };
  }

  /**
   * What this does: Marks the risk, safety, and operational answers as not applicable.
   * When it's used: To satisfy the standard NA checklist when leaving those sections blank.
   * @returns Nothing
   */
  public async answerRiskAssessmentNA(): Promise<void> {
    await this.riskAssessmentNA.check();
    await this.safetyChecklistNA.check();
    await this.operationalFormsNA.check();
  }

  /**
   * What this does: Fills in the work duration and timing details needed before saving the draft.
   * When it's used: Right before a work order draft is saved.
   * @returns Nothing
   */
  public async fillWorkDuration(assigned: string): Promise<void> {
    const today = this.formatDate(new Date());
    await this.startDateField.fill(today);
    await this.startTimeField.fill('09:00');
    await this.completionDateField.fill(today);
    await this.completionTimeField.fill('10:00');
    await this.completionTimeField.blur();
    await this.performedByField.click();
    await this.page.getByRole('option', { name: assigned, exact: true }).click();
    await this.teamSizeField.fill('1');
    await this.workCarriedOutField.fill('Automated test work carried out.');
  }

  /**
   * What this does: Saves the work order as a draft and returns the Work Orders page object.
   * When it's used: After the required fields are filled in and the form is ready to save.
   * @returns The Work Orders page after the save completes.
   */
  public async save(): Promise<WorkOrderPage> {
    await Promise.all([this.page.waitForURL(/\/technical\/pms\/work-orders/), this.saveButton.click()]);
    return new WorkOrderPage(this.page);
  }

  /**
   * What this does: Submits the work order for approval and waits for the updated status page.
   * When it's used: After a draft has been validated and is ready for approval.
   * @returns The Work Orders page with the submitted record.
   */
  public async submitWorkOrder(): Promise<WorkOrderPage> {
    await expect.poll(() => this.totalTimeField.inputValue()).toBeTruthy();
    await Promise.all([
      this.page.waitForResponse((response) => response.url().includes('/technical/api/') && response.request().method() !== 'GET' && response.status() >= 200 && response.status() < 300),
      this.submitButton.click(),
    ]);
    if (!this.page.url().includes('/technical/pms/work-orders')) await this.page.goto(routes.workOrder);
    return new WorkOrderPage(this.page);
  }

  /**
   * What this does: Formats a date as the day-month-year text used by this form.
   * When it's used: When filling the work start and end dates.
   * @param date - The current date to format for the form.
   * @returns A date string in the format used by the UI.
   */
  private formatDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}-${month}-${date.getFullYear()}`;
  }
}