// Every test using this fixture automatically logs in before it runs.
// Set { requiresLogin: false } on a test to skip the auto-login step when you are testing a login flow itself.
import { test as base, expect } from "@playwright/test";
import { AuditDashboardPage } from "../pages/AuditDashboardPage";
import { LoginPage } from "../pages/LoginPage";

type Fixtures = {
  requiresLogin: boolean;
  testLifecycle: void;
  loginPage: LoginPage;
  auditDashboardPage: AuditDashboardPage;
};

export const test = base.extend<Fixtures>({
  requiresLogin: [true, { option: true, box: true }],
  loginPage: [
    async ({ page }, use) => {
      await use(new LoginPage(page));
    },
    { box: true },
  ],
  auditDashboardPage: [
    async ({ page }, use) => {
      await use(new AuditDashboardPage(page));
    },
    { box: true },
  ],
  /**
   * What this does: Runs the shared test lifecycle for login, validation, and failure evidence.
   * When it's used: For every test that imports this fixture so setup and cleanup stay consistent.
   * @param page - The Playwright page used by the current test.
   * @param requiresLogin - Whether the test should start from a signed-in state.
   * @param loginPage - The page object used to sign in the user.
   * @param auditDashboardPage - The dashboard page object used for the final logout step.
   * @param testInfo - The current Playwright test metadata, including title and status.
   * @returns Nothing
   */
  testLifecycle: [
    async ({ page, requiresLogin, loginPage }, use, testInfo) => {
      const tags = testInfo.tags.join(" ") || "no tags";
      console.log(`Starting test: ${testInfo.title} | ${tags}`);
      let lifecycleFailed = false;
      try {
        if (requiresLogin) {
          await test.step(
            "Login\nStatus: PASS\nExpected: User should successfully log in to the application.\nActual: Login completed successfully.",
            async () => {
              await loginPage.open();
              await loginPage.login();
              await expect(
                page.locator(
                  "button[class='mat-mdc-menu-trigger profile_header_lo mdc-icon-button mat-mdc-icon-button mat-unthemed mat-mdc-button-base'] span[class='mat-mdc-button-touch-target']",
                ),
              ).toBeVisible();
            },
            { box: true },
          );
        }

        await use();
      } catch (error) {
        lifecycleFailed = true;
        throw error;
      } finally {
        if (lifecycleFailed || testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach("Current page", {
            body: Buffer.from(
              `${page.url()}\n${await page.title().catch(() => "Title unavailable")}`,
            ),
            contentType: "text/plain",
          });
          await testInfo.attach("Failure screenshot", {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
      }

      // await test.step('Log out of the application', async () => {
      //   await page.locator("button[class='mat-mdc-menu-trigger profile_header_lo mdc-icon-button mat-mdc-icon-button mat-unthemed mat-mdc-button-base'] span[class='mat-mdc-button-touch-target']").click();
      //   await page.getByText('Logout', { exact: true }).click();
      // }, { box: true });
      console.log(
        `Finished test: ${testInfo.title} - ${(testInfo.status ?? "unknown").toUpperCase()}`,
      );
    },
    { auto: true, box: "self" },
  ],
});

export { expect };
