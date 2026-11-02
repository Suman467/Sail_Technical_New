import { test as base, expect } from './baseFixture';
import { ComponentsPage } from '../pages/ComponentsPage';
import { openPrimaryComponentsSession, restoreComponentsPage } from '../utils/componentsSession';

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
  componentsPage: async ({ browser, testLifecycle }, use) => {
    void testLifecycle;
    const session = await openPrimaryComponentsSession(browser);
    try {
      await use(session.components);
      await restoreComponentsPage(session.page, session.components);
    } finally {
      await session.context.close();
    }
  },
});

export { expect };
