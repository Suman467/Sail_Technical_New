import { expect, test } from '../../fixtures/baseFixture';

/**
 * What this does: Creates an unplanned work order, verifies its draft status, and submits it for approval.
 * When it's used: In the work-order flow that covers creation and submission.
 * @param auditDashboardPage - The signed-in dashboard page object used to start the flow.
 * @returns Nothing
 */
test('Unplanned work order can be created and submitted for approval', { tag: ['@regression', '@workorder', '@unplanned', '@positive'] }, async ({ auditDashboardPage }) => {
  const workOrderPage = await test.step('Open the Unplanned Work Orders table', async () => {
    const technicalPage = await auditDashboardPage.goToTechnical();
    const page = await technicalPage.openWorkOrder();
    await page.selectVessel('PMS Test 3');
    await page.openTab('Unplanned');
    return page;
  });

  const beforeCount = await test.step('Read the current Unplanned count', async () => workOrderPage.tabCount('Unplanned'));
  const highestBefore = await test.step('Read the highest existing Work Order number', async () => workOrderPage.highestWorkOrderNumber());
  const form = await test.step('Open the Unplanned work order form', async () => workOrderPage.clickUnplannedWO());
  const componentName = await form.firstComponentName();

  await test.step('Fill Job Details', async () => form.fillJobDetails());
  await test.step('Component Code fills in after selecting Component Name', async () => form.selectComponent(componentName));
  const ranks = await test.step('Select a lower Assigned To rank and higher Approver rank', async () => form.selectAssignedAndApprover());
  expect(ranks.assigned, 'Assigned To and Approver ranks must be different').not.toBe(ranks.approver);
  expect(ranks.approverRank, `${ranks.approver} must be higher than ${ranks.assigned}`).toBeGreaterThan(ranks.assignedRank);
  await test.step('Select NA for all B1 Risk Assessment questions', async () => form.answerRiskAssessmentNA());
  await test.step('Fill required work duration details', async () => form.fillWorkDuration(ranks.assigned));

  const savedPage = await test.step('Save the work order as a draft', async () => form.save());
  await savedPage.openTab('Unplanned');
  const expectedNumber = highestBefore + 1;
  const row = savedPage.findRowByWorkOrderNumber(expectedNumber);
  const woNumber = await savedPage.workOrderNumberOf(row);
  await test.step(`Unplanned count increased and Work Order ${woNumber} is shown as Draft`, async () => {
    await expect.poll(() => savedPage.tabCount('Unplanned'), { message: `Unplanned count should increase from ${beforeCount} for Work Order ${woNumber}` }).toBe(beforeCount + 1);
    await expect.poll(() => savedPage.highestWorkOrderNumber(), { message: `Work Order ${woNumber} should be the next sequence after ${highestBefore}` }).toBe(expectedNumber);
    await expect(row, `Work Order ${woNumber} should be visible in the Unplanned table`).toBeVisible();
    await expect.poll(() => savedPage.statusOf(row), { message: `Work Order ${woNumber} should be Draft` }).toBe('Draft');
  });





  const editForm = await test.step('Open the saved work order for editing', async () => savedPage.openForEdit(row));
  const submittedPage = await test.step('Submit the work order for approval', async () => editForm.submitWorkOrder());
  await submittedPage.openTab('Unplanned');
  const submittedRow = submittedPage.findRowByWorkOrderNumber(expectedNumber);
  await test.step(`Work Order ${woNumber} status is Pending Approval`, async () => {
    await expect.poll(() => submittedPage.statusOf(submittedRow), { message: `Work Order ${woNumber} should be Pending Approval` }).toBe('Pending Approval');
  });

  

  const approvalPage = await test.step(`Search and open Work Order ${woNumber}`, async () => submittedPage.openSearchResult(woNumber));
  await test.step(`Enter approval remarks for Work Order ${woNumber}`, async () => approvalPage.enterApprovalRemarks('Approved via automated test'));
  const completedPage = await test.step(`Approve Work Order ${woNumber}`, async () => approvalPage.approve());
  await completedPage.openTab('Unplanned');
  const completedRow = completedPage.findRowByWorkOrderNumber(expectedNumber);
  await test.step(`Work Order ${woNumber} status is Completed`, async () => {
    await expect.poll(() => completedPage.statusOf(completedRow), { message: `Work Order ${woNumber} should be Completed` }).toBe('Completed');
  });



});