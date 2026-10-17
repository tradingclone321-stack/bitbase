-- Read-only post-install checks. Run as project owner in SQL Editor.
select name,applied_at from bb_private.migrations where name='finance-v2';
select id,last_finished,now()-last_finished as heartbeat_age,last_error,settled from public.bb_engine_health;
select jobid,jobname,schedule,active from cron.job where jobname like 'bitbase-%';
select jobid,status,return_message,start_time,end_time from cron.job_run_details order by start_time desc limit 20;
-- Expect ZERO rows: USDT mirror must equal the canonical available cash.
select uid,cash_balance,asset_balances->'USDT' as usdt from public.users
where coalesce((asset_balances->'USDT'->>'balance')::numeric,0)<>cash_balance
   or coalesce((asset_balances->'USDT'->>'qty')::numeric,0)<>cash_balance;
-- Pending real trades whose candle has passed. Investigate persistent backlog.
select id,uid,payload->>'pair' as pair,
       to_timestamp((payload->>'expiresAt')::numeric/1000) as expires_at
from public.bb_orders where kind='trade' and payload->>'status'='Active'
  and (payload->>'expiresAt')::numeric<extract(epoch from now()-interval '1 minute')*1000;
select collection,id,reason from public.bb_migration_review order by collection,id;
select id,uid,coin,wallet,delta,balance_after,reason,created_at from public.bb_ledger order by id desc limit 100;
select id,actor_uid,subject_uid,action,entity,entity_id,created_at from public.bb_activity order by id desc limit 100;
-- Expect FALSE for all: clients must use server APIs, not raw tables.
select has_table_privilege('anon','public.users','SELECT') as anon_can_read_users,
       has_table_privilege('anon','public.users','UPDATE') as anon_can_update_users,
       has_table_privilege('anon','public.bb_ledger','INSERT') as anon_can_write_ledger;
-- pg_net HTTP responses expose Edge Function deployment/auth/provider errors.
select id,status_code,timed_out,error_msg,created from net._http_response order by created desc limit 20;
