// Models the Technical module page.
// Its Work orders link confirms the module is ready for navigation.
import { type Locator, type Page } from '@playwright/test';
import { routes } from '../utils/routes';
import { BasePage } from './BasePage';
import { ComponentsPage } from './ComponentsPage';
import { WorkOrderPage } from './WorkOrderPage';
import { RunningHoursPage } from './RunningHoursPage';
import { SparesPage } from './SparesPage';
import { StoresPage } from './StoresPage';

/**
 * Models the Technical module landing page, which links to the main operational screens.
 */
export class TechnicalPage extends BasePage {
  protected readonly path = routes.technical;
  protected readonly pageName = 'Technical';
  // The Work orders link proves that Technical is ready.
  protected readonly pageLoadedIndicator: Locator;

  /**
   * What this does: Creates the Technical page object and stores the module's main navigation marker.
   * When it's used: After entering the Technical area from the dashboard.
   * @param page - The Playwright page instance for the Technical page.
   * @returns Nothing
   */
  public constructor(page: Page) {
    super(page);
    this.pageLoadedIndicator = page.getByRole('link', { name: 'Work orders', exact: true });
  }

  /**
   * What this does: Opens the Work Orders page and returns its page object.
   * When it's used: When a test needs to manage work orders.
   * @returns The Work Orders page object.
   */
  public async openWorkOrder(): Promise<WorkOrderPage> {
    await this.pageLoadedIndicator.click();
    return new WorkOrderPage(this.page);
  }
  
  /**
   * Opens the PMS Admin area used by the Bulk Data Import flow.
   * Keep this navigation in the Technical Page Object so specs do not contain UI selectors.
   */
  public async openAdmin(): Promise<void> {
    await this.page.getByTestId('nav-pms-admin').click();
  }

  /**
   * What this does: Opens the Components page and returns its page object when needed.
   * When it's used: In tests that need to manage components from the Technical module.
   * @returns The Components page object.
   */
  public async goToComponents(): Promise<ComponentsPage> {
    if (!this.page.url().includes(routes.componentPage)) {
      await this.page.getByRole('link', { name: 'Components', exact: true }).click();
    }
    return new ComponentsPage(this.page);
  }

  /**
   * Opens the Running Hours screen and returns its page object.
   */
  public async goToRunningHours(): Promise<RunningHoursPage> {
    if (!this.page.url().includes(routes.runningHours)) {
      await this.page.getByRole('link', { name: 'Running Hrs', exact: true }).click();
    }
    return new RunningHoursPage(this.page);
  }

  public async goToSpares(): Promise<SparesPage> {
    if (!this.page.url().includes(routes.spares)) await this.page.getByRole('link', { name: 'Spares', exact: true }).click();
    return new SparesPage(this.page);
  }

  public async goToStores(): Promise<StoresPage> {
    if (!this.page.url().includes(routes.stores)) await this.page.getByRole('link', { name: 'Stores', exact: true }).click();
    return new StoresPage(this.page);
  }
}
