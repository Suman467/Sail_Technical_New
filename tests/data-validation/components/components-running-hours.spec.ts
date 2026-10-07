import { test } from '../../../fixtures/baseFixture';
import { runComponentsAndRunningHoursScenario } from './components-validation-scenario';

test(
  'Components data validation - Add + Update - Running Hours',
  {
    tag: [
      '@regression',
      '@components',
      '@running-hours',
      '@bulkimport',
      '@add-update',
      '@data-validation',
      '@positive',
    ],
  },
  async ({ page, auditDashboardPage }) => {
    await runComponentsAndRunningHoursScenario(
      page,
      auditDashboardPage,
      'addAndUpdate',
      { stopAfterRunningHours: true },
    );
  },
);
