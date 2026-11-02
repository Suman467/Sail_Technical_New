# Sail Technical Playwright Framework Review

**Review date:** 23 October 2026  
**Scope:** Current local working tree and Git index  
**Method:** Static, read-only inspection. No PMS request, Playwright test, cleanup, package installation, or dependency update was executed. Runtime behavior was not independently verified. Secret values were not read into this report or reproduced.

## A. Executive Summary

The framework contains substantial, thoughtful automation engineering. It uses strict TypeScript, Page Objects, reusable fixtures, environment-based configuration, workbook-driven validation, tracked automation data, manually gated cleanup, failure screenshots/traces, and custom business-oriented validation and audit reports. The newer Components suites are especially deliberate about persistence, exact runtime identities, session recovery, and preserving genuine application failures.

The repository is nevertheless **not ready to share in its current form**. A populated `.env` is tracked by Git; generated reports and evidence are also tracked; the current working tree contains 106 changed/untracked/deleted entries; and the CI workflow is inconsistent with the Playwright configuration. There are also material test-quality gaps: CMP-131 does not prove that the single Work Order is planned, CMP-125 may skip instead of creating the genuinely new component its objective requires, the Components fixture can perform a redundant login in an unused context, and a diagnostic probe is included in normal discovery and logs application tree data.

The framework is a strong evolving implementation, but not yet a clean, reproducible, security-reviewed handover package.

## B. Framework Architecture

### Project shape

The inspected project includes:

- 43 Playwright `.spec.ts` files and 162 statically located `test(...)` declarations under `tests/`.
- 15 TypeScript Page Object files under `pages/`.
- General and Components-specific fixtures under `fixtures/`.
- 15 TypeScript utilities under `utils/`, including configuration, session reuse, test-data tracking, business evidence, reporting, audit generation, and route definitions.
- Workbook/document fixtures and cleanup records under `test-data/`.
- Node and PowerShell execution/report scripts under `scripts/`.
- Playwright, TypeScript, ESLint, npm, GitHub Actions, README, and project-reporting configuration.

There is no `helpers/` directory. This is not an architectural defect because equivalent shared behavior is located in `utils/` and Page Objects.

### Configuration and execution

`playwright.config.ts` configures Chromium, one worker, non-parallel execution, failure traces/screenshots, CI retries, headed local execution unless `HEADLESS=true`, Playwright HTML output, and `SimpleReporter`. One worker is appropriate for shared credentials and stateful PMS data, but the global retry policy can repeat mutating scenarios.

`utils/config.ts` centralizes environment access and fails early for core missing values. `package.json` supplies full-suite, smoke, login, reporting, type-check, lint, packaging, and manually gated Components-cleanup commands.

### Tests and Page Objects

Coverage spans login, navigation, Work Orders, bulk import, Components, Jobs, Spares, Stores, Running Hours, workbook audits, reporting standards, concurrency, linked Jobs, and linked Work Orders. Test intent is generally expressed in business terms and newer Components tests use shared reporting wrappers.

The Page Object boundary is broadly sound, but several files have become large multi-area modules:

- `pages/ComponentsPage.ts`: 1,987 lines.
- `pages/ComponentFormPage.ts`: 1,065 lines.
- `pages/BulkDataImportPage.ts`: 1,080 lines.
- `utils/SimpleReporter.ts`: 1,874 lines.

These sizes are not failures by themselves, but they increase review cost and regression risk. Any later split should follow stable UI or reporting responsibilities and preserve public APIs.

### Authentication and state

The general fixture logs in through the UI per test. Components suites can instead use `utils/componentsSession.ts`, which authenticates once, writes run-scoped browser state to the OS temporary directory, and allows replacement workers to reuse it. Each scenario still receives an isolated browser context.

That model is conceptually good, but `fixtures/componentsFixture.ts` extends the auto-login fixture and also opens its own Components session. A test using that fixture can therefore authenticate an unused default `page` and then open a second authenticated context.

### Reporting and data lifecycle

`componentValidationEvidence.ts`, `SimpleReporter.ts`, and `standardAuditReport.ts` implement scenario declarations, chronological business actions, scenario Expected/Actual results, evidence, separate Technical Details, Common Setup consolidation, worker-recovery metadata, and Passed/Failed/Skipped/Not Executed reporting. Focused reporting-standard tests are present.

Automation-created Components are tracked with identity and cleanup status. Normal execution does not invoke cleanup; cleanup has a dedicated command and exact-identity safeguards.

## C. Implemented Features

