import { test } from '../../fixtures/baseFixture';
import { runComponentsAndRunningHoursScenario } from '../data-validation/components/components-validation-scenario';

test(
  'Components data validation - Add + Update',
  { tag: ['@regression', '@components', '@running-hours', '@bulkimport', '@add-update', '@data-validation', '@positive'] },
  async ({ page, auditDashboardPage }) => {
    await runComponentsAndRunningHoursScenario(page, auditDashboardPage, 'addAndUpdate');
  },
);
