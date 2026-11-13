# Automation Reporting Migration Status

Baseline source audit on 2026-11-10: **3 of 52** Playwright spec entry points satisfied every static shared-evidence check or a documented wrapper/non-UI exemption. The audit is intentionally transparent; legacy gaps are not treated as compliant merely because the test process passes.

| Area | Spec entry points | Current priority |
|---|---:|---|
| Running Hours | 7 | Highest; concurrency/error handling is the reference implementation |
| Components | 17 | High; many already use structured steps but need comparison evidence normalized |
| Bulk Import | 15 | High; migrate existing import evidence to the shared API |
| Data Validation / Audit | 9 | Medium; bridge existing audit comparisons to the execution-evidence contract |
| Login and Navigation | 2 | Medium; add scenario declarations and step-linked UI evidence |
| Work Orders | 2 | Medium; add structured actions and state comparisons |

Run `npm run audit:reporting` for the current inventory or `npm run audit:reporting:strict` to fail when any source-level migration gap remains. Runtime HTML enforcement is independent of this source scan and identifies missing evidence in newly generated reports.

Pure calculation-only tests and wrapper entry points should be explicitly recognized by the audit rather than forced to fabricate UI screenshots. Historical reports remain unchanged when their original execution did not preserve the required evidence.
