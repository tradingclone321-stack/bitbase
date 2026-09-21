-- ============================================================================
-- BitBase — remove phantom default asset balances
-- ============================================================================
-- The old front-end shipped hardcoded default balances (USDC 800, BTC 0.1442,
-- ETH 2.041, SOL 15.2, DOGE 50000, …). Some users had those defaults written
-- into their users.asset_balances row.
--
-- This SAFELY removes them: a user is only cleaned when their asset_balances
-- EXACTLY matches the full old default template. Anyone with real deposits/
-- trades/admin-credits has different values and is left untouched. USDT is
-- rebuilt from the real cash_balance.
--
-- USAGE:
--   1. Run the DRY-RUN select first — review the listed users/values.
--   2. Run `create or replace function ...` and then select public.fix_phantom_asset_balances();
--      It returns the number of user rows cleaned.
--   3. Affected users just reopen any page; pullLocalUser re-syncs their device.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) DRY RUN — who currently matches the phantom template?
-- ----------------------------------------------------------------------------
select uid, name, cash_balance, asset_balances
  from users
 where (asset_balances->'BTC'->>'balance')::numeric = 0.1442
   and coalesce((asset_balances->'BTC'->>'qty')::numeric,0.1542) = 0.1542
   and (asset_balances->'ETH'->>'balance')::numeric = 2.041
   and coalesce((asset_balances->'ETH'->>'qty')::numeric,2.341) = 2.341
   and (asset_balances->'USDC'->>'balance')::numeric = 800
   and (asset_balances->'SOL'->>'balance')::numeric = 15.2
   and coalesce((asset_balances->'SOL'->>'qty')::numeric,15.7) = 15.7
   and (asset_balances->'BNB'->>'balance')::numeric = 3.0
   and coalesce((asset_balances->'BNB'->>'qty')::numeric,3.2) = 3.2
   and (asset_balances->'ADA'->>'balance')::numeric = 15000
   and (asset_balances->'DOGE'->>'balance')::numeric = 50000
   and (asset_balances->'XRP'->>'balance')::numeric = 4500
   and coalesce((asset_balances->'XRP'->>'qty')::numeric,5000) = 5000
   and (asset_balances->'DOT'->>'balance')::numeric = 200;

-- ----------------------------------------------------------------------------
-- 2) APPLY — zero out phantom coins for exactly-matching rows only
-- ----------------------------------------------------------------------------
create or replace function public.fix_phantom_asset_balances()
returns int
language plpgsql
security definer
set search_path = public
as $f$
declare
  r record;
  is_phantom boolean;
  v_cb numeric;
  v_new jsonb;
  fixed int := 0;
begin
  for r in
    select uid,
           coalesce(cash_balance, 0) as cb,
           coalesce(asset_balances, '{}'::jsonb) as ab
      from users
  loop
    is_phantom :=
      (r.ab->>'BTC' is not null)
      and (r.ab->'BTC'->>'balance')::numeric = 0.1442
      and coalesce((r.ab->'BTC'->>'qty')::numeric, 0.1542) = 0.1542
      and (r.ab->'ETH'->>'balance')::numeric = 2.041
      and coalesce((r.ab->'ETH'->>'qty')::numeric, 2.341) = 2.341
      and (r.ab->'USDC'->>'balance')::numeric = 800
      and (r.ab->'SOL'->>'balance')::numeric = 15.2
      and coalesce((r.ab->'SOL'->>'qty')::numeric, 15.7) = 15.7
      and (r.ab->'BNB'->>'balance')::numeric = 3.0
      and coalesce((r.ab->'BNB'->>'qty')::numeric, 3.2) = 3.2
      and (r.ab->'ADA'->>'balance')::numeric = 15000
      and (r.ab->'DOGE'->>'balance')::numeric = 50000
      and (r.ab->'XRP'->>'balance')::numeric = 4500
      and coalesce((r.ab->'XRP'->>'qty')::numeric, 5000) = 5000
      and (r.ab->'DOT'->>'balance')::numeric = 200;

    if is_phantom then
      if nullif(r.ab->>'USDT','') is null then
        v_cb := r.cb;
      else
        v_cb := coalesce((r.ab->'USDT'->>'balance')::numeric, r.cb);
      end if;
      v_new := jsonb_build_object(
        'USDT', jsonb_build_object('balance', v_cb, 'qty', v_cb),
        'BTC',  jsonb_build_object('balance', 0, 'qty', 0),
        'ETH',  jsonb_build_object('balance', 0, 'qty', 0),
        'USDC', jsonb_build_object('balance', 0, 'qty', 0),
        'SOL',  jsonb_build_object('balance', 0, 'qty', 0),
        'BNB',  jsonb_build_object('balance', 0, 'qty', 0),
        'ADA',  jsonb_build_object('balance', 0, 'qty', 0),
        'DOGE', jsonb_build_object('balance', 0, 'qty', 0),
        'XRP',  jsonb_build_object('balance', 0, 'qty', 0),
        'DOT',  jsonb_build_object('balance', 0, 'qty', 0)
      );
      update users set asset_balances = v_new where uid = r.uid;
      fixed := fixed + 1;
    end if;
  end loop;
  return fixed;
end;
$f$;

-- Run the cleanup:
select public.fix_phantom_asset_balances();