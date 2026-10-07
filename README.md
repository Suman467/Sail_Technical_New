# Sail Technical UI Automation

This Playwright and TypeScript project tests the Sail Technical web application in Chromium.

It covers login, navigation, Components, Running Hours, Work Orders, Bulk Data Import, Jobs, Spares, and Stores. Some tests check browser workflows. Others upload Excel files, compare imported data with the application, and create audit reports.

## Quick start

### Requirements

- Node.js and npm
- Access to the Sail test environment
- A valid user account, domain, and vessel
- Windows PowerShell for report packaging

### 1. Clone and open the project

```powershell
git clone <repository-url>
cd Sail_Technical_New
```

Replace `<repository-url>` with the real repository URL.

### 2. Install dependencies and Chromium

```powershell
.\env_setup.bat
```

This runs `npm install` and `npx playwright install chromium`. The equivalent manual commands are:

```powershell
npm install
npx playwright install chromium
```

For a clean install from `package-lock.json`, use `npm ci` instead of `npm install`.

### 3. Configure the environment

Copy `.env.example` to `.env` and enter real values:

```dotenv
BASE_URL="https://dev.sl-sail.com"
USERNAME="your-username"
PASSWORD="your-password"
DOMAIN="your-domain"
VESSEL_NAME="your-vessel-name"
HEADLESS="false"
```

`utils/config.ts` loads these values with `dotenv` and stops with a clear error if one is missing. `.env` is ignored by Git; never commit credentials.

Use `HEADLESS="true"` on CI or a machine without a graphical desktop. Omit it or use `HEADLESS="false"` to keep the visible local browser behavior.