Static inspection verifies code for:

- Login and Technical/PMS navigation.
- Components selection, creation, required-field validation, uniqueness and hierarchy checks, editing, refresh/reopen persistence, and selected concurrency flows.
- Component-linked Jobs: view/no-jobs, Add Job, Save & Add Jobs, Generate Work Order, list controls, scenario-owned deletion, incomplete-component behavior, Add Job cancellation, and duplicate planned Work Order prevention.
- Work Order listing, creation, approval, association checks, and tab/status searches.
- Running Hours, condition monitoring, rotation items, and stamps.
- Component, Job, Spare, Store, Location, and bulk-import workbook workflows.
- Full/limited record-level data audits.
- Primary and secondary user contexts in selected concurrency code.
- Automation-created Component tracking and explicit manual cleanup.
- Validation HTML, audit HTML, Playwright HTML, attachments, screenshots, traces, status filters, and report packaging.

These are verified as code paths, not successful application executions.

## D. Positive Findings

1. **Strong type baseline.** `tsconfig.json` enables strict TypeScript and no emit.
2. **Useful abstraction boundaries.** Tests usually express business intent while Page Objects own UI mechanics.
3. **Generally resilient locator strategy.** Roles, accessible names, labels, placeholders, and test IDs are common; no `force: true` usage was found.
4. **Real persistence assertions.** `tests/components/components-edit-and-persistence.spec.ts:204-217` saves, reopens, compares exact values, and checks record count. The known Edit/Save defect remains observable as a failure.
5. **Controlled failure coverage.** `tests/components/components-edit-and-persistence.spec.ts:296-325` exercises an injected failed-save response and verifies that no false success or stored-value change occurs.
6. **Safe cleanup design.** `package.json:10`, `playwright.config.ts:15-27`, `scripts/run-playwright.cjs`, and `tests/components/clean.spec.ts:14-24` keep cleanup manually invoked and separately authorized.
7. **Traceable automation data.** `utils/componentCreationTracker.ts` validates tracked records, serializes updates with a lock, uses atomic replacement, and records cleanup outcomes.
8. **Good failure evidence.** Components suites capture evidence before restoring the page, while Playwright retains failure screenshots/traces.
9. **Business-oriented reporting.** Shared utilities separate understandable Expected/Actual results from technical diagnostics and distinguish test-case statuses from step statuses.
10. **State protection.** A single worker and non-parallel execution reduce collisions on shared accounts and mutable PMS data.

## E. Issues Identified

### FR-001 — Critical — Sensitive environment file is tracked

- **Location:** `.env`; `.gitignore`; `README.md` environment/security guidance.
- **Evidence:** `git ls-files .env .env.example` returns both files. `.gitignore` does not exclude `.env`, although the README says it is ignored. No secret value was reproduced.
- **Impact:** Repository sharing can disclose credentials, environment URLs, user/account identifiers, and operational configuration. Removing the current file alone would not remove values from Git history.
- **Recommended correction:** Rotate any committed credentials, remove `.env` from the index and approved history, add `.env` and environment variants to `.gitignore`, retain only a sanitized example, and secret-scan the full history before distribution.

### FR-002 — High — Generated reports and evidence are tracked

- **Location:** `.gitignore`; tracked files under `reports/` (44 paths in the Git index).
- **Evidence:** Git tracks validation/audit HTML and packaged evidence while `.gitignore` does not exclude `reports/`. The working tree currently shows many tracked reports deleted locally.
- **Impact:** Reports can contain screenshots, URLs, runtime record identities, usernames, application messages, and technical diagnostics. Binary/generated churn also obscures source review.
- **Recommended correction:** Store reports in an access-controlled artifact system, add generated report paths/archives to ignore rules, remove them from source history according to policy, and review/redact existing evidence before sharing.

### FR-003 — High — CMP-131 does not prove that the retained Work Order is planned

- **Location:** `tests/components/components-linked-jobs-work-orders.spec.ts:618-673`, especially `652-671`.
- **Evidence:** The first generation checks a 2xx response and non-empty Work Order number. The final check searches all Work Order tabs and asserts one unique number for the job, but does not assert that the found row/tab/field has actual status `Planned`. The Actual text says “planned Work Order” based on count, not an explicit status assertion.
- **Impact:** CMP-131 can pass with one Work Order in an unexpected status, even though duplicate protection is specifically for an existing planned Work Order.
- **Recommended correction:** Assert the observed status/tab from the first created Work Order is Planned, preserve that exact status after the second attempt, and only then report the duplicate-protection scenario as PASS.

