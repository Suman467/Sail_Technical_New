import { type Locator, type Page } from '@playwright/test';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';

/**
 * Models the form used to add or edit a component in the Technical module.
 */
export class ComponentFormPage extends BasePage {
  protected readonly path = routes.componentPage;
  protected readonly pageName = 'Component Form';
  protected readonly pageLoadedIndicator: Locator;
  private readonly parentCodeField: Locator;
  private readonly componentCodeField: Locator;
  private readonly componentNameField: Locator;
  private readonly categoryField: Locator;
  private readonly departmentField: Locator;
  private readonly activeField: Locator;
  private readonly saveButton: Locator;
  private saveSucceeded = false;

  /**
   * What this does: Builds the form page object and stores the component fields and save button.
   * When it's used: Before filling in a new or edited component record.
   * @param page - The Playwright page instance for the component form.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByText('A. Component Information', { exact: true });
    this.parentCodeField = page.getByTestId('input-parent-component');
    this.componentCodeField = page.getByTestId('input-component-code');
    this.componentNameField = page.getByTestId('input-component-name');
    this.categoryField = page.getByTestId('select-component-category');
    this.departmentField = page.getByTestId('select-eqpt-system-dept');
    this.activeField = page.getByTestId('select-is-active');
    this.saveButton = page.getByRole('button', { name: 'Save', exact: true });
  }

  /**
   * What this does: Fills in the required component fields so the form can be saved.
   * When it's used: When creating or updating a component record.
   * @param code - The component code to give the item.
   * @param name - The display name for the component.
   * @returns Nothing
   */
  public async fillMandatoryFields(code: string, name: string): Promise<void> {
    const parentCode = (await this.page.locator('body').innerText()).match(/\n(\d+) Hull\n/)?.[1] ?? '';
    await this.parentCodeField.fill(parentCode);
    await this.componentCodeField.fill(code);
    await this.componentNameField.fill(name);
    await this.categoryField.selectOption('Ship General');
    await this.departmentField.selectOption('Engine');
    await this.activeField.selectOption('Yes');
  }

  /**
   * What this does: Saves the form and checks whether the request succeeded or whether validation blocks it.
   * When it's used: After filling in the form or when checking validation error messages.
   * @returns Nothing
   */
  public async save(): Promise<void> {
    if (await this.componentCodeField.inputValue()) {
      const response = this.page.waitForResponse((result) => result.url().includes('/technical/api/components') && result.request().method() !== 'GET');
      await this.saveButton.click();
      this.saveSucceeded = (await response).ok();
      if (this.saveSucceeded) {
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        const vessel = this.page.getByRole('combobox').first();
        await vessel.click();
        await this.page.getByRole('option', { name: 'PMS Test 3', exact: true }).click();
      }
      return;
    }
    await this.saveButton.click();
    await this.page.getByText('Please fill all mandatory fields before saving.', { exact: true }).waitFor();
  }

  /**
   * What this does: Checks whether the form shows a required-field validation error.
   * When it's used: After saving incomplete data on purpose.
   * @returns True when the required-field message is visible, otherwise false.
   */
  public async validationErrorsVisible(): Promise<boolean> {
    return this.page.getByText('This field is required', { exact: true }).first().isVisible();
  }

  /**
   * What this does: Checks whether the save action succeeded or a success message is visible.
   * When it's used: After creating or updating a component to confirm the save worked.
   * @returns True when the success state is visible, otherwise false.
   */
  public async successMessageVisible(): Promise<boolean> {
    return this.saveSucceeded || this.page.getByText(/component (created|updated|saved) successfully/i).isVisible();
  }
}