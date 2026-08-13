# BitBase — Supabase Setup

## Why this exists
The app used only `localStorage`, so the admin panel could only ever see the
users registered on *that same browser*. With Supabase connected, registrations
are pushed to a central `users` table and the admin pulls the full list from any
device — so all registered users show up.

## 1. Create the Supabase project
1. Go to https://supabase.com and create a project.
2. In **Project Settings → API**, copy the **Project URL** and the **anon public** key.

## 2. Paste your keys
Open `supabase-config.js` and replace the placeholders:

```js
var SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
var SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
```

If the keys are left as `PASTE_...`, every Supabase call is skipped and the app
silently falls back to localStorage (no errors).

## 3. Create the tables
1. In Supabase, open the **SQL Editor**.
2. Paste the entire contents of `schema.sql`.
3. Run it.

## 4. Test
- Register a user on device A → open the admin panel (default password `admin123`)
  on device A or B → the new user appears in the **Users** tab.
- Admin actions (edit balance, deactivate, admin access, approve deposits /
  withdrawals / loans / KYC) are written back to Supabase.

## Files
- `schema.sql` — creates `users`, `app_collections` (all other data), and optional
  normalized tables. RLS is enabled with a public policy (demo-grade).
- `supabase-config.js` — paste your URL + anon key here.
- `db.js` — the sync layer. localStorage stays the fast cache; this mirrors data
  to Supabase (`pushUsers`, `pullUsers`, `pushCollection`, `pullCollection`, ...).

## Security note
Passwords are stored plaintext in the `users` table to keep the existing
login/register UX. Before going to production, hash passwords (e.g. with bcrypt)
and add proper RLS policies + Supabase Auth.