### FR-004 — High — CMP-125 can skip instead of exercising its required creation workflow

- **Location:** `tests/components/components-linked-jobs-work-orders.spec.ts:207-267`, especially `209-226`.
- **Evidence:** If any pending historical CMP-125 Component already contains the derived Job, the scenario calls `test.skip` and does not create a genuinely new Component via Save & Add Jobs.
- **Impact:** A run can omit the core business objective and report an intentional skip merely because stale automation data exists. Dependent cases then use a prior-run fixture.
- **Recommended correction:** Make CMP-125 create one unique current-run Component/Job as its own scenario requires. Reuse should be limited to explicit recovery of the same interrupted run, with durable run identity and evidence.

### FR-005 — High — Components fixture can perform redundant authentication

- **Location:** `fixtures/baseFixture.ts:38-58,87`; `fixtures/componentsFixture.ts:8-24`.
- **Evidence:** The inherited `testLifecycle` is auto-enabled and UI-logs in the default `page`. `componentsPage` then calls `openPrimaryComponentsSession(browser)`, which opens a separate context from Components storage state. `void testLifecycle` ensures the first lifecycle runs but its page is not used by the Components Page Object.
- **Impact:** Unnecessary login traffic, slower tests, confusing login counts, and inconsistent reporting of the session actually used.
- **Recommended correction:** Override `requiresLogin` for this fixture or build the Components fixture directly from the appropriate base so only the Components session authenticates. Preserve the general fixture behavior for non-Components suites.

### FR-006 — High — GitHub Actions is inconsistent with runtime configuration

- **Location:** `.github/workflows/playwright.yml:17-24`; `playwright.config.ts:14,50-59,83-85`.
- **Evidence:** CI runs `npx playwright test` without `HEADLESS=true`, while the config is headed unless that variable is exactly true. The workflow uploads `playwright-report/`, but configured HTML output is `reports/validation/playwright-html`.
- **Impact:** Linux CI may fail because no graphical display is available, and the workflow may upload no Playwright HTML report even when execution completes.
- **Recommended correction:** Set `HEADLESS=true` in CI, upload the configured report/evidence paths, provide required variables through protected secrets/environment configuration, and separate safe checks from controlled PMS E2E execution.

### FR-007 — High — Current repository state is not reproducible or review-ready

- **Location:** Git working tree as a whole.
- **Evidence:** `git status --short` reports 106 entries, including modified source/configuration, deleted tracked reports, and untracked framework files. Only a static snapshot of this mixed state can be reviewed.
- **Impact:** A manager or another QA engineer cannot know which files constitute the intended deliverable or reproduce this exact framework from a clean clone.
- **Recommended correction:** Review and intentionally commit the approved source in coherent changes, exclude generated/confidential files, then verify a clean clone before handover. Do not use destructive reset/cleanup to achieve this.

### FR-008 — High — Stateful fixture lookup is not bound to the current run

- **Location:** `tests/components/components-linked-jobs-work-orders.spec.ts:35-37,209-226,274-296,586-588`.
- **Evidence:** CMP-125/CMP-126/CMP-128 choose pending CMP-125 tracker records by vessel/test ID, and CMP-131 chooses the last pending or failed automation Component. None of these queries require the current `runId` or a proven recovery token.
- **Impact:** Tests can use stale prior-run data with unexpected Jobs or Work Orders, making results nondeterministic and potentially modifying a record not created for the current scenario.
- **Recommended correction:** Persist exact scenario fixture identities for the active run, distinguish same-run worker recovery from a new command, and fail/mark dependency NOT EXECUTED rather than silently selecting an arbitrary historical record.

### FR-009 — High — Two-user conflict test is permanently disabled

- **Location:** `tests/components/components-edit-and-persistence.spec.ts:389`.
- **Evidence:** CMP-091 is declared with `test.skip(...)`, so its detailed two-user implementation is never reached.
- **Impact:** Concurrency conflict behavior may be described as implemented while providing no default executable coverage; dormant code can drift.
- **Recommended correction:** Either enable it only in an approved environment with two configured users and isolated data, or clearly list it as backlog/manual coverage rather than active automation.

### FR-010 — Medium — Authenticated state remains in the OS temporary directory

- **Location:** `playwright.config.ts:6-12`; `utils/componentsSession.ts:21-48`.
- **Evidence:** Browser storage state is written as JSON to a PID-named temporary path. No teardown removes it or explicitly restricts its permissions.
- **Impact:** Session cookies/tokens can remain on a shared workstation after the run.
- **Recommended correction:** Use restrictive file permissions where supported, delete the exact run-scoped file in global teardown/process cleanup, and ensure no packaging/report process includes it.

