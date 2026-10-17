# Supabase setup

Read **START_HERE.md** for the current installation order. This release requires
`repair-finance.sql`, the `trade-engine` Edge Function, and `supabase-cron.sql`.
Running only the old `repair-users.sql` or uploading only HTML is insufficient.

`schema.sql` is retained solely as a bootstrap for a brand-new database. Apply
`repair-finance.sql` immediately afterward before exposing the site.
