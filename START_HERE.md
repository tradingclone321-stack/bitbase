# BitBase: corrected trading and account persistence

This package fixes the uploaded HTML project. It is not yet installed in your hosted Supabase database or website. Uploading HTML alone cannot enable settlement when all browsers are closed.

## Install in this order

1. **Take a database backup and pause trading.** Deploy all files together; old frontend versions are incompatible with the protected database API.
2. In your existing Supabase project's SQL Editor, run **`repair-finance.sql`**. It uses your existing `users` and `app_collections` tables. For a completely new database, run `schema.sql` first, then `repair-finance.sql` before exposing the site.
3. In Supabase Edge Functions, deploy **`supabase/functions/trade-engine/index.ts`** as **`trade-engine`**. Deploy with JWT gateway verification disabled; the function verifies the BitBase session itself. The included `supabase/config.toml` sets this. CLI example:
   ```sh
   supabase functions deploy trade-engine --project-ref YOUR_PROJECT_REF --no-verify-jwt
   ```
4. Create a random secret of at least 32 characters. Set it as the Edge Function secret **`BITBASE_ENGINE_SECRET`**. Do not put this or a service-role key in HTML, JavaScript configuration, or source control. Supabase supplies the function's `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` environment variables.
5. In Supabase Vault, create **`bitbase_project_url`** with your project's `https://...supabase.co` URL, and **`bitbase_engine_secret`** with the exact same secret from step 4. Run **`supabase-cron.sql`** in SQL Editor. It schedules the trade worker every 10 seconds and the accrual/demo fallback every minute.
6. Upload the entire project, retaining the supplied filenames. Keep your existing public project configuration in `supabase-config.js`. Hard-refresh old browsers and sign in again. The old browser-only `admin123` login is removed. Admins sign in with their own account email/password and must have `users.is_admin = true`.
7. If there is no administrator account, register your own account and assign **that verified UID** administrator access from SQL Editor:
   ```sql
   -- Replace the sample UID with YOUR verified existing account UID.
   update public.users set is_admin = true where uid = 123456;
   ```
8. Run **`VERIFY_INSTALLATION.sql`**. Check the worker heartbeat and cron errors. New real trades fail without deducting funds when the worker has no healthy heartbeat within 90 seconds.
9. Verify a small test transaction using a funded test account, then close every browser until after expiry. Open a fresh browser, sign in, and confirm the order, ledger, and balance. Verify support, settings, and the admin activity log from another device before reopening trading.

## How money moves

USDT `cash_balance` is authoritative; `asset_balances.USDT.balance` and `.qty` mirror it. Other coins retain their own units. PostgreSQL locks the live account and commits the debit/credit, order/request, and ledger record together. Stable request IDs protect retries after lost responses.

The original product is a fixed-duration **price-direction contract**, not an exchange order or conventional futures position. This update makes that explicit on the trade page. It preserves the advertised symmetric payout rule:

| Starting balance 1,000; stake 100; quoted profit/loss 20% | Available balance |
|---|---:|
| Order accepted | 900 |
| Win: return 100 + 20 | 1,020 |
| Loss: return 100 − 20 | 980 |
| Equal entry/exit price: return 100 | 1,000 |
| Early close: return 50% of stake | 950 |

Outcome is determined by the direction and trusted server quotes, not randomness or admin win/loss overrides. Entry uses Binance's public market-data ticker. Exit uses the close of the one-second candle containing the scheduled expiry. Supported pairs are BTC, ETH, SOL, BNB, XRP, ADA, DOGE, DOT, AVAX, LINK, and UNI versus USDT. Other pairs cannot place real orders until a suitable server feed is implemented.

Under normal conditions settlement is applied on the next 10-second worker cycle after the expiry candle completes, plus request latency. It is not a promise of exact-to-the-second credit. During a price-provider or server outage, orders remain pending and retry with the original expiry candle; no price or outcome is invented. A paused Supabase project cannot run jobs. Monitor the worker and cron history.

Other corrections:

