# BitBase: corrected trading and account persistence

This package fixes the uploaded HTML project. It is not yet installed in your hosted Supabase database or website. Uploading HTML alone cannot enable settlement when all browsers are closed.

**Admin user-list error 42501:** see `ADMIN_USER_LIST_FIX.md`. Release 2026-10-17-instant-v12 keeps the safer admin session/cache handling and Vercel cache headers. The admin panel is no longer locked out by a build-string mismatch, so a stale file reports the problem instead of blocking sign-in. If the finance migration already succeeded, no additional migration is needed for that user-list fix. The Delete buttons added in instant-v11 and the guest customer-service feature added in instant-v12 both need the updated `repair-finance.sql` (see below).

## Guest customer service on the login page (release instant-v12)

A visitor who has no account can now contact you from `login.html` and receive replies there:

- The login page shows a floating support button and a **Contact customer service** link. The visitor enters a name, optional email, subject and message, then gets a private conversation panel.
- Guest conversations are stored in `public.bb_records` under the collection **`bb_guest_support`**, separate from signed-in members' `bb_support_tickets`. Guest threads never appear in a member's inbox.
- The browser keeps a random conversation key. The server stores only its SHA-256 hash in `guestTokenHash`, so a database dump cannot be used to read a guest conversation. A guest can only read or write a thread by presenting the matching key.
- The panel shows a **resume code** in the form `<threadId>.<key>`. Copying it and pasting it under "I already have a resume code" restores the conversation in another browser. Tell visitors to keep it private — anyone with the code can read the thread.
- Admin replies appear in **Admin → Support** with a **GUEST** badge. Resolving, replying and deleting use the same Support tab controls. Deleting clears the conversation content but keeps a closed tombstone, so the guest sees "Conversation closed by customer service" and can start a new conversation.
- Messages are merged by message ID on the server, so a reply typed from a slightly stale screen cannot drop a newer message from the guest. Retries reuse the same request ID and are not duplicated.
- Limits: 4,000 characters per message, 140-character subject, 80-character name, 8 guest messages per minute, and 200 messages per conversation.

**Deployment for guest support:** run the updated **`repair-finance.sql`** once in the Supabase SQL Editor. It adds the `bb_guest_support_start`, `bb_guest_support_read` and `bb_guest_support_post` functions, the guest branches in `bb_read`/`bb_save_record`, and the append-only message merge. Without that SQL the login page shows a permission/function error. Then upload `login.html`, `admin.html`, `db.js` and the rest of the `instant-v12` files together and hard-refresh (Ctrl+F5). The site must be unpaused before the login page is reachable (see the pause section below).

## Site pause switch (currently ON)

Every page of the site — including `admin.html` — redirects to `paused.html`, which shows the "Site not available" screen. The switch lives in one file: **`site-pause.js`**.

- **Put the site back online:** open `site-pause.js`, change `var SITE_PAUSED = true;` to `var SITE_PAUSED = false;`, upload that file. Nothing else changes.
- **Pause it again:** set it back to `true` and upload.
- **Remove the pause completely:** delete `paused.html` and `site-pause.js`, then delete the `<script src="site-pause.js"></script>` line from each page (it sits directly under `<meta charset>`).
- While paused, administrators cannot sign in either. Flip the flag to regain access.

## Admin Delete buttons (added in instant-v11, current release instant-v12)

Delete now performs a real server transaction instead of leaving the record in place. **Run `repair-finance.sql` once in the Supabase SQL Editor before using these buttons**; without that update the server answers `Unknown action`.

- **Users** — signs the person out everywhere, erases password/email/personal details, and removes the row from the Users table. Trades, balances and audit entries stay under the same UID and display as "Deleted user". You cannot delete your own account or the last remaining administrator.
- **Loans** — removes the loan record. Pending, paid and rejected loans are removed outright. Deleting an *active* loan writes off the outstanding balance (the borrower already received the money); the confirmation says so before it happens.
- **Deposits** — removes the deposit request. Deleting an approved deposit removes the record only; the user's balance is not changed.
- **AI Quants** — removes the plan. Deleting an active plan returns its principal to the user's USDT balance; daily earnings already paid stay with the user.
- **Withdrawals / KYC** — the server action supports them too (a pending withdrawal refunds its reserved amount; deleting KYC resets the user's KYC status when no other submission remains), but those pages have no Delete button today.

Upload `admin.html` and `db.js` with the other `instant-v12` files, then hard-refresh (Ctrl+F5).

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
