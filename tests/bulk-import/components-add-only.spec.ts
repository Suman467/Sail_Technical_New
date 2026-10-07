import { test } from '../../fixtures/baseFixture';
import { runComponentsAndRunningHoursScenario } from '../data-validation/components/components-validation-scenario';

test(
  'Components data validation - Add Only',
  { tag: ['@regression', '@components', '@running-hours', '@bulkimport', '@add-only', '@data-validation', '@positive'] },
  async ({ page, auditDashboardPage }) => {
    await runComponentsAndRunningHoursScenario(page, auditDashboardPage, 'addOnly');
  },
);
