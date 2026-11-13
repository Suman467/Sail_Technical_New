# Automation Execution Reporting Standard

This standard applies to every Playwright suite and every generated execution or audit report in this repository.

## Required case evidence

Every executed case must declare a scenario-specific business Expected Result and record meaningful actions chronologically. Each meaningful step must contain a plain-English Expected Result, an observed Actual Result created after the UI action, its own status and duration, and a screenshot attached to that exact step.

Meaningful actions include authentication or authenticated-session reuse, module navigation, vessel or record selection, initial-state capture, form or popup opening, data entry, the state immediately before Save/Submit/Cancel, the action response, refresh, persisted-state verification, and history/audit verification when relevant. Unchanged duplicate screenshots should not be added unless they prove a distinct state or session.

Actual Results use runtime application values and exact visible messages. Backend responses, request payloads, console errors, locators, call logs, stack traces, and assertion syntax belong only in Technical Details.

## State-changing scenarios

Any scenario that changes or attempts to change data must attach a module-appropriate comparison containing the initial state, entered or attempted state, and final verified state. Rejected, cancelled, failed, concurrent, and bulk workflows must explicitly show which records remained unchanged or became authoritative. Bulk workflows require one comparison row per affected record; concurrency workflows distinguish every session.

## Status rules

- PASS requires observed evidence for the intended business behavior and final verification.
- FAIL reports the attempted action, expected behavior, observed behavior, failure stage, and unreached validations.
- SKIPPED or BLOCKED reports the exact reason, missing prerequisite, whether application actions occurred, and whether screenshots exist.
- NOT EXECUTED is used when setup or dependency failure prevented the case from starting.

Missing evidence is never hidden. The shared reporter lists evidence-compliance gaps separately from application diagnostics while preserving the observed application/test outcome; reporting gaps do not falsely turn a successful business result into an application failure.

## Shared implementation

New tests import `utils/executionEvidence.ts` and use `executionScenario`, `executionActionStep`, `executionValidationStep`, `executionObservedCheck`, `executionNotExecutedStep`, and the comparison attachment appropriate to the module. Existing suites may temporarily use the compatibility exports in `utils/componentValidationEvidence.ts` while migrating.

`utils/SimpleReporter.ts` is the sole validation HTML renderer. `utils/standardAuditReport.ts` renders audit reports from the same execution evidence. Specs must not implement competing HTML formats.

Historical HTML may be regenerated only from preserved evidence. Missing historical screenshots or runtime values must be documented as unavailable and never reconstructed or invented.

## Automated enforcement

`utils/reportingStandards.ts` evaluates evidence completeness. `tests/reporting/reporting-standards.spec.ts` verifies the contract, totals, filters, diagnostics separation, and responsive rendering. A newly executed case with evidence gaps is identified in its report and cannot be silently represented as evidence-complete; its business outcome remains evidence-based and unchanged.

Migration progress and the repository audit baseline are recorded in `docs/AUTOMATION_REPORTING_MIGRATION_STATUS.md`.
