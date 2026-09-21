# BitBase — fix missing users in Admin

## Apply this update

1. Open your existing Supabase project → **SQL Editor**.
2. Run **`repair-users.sql`** once. It upgrades the existing `public.users` table without deleting accounts, changing balances, or changing access policies.
3. Upload the extracted project files to your website, keeping their names exactly as supplied: `admin.html`, `register.html`, `db.js`, `supabase-config.js`, etc. Do not add `(1)` to the deployed filenames. Uploading the whole extracted folder avoids missing dependencies.
4. Keep your own project URL and **anon/public** key in `supabase-config.js`. The supplied configuration is retained. Never put a service-role key in frontend files.
5. Reload the admin page with **Ctrl+Shift+R**, open **Users**, and register a test account from a separate browser or private window. A confirmed registration should appear automatically within about five seconds; **Refresh** also loads it immediately.

The live database has **not** been migrated by this code update. Run the SQL step above before relying on the repaired schema. If the website is hosted through Vercel/GitHub, commit/upload the extracted files there and redeploy.

## What was wrong

- Signup displayed success, created a local session, and redirected even when the server write failed. Supabase returns many failures as `{ data: null, error }`; the old code did not check them.
- Read-only checks against the supplied project confirmed that **`preferences`**, **`demo_balance`**, and **`demo_positions`** are absent from `public.users`. The old registration upsert copied these fields from browser storage when present, causing an insert to fail on older databases.
- `CREATE TABLE IF NOT EXISTS` did not upgrade existing tables. Re-running the original schema could also stop on duplicate unique constraints or publication membership.
- The admin user queries interpreted errors as empty results, sometimes replacing the cache with an empty list and labeling it “live.”
- Realtime subscriptions passed arrays of event names where Supabase expects a single event or `'*'`.
- The uploaded copies had `(1)` suffixes, while the HTML references filenames without them. The ZIP contains the correct deployment filenames, including `favicon.svg`.

## What changed

- Registration uses an **INSERT** and waits for the confirmed returned row. Failed or unconfirmed requests show a message without creating a local session or redirecting.
- UID collisions retry with another number. They cannot overwrite an existing account. Duplicate emails are checked against the central table and database constraints handle concurrent attempts.
- New accounts start with zero balances and default account flags. Settings and demo balances from a previous browser account are not sent during signup.
- Admin reads validate responses, paginate the central registry, sort newest first, and preserve the last successful cache on errors. The error line distinguishes live results from cached results.
- User refresh runs independently of unrelated collection requests. Realtime filters use `'*'`, with polling as a fallback.
- User names and emails are escaped before rendering in the admin table.
- The repair is transactional and rerunnable. It adds missing columns and indexes, enables the users publication when present, and requests a REST schema-cache reload. It never relaxes RLS policies.

## Existing missing accounts

This project uses its own **`public.users` table**, not Supabase Authentication's user list. Creating an account only in **Authentication → Users** will not create a BitBase account with this legacy login system.

A registration that only succeeded in the old browser cache does not exist on the server. After applying the fix, re-register that email if there is no matching row in `public.users`. Do not bulk-upload an old browser cache: it can resurrect deleted accounts or overwrite server balances.

If `repair-users.sql` reports duplicate UID/email values, it rolls back without changing your data. Review those duplicates before adding the unique indexes; do not delete or merge accounts blindly.

An empty successful result can also reflect RLS filtering. If users exist in SQL Editor but are invisible in Admin, review the installed authentication and read policies. This repair intentionally does not grant public access to a protected database.

## Fresh demo installation

For a brand-new database, run `schema.sql` instead of `repair-users.sql`. The supplied fresh schema retains the original demo access model; existing installations should use the narrower repair. The separate `supabase-cron.sql` remains unchanged and is unrelated to registration.

## Security limitation in the existing project

The current login stores plaintext passwords in `public.users`, uses a browser-based admin password, and the original demo policies allow public table access. Those are existing security defects. Before handling real accounts or money, replace this login with Supabase Auth and enforce administrator permissions and user-scoped RLS on the server. This registration repair does not replace that authentication architecture.

## Verification and references

Regression tests are in `tests/`. They use synthetic data and intercepted requests; they do not create accounts in your live database. Local PostgreSQL tests verify rerunnable migrations, preservation of data and policies, and rollback when duplicate identifiers exist.

Supabase documentation:

- [Insert and return the saved row](https://supabase.com/docs/reference/javascript/insert)
- [Select responses and error handling](https://supabase.com/docs/reference/javascript/select)
- [Database change subscriptions](https://supabase.com/docs/guides/realtime/postgres-changes)
