# Regression tests

These tests run against synthetic data. They intercept every browser request and never contact or change the configured live database.

Install test dependencies in this folder:

```sh
cd tests
npm install --no-save playwright @supabase/supabase-js @electric-sql/pglite
npx playwright install chromium
node registration-admin.test.cjs
node schema.test.cjs
```

The browser test uses the Supabase SDK's UMD bundle. To supply another downloaded SDK bundle, set `SUPABASE_TEST_SDK` to its absolute path. To use an existing Chromium binary, set `CHROMIUM_EXECUTABLE_PATH` to its absolute path.

Coverage: successful signup from one browser appearing in another browser's admin list; no session on failed inserts; duplicate email and concurrent signup; safe retry on UID collision; clean new-account fields; escaped table content; cached data preservation; pagination; zero-user counts; unavailable connections; request timeouts; rerunnable schema/repair; preservation of balances and policies; rollback on duplicate legacy IDs.
