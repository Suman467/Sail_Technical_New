// Models the signed-in Audit Dashboard.
// It is the starting point for authenticated navigation.
import { type Locator, type Page } from '@playwright/test';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { TechnicalPage } from './TechnicalPage';

/**
 * Models the signed-in Audit Dashboard screen where the user starts after login.
 */
export class AuditDashboardPage extends BasePage {
  protected readonly path = routes.auditDashboard;
  protected readonly pageName = 'Audit Dashboard';
  // The Audit button proves that the dashboard is ready.
  public readonly pageLoadedIndicator: Locator;
  private readonly technicalMenuItem: Locator;

  /**
   * What this does: Creates the dashboard page object and stores the selectors used on the Audit screen.
   * When it's used: When a test needs to work from the signed-in dashboard.
   * @param page - The Playwright page instance for this screen.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole('button', { name: 'Audit', exact: true });
    this.technicalMenuItem = page.getByRole('menuitem', { name: 'Technical', exact: true });
  }

  /**
   * What this does: Opens the Technical module from the dashboard and returns its page object.
   * When it's used: When a test needs to move from the dashboard into the Technical area.
   * @returns The Technical page object for the next navigation step.
   */
  public async goToTechnical(): Promise<TechnicalPage> {
    await this.pageLoadedIndicator.click();
    await this.technicalMenuItem.click();
    return new TechnicalPage(this.page);
  }
}