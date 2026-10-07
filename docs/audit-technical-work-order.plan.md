# Updated Audit Technical Work Order Exploration

## Application Overview

Re-exploration of the authenticated Sail application after the login flow update. Starting from a fresh browser state, authenticate with the current repository .env account, handle the optional already-logged-in prompt, reach the Audit summary route, then navigate Audit -> Technical -> Work orders and verify the final route and heading.

## Test Scenarios

### 1. Audit to Technical Work Order navigation

**Seed:** `tests/seed.spec.ts`

#### 1.1. Authenticate and reach Audit dashboard summary

**File:** `tests/navigation/audit-technical-workorder.spec.ts`

**Steps:**
  1. Start from a fresh browser context and run the repository authentication setup using the current .env account.
    - expect: Authentication completes successfully.
  2. If a dialog or prompt with the text "User is already logged in" is present, click the exact Proceed control exposed by the prompt; otherwise continue without clicking a nonexistent control.
    - expect: The prompt is dismissed when present.
    - expect: No unnecessary dialog interaction occurs when the prompt is absent.
  3. Wait for the page URL to be exactly https://dev.sl-sail.com/audit/dashboard/summary.
    - expect: The exact URL is https://dev.sl-sail.com/audit/dashboard/summary.
    - expect: The page is the Audit Statistics / Dashboard page.
  4. Inspect the accessibility tree and locate the Audit control with getByRole('button', { name: 'Audit', exact: true }).
    - expect: The exact accessible Audit button is present.

#### 1.2. Navigate Audit to Technical to Work orders

**File:** `tests/navigation/audit-technical-workorder.spec.ts`

**Steps:**
  1. Click getByRole('button', { name: 'Audit', exact: true }).
    - expect: The Audit menu expands.
  2. Click getByRole('menuitem', { name: 'Technical', exact: true }).
    - expect: The application navigates to exactly https://dev.sl-sail.com/technical/.
    - expect: The Technical page exposes a Work orders navigation control.
  3. Click getByRole('link', { name: 'Work orders', exact: true }).
    - expect: The application navigates to exactly https://dev.sl-sail.com/technical/pms/work-orders.
    - expect: The Work orders control is active.
  4. Locate getByRole('heading', { name: 'Work Orders (W.O)', exact: true }).
    - expect: A level-1 heading named exactly "Work Orders (W.O)" is present.
    - expect: The Work Order page is loaded and displays the work-order filters or table.