### FR-011 — Medium — Diagnostic probe runs in normal discovery and logs application data

- **Location:** `tests/components/zz-probe.spec.ts:5-26`.
- **Evidence:** The file is a normal `.spec.ts`; it traverses the live Component tree and logs codes, names, depths, and child relationships.
- **Impact:** Full-suite runs include a non-business diagnostic test and CI logs may disclose operational hierarchy data.
- **Recommended correction:** Move it outside normal discovery or place it in an explicitly selected diagnostic project/tag; remove broad data logging or attach narrowly scoped redacted diagnostics only when authorized.

### FR-012 — Medium — Hardcoded vessel and hierarchy values remain

- **Location:** `tests/workorders/unplanned-work-order-creation.spec.ts:13`; `tests/components/component-management.spec.ts:30,43,46`; `tests/components/components-linked-jobs-work-orders.spec.ts:20,184-208`.
- **Evidence:** `PMS Test 3`, parent code `8`, and business Expected text naming `AUTO_VESSEL_002` are embedded in specs while runtime vessel configuration exists.
- **Impact:** Tests and reports can target or describe the wrong environment, and a configured vessel change may not propagate consistently.
- **Recommended correction:** Use validated configuration/fixture data for runtime identity and interpolate observed values in reporting. Keep fixed hierarchy codes only where they are an explicit documented test prerequisite.

### FR-013 — Medium — Fixed timing delays remain in core workflows

- **Location:** `pages/ComponentFormPage.ts:246,440,652,741,794,833,842`; `pages/StoresPage.ts:34`; `pages/RunningHoursPage.ts:316`; `pages/ComponentsPage.ts:372`; `pages/BulkDataImportPage.ts:1020`.
- **Evidence:** Eleven `waitForTimeout` calls remain, including 5-second and 5.5-second waits in form hydration paths.
- **Impact:** Fast runs wait unnecessarily while slow environments can still exceed the delay, causing flakiness.
- **Recommended correction:** Prefer observable readiness: stable controlled-field values, enabled state, completed responses, busy-marker disappearance, or bounded polling. Document any delay for which the application exposes no reliable signal.

### FR-014 — Medium — Shared login success uses an exact style-class selector

- **Location:** `fixtures/baseFixture.ts:50-54`.
- **Evidence:** Login success depends on an exact Material CSS class string and nested span.
- **Impact:** A styling/library update can break every general-fixture test even when login succeeds.
- **Recommended correction:** Use a stable accessible role/name, test ID, URL, or dashboard landmark modeled by a Page Object.

### FR-015 — Medium — Large multi-responsibility core files increase regression risk

- **Location:** `pages/ComponentsPage.ts`, `pages/ComponentFormPage.ts`, `pages/BulkDataImportPage.ts`, `utils/SimpleReporter.ts`.
- **Evidence:** The files range from 1,065 to 1,987 lines and cover multiple sections/workflows or collection/classification/rendering concerns.
- **Impact:** Changes are harder to review and test in isolation; synchronization and reporting rules can become coupled.
- **Recommended correction:** After blocking defects are resolved, extract cohesive internal modules with characterization tests and unchanged public test APIs.

### FR-016 — Medium — Global CI retries can repeat data-changing actions

- **Location:** `playwright.config.ts:44-48`; creation/import/Work Order specs.
- **Evidence:** Every CI failure is retried twice, including scenarios that may already have created server-side data before failing.
- **Impact:** Retries can create duplicates or make the retry observe a different prerequisite, obscuring the first result.
- **Recommended correction:** Make mutations idempotent and recover exact current-run identities, or disable retries for non-idempotent projects/specs while retaining them for safe read-only tests.

### FR-017 — Medium — Binary test data requires confidentiality/provenance review

- **Location:** tracked `.xlsx`/`.docx` files under `test-data/` (16 Git-index paths).
- **Evidence:** Names indicate Component, Job, Spare, Store, Location, vessel, and framework-guide content; authorization/provenance is not documented in code.
- **Impact:** A handover package could distribute production-derived or internally confidential data.
- **Recommended correction:** Obtain data-owner approval, sanitize/anonymize fixtures, document provenance, and move large/confidential fixtures to controlled storage when appropriate.

### FR-018 — Medium — Documentation is stale or contradictory

