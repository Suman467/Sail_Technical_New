# Login

## User can reach the Audit Dashboard

- Priority: High
- Tags: `@smoke` `@regression` `@login` `@positive`
- Data: Username, password, and domain from `.env`
- Steps:
  1. Open the login page.
  2. Enter the username, password, and domain.
  3. Wait until Login is enabled.
  4. Select Login.
  5. If the active-session message appears, select Proceed.
- Expected result: The user reaches `/audit/dashboard/summary`.
