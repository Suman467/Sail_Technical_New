import { expect, type Locator, type Page } from '@playwright/test';
import { readAppNotification } from '../utils/appNotification';

export type JobIdentity = {
  jobCode: string;
  jobTitle: string;
  componentCode: string;
  componentName: string;
};

/** Models the normal Job Form opened from a component's D. Jobs section. */
export class JobFormPage {
  public constructor(private readonly page: Page) {}

  public async expectContext(component: { code: string; name: string }): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Job Form', exact: true })).toBeVisible();
    await expect(this.page.getByPlaceholder('Enter component', { exact: true })).toHaveValue(component.name);
    await expect(this.page.getByPlaceholder('Enter component code', { exact: true })).toHaveValue(component.code);
  }

  public async fillRequired(data: { jobCode: string; jobTitle: string; description: string }): Promise<JobIdentity> {
    const title = this.page.getByPlaceholder('Enter job title');
    const code = this.page.getByPlaceholder('Enter job code');
    const componentName = this.page.getByPlaceholder('Enter component', { exact: true });
    const componentCode = this.page.getByPlaceholder('Enter component code', { exact: true });
    await expect(title).toBeEditable();
    await title.fill(data.jobTitle);
    await code.fill(data.jobCode);
    await this.page.getByRole('spinbutton', { name: 'Value' }).fill('1');
    await this.selectFirstRealOption('Assigned To (Rank)');
    await this.selectFirstRealOption('Approver (Rank)');
    await this.selectFirstRealOption('Criticality');
    await this.page.getByPlaceholder(/Describe what this job is to do/i).fill(data.description);
    return {
      jobCode: data.jobCode,
      jobTitle: data.jobTitle,
      componentCode: await componentCode.inputValue(),
      componentName: await componentName.inputValue(),
    };
  }

  public async create(): Promise<{ identity: JobIdentity; feedback: string }> {
    const identity = {
      jobCode: await this.page.getByPlaceholder('Enter job code').inputValue(),
      jobTitle: await this.page.getByPlaceholder('Enter job title').inputValue(),
      componentCode: await this.page.getByPlaceholder('Enter component code', { exact: true }).inputValue(),
      componentName: await this.page.getByPlaceholder('Enter component', { exact: true }).inputValue(),
    };
    const responsePromise = this.page.waitForResponse((response) =>
      /\/technical\/api\/jobs(?:[/?]|$)/i.test(response.url())
      && response.request().method() !== 'GET');
    await this.page.getByRole('button', { name: 'Create Job', exact: true }).click();
    const response = await responsePromise;
    const responseBody = await response.text().catch(() => '');
    expect(response.ok(), `Job create should succeed. HTTP ${response.status()}: ${responseBody}`).toBe(true);
    const notification = this.page.getByText(/job .*?(?:created|saved).*success/i).filter({ visible: true }).last();
    await notification.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    return { identity, feedback: await notification.innerText().catch(() => `Job create returned HTTP ${response.status()}.`) };
  }

  /** Confirms the opened Jobs Form shows this exact job before any action is taken on it. */
  public async expectOpenedJob(jobCode: string, jobTitle: string): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Jobs Form', exact: true })).toBeVisible();
    const code = this.page.getByPlaceholder('Enter job code');
    const title = this.page.getByPlaceholder('Enter job title');
    if (await code.isVisible().catch(() => false)) {
      await expect(code, 'The opened job should be the requested Job Code').toHaveValue(jobCode);
      await expect(title, 'The opened job should be the requested Job Title').toHaveValue(jobTitle);
      return;
    }
    // The read-only Jobs Form shows values in disabled fields without placeholders.
    const valueAfter = (label: string) => this.page.getByText(label, { exact: true }).filter({ visible: true }).first()
      .locator('xpath=following::input[1]');
    await expect(valueAfter('Job Code'), 'The opened job should show the requested Job Code').toHaveValue(jobCode);
    await expect(valueAfter('Job Title'), 'The opened job should show the requested Job Title').toHaveValue(jobTitle);
  }

  /**
   * Deletes the opened job through its Delete button, confirming when the
   * application asks, and returns the confirmation text, response and visible message.
   */
  public async delete(): Promise<{ confirmation: string; httpStatus: number; ok: boolean; feedback: string }> {
    const deleteButton = this.page.getByTestId('button-delete-job');
    await expect(deleteButton, 'The opened job should expose Delete').toBeVisible();
    const responsePromise = this.page.waitForResponse((response) =>
      /\/technical\/api\/jobs(?:[/?]|$)/i.test(response.url())
      && !['GET', 'OPTIONS'].includes(response.request().method()), { timeout: 30_000 });
    await deleteButton.click();
    const dialog = this.page.getByRole('alertdialog').or(this.page.getByRole('dialog')).filter({ visible: true }).last();
    let confirmation = '';
    if (await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) {
      confirmation = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      await dialog.getByRole('button', { name: /^(delete|confirm|yes(?:,? delete)?|ok)$/i }).last().click();
    }
    const response = await responsePromise;
    const feedback = await readAppNotification(this.page) || `The application returned HTTP ${response.status()}.`;
    return { confirmation, httpStatus: response.status(), ok: response.ok(), feedback };
  }

  public async cancel(): Promise<void> {
    await this.page.getByRole('button', { name: 'Back', exact: true }).click();
  }

  private controlFor(label: string): Locator {
    return this.page.getByText(label, { exact: true }).filter({ visible: true }).locator('xpath=following::*[@role="combobox" or self::select][1]');
  }

  private async selectFirstRealOption(label: string): Promise<string> {
    const control = this.controlFor(label);
    await expect(control, `${label} should be available on Job Form`).toBeVisible();
    const options = await control.locator('option').evaluateAll((nodes) => nodes.map((node) => ({
      value: (node as unknown as { value: string }).value,
      text: node.textContent?.trim() ?? '',
      disabled: (node as unknown as { disabled: boolean }).disabled,
    })));
    const option = options.find((item) => item.value && !item.disabled && !/^(?:select|— none —)/i.test(item.text));
    if (option) {
      await control.selectOption(option.value);
      return option.text;
    }
    await control.click();
    const choices = this.page.getByRole('option').filter({ visible: true });
    await expect(choices.first(), `${label} should offer at least one configured master value`).toBeVisible();
    for (let index = 0; index < await choices.count(); index += 1) {
      const choice = choices.nth(index);
      const text = (await choice.innerText()).replace(/\s+/g, ' ').trim();
      if (text && !/^(?:select|— none —)/i.test(text) && await choice.isEnabled()) {
        await choice.click();
        return text;
      }
    }
    throw new Error(`${label} exposed no selectable configured master value.`);
  }
}
