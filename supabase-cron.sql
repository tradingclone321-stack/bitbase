-- ============================================================================
-- BitBase — AI Quant automatic daily settlement (server-side)
-- ============================================================================
-- Runs inside Supabase every hour at :15 and settles EVERY overdue day of
-- EVERY user's active AI quant plan — all plan terms (1 / 7 / 30 / 90 / 180
-- days) — even when NO browser (user or admin) is open.
--
--   * Profits are credited to users.cash_balance and mirrored into
--     asset_balances.USDT (balance + qty).
--   * On the final day the invested principal is returned as well and the
--     order flips to status "completed".
--   * Settlement is idempotent: lastPayout always advances by exactly the
--     number of settled days, so re-running can never double-credit.
--
-- INSTALL:
--   1. Supabase Dashboard -> Database -> Extensions -> enable "pg_cron".
--   2. SQL Editor -> paste this ENTIRE file -> Run.
-- VERIFY:
--   select * from cron.job;                      -- schedule listed?
--   select public.settle_ai_quants();            -- manual test run
-- ============================================================================

create extension if not exists pg_cron;

create or replace function public.settle_ai_quants()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now    bigint := (extract(epoch from now()) * 1000)::bigint;
  v_arr    jsonb;
  v_o      jsonb;
  v_new    jsonb;
  v_out    jsonb := '[]'::jsonb;
  v_uid    text;
  v_days   int;
  v_settled int;
  v_lastpay bigint;
  v_missed int;
  v_count  int;
  v_daily  numeric;
  v_credit numeric;
  v_final  boolean;
  checked_count int := 0;
  settled_count int := 0;
begin
  select payload into v_arr
    from app_collections
   where key = 'bb_ai_quants';

  if v_arr is null or jsonb_typeof(v_arr) <> 'array' then
    return jsonb_build_object('ok', true, 'ordersChecked', 0, 'settledOrders', 0);
  end if;

  for idx in 0 .. jsonb_array_length(v_arr) - 1 loop
    v_o := v_arr -> idx;
    checked_count := checked_count + 1;

    continue when coalesce(v_o->>'status','') <> 'active';

    v_uid      := coalesce(v_o->>'uid','');
    v_days     := coalesce((v_o->>'days')::int, 0);
    v_settled  := coalesce((v_o->>'settledDays')::int, 0);
    continue when v_uid = '' or v_days <= 0 or v_settled >= v_days;

    v_lastpay := coalesce(
                   (v_o->>'lastPayout')::bigint,
                   (v_o->>'started')::bigint,
                   0);
    -- Whole days elapsed since the last payout (catches up any number of
    -- missed days at once).
    v_missed := floor((v_now - v_lastpay)::numeric / 86400000)::int;
    v_count  := least(greatest(v_missed, 0), v_days - v_settled);
    continue when v_count <= 0;

    v_daily  := coalesce((v_o->>'amount')::numeric, 0)
              * coalesce((v_o->>'rate')::numeric, 0) / 100;
    v_credit := v_daily * v_count;

    v_settled := v_settled + v_count;
    v_final   := (v_settled >= v_days);

    if v_final then
      v_credit := v_credit + coalesce((v_o->>'amount')::numeric, 0); -- principal back
    end if;

    -- Credit the user: cash balance + USDT asset mirror
    update users
       set cash_balance = coalesce(cash_balance, 0) + v_credit,
           asset_balances = jsonb_set(
             coalesce(asset_balances, '{}'::jsonb),
             '{USDT}',
             coalesce(asset_balances->'USDT', '{}'::jsonb)
               || jsonb_build_object(
                    'balance',
                      coalesce(asset_balances->'USDT'->>'balance', '0')::numeric + v_credit,
                    'qty',
                      coalesce(asset_balances->'USDT'->>'qty', '0')::numeric + v_credit
                  )
           )
     where uid::text = v_uid;

    v_new := v_o || jsonb_build_object(
               'settledDays', v_settled,
               'earned',      coalesce((v_o->>'earned')::numeric, 0) + (v_daily * v_count),
               'lastPayout',  v_lastpay + (v_count::bigint * 86400000),
               'updatedAt',   v_now
             )
             || case when v_final then jsonb_build_object(
                  'status',      'completed',
                  'completedAt', v_now
                ) else '{}'::jsonb end;

    v_out := v_out || jsonb_build_array(v_new);
    settled_count := settled_count + 1;
  end loop;

  -- Write back only when something actually settled
  if settled_count > 0 then
    update app_collections
       set payload    = v_out,
           updated_at = now()
     where key = 'bb_ai_quants';
  end if;

  return jsonb_build_object('ok', true,
                            'ordersChecked', checked_count,
                            'settledOrders', settled_count);
end;
$$;

-- ----------------------------------------------------------------------------
-- Schedule: hourly at :15. Safe to re-run this file (idempotent).
-- ----------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'bitbase-settle-aiquants') then
    perform cron.unschedule('bitbase-settle-aiquants');
  end if;
  perform cron.schedule(
    'bitbase-settle-aiquants',
    '15 * * * *',
    'select public.settle_ai_quants()'
  );
end $do$;

-- Maintenance helpers -------------------------------------------------------
-- Remove / pause :  select cron.unschedule('bitbase-settle-aiquants');
-- Watch it run   :  select * from cron.job_run_details
--                    order by start_time desc limit 20;
