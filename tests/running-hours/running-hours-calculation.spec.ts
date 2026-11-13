import { expect, test } from '@playwright/test';
import { expectedInheritedRunningHours, normalizeRunningHours, runningHoursSaveAccepted } from '../../utils/runningHoursValidation';

// @reporting-non-ui — deterministic calculation checks have no browser UI or screenshot evidence.

test.describe('Running Hours calculation rules', () => {
  test('normalizes equivalent numeric Running Hours displays', () => {
    expect(normalizeRunningHours('1,020 hrs')).toBe(1020);
    expect(normalizeRunningHours(' 1020.00 ')).toBe(1020);
    expect(normalizeRunningHours('—')).toBeUndefined();
  });

  test('calculates the inherited value only for a confirmed Parent Component source', () => {
    expect(expectedInheritedRunningHours({
      masterBefore: 1000,
      masterAfter: 1020,
      inheritedBefore: 400,
      counterType: 'Inherited',
      counterSource: 'Parent Component',
    })).toBe(420);

    expect(expectedInheritedRunningHours({
      masterBefore: 1000,
      masterAfter: 1020,
      inheritedBefore: 400,
      counterType: 'Master',
      counterSource: 'Self',
    })).toBeUndefined();
  });

  test('classifies immediate Save evidence without rejecting a closed successful dialog', () => {
    expect(runningHoursSaveAccepted({ responseStatus: 200, feedback: '', dialogClosed: true })).toBe(true);
    expect(runningHoursSaveAccepted({ feedback: '', dialogClosed: true })).toBe(true);
    expect(runningHoursSaveAccepted({ feedback: 'Running hours updated successfully', dialogClosed: false })).toBe(true);
    expect(runningHoursSaveAccepted({ responseStatus: 500, feedback: '', dialogClosed: true })).toBe(false);
    expect(runningHoursSaveAccepted({ feedback: 'Unable to update running hours', dialogClosed: true })).toBe(false);
    expect(runningHoursSaveAccepted({ feedback: '', dialogClosed: false })).toBe(false);
  });
});
