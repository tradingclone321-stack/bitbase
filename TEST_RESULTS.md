# Verification results

## Confirmed against the supplied database (read-only)

- The core `public.users` fields are accessible with the supplied project configuration.
- `preferences`, `demo_balance`, and `demo_positions` each returned PostgreSQL error `42703` (missing column).
- No test account was created and no production database mutation was performed.

## Browser regression checks — passed

Executed in headless Chromium with the real Supabase JavaScript SDK and intercepted REST responses. All account data was synthetic. Two independent browser contexts verified that the admin user list polls the central registry independently of registration's local storage.

1. Signup waits for a confirmed server insert, then appears first in a separate admin browser.
2. Failed inserts create no local session, show an error, and do not redirect.
3. Duplicate emails are detected using the central database, even in a fresh browser.
4. Concurrent attempts with the same email create exactly one account.
5. A UID collision retries without changing the existing account.
6. New accounts do not inherit admin/KYC flags or old preferences and demo balances.
7. User-supplied names are escaped in the admin table.
8. Query errors preserve the cache and display an actionable error instead of live/empty success.
9. Pagination handles a server row cap; a genuinely empty list resets the user count.
10. Missing SDK/configuration and request timeouts do not become successful registrations.
11. No uncaught page JavaScript errors occurred during the regression run.

## SQL regression checks — passed

Executed using PostgreSQL 18.3 through PGlite, with disposable local data.

- `schema.sql` runs twice without duplicate constraint, policy, or publication errors.
- `repair-users.sql` runs twice and restores the missing fields.
- Existing user values, balances, account flags, timestamps, and RLS policies are preserved.
- Duplicate legacy UIDs abort the transaction without deleting accounts or leaving a partial migration.

## Static checks — passed

- `db.js` and 35 inline JavaScript blocks parse successfully; JSON-LD is validated separately.
- All local HTML dependency paths resolve in the packaged project.
- The supplied favicon is included as `favicon.svg`.

## Remaining deployment step

Run `repair-users.sql` in the existing Supabase project's SQL Editor, upload the project files, then repeat one signup from a separate browser. No hosted website deployment or live database migration was performed here. Existing authentication security limitations are documented in `SUPABASE_SETUP.md`.
