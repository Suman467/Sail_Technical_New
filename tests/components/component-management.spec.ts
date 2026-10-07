import { expect, test } from '../../fixtures/componentsFixture';

/**
 * What this does: Checks that the Components page loads and the visible count matches the list data.
 * When it's used: In the regression suite for component list validation.
 * @param componentsPage - The page object for the Components screen.
 * @returns Nothing
 */
test('Components list loads with the correct count', { tag: ['@regression', '@components', '@positive'] }, async ({ componentsPage }) => {
  await test.step('Components page is shown', async () => componentsPage.expectToBeOnPage());
  await test.step('The Components list is shown', async () => {
    await expect(componentsPage.firstRow(), 'The Components list should contain visible rows').toBeVisible();
  });
  await test.step('Displayed component count matches the visible rows', async () => {
    await expect.poll(() => componentsPage.displayedCount(), 'Displayed component count should match the visible row count').toBe(await componentsPage.rowCount());
  });
});

/**
 * What this does: Verifies the component list can be filtered by vessel and still matches the displayed count.
 * When it's used: In scenarios where a vessel-specific component list needs to be checked.
 * @param componentsPage - The page object for the Components screen.
 * @returns Nothing
 */
test('Component list can be filtered by vessel', { tag: ['@regression', '@components', '@positive'] }, async ({ componentsPage }) => {
  await test.step('Components page is shown', async () => componentsPage.expectToBeOnPage());
  await test.step('Select vessel PMS Test 3', async () => componentsPage.selectVessel('PMS Test 3'));
  await test.step('Filtered component count matches the visible rows', async () => {
    await expect.poll(() => componentsPage.displayedCount(), 'Filtered component count should match the visible row count').toBe(await componentsPage.rowCount());
  });
});

/**
 * What this does: Creates a component, confirms validation, updates it, and checks the changed values are visible.
 * When it's used: In the component management flow that covers create and edit actions.
 * @param componentsPage - The page object for the Components screen.
 * @returns Nothing
 */
test('A component can be added and then edited', { tag: ['@regression', '@components', '@positive', '@negative'] }, async ({ componentsPage }) => {
  await test.step('Components page is shown', async () => componentsPage.expectToBeOnPage());
  await test.step('Select vessel PMS Test 3', async () => componentsPage.selectVessel('PMS Test 3'));
  const form = await test.step('Open the Add Component form', async () => componentsPage.openComponentForAdd());
  const code = `AUTO-${Date.now()}`;
  const name = `Automated Component ${Date.now()}`;
  await test.step('Saving with empty mandatory fields shows validation errors', async () => {
    await form.save();
    await expect.poll(() => form.validationErrorsVisible(), 'Mandatory Component fields should show validation errors').toBe(true);
  });
  await test.step('Component is created with valid data', async () => {
    await form.fillMandatoryFields(code, name);
    await form.save();
    await expect.poll(() => form.successMessageVisible(), 'A component save success message should be shown').toBe(true);
  });
  const row = await componentsPage.findRowByCode(code);
  await test.step(`Component ${code} is visible in the list`, async () => {
    await expect(row, `Component ${code} should be visible after creation`).toBeVisible();
  });
  const updatedName = `${name} - Updated`;
  const editForm = await test.step(`Open Component ${code} for editing`, async () => componentsPage.openRowForEdit(row));
  await test.step(`Component ${code} can be edited`, async () => {
    await editForm.fillMandatoryFields(code, updatedName);
    await editForm.save();
    await expect.poll(() => editForm.successMessageVisible(), `Component ${code} should show an update success message`).toBe(true);
  });
  await test.step(`Component ${code} shows the updated name`, async () => {
    await expect(await componentsPage.findRowByCode(updatedName), `Component ${code} should show its updated name`).toBeVisible();
  });
});