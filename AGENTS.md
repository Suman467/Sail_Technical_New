# Project reporting standard

These standards apply project-wide to every current and future Playwright validation and audit report, not only Components reports. Shared reporting utilities are the default implementation point; individual specifications must not create competing report formats.

- Every test case must show its ID/name, overall status, scenario-specific Expected and Actual Results, duration, chronological business steps, evidence, and separate Technical Details when diagnostics exist.
- Test-case totals must distinguish Passed, Failed, intentionally Skipped, and Not Executed after setup or dependency failure. Step totals and test-case totals must never be mixed.
- Reports must provide All, Passed, Failed, Skipped, and Not Executed filters whenever those statuses can occur.
- Failure Actual Results must state the attempted business action, expected outcome, observed behavior, failure stage, and any planned validations that were not reached. Unknown causes must remain described as observations, not asserted as application defects.
- Historical HTML may be regenerated only from preserved execution evidence without changing outcomes or timestamps. If evidence is insufficient, retain the report and document that limitation instead of inventing steps.

These rules are permanent for every Playwright validation and audit report, especially Components scenarios:

- Every test case and every recorded business step must state, in simple business language, what the application should do and what it actually did.
- Expected Results must describe the scenario-specific application outcome, not repeat a generic template.
- Actual Results must use observed application values and behavior. Never claim a behavior was verified when execution did not reach that validation.
- For failures, explain the expected-versus-observed difference clearly enough for manual testers, managers, and nontechnical readers.
- Never place raw Playwright errors, locators, assertions, call logs, stack traces, ANSI codes, or TypeScript syntax in Expected or Actual Results. Put diagnostics only in a separate Technical Details section.
- Preserve test outcomes, assertions, screenshots, evidence, and audit data. Reporting improvements must not turn failures into passes or weaken business validation.
- If execution stops during setup or navigation, identify that stage and state what application result was or was not observed; do not use vague phrases when specific evidence exists.
- New Components tests must record scenario-specific Expected and Actual Results through the shared reporting utilities.
- Components suites must authenticate the primary user once per worker and reuse that authenticated state. Log in again only when authentication has genuinely expired or the worker/session was lost.
- After each Components test, restore the Components page and configured vessel without deleting test data. A failed scenario must retain its evidence, fail only itself, and must not prevent later independent scenarios from running.
- Components tests must wait for Add/Edit forms to finish hydrating before editing controlled fields. Validation scenarios must record the exact visible application message or observed successful response; they must not substitute generic mandatory-field feedback.
- Never run component cleanup as an automatic teardown. Cleanup remains an explicit manual operation.
- Components validation reports must use runtime vessel, code, name, parent, and visible validation messages. Screenshot examples are evidence only and must never become hardcoded test data or claimed Actual Results.
- Uniqueness and hierarchy scenarios must isolate the intended rule. A duplicate-code rejection does not prove self-parent or circular-descendant validation, and a direct self-parent attempt does not prove descendant-cycle prevention.
- Components suite reports must show shared authentication and initial PMS-to-Components navigation once under **Common Setup / Initial Navigation**. Do not repeat shared setup, page-open confirmations, or between-test refreshes inside every test case. A single-test execution must retain its setup once so the report is understandable by itself, and scenarios that explicitly validate login, navigation, Components loading, or vessel selection must retain those relevant steps.
- If authentication expires or a session is lost, report the additional login as a recovery event. Do not disguise a navigation or setup failure as shared successful setup.
- Test-case findings must contain only scenario-relevant actions and validations, with runtime values in Actual Results. Technical errors belong only in Technical Details.
- A failed Components scenario must fail only itself; later independent scenarios must continue using the authenticated worker session. Use separate authenticated users only when the scenario requires them.
- Component cleanup is an explicit manual operation and must never run automatically.
- Common-setup filtering may remove only generic login-page, dashboard-page, and Components-page confirmations. It must never remove vessel selection, component selection or creation, form opening, field entry, Save, visible feedback capture, refresh, search/reopen, persistence checks, hierarchy checks, or record-count checks.
- Shared helpers must record a business action only when the UI action actually occurred. In particular, a vessel-selection helper that detects the requested vessel is already selected must not emit another Select Vessel row.
- Components reports must preserve meaningful actions in execution order. Each meaningful action needs its own scenario-specific Expected Result, observed Actual Result with runtime values, and evidence-based status; do not collapse several material actions into one summary step.
- When execution stops, retain every completed action, report the exact business stage that failed, and label any explicitly planned but unreached validations as NOT EXECUTED. Never infer a successful Actual Result for an action the browser did not reach.

