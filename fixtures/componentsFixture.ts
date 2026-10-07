import { test as base, expect } from './baseFixture';
import { ComponentsPage } from '../pages/ComponentsPage';

/**
 * Provides the shared Components page setup used by component tests.
 */
export const test = base.extend<{ componentsPage: ComponentsPage }>({
  /**
   * What this does: Opens the Technical area and lands on the Components screen before the test runs.
   * When it's used: In tests that need a ready-to-use Components page object.
   * @param auditDashboardPage - The signed-in dashboard page used to navigate into the app.
   * @param testLifecycle - The shared setup hook that keeps the test lifecycle consistent.
   * @returns Nothing
   */
  componentsPage: async ({ auditDashboardPage, testLifecycle }, use) => {
    void testLifecycle;
    const technicalPage = await auditDashboardPage.goToTechnical();
    const componentsPage = await technicalPage.goToComponents();
    await componentsPage.expectToBeOnPage();
    await use(componentsPage);
  },
});

export { expect };