- Withdrawal requests reserve amount plus fee immediately. Rejection refunds that reservation once. Approval requires a confirmed payout reference and does not debit again. This software records approvals; it does not send blockchain transactions.
- Deposit approval credits the deposited coin, not an estimated USDT equivalent. Conversion is a separate operation using a server quote. Deposit verification is still the administrator's responsibility.
- Transfers debit the source wallet and credit the destination atomically. Funding balances persist in `users.funding_balances`.
- Quant principal is debited with its order; missed daily payouts catch up once, and principal returns at maturity. These are configured accrual plans; no external AI trading strategy is connected.
- Earn redemptions return principal and accrued interest once; locked positions settle at maturity. The packaged earn products are accounting plans, not integrated DeFi transactions.
- Practice trades use a separate persistent demo balance and server simulation. They cannot alter real funds or real trade history.
- Admin adjustments require a reason. A “set balance” operation rejects a stale balance instead of overwriting a recent trade or another admin's credit.
- Profile changes, preferences, support conversations, KYC decisions, orders, and requests persist centrally. Foreground pages refresh server data periodically and on reconnect. Unsaved form drafts are not synced.

## Existing accounts and historical discrepancies

Existing account UIDs, cash balances, coin balances, and stored source collections are preserved. Passwords are migrated to private hashes. Passwords and full tables are no longer publicly readable; sessions are verified by the server, expire after seven days, and can be revoked across devices. Email-only password reset is removed because it did not verify ownership. Account recovery requires a verified support process; no recovery-email provider is configured in this project.

**Existing active real/quant/earn orders are put in `Review`.** The old code wrote the stake deduction separately from the order, sometimes only to browser storage. It is impossible to infer reliably whether each deduction actually committed. Automatically refunding all old orders could create money twice. Their original records are retained in `app_collections` and `bb_migration_review`; imported orders are in `bb_orders`. No new migration credits are generated.

Reconcile each old order against reliable transaction/deposit records and any available browser export. Apply an evidenced correction through **Admin → Balances**, with the source reference in the reason. Do not bulk-upload old browser balances. Browser-only missing orders and already incorrect historical balances cannot be reconstructed from this archive alone. Do not delete records to hide discrepancies.

The account architecture has been improved, but this is not a certification for operating a real-money exchange. Email verification, MFA, external execution/custody, production rate limiting, monitoring, recovery, and an independent security review remain deployment responsibilities.

## Database locations

| Data | Current location |
|---|---|
| Available USDT, coin holdings, funding wallet, profile, preferences, demo state | `public.users` |
| Real trades, quant and earn orders | `public.bb_orders` |
| Deposits, withdrawals, loans, support, KYC, deposit configuration, demo history | `public.bb_records` |
| Confirmed financial debits and credits | `public.bb_ledger` |
| User/admin actions and automated settlement events | `public.bb_activity` |
| Legacy active orders needing reconciliation | `public.bb_migration_review` |
| Worker heartbeat and last error | `public.bb_engine_health` |
| Password hashes, sessions, duplicate-request results | `bb_private` schema |

The original optional tables named `trades`, `withdrawal_requests`, etc. are not the new source of truth. Legacy `app_collections` are retained as an archive. Use the tables above when inspecting current data.

## Verification and limits

See `TEST_RESULTS.md` and `tests/`. The tests use synthetic records and a local PostgreSQL engine. Browser tests execute the actual UI, Supabase SDK, SQL functions, and Edge Function handler with intercepted database/market requests. They do not touch live accounts.

Live credentials for migration/deployment were not provided, so the hosted migration, provider access from your Supabase region, production cron jobs, real chain transfers, load at production scale, and true multi-connection PostgreSQL contention were not tested. No finite test suite can guarantee zero defects.

Primary implementation references:

- https://www.postgresql.org/docs/18/explicit-locking.html
- https://supabase.com/docs/guides/cron/quickstart
- https://supabase.com/docs/guides/functions/schedule-functions
- https://supabase.com/docs/guides/database/functions
- https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