Some older component and work-order tests use `PMS Test 3` directly instead of `VESSEL_NAME`. Review [Known review items](#known-review-items) before using another environment.

### 4. Check test data

Real bulk-import and audit tests need the files under `test-data/`. Standard module folders may contain multiple scenario files. The shared runner submits every configured file to the application before interpreting the UI response; it does not pre-classify extension, size, or validity. Helpers documented as single-workbook readers for separate source-data validation still require exactly one suitable workbook.

### 5. Run tests

The configuration uses one worker. Chromium is headed by default and becomes headless when `HEADLESS=true`.

```powershell
# All tests
npm test

# One spec
npm test -- tests/login/login.spec.ts

# A Windows-style path also works through the project runner
npm test -- tests\workorders\work-order-counts.spec.ts

# Explicit headed mode
npm test -- --headed

# Tags
npm run test:smoke
npm run test:login
npm test -- --grep @components

# List tests without running them
npm test -- --list
```

### 6. Open reports

```powershell
# Detailed Playwright report
npm run report:detailed

# Folder containing the small per-spec reports
npm run report:summary

# Create reports/validation/Playwright-Reports.zip
npm run report:package
```

## Technologies used

| Tool            | Purpose                                                         |
| --------------- | --------------------------------------------------------------- |
| Playwright Test | Browser tests, assertions, screenshots, traces, and HTML report |
| TypeScript      | Typed tests, page objects, fixtures, and helpers                |
| Chromium        | Configured browser                                              |
| dotenv          | Loads `.env` settings                                           |
| xlsx            | Reads expected data from Excel                                  |
| ESLint          | Finds code-quality and unused-code issues                       |
| Prettier        | Installed formatter; no npm script is currently defined         |

## Project structure

```text
Sail_Technical_New/
|-- .github/workflows/playwright.yml       # GitHub Actions workflow
|-- docs/                                  # Existing plans and notes
|-- fixtures/
|   |-- baseFixture.ts                     # Login lifecycle and common page objects
|   `-- componentsFixture.ts               # Opens Components before component tests
|-- pages/                                 # Page Object Model classes and locators
|-- scripts/
|   |-- run-playwright.cjs                 # Normalizes test paths and starts Playwright
|   `-- package-playwright-report.ps1      # Builds the report ZIP
|-- test-data/                             # Excel, JSON, and upload inputs
|-- tests/
|   |-- bulk-import/                       # Bulk upload tests and shared workflow
|   |-- components/                        # Component management tests
|   |-- data-validation/                   # Excel-to-UI validation and audits
|   |-- login/                             # Login test
|   |-- navigation/                        # Menu navigation test
|   `-- workorders/                        # Work Order tests
|-- utils/                                 # Config, Excel readers, routes, and reports
|-- .env.example                           # Environment template
|-- env_setup.bat                          # Installs packages and Chromium
|-- eslint.config.mjs                      # Lint rules
|-- package.json                           # npm commands and dependencies
|-- playwright.config.ts                   # Playwright settings
|-- tsconfig.json                          # TypeScript settings
`-- README.md                              # This guide
```

Generated output goes to `reports/` and `test-results/`; both are ignored by Git.

## How a test runs

```text
Spec -> fixture -> scenario/helper -> page object -> Sail UI
     -> assertion -> attachment/audit report -> Playwright HTML report
```

1. `playwright.config.ts` finds `*.spec.ts` below `tests/`.
2. Most specs import `test` from `fixtures/baseFixture.ts`.
3. The base fixture creates `LoginPage` and `AuditDashboardPage`. Its automatic lifecycle opens login, signs in, and checks the profile button.
4. The spec calls page objects directly or calls a shared scenario helper.
5. Page objects navigate, select values, upload files, and read the UI.
6. Assertions compare the UI with expected values. Excel audits use readers in `utils/`.
7. Failures get a URL/title attachment and screenshot. Scenarios may attach more text, JSON, HTML, or screenshots.
8. Playwright writes `reports/validation/playwright-html`; `SimpleReporter.ts` also writes one small report per spec.

The login spec disables automatic login and tests the form itself. `bulkDataImportPage.spec.ts` uses local HTML and does not touch Sail data, although test collection still loads `.env` through the Playwright configuration.

## Page Object Model

Page objects keep locators and UI actions out of spec files. `pages/BasePage.ts` stores the Playwright `Page` and supplies `open()`, `expectToBeOnPage()`, and `logout()`. Every application page extends it.

```text
BasePage
|-- LoginPage -> AuditDashboardPage
|-- AuditDashboardPage -> TechnicalPage
|-- TechnicalPage -> ComponentsPage / RunningHoursPage / SparesPage / StoresPage / WorkOrderPage
|-- ComponentsPage -> ComponentFormPage
|-- WorkOrderPage -> UnplannedWorkOrderFormPage / WorkOrderApprovalPage
`-- BulkDataImportPage
```

| File                                  | Responsibility                                                         |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `pages/LoginPage.ts`                  | Login and return the dashboard                                         |
| `pages/AuditDashboardPage.ts`         | Check Audit and open Technical                                         |
| `pages/TechnicalPage.ts`              | Open Work Orders, Admin, Components, Running Hours, Spares, and Stores |
| `pages/BulkDataImportPage.ts`         | Templates, modes, upload, validation errors, import, and history       |
| `pages/ComponentsPage.ts`             | Component tree/details/jobs/spares and list/add/edit actions           |
| `pages/ComponentFormPage.ts`          | Fill and save component forms                                          |
| `pages/RunningHoursPage.ts`           | Read the Running Hours overview                                        |
| `pages/SparesPage.ts`                 | Find records in the Spares module                                      |
| `pages/StoresPage.ts`                 | Select store type and read records                                     |
| `pages/WorkOrderPage.ts`              | Vessels, tabs, counts, statuses, create/edit/approval entry points     |
| `pages/UnplannedWorkOrderFormPage.ts` | Fill, save, and submit an unplanned work order                         |
| `pages/WorkOrderApprovalPage.ts`      | Add remarks and approve a work order                                   |

Update a locator in the page class that owns its screen. Keep reusable multi-page business flow in a scenario helper.

## Fixtures

`fixtures/baseFixture.ts` supplies `loginPage`, `auditDashboardPage`, `requiresLogin`, and an automatic login/failure-evidence lifecycle. `requiresLogin` defaults to `true`.

`fixtures/componentsFixture.ts` extends it with `componentsPage`. It opens Audit -> Technical -> Components before each component-management test.

The logout block in `baseFixture.ts` is commented out. Browser context cleanup ends the session instead of clicking Logout.

## Test data

| Path                                                            | Used for                                            |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `test-data/bulk-import/Components/`                             | Automatic Components bulk import                    |
| `test-data/bulk-import/Job/`                                    | Job bulk-import modes                               |
| `test-data/bulk-import/Spares/`                                 | Spares bulk-import modes                            |
| `test-data/location/`                                           | Location Add + Update                               |
| `test-data/components-validation/Components Updated.xlsx`       | Component, hierarchy, and Running Hours validation  |
| `test-data/components-validation/components-expected-data.json` | Saved/reference component expected data             |
| `test-data/components-validation/components-import-result.json` | Persisted component import metadata used by helpers |
| `test-data/job-validation/`                                     | Job upload and post-import audit                    |
| `test-data/spare-validation/`                                   | Spares upload and post-import audit                 |
| `test-data/stores-validation/`                                  | Stores, Lubes, Chemicals, and Others audits         |

Required but currently absent:

- `test-data/bulk-import/file-size-validation/`: one supported `.xlsx`, `.xls`, or `.csv` file larger than 20 MB.
- `test-data/bulk-import/invalid-file-type/`: one `.doc` or `.docx` file.

`utils/testDataFile.ts` resolves these files. Its single-file helpers fail if there is no suitable file or more than one, so do not keep backup workbooks in those folders.

## Test specs and their purpose

There are 28 spec files and 43 collected tests. Loop-based specs create multiple tests.

### Login, navigation, and Components

#### `tests/login/login.spec.ts`

Tests the real login form. It disables auto-login, clears storage, calls `LoginPage.open()` and `login()`, and checks `AuditDashboardPage`. It uses `.env` and `baseFixture.ts`. End result: the Audit Dashboard is visible.

#### `tests/navigation/audit-technical-workorder.spec.ts`

Protects Audit -> Technical -> Work Orders navigation. The fixture logs in, then `AuditDashboardPage` and `TechnicalPage` perform the navigation. End result: Work Orders opens.

#### `tests/components/component-management.spec.ts`

Contains three tests using `componentsFixture.ts`, `ComponentsPage.ts`, and `ComponentFormPage.ts`: list count equals visible rows; filtering by `PMS Test 3` keeps the count correct; and an add/edit flow. The last test checks empty-field errors, creates a timestamped component, edits its name, and verifies it. End result: the list and basic component maintenance work.

### Bulk import

Real import specs use `baseFixture.ts`, `BulkDataImportPage.ts`, and `bulkDataImportScenario.ts`. Their flow is login -> Technical -> Admin -> select vessel/template/mode -> resolve file -> upload -> capture validation -> import valid rows -> confirm partial import if needed -> capture result.

#### `tests/bulk-import/bulkDataImport-component-add.spec.ts`

Runs Component Add against every scenario file in `test-data/bulk-import/Components/`. Every file is uploaded before the application response is interpreted. Every successfully imported workbook continues through the existing Component UI validator.

#### `tests/bulk-import/bulkDataImport-component-update.spec.ts`

Runs the same reusable Component flow in Update mode. It remains an independent spec so this mode can be executed and reported separately.

#### `tests/bulk-import/bulkDataImport-component-add-update.spec.ts`

Runs Component Add + Update as an independent spec. Valid imported rows are read from the same uploaded workbook, application-rejected rows are excluded, and accepted records continue to Component UI validation.

#### `tests/bulk-import/bulkDataImport-job-add-only.spec.ts`

Uploads the Job workbook from `test-data/bulk-import/Job/` in Add Only mode. End result: accepted new Jobs are imported.

#### `tests/bulk-import/bulkDataImport-job-update-only.spec.ts`

Uses the same Job input in Update Only mode. End result: accepted existing Jobs are updated.

#### `tests/bulk-import/bulkDataImport-job-add-update.spec.ts`

Uses Job Add + Update. End result: accepted new and existing Job rows finish the combined flow.

#### `tests/bulk-import/bulkDataImport-spares-add-only.spec.ts`

Uploads the file in `test-data/bulk-import/Spares/` in Add Only mode and captures validation/import evidence.

#### `tests/bulk-import/bulkDataImport-spares-update-only.spec.ts`

Uses the Spares input in Update Only mode. End result: accepted existing Spares are updated.

#### `tests/bulk-import/bulkDataImport-spares-add-update.spec.ts`

Uses combined Spares Add + Update. End result: accepted rows complete the import.

#### `tests/bulk-import/bulkDataImport-location-add-update.spec.ts`

Uploads `test-data/location/03_Locations.xlsx`. Locations have no normal mode radio, so Add + Update describes the template's built-in behavior. End result: Import Locations is enabled and success appears.

#### `tests/bulk-import/bulkDataImport-file-size-validation.spec.ts`

Checks that Components upload rejects a supported file larger than 20 MB. It validates the input size/type before upload and expects a rejection message. It cannot complete until `test-data/bulk-import/file-size-validation/` is supplied.

#### `tests/bulk-import/bulkDataImport-invalid-file-type.spec.ts`

Checks that Components upload rejects Word files and lists `.xlsx`, `.xls`, or `.csv` as supported. It cannot complete until `test-data/bulk-import/invalid-file-type/` is supplied. The Word file currently under `Components/` is not read by this spec.

#### `tests/bulk-import/bulkDataImportPage.spec.ts`

Tests `BulkDataImportPage` without the real application. Local HTML creates six cases: three modes with zero or partial errors. It checks summaries, error rows and attachments, confirmation, old/new action methods, and final metrics. End result: the shared page-object workflow handles clean and partial imports consistently.

### Components and Running Hours validation

These use `components-validation-scenario.ts`, `BulkDataImportPage.ts`, `ComponentsPage.ts`, `RunningHoursPage.ts`, `componentsExpectedData.ts`, and `Components Updated.xlsx`. The helper imports, excludes rejected rows, compares the UI, and attaches evidence.

#### `tests/bulk-import/components-add-only.spec.ts`

Runs the full Components and Running Hours comparison in Add Only mode. End result: accepted workbook records match both areas.

#### `tests/bulk-import/components-add-update.spec.ts`

Runs the full comparison in Add + Update mode. End result: accepted new/updated records match the UI.

#### `tests/data-validation/components/components-update-only.spec.ts`

Runs the full comparison in Update Only mode. End result: accepted existing component and Running Hours values match.

#### `tests/data-validation/components/components-running-hours.spec.ts`

Focuses on Add + Update plus Running Hours. The fixture logs in; the helper uploads the component workbook, captures rejected rows, imports accepted rows, opens Running Hours, and compares component code/name/category/current hours. `{ stopAfterRunningHours: true }` stops before later Components-detail validation. End result: every checked accepted row and its hours match.

#### `tests/data-validation/components/components-validation-audit.spec.ts`

Imports with Add + Update, keeps accepted child records with a Parent Component Code, then fully audits Components hierarchy and details. It has no test timeout. End result: no required record/field mismatch and a complete audit output.

#### `tests/data-validation/components/components-validation-audit-partially.spec.ts`

Performs the same import but audits the first `DATA_VALIDATION_LIMIT` accepted child records (currently 10). End result: the sample matches while the report keeps the full imported count.

### Jobs validation

These use `jobs-validation-scenario.ts`, `jobsExpectedData.ts`, `ComponentsPage.ts`, and `test-data/job-validation/Jobs Updated.xlsx`. The helper imports with Job Add + Update, removes rejected rows, finds each parent Component, reads the Job by code, compares fields, and creates audit evidence.

#### `tests/data-validation/jobs/jobs-validation-audit.spec.ts`

Audits every accepted Job. End result: each Job exists under the correct Component and compared values match.

#### `tests/data-validation/jobs/jobs-validation-audit-partially.spec.ts`

Audits the first 10 accepted Jobs. End result: the sample matches and a partial report is created.

### Spares validation

These use `spares-validation-scenario.ts`, `sparesExpectedData.ts`, `ComponentsPage.ts`, and `test-data/spare-validation/Spares Updated .xlsx`. They import with Spares Add + Update, remove rejected rows, open each parent Component's F. Spares section, and compare Part Code, Part Name, Component Name, Part Number, and ROB.

#### `tests/data-validation/spares/spares-validation-audit.spec.ts`

Strictly audits every accepted Spare. End result: no accepted Spare is missing or mismatched.

#### `tests/data-validation/spares/spares-validation-audit-partially.spec.ts`

Strictly audits the first 10 accepted Spares. End result: the sample matches and a partial report is created.

### Stores validation

These use `stores-validation-scenario.ts`, `storesExpectedData.ts`, `StoresPage.ts`, and every workbook in `test-data/stores-validation/`. File names identify Stores, Lubes, Chemicals, or Others. Each test imports with Add + Update, opens the matching tab, and compares identifier, name, category/application, UOM, and ROB.

#### `tests/data-validation/stores/stores-validation-audit.spec.ts`

A loop creates four complete tests, one per store type. End result: every accepted record matches and four complete reports are created.

#### `tests/data-validation/stores/stores-validation-audit-partially.spec.ts`

A loop creates four tests for the first 10 accepted records per store type. End result: each sample matches and four partial reports are created.

### Work Orders

#### `tests/workorders/work-order-counts.spec.ts`

Opens Work Orders, checks all seven tabs, selects `VESSEL_NAME`, and compares each tab badge with its list footer through `WorkOrderPage.ts`. End result: all badge and list counts match.

#### `tests/workorders/unplanned-work-order-creation.spec.ts`

Covers the full unplanned Work Order lifecycle. It selects `PMS Test 3`, records the count/highest number, fills the form, checks assigned/approver ranks, saves Draft, verifies the next number and increased count, submits to Pending Approval, enters remarks, approves, and checks Completed. It uses `WorkOrderPage.ts`, `UnplannedWorkOrderFormPage.ts`, and `WorkOrderApprovalPage.ts`. End result: one new sequential order reaches Completed.

## Scenario and utility files

Scenario files are shared workflows, not specs:

- `tests/bulk-import/bulkDataImportScenario.ts`: real uploads and file rejection.
- `tests/data-validation/components/components-validation-scenario.ts`: component, hierarchy, detail, job, spare, and Running Hours comparisons.
- `tests/data-validation/jobs/jobs-validation-scenario.ts`: Job import and comparison.
- `tests/data-validation/spares/spares-validation-scenario.ts`: Spares import and comparison.
- `tests/data-validation/stores/stores-validation-scenario.ts`: Stores import and comparison.

Important utilities:

- `utils/config.ts`: environment values and partial-audit limit.
- `utils/routes.ts`: shared application paths.
- `utils/testDataFile.ts`: test-file resolution.
- `utils/*ExpectedData.ts`: Excel parsing and normalization.
- `utils/standardAuditReport.ts`: detailed HTML audit reports.
- `utils/SimpleReporter.ts`: per-spec reports and report packaging trigger.

## Reports

- `reports/validation/playwright-html/`: detailed Playwright report.
- `reports/validation/<spec-name>.html`: small per-spec reports.
- `reports/audit/<spec-name>.html`: the standard Audit Report for each spec. Data Validation scenarios may write their richer record-level audit to the same path first; the reporter preserves that fresh file instead of replacing it.
- `reports/validation/Playwright-Reports.zip`: packaged reports.
- `test-results/`: traces, screenshots, and Playwright artifacts.

The configuration retains traces and screenshots on failure. The base fixture also attaches a full-page failure screenshot and current URL/title.

### Common reporting for every spec

`utils/SimpleReporter.ts` is registered once in `playwright.config.ts`. It automatically creates the existing Validation Report and ensures the existing standard Audit Report for every completed `.spec.ts` file. Bulk Import specs and future specs do not need their own HTML generator or reporter configuration.

For a normal new spec, write clear `test.step(...)` calls and use the existing fixture. The common reporter will automatically record the test result, business steps, expected/actual text, status, duration, and available evidence.

When a new data-comparison spec has record-level Expected and Actual values, attach one JSON array using a name that contains `validation comparison data`. Use the existing comparison shape:

```ts
await test.info().attach("My module validation comparison data", {
  body: JSON.stringify([
    {
      recordCode: "CODE-001",
      recordName: "Example record",
      field: "Field name",
      expected: "Expected value",
      actual: "Actual value",
      status: "PASS", // PASS, MISMATCH, MISSING, or ERROR
      reason: "",
    },
  ]),
  contentType: "application/json",
});
```

This is the same attachment contract already used by the Data Validation scenarios. Do not create report HTML in a new spec. If the spec needs a business-specific record-level Audit Report, pass its existing audit data to `generateStandardAuditReport` from `utils/standardAuditReport.ts`; this keeps the same columns, layout, status rules, and Expected/Actual representation.

Bulk Import scenarios also place meaningful evidence in this existing report: validation-error screenshots are shown with their matching validation-error section, while rejection, import-complete, partial-import confirmation, import-summary, and final-validation screenshots appear as evidence for the same test result. The report layout and columns are unchanged.

### Adding a Bulk Import scenario

Use `runBulkDataImportFolderScenario` for a standard module spec. Inputs are resolved only from `test-data/bulk-import/<Module>/`; the resolver does not fall back to another folder and does not depend on filenames or directory order. Each existing file is submitted to the application, then the shared runner reads the actual upload-validation response.

```ts
await runBulkDataImportFolderScenario(page, auditDashboardPage, {
  module: "job",
  mode: "addAndUpdate",
  rowErrors: "skip-and-import",
});
```

Available expectation types are:

- `runBulkDataImportFolderScenario`: executes every configured file in a module folder without pre-validating type or size. Application rejection stops that attempt; application acceptance continues through row validation and import.
- `outcome: 'from-file'`: available to lower-level single-file helpers when a caller already supplies a specific file.
- `outcome: 'import'`: requires a supported file within the configured size limit. `rowErrors` declares whether Skip Errors is allowed.
- `outcome: 'validation-rejection'`: expects a supported file to be rejected during application data validation. An optional `errorPattern` checks the returned error.
- `outcome: 'file-rejection'`: expects an unsupported type or maximum-size rejection and requires the expected application error pattern.

The maximum upload size is defined once as `BULK_IMPORT_MAX_UPLOAD_SIZE_BYTES` in `utils/config.ts`. Do not repeat the byte value in a spec.

## Adding or changing a test

1. Add a `.spec.ts` file to the matching folder under `tests/`.
2. Import `test` from `fixtures/baseFixture.ts` unless the test must avoid auto-login.
3. Reuse a page object or add the action/locator to the owning file under `pages/`.
4. Add a scenario helper only for genuinely reusable multi-page flow.
5. Put inputs in the correct `test-data/` folder.
6. Add useful tags such as `@regression`, `@components`, or `@bulkimport`.
7. Run `npm run typecheck`, `npm run lint`, and the individual spec.

Do not put credentials in tests or commit `.env`.

## Known review items

These were not changed because they need data, environment, or team decisions.

| Item                                                                  | Classification               | Recommendation                                                                 | Reason                                                                                 |
| --------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Missing `test-data/bulk-import/file-size-validation/`                 | REVIEW MANUALLY              | Add a supported file over 20 MB                                                | Required by the file-size spec                                                         |
| `test-data/bulk-import/Playwright_UI_Automation_Framework_Guide.docx` | KEEP IF INTENTIONAL          | Used by the dedicated invalid-file-type spec                                   | The file is submitted to the application before its validation response is evaluated   |
| Hard-coded `PMS Test 3`                                               | REVIEW MANUALLY              | Use `config.vesselName` if not a business requirement                          | Conflicts with portable `.env` setup                                                   |
| `DATA_VALIDATION_LIMIT = 10`                                          | KEEP                         | Keep unless configurability is needed                                          | One clear source for partial-audit size                                                |
| 20 MB upload limit                                                    | REVIEW MANUALLY              | Keep the configured oversized fixture aligned with the application requirement | Acceptance/rejection is determined only from the application's post-upload UI response |
| `components-expected-data.json`                                       | REVIEW MANUALLY              | Confirm whether it remains maintained                                          | No direct code reference was found                                                     |
| `components-import-result.json`                                       | KEEP                         | Keep; tests may rewrite it                                                     | Used as persisted component import metadata                                            |
| `docs/*.md`                                                           | KEEP                         | Keep as project/design history                                                 | Not runtime code, but contains useful knowledge                                        |
| `.codex/agents/*.toml`                                                | KEEP                         | Keep if Codex test agents are used                                             | Tool configuration, not runtime code                                                   |
| `reports/`                                                            | KEEP LOCALLY / DO NOT COMMIT | Keep ignored                                                                   | Generated evidence may be useful                                                       |
| `test-results/`                                                       | KEEP LOCALLY / DO NOT COMMIT | Keep ignored                                                                   | Generated traces and failures                                                          |
| CI uploads `playwright-report/`                                       | REVIEW MANUALLY              | Upload `reports/validation/playwright-html/` instead, or align config          | Current configured output is elsewhere                                                 |
| CI browser mode                                                       | CONFIGURED                   | Set `HEADLESS=true` in CI                                                      | Local runs remain headed by default                                                    |
| Commented logout in `baseFixture.ts`                                  | REVIEW MANUALLY              | Remove or restore after deciding lifecycle                                     | Old code does not run                                                                  |
| `debug.log`                                                           | REMOVE                       | Removed and ignored                                                            | Generated Chromium GPU messages; no references                                         |
| Unused `ExpectedStoreRecord` import                                   | REMOVE                       | Removed                                                                        | ESLint identified it as unused                                                         |

No page object, helper, workbook, report, documentation, or configuration file was deleted merely because it was not imported. Existing generated reports were left in place.

## Suggested organization

The current top-level layout is understandable. A large refactor is not needed.

1. Put the Word negative-test input in `test-data/bulk-import/invalid-file-type/` after confirming it is the intended file.
2. Add or document how to obtain the oversized file for `file-size-validation/` if it is too large for source control.
3. Optionally move shared scenario helpers to one `scenarios/` folder only if team members mistake them for specs. Playwright already ignores them because they are not `.spec.ts` files.
4. Keep page objects flat under `pages/` at the current project size.

## Verification

```powershell
npm run typecheck
npm run lint
npm test -- --list
```

These check types, lint rules, and discovery without running real workflows. The full suite changes application data through imports, component creation, and Work Order creation/approval, so run it only in the correct test environment with approved data.
