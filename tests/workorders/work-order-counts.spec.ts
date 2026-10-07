// Checks that Work Orders tab counts match their list totals.
// The selected vessel comes from the shared environment configuration.
import { test, expect } from '../../fixtures/baseFixture';
import { config } from '../../utils/config';

/**
 * What this does: Checks that each Work Orders tab count matches the number shown in the current list.
 * When it's used: In regression coverage for the Work Orders summary screen.
 * @param auditDashboardPage - The signed-in dashboard page object used to reach the work-order list.
 * @returns Nothing
 */
test('Work order counts on each tab match the list totals for the selected vessel', { tag: ['@regression', '@workorder', '@counts', '@positive'] }, async ({ auditDashboardPage }) => {
  const workOrderPage = await test.step('Open the Work Orders page', async () => {
    const technicalPage = await auditDashboardPage.goToTechnical();
    return technicalPage.openWorkOrder();
  });

  await test.step('Work Orders heading is shown', async () => {
    await workOrderPage.expectToBeOnPage();
  });

  await test.step('All seven tabs are visible', async () => {
    for (const name of workOrderPage.tabNames) {
      await expect(workOrderPage.tab(name), `${name} tab should be visible`).toBeVisible();
    }
  });

  await test.step(`Select vessel ${config.vesselName}`, async () => {
    await workOrderPage.selectVessel();
  });

  for (const name of workOrderPage.tabNames) {
    await workOrderPage.openTab(name);
    const listCount = await workOrderPage.footerCount();
    await test.step(`${name}: list shows ${listCount}, tab should show the same`, async () => {
      await expect.poll(() => workOrderPage.tabCount(name), {
        message: `${name}: the tab count should match the list total of ${listCount}`,
        timeout: 20_000,
      }).toBe(listCount);
    });
  }
});