// Verifies navigation from Audit to Technical Work Orders.
// Authentication is provided automatically by the shared fixture.
import { test } from '../../fixtures/baseFixture';

/**
 * What this does: Confirms the user can navigate from the Audit dashboard into Technical and then into Work Orders.
 * When it's used: In navigation regression coverage for the main menu flow.
 * @param auditDashboardPage - The signed-in dashboard page object for starting the flow.
 * @returns Nothing
 */
test('User can open Work Orders from the Audit menu', { tag: ['@smoke', '@regression', '@navigation', '@audit', '@technical', '@workorder', '@positive'] }, async ({ auditDashboardPage }) => {
  await test.step('Audit dashboard is shown', async () => {
    await auditDashboardPage.expectToBeOnPage();
  });
  const technicalPage = await test.step('Open Technical from the Audit menu', async () => auditDashboardPage.goToTechnical());
  await technicalPage.expectToBeOnPage();
  await test.step('Open Work Order', async () => {
    const workOrderPage = await technicalPage.openWorkOrder();
    await workOrderPage.expectToBeOnPage();
  });
});
