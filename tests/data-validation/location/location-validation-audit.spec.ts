import { test } from "../../../fixtures/baseFixture";
import { runLocationValidation } from "./location-validation-scenario";

test(
  "Location bulk upload validation and audit - Add + Update",
  { tag: ["@regression", "@location", "@data-validation", "@data-audit", "@bulkimport"] },
  async ({ page, auditDashboardPage }) => {
    await runLocationValidation(page, auditDashboardPage);
  },
);