- **Location:** `README.md` setup, suite inventory, security, and known-review sections.
- **Evidence:** README says `.env` and reports are ignored, contrary to `.gitignore` and the Git index. It does not provide a complete current matrix for newer CMP scenarios, their dependencies, mutations, and skip/NOT EXECUTED conditions.
- **Impact:** A new QA engineer can mispackage secrets/evidence or misunderstand automated coverage.
- **Recommended correction:** Correct repository-hygiene statements and add a maintained coverage/prerequisite matrix with scenario status, data ownership, mutation behavior, session model, and cleanup responsibility.

### FR-019 — Low — Package/report tooling has portability and metadata gaps

- **Location:** `package.json:4-19`; `README.md` reporting commands.
- **Evidence:** Description and keywords are empty; `report:summary` uses Windows `start`; packaging uses PowerShell; Prettier is installed without a format-check command.
- **Impact:** Minor handover friction, especially for macOS/Linux engineers.
- **Recommended correction:** Document Windows as required or provide cross-platform Node commands; add accurate metadata and an optional format-check workflow.

## F. Test Reliability Assessment

### Independence and dependencies

Many suites are independently runnable, but Components groups deliberately share a browser context and created records. That is acceptable when dependencies are explicit and ordered. The main risk is selection of historical tracker records without current-run identity (FR-008). Serial or shared-state groups also mean a setup failure can prevent later dependent cases; reporting utilities appropriately distinguish NOT EXECUTED where used.

CMP-131 now creates its own Job and performs first/second Generate WO actions, which is a meaningful improvement over relying on CMP-126. Its remaining reliability gap is the missing explicit Planned-status assertion. CMP-132 is intentionally skipped. CMP-091 is statically skipped. These must remain visible in the coverage inventory.

### Assertions and false positives

The strongest scenarios assert exact identities, server responses, refreshed/reopened values, association fields, and record counts. CMP-126 now generates a Work Order, confirms response/number, refreshes the Work Orders page, and checks Job/Component association. CMP-127 now exercises Show All, Collapse, optional Expand, and optional pagination and checks uniqueness/counts; the older draft finding that these two cases simply fell through is no longer valid.

CMP-131’s “only one” assertion is useful, but Planned status must be observed rather than inferred. CMP-125’s skip path is a coverage omission, not proof that Save & Add Jobs worked in the current execution.

### Failure handling

Components tests generally capture a screenshot before restore, use scenario-specific Expected/Actual results, and allow independent later cases to continue when a worker can recover. Some `.catch(() => undefined/false)` calls intentionally protect the primary failure or probe optional UI; they must not suppress an assertion essential to the business result.

### Locators and waits

The prevailing role/test-ID approach is positive. The shared-login exact class selector is brittle. Fixed hydration delays remain. Some complex grids necessarily use CSS structure and horizontal scrolling; these should be supported by stable test IDs where the application can provide them.

### Mutation safety

Unique tokens and Component tracking reduce collision risk, and normal teardown does not clean application data. CMP-128 deletes only the Job it creates for that scenario. Nevertheless, bulk import and Work Order creation are inherently mutating, historical fixture selection is risky, and CI retries can repeat a write.

## G. Reporting Assessment

The reporting framework substantially satisfies the project standard:

- Common Setup/Initial Navigation is consolidated.
- Meaningful actions are captured in chronological order and renumbered.
- Scenario declarations provide Expected Results even when the body cannot run.
- Runtime Actual Results can be recorded after observation.
- Passed, Failed, Skipped, and Not Executed are distinct test outcomes and filters.
- Unreached planned checks can be reported as NOT EXECUTED.
- Business language is separated from raw errors, locators, call logs, and stacks.
- Failure screenshots and Technical Details are supported.
- Worker/session recovery metadata is separate from normal business steps.

Risks are implementation concentration (`SimpleReporter.ts` is 1,874 lines), convention-heavy parsing of step titles/attachments, and the possibility of inaccurate business wording when a test itself infers an outcome (as CMP-131 currently infers Planned status). Reporting cannot correct an incomplete business assertion; the test must establish the fact first.

Existing reporting-standard tests are a good safeguard. Additional focused tests should cover session recovery, timeout while a step is active, first-failed-step selection, historical evidence preservation, and failure-stage classification without title-based cross-contamination.

## H. Security Assessment

The principal security blockers are:

1. A populated `.env` is tracked.
2. Generated reports/evidence are tracked.
3. Authenticated browser state is left in the OS temporary directory.
4. The diagnostic probe logs Component hierarchy information.
5. Binary test data lacks documented sharing approval/provenance.

