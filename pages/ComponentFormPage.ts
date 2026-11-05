import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { JobFormPage } from './JobFormPage';

export type ComponentValidationSubmission = {
  succeeded: boolean;
  status?: number;
  feedback: string;
  formRemainedOpen: boolean;
};

export type ConcurrentComponentSubmission = {
  status: number;
  uiMessage: string;
  responseMessage: string;
  /** Raw response body exactly as the server returned it. */
  responseBody: string;
  saveInitiatedAt: number;
  responseReceivedAt: number;
};

export type RunningHoursFormState = {
  counterType: string;
  counterSource: string;
  runningHours: string;
  readingDate: string;
};

export type RotationItemFormState = {
  rotationalItem: string;
  stamp: string;
  stampDisabled: boolean;
};

export type SaveAndAddJobResult = {
  componentCode: string;
  componentName: string;
  vessel: string;
  actionLabel: string;
};

const businessStep = (title: string, expected: string, actual: string) =>
  `${title}\nExpected: ${expected}\nActual: ${actual}`;

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
  private readonly selectedVessel: string;

  private field(label: string, testId?: string): Locator {
    if (testId) return this.page.getByTestId(testId).filter({ visible: true });
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const visibleLabel = this.page.locator('label')
      .filter({ hasText: new RegExp(`^${escaped}\\s*\\*?$`) })
      .filter({ visible: true });
    return visibleLabel.locator('..').locator('input, textarea, select').first();
  }

  /**
   * What this does: Builds the form page object and stores the component fields and save button.
   * When it's used: Before filling in a new or edited component record.
   * @param page - The Playwright page instance for the component form.
   * @returns Nothing
   */
  public constructor(page: Page, selectedVessel: string) {
    super(page);
    this.selectedVessel = selectedVessel;
    this.pageLoadedIndicator = page.getByText('A. Component Information', { exact: true });
    this.parentCodeField = this.field('Parent Component Code', 'input-parent-component');
    this.componentCodeField = this.field('Component Code', 'input-component-code');
    this.componentNameField = this.field('Component Name', 'input-component-name');
    this.categoryField = this.field('Component Category', 'select-component-category');
    this.departmentField = this.field('Equipment / System Department', 'select-eqpt-system-dept');
    this.activeField = this.field('Is Active', 'select-is-active');
    this.saveButton = page.getByRole('button', { name: 'Save', exact: true });
  }

  /**
   * What this does: Fills in the required component fields so the form can be saved.
   * When it's used: When creating or updating a component record.
   * @param code - The component code to give the item.
   * @param name - The display name for the component.
   * @returns Nothing
   */
  public async fillMandatoryFields(
    code: string,
    name: string,
    configuredParentCode?: string,
  ): Promise<void> {
    const parentCode = configuredParentCode
      ?? (await this.page.locator('body').innerText()).match(/\n(\d+) Hull\n/)?.[1]
      ?? '';
    await this.parentCodeField.fill(parentCode);
    await this.componentCodeField.press('Control+A');
    await this.componentCodeField.press('Backspace');
    await this.componentCodeField.pressSequentially(code);
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
  public async save(): Promise<boolean> {
    if (await this.componentCodeField.inputValue()) {
      const response = this.page.waitForResponse((result) => result.url().includes('/technical/api/components') && result.request().method() !== 'GET');
      await this.saveButton.click();
      this.saveSucceeded = (await response).ok();
      if (this.saveSucceeded) {
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        const vessel = this.page.getByRole('combobox').first();
        await vessel.click();
        await this.page.getByRole('option', { name: this.selectedVessel, exact: true }).click();
      }
      return this.saveSucceeded;
    }
    await this.saveButton.click();
    await this.page.getByText('Please fill all mandatory fields before saving.', { exact: true }).waitFor();
    return false;
  }

  /** Returns visible save feedback when creation is rejected. */
  public async saveFeedback(): Promise<string> {
    const feedback = this.page
      .getByText(/already exists|duplicate|invalid|required|failed|error/i)
      .filter({ visible: true })
      .last();
    return await feedback.isVisible().catch(() => false)
      ? (await feedback.innerText()).replace(/\s+/g, ' ').trim()
      : 'The application rejected the component without visible feedback.';
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

  public async expectAddContext(parentCode: string): Promise<{ parentCode: string; proposedCode: string }> {
    await expect(this.page.getByRole('heading', { name: /add component/i })).toBeVisible();
    await expect(this.parentCodeField).toHaveValue(parentCode);
    const proposedCode = await this.componentCodeField.inputValue();
    expect(proposedCode.trim(), 'The Add form should propose a child code').not.toBe('');
    return { parentCode: await this.parentCodeField.inputValue(), proposedCode };
  }

  public async fillRequired(data: { parentCode?: string; code?: string; name?: string; category?: string; department?: string; isParent?: 'Yes' | 'No'; isActive?: 'Yes' | 'No'; actorLabel?: string }): Promise<void> {
    const actor = data.actorLabel ? ` for ${data.actorLabel}` : '';
    // Only the fields this call actually enters are reported; an empty value is entered as blank.
    const value = (text: string) => (text.trim() ? `"${text}"` : '(blank)');
    const entered = [
      data.parentCode !== undefined && `Parent Component Code ${value(data.parentCode)}`,
      data.code !== undefined && `Component Code ${value(data.code)}`,
      data.name !== undefined && `Component Name ${value(data.name)}`,
      data.category !== undefined && `Component Category ${data.category ? value(data.category) : '(not selected)'}`,
      data.isParent !== undefined && `Is Parent ${data.isParent}`,
      data.department !== undefined && `Equipment / System Department ${data.department ? value(data.department) : '(not selected)'}`,
      data.isActive !== undefined && `Is Active ${data.isActive}`,
    ].filter(Boolean).join(', ');
    await test.step(businessStep(
      data.code
        ? `Enter required Add Component values for ${data.code}${actor} in Vessel ${this.selectedVessel}`
        : `Enter ${entered} in the open Add Component form${actor} in Vessel ${this.selectedVessel}`,
      `${data.actorLabel ?? 'The user'} should enter ${entered} in the Add form before Save.`,
      `${data.actorLabel ?? 'The user'} entered ${entered} in the Add form.`,
    ), async () => {
    if (data.parentCode !== undefined) await this.parentCodeField.fill(data.parentCode);
    if (data.code !== undefined) await this.componentCodeField.fill(data.code);
    if (data.name !== undefined) await this.componentNameField.fill(data.name);
    if (data.category !== undefined) {
      // An empty category means "omit it"; selectConfigured would fall back to the first real option.
      if (data.category) await this.selectConfigured(this.categoryField, data.category);
      else await this.categoryField.selectOption('');
    }
    if (data.isParent !== undefined) await this.selectConfigured(this.field('Is Parent', 'select-is-parent'), data.isParent);
    if (data.department !== undefined) {
      if (data.department) await this.selectConfigured(this.departmentField, data.department);
      else await this.departmentField.selectOption('');
    }
    if (data.isActive !== undefined) await this.selectConfigured(this.activeField, data.isActive);
    });
  }

  /** Confirms the Add form has finished hydrating and contains the intended values before a coordinated Save. */
  public async expectReadyForConcurrentSave(data: { parentCode: string; code: string; name: string; category: string; department: string; isParent: 'Yes' | 'No'; isActive: 'Yes' | 'No' }): Promise<void> {
    await expect(this.page.getByRole('heading', { name: /add component/i })).toBeVisible();
    await this.page.waitForLoadState('networkidle');
    await expect(this.parentCodeField).toHaveValue(data.parentCode);
    await expect(this.componentCodeField).toHaveValue(data.code);
    await expect(this.componentNameField).toHaveValue(data.name);
    await expect(this.categoryField.locator('option:checked')).toHaveText(data.category);
    await expect(this.departmentField.locator('option:checked')).toHaveText(data.department);
    await expect(this.field('Is Parent', 'select-is-parent').locator('option:checked')).toContainText(data.isParent);
    await expect(this.activeField.locator('option:checked')).toContainText(data.isActive);
    await expect(this.saveButton).toBeEnabled();
  }

  /** Waits for Edit form hydration so a subsequent user edit is not overwritten by late data. */
  public async expectEditReady(expectedCode: string): Promise<{
    name: string;
    category: string;
    department: string;
    active: string;
  }> {
    await expect(this.page.getByRole('heading', { name: /edit component/i })).toBeVisible();
    await this.page.waitForLoadState('networkidle');
    await expect(this.componentCodeField).toBeEditable();
    await expect(this.componentCodeField).toHaveValue(expectedCode);
    await expect(this.componentNameField).not.toHaveValue('');
    await expect(this.categoryField).not.toHaveValue('');
    await expect(this.activeField).not.toHaveValue('');
    const isParent = await this.field('Is Parent', 'select-is-parent').inputValue();
    if (isParent === 'No') await expect(this.departmentField).not.toHaveValue('');
    return {
      name: await this.componentNameField.inputValue(),
      category: await this.categoryField.inputValue(),
      department: await this.departmentField.inputValue(),
      active: await this.activeField.inputValue(),
    };
  }

  /** Replaces Component Code through normal keyboard interaction after Edit hydration. */
  public async changeComponentCode(code: string): Promise<void> {
    await expect(this.componentCodeField).toBeVisible();
    await expect(this.componentCodeField).toBeEditable();
    await this.componentCodeField.click();
    // The Edit form applies a delayed client-side initialization after focus.
    // CMP-054 must let that observed initialization finish before replacing
    // the controlled value, otherwise the application restores the old code.
    await this.page.waitForTimeout(5_000);
    let lastValue = await this.componentCodeField.inputValue();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await this.componentCodeField.click();
      await this.componentCodeField.press('Control+A');
      await this.componentCodeField.press('Backspace');
      await this.componentCodeField.pressSequentially(code);
      await this.componentCodeField.press('Tab');
      let consecutiveMatches = 0;
      try {
        await expect.poll(async () => {
          lastValue = await this.componentCodeField.inputValue();
          consecutiveMatches = lastValue === code ? consecutiveMatches + 1 : 0;
          return consecutiveMatches;
        }, {
          message: 'Component Code should remain stable after the user edit',
          timeout: 3_000,
          intervals: [250],
        }).toBeGreaterThanOrEqual(4);
        await test.step(businessStep(
          `Enter Component Code ${code} in the Edit form`,
          `The controlled Component Code field should retain ${code} before Save.`,
          `The Component Code field retained ${code} through the form's delayed initialization.`,
        ), async () => {});
        return;
      } catch {
        // Delayed initialization can restore the old value. Retry only with
        // the same bounded UI interaction a user performs manually.
      }
    }
    throw new Error(`Component Code reverted to "${lastValue}" after five normal UI replacement attempts; expected "${code}".`);
  }

  /** Replaces Component Name after Edit form hydration and proves the controlled value is stable. */
  public async changeComponentName(name: string): Promise<void> {
    await this.replaceStableEditValue(this.componentNameField, name, 'Component Name');
    await test.step(businessStep(
      `Enter Component Name "${name}" in the Edit form`,
      `The controlled Component Name field should retain "${name}" before Save.`,
      `The Component Name field retained "${name}" before Save.`,
    ), async () => {});
  }

  /** Confirms fields unrelated to a code-only edit retained their hydrated values. */
  public async expectRequiredValuesUnchanged(expected: {
    name: string;
    category: string;
    department: string;
    active: string;
  }): Promise<void> {
    await expect(this.componentNameField).toHaveValue(expected.name);
    await expect(this.categoryField).toHaveValue(expected.category);
    await expect(this.departmentField).toHaveValue(expected.department);
    await expect(this.activeField).toHaveValue(expected.active);
  }

  /** Submits a validation scenario and returns the real response or visible application feedback. */
  public async submitForValidation(options: {
    /** Scenario-specific application message that also counts as Save feedback. */
    feedbackPattern?: RegExp;
    /** Scenario-specific Expected Result for the recorded Save step. */
    expected?: string;
  } = {}): Promise<ComponentValidationSubmission> {
    const responses: Array<{ status: number; body: string }> = [];
    const listener = async (response: import('@playwright/test').Response) => {
      if (response.url().includes('/technical/api/components') && response.request().method() !== 'GET') {
        responses.push({ status: response.status(), body: await response.text().catch(() => '') });
      }
    };
    this.page.on('response', listener);
    try {
      await this.saveButton.click();
      const defaultFeedback = this.page
        .getByText(/required|mandatory|save failed|invalid|already exists|duplicate|conflict|circular|cycle|cannot be its own parent|not found|no longer exists|deleted|does not exist/i)
        .filter({ visible: true });
      const scenarioFeedback = options.feedbackPattern
        ? this.page.getByText(options.feedbackPattern).filter({ visible: true })
        : undefined;
      const feedback = scenarioFeedback ? defaultFeedback.or(scenarioFeedback) : defaultFeedback;
      // The form's own pre-save checks block the request and show a
      // "Component Save Failed" notification whose description is the
      // application's reworded message, so that notification is Save feedback too.
      const saveFailedTitle = this.page.getByText('Component Save Failed', { exact: true }).filter({ visible: true });
      // A scenario-specific message is awaited on its own: the form's standing
      // "Fill mandatory fields..." instruction would otherwise satisfy the wait.
      await expect.poll(async () => responses.length > 0
        || await (scenarioFeedback ?? feedback).count() > 0
        || await saveFailedTitle.count() > 0, {
        message: 'Save should produce a component response or visible validation feedback',
      }).toBe(true);
      const response = responses.at(-1);
      // Title and description of the notification, read as separate lines.
      const notificationLines = (await saveFailedTitle.first().locator('xpath=..').innerText().catch(() => ''))
        .split('\n').map((text) => text.trim()).filter(Boolean);
      const visibleFeedback = [...notificationLines, ...await feedback.allInnerTexts()]
        .map((text) => text.replace(/\s+/g, ' ').trim())
        .filter((text) => text && !(options.feedbackPattern && /^Fill mandatory fields and click \+ Add Job\b/i.test(text)))
        // A notification container repeats its message after its own title;
        // keep the exact message element rather than that combined text.
        .filter((text, _index, all) => !options.feedbackPattern || !all.some((other) => other !== text && text.includes(other)));
      const responseMessage = response?.body ? readResponseMessage(response.body) : '';
      const outcome = {
        succeeded: Boolean(response && response.status >= 200 && response.status < 300),
        status: response?.status,
        feedback: responseMessage || [...new Set(visibleFeedback)].join(' | ') || 'The application displayed no validation message.',
        formRemainedOpen: await this.page.getByRole('heading', { name: /edit component/i }).isVisible().catch(() => false),
      };
      await test.step(businessStep(
        'Click Save and capture the application response',
        options.expected ?? 'Save should return the scenario-specific success or validation outcome and leave the form in the appropriate state.',
        `Save returned ${outcome.status ? `HTTP ${outcome.status}` : 'no HTTP write response'}; ${outcome.formRemainedOpen ? 'the Edit form remained open' : 'the Edit form closed'}; the application displayed: "${outcome.feedback}"`,
      ), async () => {});
      return outcome;
    } finally {
      this.page.off('response', listener);
    }
  }

  private async selectConfigured(field: Locator, preferred: string): Promise<void> {
    let match: { value: string; text: string } | undefined;
    await expect.poll(async () => {
      const options = await field.locator('option').evaluateAll((items) => items.map((item) => ({
        value: (item as unknown as { value: string }).value,
        text: item.textContent?.trim() ?? '',
      })));
      match = (preferred ? options.find((item) => item.value === preferred || item.text === preferred) : undefined)
        ?? options.find((item) => item.value && !/select|choose/i.test(item.text));
      return Boolean(match);
    }, { message: `A usable ${preferred} option should finish loading` }).toBe(true);
    await field.selectOption(match!.value);
  }

  /** Updates an exact form control and waits until its controlled state retains the new value. */
  private async setControlledText(control: Locator, value: string): Promise<void> {
    await expect(control).toBeVisible();
    await expect(control).toBeEditable();
    await control.click();
    await control.press('Control+A');
    await control.pressSequentially(value);
    await expect.poll(() => control.inputValue(), {
      message: 'The controlled form field should retain the edited value',
    }).toBe(value);
  }

  public async fillOptional(values: Record<string, string>): Promise<void> {
    const ids: Record<string, string> = {
      Model: 'input-model', 'Serial No.': 'input-serial-no', 'Drawing No': 'input-drawing-no',
      Location: 'input-location', Rating: 'input-rating',
      'Installation Date': 'input-installation-date', 'Commissioned Date': 'input-commissioned-date',
    };
    let waitedForEmptyEditHydration = false;
    for (const [label, value] of Object.entries(values)) {
      const control = label === 'Notes / Technical Information'
        ? this.page.getByRole('textbox', { name: 'Notes / Technical Information', exact: true })
        : this.field(label, ids[label]);
      await expect(control, `${label} should be visible before filling`).toBeVisible();
      await expect(control, `${label} should be editable before filling`).toBeEditable();
      if (value === '') {
        await this.replaceStableEditValue(
          control,
          value,
          label,
          waitedForEmptyEditHydration ? 0 : 5_000,
        );
        waitedForEmptyEditHydration = true;
      } else {
        // Edit forms are controlled and can re-render after hydration. Use the
        // same bounded stability check for entered values as for clearing, so
        // a late render cannot silently replace the user's edit before Save.
        await this.replaceStableEditValue(control, value, label);
      }
    }
  }

  /** Edits one controlled optional text field through the same keyboard events as a user. */
  public async editOptionalText(label: 'Location' | 'Notes / Technical Information', value: string): Promise<void> {
    const testId = label === 'Location' ? 'input-location' : 'input-notes';
    const control = this.field(label, testId);
    await this.setControlledText(control, value);
    await control.blur();
    await expect(control, `${label} should contain the edited value before Save`).toHaveValue(value);
  }

  /** Changes the parent through the edit form's user-input path and commits any matching suggestion. */
  public async changeParent(parentCode: string): Promise<void> {
    await this.replaceStableEditValue(this.parentCodeField, parentCode, 'Parent Component Code', 5_000, true);
    await test.step(businessStep(
      `Enter Parent Component Code ${parentCode} in the Edit form`,
      `Parent Component Code should retain ${parentCode} before Save.`,
      `Parent Component Code retained ${parentCode} before Save.`,
    ), async () => {});
  }

  private async replaceStableEditValue(
    control: Locator,
    value: string,
    fieldName: string,
    initializationDelay = 0,
    atomicFill = false,
  ): Promise<void> {
    await expect(control).toBeVisible();
    await expect(control).toBeEditable();
    await control.click();
    if (initializationDelay) await this.page.waitForTimeout(initializationDelay);
    let lastValue = await control.inputValue();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await control.click();
      if (atomicFill) await control.fill(value);
      else {
        await control.press('Control+A');
        await control.press('Backspace');
        await control.pressSequentially(value);
      }
      await control.press('Tab');
      let consecutiveMatches = 0;
      try {
        await expect.poll(async () => {
          lastValue = await control.inputValue();
          consecutiveMatches = lastValue === value ? consecutiveMatches + 1 : 0;
          return consecutiveMatches;
        }, {
          message: `${fieldName} should remain stable after the user edit`,
          timeout: 3_000,
          intervals: [250],
        }).toBeGreaterThanOrEqual(4);
        return;
      } catch {
        // A delayed controlled-form render restored the old value. Retry only
        // through the same bounded keyboard interaction available to a user.
      }
    }
    throw new Error(`${fieldName} reverted to "${lastValue}" after five normal UI replacement attempts; expected "${value}".`);
  }

  public async value(label: string, testId: string): Promise<string> {
    return this.field(label, testId).inputValue();
  }

  /** Returns the enabled business choices exposed by a form select. */
  public async availableSelectOptions(label: string, testId?: string): Promise<Array<{ value: string; text: string }>> {
    if (label === 'Maker') {
      const control = this.page.getByTestId('input-maker').filter({ visible: true });
      await expect(control, 'Maker should be visible').toBeVisible();
      await control.click();
      const dialog = this.page.getByRole('dialog').filter({ visible: true });
      await expect(dialog, 'The configured Maker choices should open').toBeVisible();
      const choices = dialog.locator('[role="option"], [cmdk-item], button').filter({ visible: true });
      const options = await choices.evaluateAll((nodes) => nodes.map((node) => ({
        text: (node.textContent ?? '').trim(),
        value: (node.getAttribute('data-testid') ?? '').replace(/^option-maker-/, '') || (node.textContent ?? '').trim(),
      })).filter((option) => option.text && !/close|clear|cancel|select maker/i.test(option.text)));
      await this.page.keyboard.press('Escape');
      return options.filter((option, index) => options.findIndex((candidate) => candidate.value === option.value) === index);
    }
    const control = this.field(label, testId);
    await expect(control, `${label} should be visible`).toBeVisible();
    return control.locator('option').evaluateAll((options) => options
      .map((option) => ({
        value: (option as unknown as { value: string }).value,
        text: option.textContent?.trim() ?? '',
        disabled: (option as unknown as { disabled: boolean }).disabled,
      }))
      .filter((option) => option.value && option.text && !option.disabled && !/^(select|choose|null)$/i.test(option.text))
      .map(({ value, text }) => ({ value, text })));
  }

  /** Selects an exact live master value and returns the displayed option text. */
  public async selectMasterValue(label: string, testId: string | undefined, valueOrText: string): Promise<string> {
    if (label === 'Maker') {
      const control = this.page.getByTestId('input-maker').filter({ visible: true });
      await expect(control, 'Maker should be visible').toBeVisible();
      await expect(control, 'Maker should be editable').toBeEnabled();
      await control.click();
      const dialog = this.page.getByRole('dialog').filter({ visible: true });
      await expect(dialog, 'The configured Maker choices should open').toBeVisible();
      const codeChoice = dialog.getByTestId(`option-maker-${valueOrText}`).filter({ visible: true });
      const textChoice = dialog.locator('[role="option"], [cmdk-item]').filter({
        hasText: new RegExp(`^${valueOrText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), visible: true,
      }).first();
      const choice = await codeChoice.isVisible().catch(() => false) ? codeChoice : textChoice;
      await expect(choice, `Maker should contain configured value ${valueOrText}`).toBeVisible();
      const selectedText = (await choice.innerText()).trim();
      await choice.click();
      await expect(control).toContainText(selectedText);
      return selectedText;
    }
    const control = this.field(label, testId);
    await expect(control, `${label} should be visible`).toBeVisible();
    await expect(control, `${label} should be editable`).toBeEditable();
    const options = await this.availableSelectOptions(label, testId);
    const match = options.find((option) => option.value === valueOrText || option.text === valueOrText);
    expect(match, `${label} should contain configured value ${valueOrText}`).toBeTruthy();
    await control.selectOption(match!.value);
    await expect(control.locator('option:checked')).toHaveText(match!.text);
    return match!.text;
  }

  /** Clears an optional select using its real blank option. */
  public async clearOptionalSelect(label: string, testId?: string): Promise<{ value: string; dependentValue?: string }> {
    if (label === 'Maker') {
      const control = this.page.getByTestId('input-maker').filter({ visible: true });
      await expect(control, 'Maker should be visible').toBeVisible();
      // The application exposes a dedicated × button immediately after the
      // Maker picker. This is the same clear action used by the manual workflow;
      // selecting an item again from the dialog is not equivalent.
      const clearButton = control.locator('xpath=following-sibling::button[1]').filter({ visible: true });
      await expect(clearButton, 'The Maker clear button should be visible beside the selected Maker').toBeVisible();
      await clearButton.click();
      await expect(control, 'Maker should return to its unselected state').toContainText(/select maker/i);
      const makerCode = this.page.getByTestId('input-maker-code').filter({ visible: true });
      await expect(makerCode, 'Maker Code should clear with Maker').toHaveValue('');
      return {
        value: (await control.innerText()).replace(/\s+/g, ' ').trim(),
        dependentValue: await makerCode.inputValue(),
      };
    }
    const control = this.field(label, testId);
    await expect(control, `${label} should be visible`).toBeVisible();
    await expect(control, `${label} should be editable`).toBeEditable();
    await control.selectOption('');
    await expect(control).toHaveValue('');
    return { value: await control.inputValue() };
  }

  /** Reads a form control's current value. */
  public async controlValue(label: string, testId?: string): Promise<string> {
    if (label === 'Maker') return this.page.getByTestId('input-maker').filter({ visible: true }).innerText();
    if (label === 'Maker Code') return this.page.getByTestId('input-maker-code').filter({ visible: true }).inputValue();
    if (label === 'Notes / Technical Information') {
      const notes = this.page.getByRole('textbox', { name: label, exact: true }).filter({ visible: true });
      await expect(notes, `${label} should be visible`).toBeVisible();
      return notes.inputValue();
    }
    const control = this.field(label, testId);
    await expect(control, `${label} should be visible`).toBeVisible();
    return control.inputValue();
  }

  /** Confirms whether a dependent form field can be edited independently. */
  public async controlIsEditable(label: string, testId?: string): Promise<boolean> {
    if (label === 'Maker Code') return this.page.getByTestId('input-maker-code').filter({ visible: true }).isEditable();
    const control = this.field(label, testId);
    await expect(control, `${label} should be visible`).toBeVisible();
    return control.isEditable();
  }

  private async openRunningHoursSection(): Promise<void> {
    const heading = this.page.getByText('C. Running Hours & Condition Monitoring', { exact: true }).filter({ visible: true });
    await expect(heading, 'Section C should be available in the Component form').toBeVisible();
    await heading.scrollIntoViewIfNeeded();
    const counterType = this.field('RH Counter Type', 'select-rh-counter-type');
    if (!(await counterType.isVisible().catch(() => false))) await heading.click();
    await expect(counterType, 'RH Counter Type should be visible in Section C').toBeVisible();
  }

  private runningHoursControl(label: 'RH Counter Type' | 'RH Counter Source' | 'Running Hours' | 'Date'): Locator {
    // RH Counter Source renders as a read-only text box for None/Master and as
    // a picker button for Inherited; both use the same test id.
    const testIds = {
      'RH Counter Type': 'select-rh-counter-type',
      'RH Counter Source': 'input-rh-counter-source',
      'Running Hours': 'input-running-hours-c',
      Date: 'input-last-updated',
    } as const;
    return this.page.getByTestId(testIds[label]).filter({ visible: true });
  }

  private async readRunningHoursControl(label: 'RH Counter Type' | 'RH Counter Source' | 'Running Hours' | 'Date'): Promise<string> {
    const control = this.runningHoursControl(label);
    if (!(await control.isVisible().catch(() => false))) return '';
    const tagName = (await control.evaluate((node) => node.tagName)).toLowerCase();
    if (tagName === 'select') return (await control.locator('option:checked').innerText()).trim();
    if (tagName === 'button') return (await control.innerText()).replace(/\s+/g, ' ').trim();
    return (await control.inputValue()).trim();
  }

  /** Reads the editable values displayed in Section C after form hydration. */
  public async readRunningHoursState(): Promise<RunningHoursFormState> {
    await this.openRunningHoursSection();
    return {
      counterType: await this.readRunningHoursControl('RH Counter Type'),
      counterSource: await this.readRunningHoursControl('RH Counter Source'),
      runningHours: await this.readRunningHoursControl('Running Hours'),
      readingDate: await this.readRunningHoursControl('Date'),
    };
  }

  /** Selects a supported RH type through the normal form control and returns the displayed source. */
  public async setRhCounterType(value: 'Master' | 'Inherited' | 'Not RH Driven'): Promise<{ type: string; source: string }> {
    await this.openRunningHoursSection();
    const control = this.runningHoursControl('RH Counter Type');
    const options = await control.locator('option').evaluateAll((items) => items.map((item) => ({
      value: (item as unknown as { value: string }).value,
      text: item.textContent?.trim() ?? '',
    })));
    const match = options.find((option) => {
      if (value === 'Not RH Driven') return /^(?:none|not rh driven)$/i.test(option.text);
      return option.text.toLowerCase() === value.toLowerCase();
    });
    expect(match, `RH Counter Type should offer ${value}`).toBeTruthy();
    // The Edit form applies a delayed client-side initialization that can
    // restore the saved type after a selection. Retry only the same selection
    // a user makes, and prove the choice is retained before continuing.
    let lastValue = await control.inputValue();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await control.selectOption(match!.value);
      let consecutiveMatches = 0;
      try {
        await expect.poll(async () => {
          lastValue = await control.inputValue();
          consecutiveMatches = lastValue === match!.value ? consecutiveMatches + 1 : 0;
          return consecutiveMatches;
        }, { message: `RH Counter Type should remain ${match!.text}`, timeout: 3_000, intervals: [250] }).toBeGreaterThanOrEqual(4);
        return { type: match!.text, source: await this.readRunningHoursControl('RH Counter Source') };
      } catch {
        await this.page.waitForTimeout(1_000);
      }
    }
    const shownText = options.find((option) => option.value === lastValue)?.text ?? lastValue;
    throw new Error(`RH Counter Type returned to "${shownText}" after five normal selections of ${match!.text}; the form did not keep the new type.`);
  }

  /** Opens the Inherited source picker and selects the first offered Master component other than the excluded code. */
  public async selectRhCounterSource(excludedCode = ''): Promise<{ code: string; name: string; offered: number; displayed: string }> {
    await this.openRunningHoursSection();
    const control = this.runningHoursControl('RH Counter Source');
    await expect(control, 'RH Counter Source should become a source picker for Inherited').toHaveAttribute('role', 'combobox');
    await control.click();
    const choices = this.page.getByRole('dialog').filter({ visible: true }).locator('[data-testid^="option-rh-source-"]');
    await expect(choices.first(), 'The RH Counter Source picker should list Master components').toBeVisible();
    const offered = await choices.evaluateAll((nodes) => nodes.map((node) => ({
      code: (node.getAttribute('data-testid') ?? '').replace(/^option-rh-source-/, ''),
      name: node.querySelectorAll('span')[1]?.textContent?.trim() ?? '',
      disabled: node.getAttribute('aria-disabled') === 'true',
    })));
    const match = offered.find((option) => option.code && !option.disabled && option.code !== excludedCode);
    expect(match, 'At least one valid same-vessel Master source should be offered').toBeTruthy();
    await this.page.getByTestId(`option-rh-source-${match!.code}`).filter({ visible: true }).click();
    await expect(control, `RH Counter Source should display the selected Master ${match!.code}`).toContainText(match!.code);
    return { ...match!, offered: offered.length, displayed: await this.readRunningHoursControl('RH Counter Source') };
  }

  /**
   * Attempts to assign a source through the same click-and-type interaction a
   * user would use. No forced action or DOM change is used.
   */
  public async attemptRhCounterSourceEntry(text: string): Promise<{ control: string; readOnly: boolean; pickerOpened: boolean; before: string; after: string }> {
    await this.openRunningHoursSection();
    const control = this.runningHoursControl('RH Counter Source');
    await expect(control, 'RH Counter Source should be visible in Section C').toBeVisible();
    const tagName = (await control.evaluate((node) => node.tagName)).toLowerCase();
    const before = await this.readRunningHoursControl('RH Counter Source');
    const readOnly = !(await control.isEditable().catch(() => false));
    await control.click();
    const picker = this.page.getByRole('dialog').filter({ visible: true }).locator('[data-testid^="option-rh-source-"]');
    const pickerOpened = await picker.first().isVisible({ timeout: 1_500 }).catch(() => false);
    if (pickerOpened) await this.page.keyboard.press('Escape');
    else await this.page.keyboard.type(text);
    return {
      control: tagName === 'button' ? 'source picker' : readOnly ? 'read-only text box' : 'editable text box',
      readOnly,
      pickerOpened,
      before,
      after: await this.readRunningHoursControl('RH Counter Source'),
    };
  }

  /**
   * Enters a Running Hours reading and its date and proves both controlled values are retained.
   * The date control is the application's masked DD-MM-YYYY field, so an ISO date is typed
   * day-first through the keyboard exactly as a user enters it.
   */
  public async setRunningHours(value: string, date: string): Promise<{ runningHours: string; readingDate: string }> {
    await this.openRunningHoursSection();
    await this.replaceStableEditValue(this.runningHoursControl('Running Hours'), value, 'Running Hours');
    const iso = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const typedDate = iso ? `${iso[3]}-${iso[2]}-${iso[1]}` : date;
    await this.replaceStableEditValue(this.runningHoursControl('Date'), typedDate, 'Running Hours date');
    return {
      runningHours: await this.readRunningHoursControl('Running Hours'),
      readingDate: await this.readRunningHoursControl('Date'),
    };
  }

  public async supportedRhCounterTypes(): Promise<string[]> {
    await this.openRunningHoursSection();
    return this.runningHoursControl('RH Counter Type').locator('option').allInnerTexts()
      .then((values) => values.map((value) => value.trim()).filter(Boolean));
  }

  /** Changes the Rotation Item flag through the application select. */
  public async setRotationalItem(value: 'Yes' | 'No'): Promise<RotationItemFormState> {
    const rotationalItem = this.page.getByTestId('select-rotational-item').filter({ visible: true });
    await expect(rotationalItem, 'Rotational Item should be visible in Component Information').toBeVisible();
    let observed = '';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await rotationalItem.selectOption({ label: value });
      let consecutiveMatches = 0;
      const stable = await expect.poll(async () => {
        observed = (await rotationalItem.locator('option:checked').innerText()).trim();
        consecutiveMatches = observed === value ? consecutiveMatches + 1 : 0;
        return consecutiveMatches;
      }, {
        message: `Rotational Item should remain ${value} after controlled-form hydration`,
        timeout: 3_000,
        intervals: [250],
      }).toBeGreaterThanOrEqual(4).then(() => true).catch(() => false);
      if (stable) return this.readRotationItemState();
      // Let the Edit form's delayed initialization finish before the same
      // user selection is repeated.
      await this.page.waitForTimeout(1_000);
    }
    throw new Error(`Rotational Item reverted to "${observed}" after five normal UI selection attempts; expected "${value}".`);
  }

  /** Reads the Rotation Item and Stamp controls shown to the user. */
  public async readRotationItemState(): Promise<RotationItemFormState> {
    const rotationalItem = this.page.getByTestId('select-rotational-item').filter({ visible: true });
    const stamp = this.page.getByTestId('input-stamp').filter({ visible: true });
    await expect(rotationalItem).toBeVisible();
    await expect(stamp).toBeVisible();
    return {
      rotationalItem: (await rotationalItem.locator('option:checked').innerText()).trim(),
      stamp: (await stamp.locator('option:checked').innerText()).trim(),
      stampDisabled: await stamp.isDisabled(),
    };
  }

  /** Returns the enabled stamps currently offered by the normal dropdown. */
  public async availableStamps(): Promise<Array<{ value: string; text: string }>> {
    const stamp = this.page.getByTestId('input-stamp').filter({ visible: true });
    await expect(stamp).toBeEnabled();
    return stamp.locator('option').evaluateAll((items) => items.map((item) => ({
      value: (item as unknown as { value: string }).value,
      text: item.textContent?.trim() ?? '',
      disabled: (item as unknown as { disabled: boolean }).disabled,
    })).filter((item) => item.value && item.text && !item.disabled && !/select stamp/i.test(item.text))
      .map(({ value, text }) => ({ value, text })));
  }

  /**
   * Selects an exact stamp from the live dropdown. The option value is the
   * unique stamp number shown after Save (for example "Test Stamp_001"); the
   * label adds its description (for example "Test Stamp_001 — Stamp -1").
   */
  public async selectStamp(valueOrText: string): Promise<{ name: string; label: string }> {
    const stamp = this.page.getByTestId('input-stamp').filter({ visible: true });
    const choices = await this.availableStamps();
    const match = choices.find((choice) => choice.value === valueOrText || choice.text === valueOrText);
    expect(match, `Stamp ${valueOrText} should be available for selection`).toBeTruthy();
    // The Edit form's delayed initialization can restore the saved stamp after
    // a selection; repeat only the same user selection and prove it is kept.
    let observed = '';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await stamp.selectOption(match!.value);
      let consecutiveMatches = 0;
      const stable = await expect.poll(async () => {
        observed = (await stamp.locator('option:checked').innerText()).trim();
        consecutiveMatches = observed === match!.text ? consecutiveMatches + 1 : 0;
        return consecutiveMatches;
      }, { message: `Stamp should remain ${match!.text}`, timeout: 3_000, intervals: [250] })
        .toBeGreaterThanOrEqual(4).then(() => true).catch(() => false);
      if (stable) return { name: match!.value, label: match!.text };
      await this.page.waitForTimeout(1_000);
    }
    throw new Error(`The Stamp dropdown returned to "${observed}" after five normal selections of "${match!.text}"; the form did not keep the selected stamp.`);
  }

  public async clearStamp(): Promise<void> {
    const stamp = this.page.getByTestId('input-stamp').filter({ visible: true });
    await expect(stamp).toBeEnabled();
    await stamp.selectOption('');
    await expect(stamp).toHaveValue('');
  }

  /** Types an unsupported value into the focused RH Counter Type control, as a keyboard user would. */
  public async attemptUnsupportedRhCounterType(text: string): Promise<{ control: string; before: string; after: string; options: string[] }> {
    await this.openRunningHoursSection();
    const control = this.runningHoursControl('RH Counter Type');
    const before = await this.readRunningHoursControl('RH Counter Type');
    await control.focus();
    await this.page.keyboard.type(text);
    return {
      control: (await control.evaluate((node) => node.tagName)).toLowerCase() === 'select' ? 'fixed choice list' : 'text entry',
      before,
      after: await this.readRunningHoursControl('RH Counter Type'),
      options: await this.supportedRhCounterTypes(),
    };
  }

  /** Sets a supported Yes/No select and verifies its controlled value. */
  public async setYesNo(label: string, testId: string | undefined, value: 'Yes' | 'No'): Promise<void> {
    await this.selectMasterValue(label, testId, value);
  }

  /** Clears a required text control without deliberately moving focus away from it. */
  public async clearRequiredText(label: string, testId: string): Promise<boolean> {
    const control = this.field(label, testId);
    await expect(control, `${label} should be visible before clearing`).toBeVisible();
    await expect(control, `${label} should be editable before clearing`).toBeEditable();
    // The Add form initializes its proposed code asynchronously. This one-time
    // diagnostic delay mirrors the observed manual workflow before bounded retries.
    await this.page.waitForTimeout(5_500);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await control.click();
      if (attempt === 1) await control.clear();
      else {
        await control.press('Control+A');
        await control.press('Backspace');
      }
      if ((await control.inputValue()) === '') return true;
      if (attempt < 5) await this.page.waitForTimeout(1_000);
    }
    return false;
  }

  public async selectedOptionText(label: string, testId: string): Promise<string> {
    return this.field(label, testId).locator('option:checked').innerText();
  }

  /** Returns whether the approved edit form permits changing the parent relationship. */
  public async canChangeParent(): Promise<boolean> {
    return this.parentCodeField.isEditable();
  }

  public async expectSaveBlocked(
    fieldName?: string,
    onUnexpectedSuccessfulSave?: (request: Request) => Promise<void>,
    formMode: 'add' | 'edit' = 'add',
  ): Promise<string> {
    // Feedback text alone can be stale when a draft form is reused, so also
    // prove that no create/update request succeeded for this Save click.
    const formHeading = this.page.getByRole('heading', {
      name: formMode === 'add' ? /add component/i : /edit component/i,
    });
    await expect(formHeading, `The rejected Save should start from the ${formMode === 'add' ? 'Add' : 'Edit'} Component form`).toBeVisible();
    const writes: Array<Promise<{ request: Request; status: number }>> = [];
    const listener = (request: Request) => {
      if (request.url().includes('/technical/api/components') && request.method() !== 'GET') {
        writes.push(request.response().then(
          (response) => ({ request, status: response?.status() ?? 0 }),
          () => ({ request, status: 0 }),
        ));
      }
    };
    this.page.on('request', listener);
    try {
      await this.saveButton.click();
      const feedback = this.page
        .getByText(/required|mandatory|save failed|invalid|already exists|duplicate|conflict|not found|does not exist|cannot be found|wrong vessel/i)
        .filter({ visible: true });
      await expect(feedback.first(), `${fieldName ?? 'Required fields'} validation should be visible`).toBeVisible();
      await expect(formHeading, `The ${formMode === 'add' ? 'Add' : 'Edit'} Component form should remain open after the rejected Save`).toBeVisible();
      await expect(this.saveButton, 'Save should remain available on the rejected Add Component form').toBeVisible();
      const successful = (await Promise.all(writes)).filter(({ status }) => status >= 200 && status < 300);
      expect(successful, `${fieldName ?? 'Required fields'} validation should prevent any successful component save`).toEqual([]);
      // The form's standing "Fill mandatory fields..." instruction is always
      // visible and is not Save feedback, so it is left out of the message.
      const visibleFeedback = [...new Set((await feedback.allInnerTexts())
        .map((text) => text.replace(/\s+/g, ' ').trim())
        .filter((text) => text && !/^Fill mandatory fields and click \+ Add Job\b/i.test(text)))]
        .join(' | ') || 'No validation message other than the form instructions was visible.';
      await test.step(businessStep(
        `Click Save and capture ${fieldName ?? 'required-field'} validation`,
        `The application should reject the invalid component, show ${fieldName ?? 'required-field'} feedback, and keep the form open without a successful write.`,
        visibleFeedback.startsWith('No validation message')
          ? 'Save produced no successful write and the form remained open, but no validation message other than the form instructions was visible.'
          : `Save was rejected with no successful write; the form remained open and displayed: "${visibleFeedback}"`,
      ), async () => {});
      return visibleFeedback;
    } catch (error) {
      const successful = (await Promise.all(writes)).filter(({ status }) => status >= 200 && status < 300);
      for (const { request } of successful) await onUnexpectedSuccessfulSave?.(request);
      throw error;
    } finally {
      this.page.off('request', listener);
    }
  }

  /** Returns whether an unsaved Add Component form is currently displayed. */
  public async isAddFormOpen(): Promise<boolean> {
    return await this.page.getByRole('heading', { name: /add component/i }).isVisible().catch(() => false)
      && await this.saveButton.isVisible().catch(() => false);
  }

  public async saveValid(): Promise<boolean> {
    const code = await this.componentCodeField.inputValue();
    const name = await this.componentNameField.inputValue();
    return test.step(businessStep(
      `Click Save for Component ${code} (${name})`,
      `The application should save Component ${code} once and return a successful response.`,
      `The application returned a successful response for Component ${code} (${name}) and the register was refreshed.`,
    ), async () => {
    const responsePromise = this.page.waitForResponse((response) => response.url().includes('/technical/api/components') && response.request().method() !== 'GET');
    await this.saveButton.click();
    const response = await responsePromise;
    this.saveSucceeded = response.ok();
    const responseText = response.ok() ? '' : await response.text().catch(() => 'No response body');
    expect(response.ok(), `The component save request should succeed. HTTP ${response.status()}: ${responseText}`).toBe(true);
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    return true;
    });
  }

  /** Saves the hydrated Add Component form through the action exposed beside D. Jobs. */
  public async saveAndOpenAddJob(): Promise<SaveAndAddJobResult & { jobForm: JobFormPage }> {
    const componentCode = await this.componentCodeField.inputValue();
    const componentName = await this.componentNameField.inputValue();
    await this.expectReadyForJobCreation(componentCode, componentName);
    const addJob = this.page.getByRole('button', { name: /^\+\s*Add Jobs?$/i }).filter({ visible: true });
    await expect(addJob, 'The hydrated Add Component form should expose its Add Job action').toBeVisible();
    const actionLabel = (await addJob.innerText()).replace(/\s+/g, ' ').trim();
    const componentResponse = this.page.waitForResponse((response) =>
      response.url().includes('/technical/api/components')
      && response.request().method() !== 'GET');
    await addJob.click();
    const response = await componentResponse;
    const responseText = response.ok() ? '' : await response.text().catch(() => 'No response body');
    expect(response.ok(), `Component save before Add Job should succeed. HTTP ${response.status()}: ${responseText}`).toBe(true);
    await expect(this.page.getByRole('heading', { name: /^(?:add )?job form$/i }).filter({ visible: true }),
      'The Add Job form should open after the component is saved').toBeVisible({ timeout: 20_000 });
    this.saveSucceeded = true;
    return { componentCode, componentName, vessel: this.selectedVessel, actionLabel, jobForm: new JobFormPage(this.page, this.selectedVessel) };
  }

  private async expectReadyForJobCreation(componentCode: string, componentName: string): Promise<void> {
    await expect(this.page.getByRole('heading', { name: /add component/i })).toBeVisible();
    await this.page.waitForLoadState('networkidle');
    await expect(this.componentCodeField).toHaveValue(componentCode);
    await expect(this.componentNameField).toHaveValue(componentName);
    await expect(this.categoryField).not.toHaveValue('');
    await expect(this.departmentField).not.toHaveValue('');
    await expect(this.activeField).not.toHaveValue('');
  }

  /** Attempts the form's actual Add Job action and proves an incomplete component is not written. */
  public async expectAddJobBlocked(fieldName: string): Promise<{ action: string; feedback: string; disabled: boolean }> {
    const addJob = this.page.getByRole('button', { name: /^\+\s*Add Jobs?$/i }).filter({ visible: true });
    await expect(addJob, 'The Add Component form should expose its Add Job action').toBeVisible();
    const action = (await addJob.innerText()).replace(/\s+/g, ' ').trim();
    const disabled = await addJob.isDisabled();
    const successfulWrites: number[] = [];
    const listener = (response: import('@playwright/test').Response) => {
      if (response.url().includes('/technical/api/components') && response.request().method() !== 'GET' && response.ok()) successfulWrites.push(response.status());
    };
    this.page.on('response', listener);
    try {
      if (!disabled) await addJob.click();
      const feedbackLocator = this.page.getByText(/required|mandatory|fill all|invalid/i).filter({ visible: true });
      await feedbackLocator.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
      const feedback = [...new Set((await feedbackLocator.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim())
        .filter((text) => text && !/^Fill mandatory fields and click \+ Add Job/i.test(text)))].join(' | ');
      expect(successfulWrites, `${fieldName} should prevent a successful component write`).toEqual([]);
      await expect(this.page.getByRole('heading', { name: /add component/i }), 'The incomplete component form should remain open').toBeVisible();
      return { action, disabled, feedback: feedback || (disabled ? `${action} was disabled.` : 'The form remained open with no successful component write.') };
    } finally {
      this.page.off('response', listener);
    }
  }

  public async saveRepeatedly(): Promise<number[]> {
    const responses: number[] = [];
    const listener = (response: import('@playwright/test').Response) => {
      if (response.url().includes('/technical/api/components') && response.request().method() !== 'GET') responses.push(response.status());
    };
    this.page.on('response', listener);
    await this.saveButton.click({ noWaitAfter: true });
    if (await this.saveButton.isEnabled().catch(() => false)) await this.saveButton.click({ noWaitAfter: true });
    await expect.poll(() => responses.length, 'At least one create response should complete').toBeGreaterThan(0);
    this.page.off('response', listener);
    expect(responses.filter((status) => status >= 200 && status < 300).length).toBeLessThanOrEqual(1);
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    return responses;
  }

  /** Submits one form during a coordinated concurrency check and returns the real server/UI outcome. */
  public async submitForConflict(): Promise<ConcurrentComponentSubmission> {
    const submittedCode = await this.componentCodeField.inputValue();
    const submittedName = await this.componentNameField.inputValue();
    const responsePromise = this.page.waitForResponse(
      (response) => {
        const request = response.request();
        const body = request.postData() ?? '';
        return response.url().includes('/technical/api/components')
          && request.method() !== 'GET'
          && body.includes(submittedCode)
          && body.includes(submittedName);
      },
    );
    const saveInitiatedAt = Date.now();
    await this.saveButton.click({ noWaitAfter: true });
    const response = await responsePromise;
    const responseReceivedAt = Date.now();
    const responseBody = await response.text().catch(() => '');
    const responseMessage = readResponseMessage(responseBody);
    const visibleMessages = this.page
      .getByText(/success|created|saved|already exists|duplicate|conflict|unique code|invalid|failed|error/i)
      .filter({ visible: true });
    await visibleMessages.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    const messages = (await visibleMessages.allInnerTexts())
      .map((message) => message.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return {
      status: response.status(),
      uiMessage: [...new Set(messages)].join(' | ') || 'No visible save notification or validation message was displayed.',
      responseMessage,
      responseBody,
      saveInitiatedAt,
      responseReceivedAt,
    };
  }

  public async back(): Promise<void> {
    await this.page.getByRole('button', { name: /back|cancel/i }).first().click();
    await expect(this.page.getByRole('heading', { name: 'Components', exact: true })).toBeVisible();
  }

  public async canOmitIsActive(): Promise<boolean> {
    return (await this.activeField.locator('option').evaluateAll((options) => options.some((option) => !(option as unknown as { value: string }).value)))
      && await this.activeField.isEditable();
  }

}

function readResponseMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return ['message', 'error', 'details']
      .map((key) => parsed[key])
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
      ?.trim() ?? '';
  } catch {
    return body.trim();
  }
}
