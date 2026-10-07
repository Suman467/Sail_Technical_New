import { test } from '../../../fixtures/baseFixture';
import { runComponentsAndRunningHoursScenario } from './components-validation-scenario';

test(
  'Components data validation - Update Only',
  { tag: ['@regression', '@components', '@running-hours', '@bulkimport', '@update-only', '@data-validation', '@positive'] },
  async ({ page, auditDashboardPage }) => {
    await runComponentsAndRunningHoursScenario(page, auditDashboardPage, 'updateOnly');
  },
);