Positive controls include environment-based credential access, ignored `playwright/.auth` and default test-result/cache paths, distinct secondary-user environment variables, run-scoped temporary auth filenames, and strict cleanup authorization.

Before sharing, use an approved secret scanner against the complete Git history. Exclude `.env`, auth state, reports, traces, screenshots, archives, and unreviewed workbooks/documents from the management package.

## I. Documentation and Handover Readiness

README provides useful Windows-oriented instructions for installation, environment setup, full/single/tagged runs, report viewing/packaging, type-checking, linting, and manual cleanup. Another QA engineer could understand the broad framework layout.

They could not yet safely reproduce and operate it from a clean clone because the intended source snapshot is not committed cleanly, Git hygiene contradicts the documentation, CI paths/mode are incorrect, and the suite lacks a complete current coverage/data-dependency matrix. An operational runbook should identify approved environments, allowed mutations, test-user permissions, expected fixture state, recovery behavior, and artifact handling.

## J. Prioritized Improvement Plan

### 1. Must fix before manager review

1. Rotate and remove committed secrets; correct `.gitignore`; secret-scan full history.
2. Remove generated reports/evidence from source control and review existing artifacts for confidential content.
3. Establish an intentional, reproducible clean Git snapshot for handover.
4. Make CMP-131 explicitly assert Planned status before and after the duplicate attempt.
5. Make CMP-125 exercise genuinely new Save & Add Jobs data per run, with only same-run recovery allowed.
6. Eliminate redundant Components-fixture login and correct CI headless/report paths.
7. Bind stateful fixture selection to exact current-run identities.

### 2. Recommended improvements

1. Securely remove temporary browser storage state after the run.
2. Move the diagnostic probe out of default discovery and remove broad hierarchy logging.
3. Review all binary fixtures for confidentiality and provenance.
4. Replace hardcoded environment identities and long fixed delays.
5. Selectively handle retries for mutating tests.
6. Replace the login CSS selector with a stable application locator.
7. Update README with a scenario/dependency/mutation matrix.

### 3. Optional future enhancements

1. Split large Page Objects/reporter modules along cohesive boundaries with characterization tests.
2. Add cross-platform report commands and formatting checks.
3. Add a controlled CI pipeline with secret scanning, type-check, lint, reporting tests, and an explicitly authorized PMS E2E stage.
4. Publish trend summaries through artifact storage without committing raw evidence.

## K. Overall Framework Rating

| Area | Rating | Rationale |
|---|---:|---|
| Architecture | 7/10 | Clear layers and reusable utilities; reduced by dual authentication models and oversized core modules. |
| Code quality | 7/10 | Strict types, generally strong locators, and detailed business workflows; reduced by fixed waits, hardcoded values, and diagnostic code in discovery. |
| Test reliability | 6/10 | Strong persistence and identity checks in many scenarios; reduced by stale cross-run fixture selection, CMP-131 status inference, skips, and mutation retries. |
| Maintainability | 6/10 | Good reuse and documentation comments, but 1,000–2,000-line core files and a mixed working tree increase change risk. |
| Reporting | 8/10 | Rich business reporting, evidence, status separation, and regression tests; complexity and source-test inference remain risks. |
| Security | 3/10 | Environment-based access is sound in principle, but tracked `.env` and evidence are release blockers and temporary auth state persists. |
| Documentation | 6/10 | Extensive usage guidance, but repository claims are contradictory and current coverage/dependencies are incomplete. |

**Weighted overall assessment: 6.1/10.** This is an evidence-based review judgment, not an execution certification.

## L. Final Recommendation

# NOT READY — IMPORTANT ISSUES FOUND

Do not share the repository in its current form. The tracked `.env`, tracked evidence, unreproducible mixed working tree, CMP-131 Planned-status gap, CMP-125 current-run coverage gap, duplicate Components authentication, and broken CI assumptions are material blockers.

After the must-fix items are addressed, perform a second static review and then a controlled execution in an approved isolated PMS environment. The known Edit/Save persistence defect must remain visible as a genuine failed persistence assertion; it must not be bypassed, reclassified, or forced to pass.

### Review limitations

- No application tests or network requests were executed.
- No cleanup was executed.
- No dependencies were installed or updated.
- No existing source, configuration, test data, or historical report was modified.
- The requested manager report is the only created/updated deliverable.
- Runtime success, current application behavior, and historical report outcomes were not inferred from method existence.
- Secret values were deliberately excluded.
