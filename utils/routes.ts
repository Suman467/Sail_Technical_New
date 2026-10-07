/**
 * Keeps the app paths in one place so the page objects and tests all use the same URLs.
 */
export const routes = {
  login: '/login',
  home: '/home',
  auditDashboard: '/audit/dashboard/summary',
  technical: '/technical/',
  workOrder: '/technical/pms/work-orders',
  unplannedWorkOrderForm: '/technical/pms/work-order/unplanned/new',
  componentPage: '/technical/pms/components',
  runningHours: '/technical/pms/running-hrs',
  spares: '/technical/spares',
  stores: '/technical/stores',
  bulkDataImportPage: '/technical/pms/admin',
} as const;
