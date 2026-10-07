# Audit to Technical Work Orders

## User can open Work Orders from the Audit menu

- Priority: High
- Tags: `@smoke` `@regression` `@navigation` `@audit` `@technical` `@workorder` `@positive`
- Data: Authenticated user from `.env`
- Steps:
  1. Confirm the Audit Dashboard is shown.
  2. Open the Audit menu.
  3. Select Technical.
  4. Select Work orders.
- Expected result: The Technical module opens, then the Work Orders page opens at `/technical/pms/work-orders` and shows `Work Orders (W.O)`.
