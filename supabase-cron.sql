-- Run AFTER repair-finance.sql and deploying the trade-engine Edge Function.
-- Create these two Vault secrets in Supabase first:
-- bitbase_project_url = your https://....supabase.co project URL
-- bitbase_engine_secret = same random 32+ character value as BITBASE_ENGINE_SECRET
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
 if not exists(select 1 from vault.decrypted_secrets where name='bitbase_project_url') or not exists(select 1 from vault.decrypted_secrets where name='bitbase_engine_secret' and length(decrypted_secret)>=32) then
  raise exception 'Create bitbase_project_url and bitbase_engine_secret in Vault first';
 end if;
 perform cron.unschedule(jobid) from cron.job where jobname in ('bitbase-finance-engine','bitbase-accruals','bitbase-settle-aiquants');
 perform cron.schedule('bitbase-finance-engine','10 seconds',$job$
  select net.http_post(
   url := (select decrypted_secret from vault.decrypted_secrets where name='bitbase_project_url') || '/functions/v1/trade-engine',
   headers := jsonb_build_object('Content-Type','application/json','x-engine-secret',(select decrypted_secret from vault.decrypted_secrets where name='bitbase_engine_secret')),
   body := '{"action":"settle"}'::jsonb,timeout_milliseconds := 55000);
 $job$);
 perform cron.schedule('bitbase-accruals','* * * * *','select public.bb_settle_accruals()');
end $$;
