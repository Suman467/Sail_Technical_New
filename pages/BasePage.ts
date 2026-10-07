// Provides common page actions used by every page object.
// Child pages define their path and the control that proves they loaded.
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Represents a real screen in the application and holds the common actions all pages share.
 */
export abstract class BasePage {
  protected abstract readonly path: string;
  protected abstract readonly pageName: string;
  protected abstract readonly pageLoadedIndicator: Locator;
  private readonly userMenu: Locator;
  private readonly logoutButton: Locator;

  /**
   * What this does: Creates the page object and keeps the shared selectors used by all pages.
   * When it's used: Every time a page object is created for a screen or flow.
   * @param page - The Playwright page this object will control.
   * @returns Nothing
   */
  protected constructor(protected readonly page: Page) {
    this.userMenu = page.getByRole('button', { name: 'SR', exact: true });
    this.logoutButton = page.getByRole('menuitem', { name: 'Logout', exact: true });
  }

  /**
   * What this does: Opens the page and waits for the main screen element to appear.
   * When it's used: Before a test starts interacting with a page.
   * @returns Nothing
   */
  public async open(): Promise<void> {
    await this.page.goto(this.path);
    await this.expectToBeOnPage();
  }

  /**
   * What this does: Checks that the expected page URL and the page marker are visible.
   * When it's used: After navigation or when a test needs to confirm it is on the right screen.
   * @returns Nothing
   */
  public async expectToBeOnPage(): Promise<void> {
    await test.step(`${this.pageName} page is open`, async () => {
      await expect(this.page, `The ${this.pageName} page should open`).toHaveURL(this.path);
      await expect(this.pageLoadedIndicator, `The ${this.pageName} page should be ready`).toBeVisible();
    }, { box: true });
  }

  /**
   * What this does: Signs the current user out if the user menu is visible.
   * When it's used: At the end of a test or whenever the browser session should be closed.
   * @returns Nothing
   */
  public async logout(): Promise<void> {
    if (await this.userMenu.isVisible()) {
      await this.userMenu.click();
      await this.logoutButton.click();
    }
  }
}