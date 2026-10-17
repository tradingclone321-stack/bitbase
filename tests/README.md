# Regression tests

Use Node 24+ for the Edge Function TypeScript test import. Tests use synthetic data.
All browser network requests are intercepted. No production database is contacted.

```sh
cd tests
npm install --no-save playwright @supabase/supabase-js @electric-sql/pglite
npx playwright install chromium
node finance.test.cjs
node browser-finance.test.cjs
node schema.test.cjs
```

If using an existing Chromium installation, set `CHROMIUM_EXECUTABLE_PATH` to its
absolute path. `SUPABASE_TEST_SDK` can point to the real Supabase UMD SDK bundle.
The browser test can also use `@sparticuz/chromium` when installed.

`finance.test.cjs` exercises PostgreSQL functions, transaction rollback, permissions,
idempotency, payouts, withdrawals, transfers, conversion, earn/quant accruals,
sessions, device restoration, and audit records. PGlite serializes queries; the
simultaneously submitted operations test is not a multi-connection lock stress test.

`browser-finance.test.cjs` executes the original page interfaces against the new
SQL API and executes the actual price worker with controlled market responses.
It closes all browsers before settlement and signs in through a fresh context.
It also tests dropped responses and quote-provider failures.

`schema.test.cjs` retains the original schema/bootstrap compatibility checks.
Production scheduler/extension installation and external-provider reachability
must be verified separately with `VERIFY_INSTALLATION.sql`.
