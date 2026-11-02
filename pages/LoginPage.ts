// Models the login screen for the application.
// Captcha is intentionally absent because this test account does not use it.
import { expect, type Locator, type Page } from '@playwright/test';
import { config } from '../utils/config';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { AuditDashboardPage } from './AuditDashboardPage';

/**
 * Models the main login screen for the application.
 */
export class LoginPage extends BasePage {
  protected readonly path = routes.login;
  protected readonly pageName = 'Login';
  protected readonly pageLoadedIndicator: Locator;
  private readonly usernameField: Locator;
  private readonly passwordField: Locator;
  private readonly domainField: Locator;
  private readonly loginButton: Locator;
  private readonly proceedButton: Locator;

  /**
   * What this does: Creates the login page object and stores the login form selectors.
   * When it's used: Before a test signs the user in.
   * @param page - The Playwright page instance for the login screen.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.usernameField = page.getByRole('textbox', { name: 'Username' });
    this.passwordField = page.getByRole('textbox', { name: 'Password' });
    this.domainField = page.getByRole('textbox', { name: 'Domain' });
    this.loginButton = page.getByRole('button', { name: 'Login' });
    this.proceedButton = page.getByRole('button', { name: 'Proceed', exact: true });
    this.pageLoadedIndicator = this.usernameField;
  }

  /**
   * What this does: Fills the sign-in form and confirms the dashboard opens after the login flow.
   * When it's used: In tests that need to start from a signed-in user session.
   * @param username - The user name to sign in with.
   * @param password - The password for that user.
   * @param domain - The login domain for the session.
   * @returns The dashboard page after a successful sign-in.
   */
  public async login(username = config.username, password = config.password, domain = config.domain): Promise<AuditDashboardPage> {
    const dashboard = await this.submitCredentials(username, password, domain);
    await dashboard.expectToBeOnPage();
    return dashboard;
  }

  /** Signs in for PMS navigation while accepting either supported authenticated landing route. */
  public async loginForPms(username: string, password: string, domain = config.domain): Promise<AuditDashboardPage> {
    const dashboard = await this.submitCredentials(username, password, domain);
    await this.page.waitForURL(/\/(?:home|audit\/dashboard\/summary)(?:[/?#]|$)/, { timeout: 30_000 });
    await expect(dashboard.pageLoadedIndicator, 'The authenticated landing page should show the Audit application entry').toBeVisible();
    await expect(this.page, 'Login should finish on an authenticated application page').toHaveURL(/\/(?:home|audit\/dashboard\/summary)(?:[/?#]|$)/);
    return dashboard;
  }

  private async submitCredentials(username: string, password: string, domain: string): Promise<AuditDashboardPage> {
    await this.usernameField.fill(username);
    await this.passwordField.fill(password);
    await this.domainField.fill(domain);
    // Commit the final Angular form control so its validation state updates
    // before checking the submit button.
    await this.domainField.press('Tab');
    await expect(this.loginButton).toBeEnabled();
    await this.loginButton.click();

    const dashboard = new AuditDashboardPage(this.page);
    await expect(this.proceedButton.or(dashboard.pageLoadedIndicator), 'The login result or active-session prompt should appear').toBeVisible();
    if (await this.proceedButton.isVisible()) {
      await this.proceedButton.click();
    }

    return dashboard;
  }
}
