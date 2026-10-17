# Admin users do not load — 42501

The screenshot's exact wording, “Database access was denied (42501). Check the project key and existing access policies,” comes from the old September `db.js`. That client reads `public.users` directly. The finance migration deliberately blocks that public route; the updated administrator page reads through `bb_read`, which checks a real administrator session.

The configured project's `bb_read` endpoint was checked with an intentionally invalid session. It returned the expected authentication error, confirming that the protected endpoint is installed and callable. No live account records were read or changed.

## Fix this deployment

1. Extract this ZIP and replace the files in the folder your existing site actually deploys. Put `index.html`, `admin.html`, `db.js`, `finance-ui.js`, `supabase-config.js` and `vercel.json` together at the site's root; do not accidentally upload them inside an extra nested folder. Deploy the complete update. Retain your correct public Supabase project URL and anon key.
2. If using GitHub/Vercel, commit to the branch connected to your production website and wait until that production deployment is ready. Merely uploading a ZIP to GitHub, or deploying an unrelated preview, does not update the live site's individual files. The included Vercel headers request browser revalidation and prevent CDN reuse of old responses.
3. Close older website tabs. Open `admin.html?v=20261017-admin-v3` on your own website and press **Ctrl+F5**. A private/incognito window is also useful for the first check. The login screen must show **Admin update 20261017.3** and an **Admin account email** input. If it does not, the website is still serving a different deployment.
4. Sign in with your administrator account's email and account password. The previous shared `admin123` password and browser-only admin flags do not authorize access to the protected API.
5. If the account is reported as not an administrator, the Supabase project owner should find **their own verified account** in `public.users`, confirm its UID/email, and set **only that account's** `is_admin` value to `true`. Sign in again. No administrator identity can be safely inferred from the old shared password.
6. Open **User Management** and click **Refresh now**. It should report the number of users “loaded live from server.” Register a test account from a different browser and confirm it appears after refresh.

If `repair-finance.sql` already completed, this frontend update requires **no additional database migration**. The existing Edge Function and cron setup is still required for offline trade settlement as described in `START_HERE.md`.

## If it still fails

- **“Different updates”**: `admin.html`, `db.js`, or `finance-ui.js` was not deployed together. Replace the full project and reload.
- **Missing database update / PGRST202**: verify `supabase-config.js` points to the project where `repair-finance.sql` ran.
- **Not an administrator**: use the correct account and verify `users.is_admin`; a browser cache cannot grant this role.
- **Database API permission denied / 42501** with this new release: run `CHECK_ADMIN_ACCESS.sql` in SQL Editor and inspect the function permissions. Re-running the complete `repair-finance.sql` restores its intended grants without opening the user table.
- **Database unavailable**: verify the public Supabase configuration and that the Supabase JavaScript SDK loaded; the login now keeps the error visible.

Do not disable RLS, grant anonymous access to `users`, or put a service-role key in the website. Those changes would undo the protections around account and financial data.

Send the new error text and a screenshot showing the admin release label if the updated deployment still fails. Do not send passwords, session tokens, or private keys.
