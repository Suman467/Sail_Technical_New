// Verifies that a user can sign in through the real login screen.
// This spec owns its login flow and does not use the common login fixture.
import { test } from '../../fixtures/baseFixture';

test.use({ requiresLogin: false, storageState: { cookies: [], origins: [] } });

/**
 * What this does: Signs in with the real login form and checks that the Audit Dashboard opens.
 * When it's used: In login smoke and regression coverage.
 * @param loginPage - The page object used to complete the sign-in flow.
 * @returns Nothing
 */
test('User can reach the Audit Dashboard after signing in', { tag: ['@smoke', '@regression', '@login', '@positive'] }, async ({ loginPage }) => {
  await test.step('Open the login page', async () => {
    await loginPage.open();
  });
  const dashboard = await test.step('Enter details and sign in', async () => loginPage.login());
  await test.step('Confirm the Audit Dashboard is shown', async () => {
    await dashboard.expectToBeOnPage();
  });
});
