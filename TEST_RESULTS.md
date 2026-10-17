# Verification results — 17 October 2026

The uploaded project has been repaired and tested locally. **38 financial integration checks, 15 browser/worker checks, and 3 schema compatibility checks passed.** This report supersedes the previous registration-only report.

## What was repaired

Balances and orders previously depended on browser storage, separate writes, and browser timers. The repaired project commits financial mutations and their ledger records together in PostgreSQL. A scheduled server worker settles expired trades even when every browser is closed. Retries use stable request IDs, and account pages refresh authoritative server data instead of uploading cached balances.

## Financial integration — 38 checks passed

Executed against actual PostgreSQL functions using PGlite and synthetic accounts. Detailed output: `tests/finance-results.txt`.

| Area | Verified cases |
|---|---|
| Migration | Rerun without duplicate changes; existing balances and other coin holdings preserved; uncertain active legacy orders retained for review |
| Authentication and permissions | Private password hashes; no password in account responses; null/wrong credentials rejected; direct anonymous table/money access denied; user cannot gain admin access |
| Trade acceptance | Stake and order committed together; insufficient funds, invalid numeric values, invalid duration, unsupported input and stale quotes rejected; missing/stale/failing worker blocks new debits |
| Trade outcome | UP/DOWN wins and losses, equal-price refund, signed P&L, principal returned correctly, premature/wrong-candle settlement rejected |
| Duplicate requests | Placement retries, repeated settlement, repeated early close and worker-after-close do not duplicate money |
| Conflicting updates | Simultaneously submitted trades cannot overspend; admin credits accumulate; stale absolute balance change rejected; changed input cannot reuse an accepted request ID |
| Deposits and withdrawals | Correct coin units; approval once; amount plus fee reserved; rejection refunds once; confirmed payout reference required; approval does not debit again |
| Transfers and conversion | Both sides committed together; reverse transfer conserves total; retry preserves original conversion fill |
| Loans and accrual plans | Approval cannot duplicate funds; repayment reference; quant catch-up after missed days; principal once at maturity; flexible earn redemption; locked earn maturity |
| Durable account data | Support and KYC ownership; stale-edit conflict detection; no forged admin messages; profile/preferences/history restored by new login |
| Audit and sessions | Financial and business activity records; ledger reconciles to fixture opening balances; deactivation revokes access without preventing existing settlement; logout across devices |
| Demo account | Server settlement and durable practice balance; no real-money or real-history changes |

PGlite serializes queries. Simultaneously submitted requests here verify transactional and idempotency behavior; they are **not** a true multi-connection PostgreSQL lock/load test.

## Browser and worker integration — 15 checks passed

Executed in headless Chromium with the actual HTML pages, real Supabase JavaScript SDK, migrated SQL API and the actual Edge Function handler. All remote requests were intercepted. Prices were controlled test fixtures, not live market data.

1. Real login form obtains a server session without caching a password.
2. Administrator email/password login is verified on the server.
3. Actual trade page deducts 100 from a 1,000 balance only after accepted placement.
4. The active trade appears in a separate administrator browser.
5. The price worker settles exactly once after **all browser contexts are closed**.
6. A fresh device signs in and restores the settled order and 1,020 winning balance.
7. A lost placement response followed by same-form retry does not deduct again.
8. Price-provider failure leaves funds unchanged; retry recovers.
9. Scheduler requests require the private engine secret.
10. Stale or manually edited browser balances are replaced from the server and never uploaded.
11. All eight account pages load and refresh against real SQL responses.
12. Demo trades use separate durable funds and cannot double-refund.
13. A fresh administrator browser restores all tabs and durable audit history.
14. Registration creates a confirmed server account visible on a separate admin device.
15. No uncaught page JavaScript errors occur during the complete run.

## Schema and static checks

- Three original schema compatibility checks pass: repeatable bootstrap, missing-column repair preserving user data, and rollback on duplicate legacy UIDs.
- 44 standalone/inline JavaScript blocks parse successfully.
- Local HTML dependency paths and structured-data JSON are checked before packaging.
- The delivered ZIP is checked for archive integrity.

## Required live installation and remaining limits

**These changes are not installed in the hosted site or database.** Follow `START_HERE.md` to install `repair-finance.sql`, deploy the `trade-engine` Edge Function, configure its private secret and schedule `supabase-cron.sql`. Uploading HTML alone does not provide offline settlement. Run `VERIFY_INSTALLATION.sql` and repeat a funded test-account trade with all browsers closed before reopening trading.

Existing active real/quant/earn orders are preserved in `Review` because the old system cannot prove whether their separate deductions committed. Do not guess refunds or overwrite balances from browser caches. Reconcile those orders and historical discrepancies from reliable records.

No live database mutation, production deployment, real blockchain transfer, production load test, external-provider regional reachability test, or independent security audit was performed. Production cron/pg_net/Vault extension installation still requires verification. Persistent business actions are recorded; unsaved form drafts and every navigation/click are not an analytics log. No finite test suite can establish that every possible scenario is error-free.