## Components report generation

These rules describe how the shared reporting utilities must build Components validation and audit reports:

- Record every actual test action exactly once, in chronological order of completion. A step that groups other steps (for example a scenario validation wrapper) is reported after the actions it contains, because its result is only known when they finish. Never record the same action twice by listing both a parent summary and a duplicate copy of its child.
- Determine each step's status from that step's own execution outcome, never by matching its title against other failed steps. A step that was still running when a test timed out is a FAIL with "no result was observed", never a PASS.
- Number the steps of each test case sequentially (1, 2, 3, …) after setup filtering, without gaps.
- An identical action repeated back-to-back with the same result may be shown once, but its Actual Result must state how many times it was performed. Distinct actions must never be merged.
- The scenario-level Expected Result comes from the scenario validation step when it was reached, otherwise from the Expected Result declared on the test itself (`test(title, componentScenario(expected), body)`, which also covers scenarios skipped before their body runs). It must never be borrowed from an unrelated later step or another component.
- The scenario-level Actual Result for a passed test is the observed result of the scenario validation. For a failed test it names the first failed step by number and title, explains the observed difference, and states when the main validation or planned validations were NOT EXECUTED.
- When an Actual Result depends on values observed during execution (for example the exact validation message), record it after the validation completes (`componentValidationStep(..., { actual })`) rather than writing it in advance.
- Shared `beforeAll` setup in the first test of a run goes under **Common Setup / Initial Navigation** with its real statuses. The same setup appearing again later means a worker restart or session loss and must be reported inside that test case as a **Session recovery** event, stating whether the saved authentication was reused or the user logged in again.
- Report the actual primary-user UI login count and distinguish an in-memory browser-context reuse from a replacement worker that opened a new context with saved authenticated state. Never claim that one browser context survived a Playwright worker restart.
- Do not present worker restart, page restoration, or saved-authentication recovery as ordinary scenario execution steps. Keep that lifecycle evidence in execution metadata or Technical Details.
- A Playwright worker process is replaced after a test-level failure; an in-memory context owned by that process cannot survive. Preserve the same context within a live worker, reuse the run-scoped authenticated state in a replacement worker, and disclose this limitation rather than suppressing failures.
- CMP-061 must reuse the suite's existing authenticated primary-user context when it is still usable and create only the distinct secondary-user context needed for concurrency. Record actual authentication attempts for both users.
- After-test restore steps are omitted when they are passing generic page confirmations; any failed or non-generic restore step is reported as **After-test restore**.
- Report the vessels and users that were actually used at runtime, not only the configured defaults.
- Capture a failure screenshot for every failed or timed-out Components test before the page is restored, and show failure evidence once per test case beneath the first failed step.
- Technical diagnostics (error message, assertion output, file location) appear only in the separate **Technical Details** section of the validation report and audit report.
- Recorded validation messages must exclude the form's standing instruction text (for example "Fill mandatory fields and click + Add Job…"), which is not Save feedback.
- When Playwright skips scenarios because a shared `beforeAll` setup failed, report them as NOT EXECUTED with that reason, never as an unexplained skip.
- Shared implementation: `utils/SimpleReporter.ts` (timeline, setup consolidation, scenario results), `utils/componentValidationEvidence.ts` (scenario declaration, validation steps, observed actuals, screenshots), and `utils/standardAuditReport.ts` (audit rendering).

## Manual Components cleanup

- Components cleanup runs only through `npm run cleanup:components`; normal test execution and teardown must never invoke it.
- Delete only exact tracked or explicitly approved identities, preserve child-before-parent order, and use a bounded deletion loop.
- If the exact **Cannot Delete Component / Component not found** popup appears, acknowledge it, wait for it to close, refresh Components in the same authenticated session, restore the vessel, and verify the tracked vessel/code/name identity. Record `already_absent` only when that exact identity is confirmed absent; otherwise record `failed` and continue. Other delete errors must never be treated as successful cleanup.
- Cleanup reports must list each authorized record as `deleted`, `already_absent`, `failed`, or `skipped`, with its runtime vessel, code, name, and failure reason when applicable.
