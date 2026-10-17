-- BitBase financial integrity migration. Back up first. Run once in SQL Editor.
-- Rerunnable. Does NOT recalculate historical balances or infer missing debits.
begin;
create extension if not exists pgcrypto;
create schema if not exists bb_private;
revoke all on schema bb_private from public;
revoke create on schema public from public;
alter table public.users add column if not exists preferences jsonb not null default '{}';
alter table public.users add column if not exists demo_balance jsonb;
alter table public.users add column if not exists demo_positions jsonb;
alter table public.users add column if not exists funding_balances jsonb not null default '{}';
alter table public.users add column if not exists updated_at timestamptz not null default now();
-- Reject ambiguous legacy identities; do not silently merge accounts.
create unique index if not exists bb_users_email_normalized on public.users(lower(trim(email))) where email <> '';
create unique index if not exists users_uid_key on public.users(uid);

create table if not exists bb_private.credentials(uid integer primary key references public.users(uid), password_hash text not null);
create table if not exists bb_private.sessions(token_hash text primary key,uid integer not null references public.users(uid),expires_at timestamptz not null,created_at timestamptz not null default now());
create index if not exists bb_sessions_uid on bb_private.sessions(uid);
create table if not exists bb_private.login_attempts(email text primary key,attempts integer not null default 0,since timestamptz not null default now());
-- Preserve existing passwords as hashes; frontend can no longer read passwords.
insert into bb_private.credentials(uid,password_hash)
select uid,crypt(password,gen_salt('bf',10)) from public.users where password <> ''
on conflict(uid) do nothing;
update public.users set password='' where password<>'';

create table if not exists public.bb_records (
 collection text not null,id text not null,uid integer,payload jsonb not null,
 version bigint not null default 1,updated_at timestamptz not null default now(),
 primary key(collection,id)
);
create index if not exists bb_records_owner on public.bb_records(uid,collection);
create table if not exists public.bb_orders (
 id text primary key,uid integer not null references public.users(uid),kind text not null check(kind in ('trade','quant','earn')),
 request_id text not null,payload jsonb not null,version bigint not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(uid,request_id)
);
create index if not exists bb_orders_active on public.bb_orders(kind,((payload->>'status')));
create index if not exists bb_orders_owner on public.bb_orders(uid,created_at);
create table if not exists public.bb_ledger (
 id bigint generated always as identity primary key,event_key text not null unique,
 uid integer not null,coin text not null,wallet text not null default 'spot',delta numeric(28,8) not null,
 balance_after numeric(28,8) not null,reason text not null,actor_uid integer,
 created_at timestamptz not null default now()
);
create table if not exists public.bb_activity (
 id bigint generated always as identity primary key,actor_uid integer,subject_uid integer,
 action text not null,entity text not null,entity_id text,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create index if not exists bb_activity_subject on public.bb_activity(subject_uid,created_at);
create table if not exists bb_private.requests (
 uid integer not null,id text not null,action text not null,input jsonb not null,result jsonb not null,
 primary key(uid,id),created_at timestamptz not null default now()
);
create table if not exists bb_private.migrations(name text primary key,applied_at timestamptz default now());
create table if not exists public.bb_migration_review(collection text,id text,payload jsonb,reason text,primary key(collection,id));
create table if not exists public.bb_engine_health(id boolean primary key default true check(id),last_started timestamptz,last_finished timestamptz,last_error text,settled integer not null default 0);

create or replace function bb_private.audit(p_actor integer,p_uid integer,p_action text,p_entity text,p_id text,p_details jsonb default '{}') returns void
language sql set search_path=pg_catalog,public as $$
 insert into public.bb_activity(actor_uid,subject_uid,action,entity,entity_id,details) values(p_actor,p_uid,p_action,p_entity,p_id,p_details)
$$;
create or replace function bb_private.actor(p_token text) returns public.users
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users;
begin
 select x.* into u from public.users x join bb_private.sessions s on s.uid=x.uid
 where s.token_hash=encode(digest(p_token,'sha256'),'hex') and s.expires_at>now();
 if u.uid is null or u.is_deactivated then raise exception 'Sign in again: session expired or account unavailable' using errcode='28000'; end if;
 return u;
end $$;
create or replace function bb_private.public_user(u public.users) returns jsonb
language sql immutable as $$ select to_jsonb(u)-'password' $$;
create or replace function bb_private.amount(p text) returns numeric
language plpgsql immutable as $$
declare n numeric;
begin
 n:=p::numeric;
 if n is null or n::text in ('NaN','Infinity','-Infinity') or n<=0 or n>1000000000000000 or n<>round(n,8) then
 raise exception 'Amount must be positive, finite, and have at most 8 decimal places'; end if;
 return n;
end $$;
create or replace function bb_private.coin_balance(u public.users,p_coin text,p_wallet text default 'spot') returns numeric
language sql immutable as $$
 select case when p_wallet='funding' then coalesce((u.funding_balances->>p_coin)::numeric,0)
 when p_coin='USDT' then u.cash_balance else coalesce((u.asset_balances->p_coin->>'balance')::numeric,(u.asset_balances->p_coin->>'qty')::numeric,0) end
$$;
-- The ONLY balance writer. Locks the live row; checks funds; records each delta.
create or replace function bb_private.move(p_uid integer,p_coin text,p_delta numeric,p_event text,p_reason text,p_actor integer default null,p_wallet text default 'spot') returns numeric
language plpgsql set search_path=pg_catalog,public as $$
declare u public.users; old public.bb_ledger; b numeric; d numeric:=round(p_delta,8); ab jsonb;
begin
 if p_coin !~ '^[A-Z0-9]{2,12}$' or p_wallet not in ('spot','funding') or d is null or d::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid balance change'; end if;
 select * into u from public.users where uid=p_uid for update;
 if not found then raise exception 'Account not found'; end if;
 select * into old from public.bb_ledger where event_key=p_event;
 if found then
  if old.uid<>p_uid or old.coin<>p_coin or old.delta<>d or old.wallet<>p_wallet then raise exception 'Conflicting duplicate money operation'; end if;
  return bb_private.coin_balance(u,p_coin,p_wallet);
 end if;
 b:=round(bb_private.coin_balance(u,p_coin,p_wallet)+d,8);
 if b<0 then raise exception 'Insufficient % balance',p_coin using errcode='P0001'; end if;
 if p_wallet='funding' then
  update public.users set funding_balances=jsonb_set(funding_balances,array[p_coin],to_jsonb(b)),updated_at=now() where uid=p_uid;
 else
  ab:=jsonb_set(coalesce(u.asset_balances,'{}'),array[p_coin],coalesce(u.asset_balances->p_coin,'{}')||jsonb_build_object('balance',b,'qty',b));
  update public.users set asset_balances=ab,cash_balance=case when p_coin='USDT' then b else cash_balance end,updated_at=now() where uid=p_uid;
 end if;
 insert into public.bb_ledger(event_key,uid,coin,wallet,delta,balance_after,reason,actor_uid) values(p_event,p_uid,p_coin,p_wallet,d,b,p_reason,p_actor);
 perform bb_private.audit(p_actor,p_uid,'balance.'||p_reason,'ledger',p_event,jsonb_build_object('coin',p_coin,'wallet',p_wallet,'delta',d,'balance',b));
 return b;
end $$;

-- Accounts use revocable server sessions, not a local password/admin flag.
create or replace function public.bb_register(p_name text,p_email text,p_password text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users; tok text; i integer;
begin
 if p_name is null or p_email is null or p_password is null or p_name ~ '[<>]' or length(trim(p_name))<1 or length(p_name)>120 or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or octet_length(p_password) not between 8 and 72 then raise exception 'Valid name, email, and an 8–72 byte password are required'; end if;
 for i in 1..20 loop
  begin
   insert into public.users(uid,name,email,password) values(100000+floor(random()*900000)::int,trim(p_name),lower(trim(p_email)),'') returning * into u;
   exit;
  exception when unique_violation then
   if exists(select 1 from public.users where lower(trim(email))=lower(trim(p_email))) then raise exception 'An account with this email already exists'; end if;
  end;
 end loop;
 if u.uid is null then raise exception 'Unable to allocate account number'; end if;
 insert into bb_private.credentials values(u.uid,crypt(p_password,gen_salt('bf',10)));
 tok:=encode(gen_random_bytes(32),'hex');
 insert into bb_private.sessions(token_hash,uid,expires_at) values(encode(digest(tok,'sha256'),'hex'),u.uid,now()+interval '7 days');
 perform bb_private.audit(u.uid,u.uid,'account.register','users',u.uid::text);
 return jsonb_build_object('user',bb_private.public_user(u),'token',tok);
end $$;
create or replace function public.bb_login(p_email text,p_password text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users; h text; tok text; a bb_private.login_attempts; em text:=lower(trim(p_email));
begin
 perform pg_advisory_xact_lock(hashtext('login:'||em));
 insert into bb_private.login_attempts(email) values(em) on conflict do nothing;
 select * into a from bb_private.login_attempts where email=em for update;
 if a.since<now()-interval '15 minutes' then update bb_private.login_attempts set attempts=0,since=now() where email=em; a.attempts:=0; end if;
 if a.attempts>=15 then return jsonb_build_object('error','Too many attempts. Try again in 15 minutes.'); end if;
 select * into u from public.users where lower(trim(email))=em;
 select password_hash into h from bb_private.credentials where uid=u.uid;
 if p_password is null or h is null or octet_length(p_password)>72 or crypt(p_password,h)<>h or u.is_deactivated then
  update bb_private.login_attempts set attempts=attempts+1 where email=em;
  return jsonb_build_object('error','Incorrect credentials or account unavailable');
 end if;
 delete from bb_private.login_attempts where email=em;
 delete from bb_private.sessions where expires_at<now();
 tok:=encode(gen_random_bytes(32),'hex');
 insert into bb_private.sessions(token_hash,uid,expires_at) values(encode(digest(tok,'sha256'),'hex'),u.uid,now()+interval '7 days');
 perform bb_private.audit(u.uid,u.uid,'account.login','users',u.uid::text);
 return jsonb_build_object('user',bb_private.public_user(u),'token',tok);
end $$;

-- Import server records once. Local browser-only records cannot prove a debit.
-- Keep all originals in app_collections for reconciliation; never import twice.
do $migration$
declare c record; r jsonb; k text; rid text; uidn integer; started bigint; dur integer;
begin
 if exists(select 1 from bb_private.migrations where name='finance-v2') then return; end if;
 for c in select * from public.app_collections loop
  if jsonb_typeof(c.payload)='array' then
   for r in select value from jsonb_array_elements(c.payload) loop
    rid:=coalesce(r->>'id','legacy-'||md5(r::text));
    begin uidn:=coalesce(r->>'uid',r->>'userId')::integer; exception when others then uidn:=null; end;
    if c.key in ('bb_trades_history','bb_ai_quants','bb_earn_positions') and uidn is not null and exists(select 1 from public.users where uid=uidn) then
     k:=case c.key when 'bb_trades_history' then 'trade' when 'bb_ai_quants' then 'quant' else 'earn' end;
     if k='trade' and r->>'status' in ('Won','Lost','Closed') then
      r:=r||jsonb_build_object('potentialProfit',abs(coalesce((r->>'profit')::numeric,0)),'legacyProfit',r->'profit');
      if r->>'status'='Lost' then r:=r||jsonb_build_object('profit',-abs(coalesce((r->>'profit')::numeric,0)));
      elsif r->>'status'='Closed' and r ? 'refund' then r:=r||jsonb_build_object('profit',(r->>'refund')::numeric-(r->>'amount')::numeric);end if;
     end if;
     if lower(coalesce(r->>'status','active'))='active' then
      -- Do not guess whether the original independent balance write committed.
      insert into public.bb_migration_review values(c.key,rid,r,'Active legacy order: verify original debit and terms before enabling settlement') on conflict do nothing;
      r:=r||jsonb_build_object('status','Review','legacyStatus',coalesce(r->>'status','active'));
     end if;
     insert into public.bb_orders(id,uid,kind,request_id,payload) values('legacy-'||uidn||'-'||rid,uidn,k,'legacy-'||k||'-'||rid,r||jsonb_build_object('id','legacy-'||uidn||'-'||rid,'legacyId',rid,'uid',uidn::text)) on conflict do nothing;
    elsif c.key not in ('bb_balance_history','bb_profit_modules') then
     insert into public.bb_records(collection,id,uid,payload) values(c.key,rid,uidn,r||jsonb_build_object('id',rid)) on conflict do nothing;
    end if;
   end loop;
  elsif c.key='bb_deposit_addresses' and jsonb_typeof(c.payload)='object' then
   insert into public.bb_records(collection,id,uid,payload) values(c.key,'config',null,c.payload) on conflict do nothing;
  end if;
 end loop;
 -- USDT is a mirror of cash, never a second independent amount.
 update public.users set asset_balances=jsonb_set(coalesce(asset_balances,'{}'),'{USDT}',coalesce(asset_balances->'USDT','{}')||jsonb_build_object('balance',cash_balance,'qty',cash_balance));
 perform bb_private.audit(null,null,'migration.finance_v2','migration','finance-v2');
 insert into bb_private.migrations(name) values('finance-v2');
end $migration$;

-- Read API: ownership and administrator privileges are checked in PostgreSQL.
create or replace function public.bb_read(p_token text,p_resource text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users; result jsonb;
begin
 u:=bb_private.actor(p_token);
 if p_resource='me' then return bb_private.public_user(u); end if;
 if p_resource='users' then
  if not u.is_admin then raise exception 'Administrator access required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(bb_private.public_user(x) order by x.created_at desc,x.uid desc),'[]') into result from public.users x; return result;
 end if;
 if p_resource='bb_balance_history' then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'uid',uid::text,'type',case when delta>=0 then 'credit' else 'debit' end,'amount',abs(delta),'newBalance',balance_after,'reason',reason||' ('||coin||'/'||wallet||')','time',extract(epoch from created_at)*1000) order by id desc),'[]') into result from public.bb_ledger where u.is_admin or uid=u.uid; return result;
 end if;
 if p_resource='activity' then
  select coalesce(jsonb_agg(to_jsonb(a) order by id desc),'[]') into result from public.bb_activity a where u.is_admin or subject_uid=u.uid; return result;
 end if;
 if p_resource='health' then return coalesce((select to_jsonb(h) from public.bb_engine_health h),'{}'); end if;
 if p_resource in ('bb_trade_positions','bb_trades_history','bb_ai_quants','bb_earn_positions') then
  select coalesce(jsonb_agg(payload||jsonb_build_object('_version',version) order by created_at desc,id),'[]') into result from public.bb_orders where (u.is_admin or uid=u.uid) and kind=case p_resource when 'bb_ai_quants' then 'quant' when 'bb_earn_positions' then 'earn' else 'trade' end; return result;
 end if;
 if p_resource='bb_profit_modules' then return '{}'::jsonb; end if;
 if p_resource='bb_deposit_addresses' then return coalesce((select payload||jsonb_build_object('_version',version) from public.bb_records where collection=p_resource and id='config'),'{}'); end if;
 if p_resource not in ('bb_deposit_requests','bb_withdrawal_requests','bb_loans','bb_kyc_submissions','bb_support_tickets','bb_demo_trades_hist') then raise exception 'Unknown collection'; end if;
 select coalesce(jsonb_agg(payload||jsonb_build_object('_version',version) order by updated_at,id),'[]') into result from public.bb_records where collection=p_resource and (u.is_admin or uid=u.uid); return result;
end $$;

-- Non-financial record writes: compare versions, never replace a shared array.
create or replace function public.bb_save_record(p_token text,p_collection text,p_record jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users; r public.bb_records; rid text; n jsonb; v bigint; ms bigint:=(extract(epoch from now())*1000)::bigint; other jsonb;
begin
 u:=bb_private.actor(p_token); rid:=p_record->>'id';
 if p_collection='bb_deposit_addresses' then rid:='config'; if not u.is_admin then raise exception 'Administrator access required'; end if; end if;
 if p_collection not in ('bb_support_tickets','bb_kyc_submissions','bb_deposit_addresses') or rid is null or rid !~ '^[A-Za-z0-9_-]{1,180}$' then raise exception 'Use the financial transaction API for this record'; end if;
 perform pg_advisory_xact_lock(hashtext(p_collection||':'||rid));
 select * into r from public.bb_records where collection=p_collection and id=rid for update;
 if r.id is not null and not u.is_admin and r.uid<>u.uid then raise exception 'Record belongs to another account'; end if;
 n:=p_record-'_version';
 if r.id is not null and n=r.payload then return r.payload||jsonb_build_object('_version',r.version); end if;
 if r.id is not null and coalesce((p_record->>'_version')::bigint,0)<>r.version then raise exception 'Record changed on another device. Refresh and retry.' using errcode='40001'; end if;
 if p_collection<>'bb_deposit_addresses' then
  n:=n||jsonb_build_object('userId',coalesce(r.uid,u.uid)::text,'uid',coalesce(r.uid,u.uid)::text,'id',rid);
 end if;
 if p_collection='bb_kyc_submissions' then
  if r.id is not null and not u.is_admin then raise exception 'Submit a new KYC request'; end if;
  if not u.is_admin or r.id is null then n:=n||jsonb_build_object('status','pending','createdAt',ms); end if;
  if n->>'status' not in ('pending','approved','rejected','deleted') then raise exception 'Invalid KYC status'; end if;
  if n->>'status'<>'deleted' then update public.users set kyc_status=n->>'status' where uid=coalesce(r.uid,u.uid); end if;
 end if;
 if p_collection='bb_support_tickets' and not u.is_admin then
  if r.payload->>'status'='deleted' then raise exception 'Conversation deleted'; end if;
  n:=n||jsonb_build_object('status',coalesce(r.payload->>'status','open'),'userName',u.name,'userEmail',u.email);
  for other in select value from jsonb_array_elements(coalesce(n->'messages','[]')) loop
   if other->>'from' in ('admin','support') and not coalesce(r.payload->'messages','[]') @> jsonb_build_array(other) then raise exception 'Cannot impersonate support'; end if;
  end loop;
 end if;
 insert into public.bb_records(collection,id,uid,payload) values(p_collection,rid,case when p_collection='bb_deposit_addresses' then null else coalesce(r.uid,u.uid) end,n)
 on conflict(collection,id) do update set payload=excluded.payload,version=bb_records.version+1,updated_at=now() returning version into v;
 perform bb_private.audit(u.uid,coalesce(r.uid,u.uid),'record.save',p_collection,rid,jsonb_build_object('version',v,'status',n->>'status'));
 return n||jsonb_build_object('_version',v);
end $$;

-- One transaction for user/admin actions. Caller supplies a stable request ID.
create or replace function public.bb_action(p_token text,p_action text,p_id text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
#variable_conflict use_variable
declare u public.users; target public.users; prev bb_private.requests; rec public.bb_records; ord public.bb_orders;
 n jsonb; res jsonb; cid text; rid text; coin text; wallet text; amt numeric; delta numeric; bal numeric; fee numeric;
 ms bigint:=(extract(epoch from now())*1000)::bigint; rate numeric; days integer; min_amt numeric; ky text; action_status text; updated public.users;
begin
 u:=bb_private.actor(p_token);
 if coalesce(p_id,'') !~ '^[A-Za-z0-9_-]{12,180}$' then raise exception 'A unique request ID is required'; end if;
 -- Account-first locking is shared by orders, admin writes, cron, and approvals.
 -- Record actions lock target owner, then record. All paths use this order.
 perform pg_advisory_xact_lock(hashtext('request:'||u.uid||':'||p_id));
 select * into prev from bb_private.requests where uid=u.uid and id=p_id;
 if found then
  if prev.action<>p_action or prev.input<>jsonb_build_object('hash',encode(digest(p_data::text,'sha256'),'hex')) then raise exception 'Request ID already used for different input'; end if;
  return prev.result;
 end if;
 if p_action in ('profile','preferences','demo','password','logout','logout_all') then
  select * into target from public.users where users.uid=u.uid for update;
  if p_action='profile' then
   if p_data->>'name' ~ '[<>]' or length(trim(p_data->>'name')) not between 1 and 120 or p_data->>'email' !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Valid name and email required'; end if;
   update public.users set name=trim(p_data->>'name'),email=lower(trim(p_data->>'email')),phone=coalesce(p_data->>'phone',phone),username=coalesce(p_data->>'username',username),country=coalesce(p_data->>'country',country),updated_at=now() where uid=u.uid;
  elsif p_action='preferences' then update public.users set preferences=p_data,updated_at=now() where uid=u.uid;
  elsif p_action='demo' then raise exception 'Use the practice trading API';
  elsif p_action='password' then
   if octet_length(p_data->>'password') not between 8 and 72 or not exists(select 1 from bb_private.credentials where uid=u.uid and crypt(p_data->>'current',password_hash)=password_hash) then raise exception 'Incorrect current password or invalid new password'; end if;
   update bb_private.credentials set password_hash=crypt(p_data->>'password',gen_salt('bf',10)) where uid=u.uid;
   delete from bb_private.sessions where uid=u.uid and token_hash<>encode(digest(p_token,'sha256'),'hex');
  elsif p_action='logout_all' then delete from bb_private.sessions where uid=u.uid;
  else delete from bb_private.sessions where token_hash=encode(digest(p_token,'sha256'),'hex'); end if;
  res:=jsonb_build_object('ok',true);
 elsif p_action in ('admin_adjust','admin_user','profit_module') then
  if not u.is_admin then raise exception 'Administrator access required' using errcode='42501'; end if;
  select * into target from public.users where uid=(p_data->>'uid')::integer for update;
  if not found then raise exception 'Account not found'; end if;
  if p_action='profit_module' then
   -- Dedicated administrator switch: while on, this account's settled trades always win.
   update public.users set profit_module=coalesce((p_data->>'enabled')::boolean,false),updated_at=now() where uid=target.uid returning * into updated;
   res:=bb_private.public_user(updated);
  elsif p_action='admin_adjust' then
   amt:=(p_data->>'amount')::numeric;
   if amt is null or amt::text in ('NaN','Infinity','-Infinity') or amt<0 or amt<>round(amt,8) or amt>1000000000000000 then raise exception 'Invalid amount'; end if;
   if length(trim(coalesce(p_data->>'reason','')))<3 then raise exception 'Enter a reason for the adjustment'; end if;
   if p_data->>'mode'='set' then
    if (p_data->>'expected')::numeric is distinct from target.cash_balance then raise exception 'Balance changed. Refresh and retry.' using errcode='40001'; end if;
    delta:=amt-target.cash_balance;
   elsif p_data->>'mode'='credit' then delta:=amt;
   elsif p_data->>'mode'='debit' then delta:=-amt;
   else raise exception 'Invalid adjustment mode'; end if;
   bal:=bb_private.move(target.uid,'USDT',delta,'admin:'||u.uid||':'||p_id,'admin_adjust: '||(p_data->>'reason'),u.uid);
   res:=jsonb_build_object('balance',bal);
  else
   if p_data ? 'expected_updated_at' and (p_data->>'expected_updated_at')::timestamptz is distinct from target.updated_at then raise exception 'User changed. Refresh and retry.' using errcode='40001'; end if;
   if p_data ? 'cash_balance' or p_data ? 'asset_balances' or p_data ? 'password' or p_data ? 'profit_module' then raise exception 'Use the dedicated balance or password action'; end if;
   if p_data ? 'email' and p_data->>'email' !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Invalid email'; end if;
   if p_data ? 'name' and length(trim(p_data->>'name')) not between 1 and 120 then raise exception 'Invalid name'; end if;
   if p_data ? 'kyc_status' and p_data->>'kyc_status' not in ('none','pending','approved','rejected') then raise exception 'Invalid KYC status'; end if;
   if target.uid=u.uid and (coalesce((p_data->>'is_admin')::boolean,true)=false or coalesce((p_data->>'is_deactivated')::boolean,false)) then raise exception 'Use another administrator to change your own access'; end if;
   update public.users set name=coalesce(p_data->>'name',name),email=coalesce(lower(trim(p_data->>'email')),email),is_admin=coalesce((p_data->>'is_admin')::boolean,is_admin),is_deactivated=coalesce((p_data->>'is_deactivated')::boolean,is_deactivated),kyc_status=coalesce(p_data->>'kyc_status',kyc_status),updated_at=now() where uid=target.uid returning * into updated;
   if updated.is_deactivated then delete from bb_private.sessions where uid=target.uid; end if;
   res:=bb_private.public_user(updated);
  end if;
 elsif p_action='transfer' then
  select * into target from public.users where users.uid=u.uid for update;
  coin:=p_data->>'coin'; amt:=bb_private.amount(p_data->>'amount');wallet:=p_data->>'from';
  if wallet not in ('spot','funding') or p_data->>'to' not in ('spot','funding') or wallet=p_data->>'to' then raise exception 'Select different valid wallets'; end if;
  perform bb_private.move(u.uid,coin,-amt,'transfer-out:'||u.uid||':'||p_id,'transfer',u.uid,wallet);
  perform bb_private.move(u.uid,coin,amt,'transfer-in:'||u.uid||':'||p_id,'transfer',u.uid,p_data->>'to');
  res:=jsonb_build_object('ok',true);
 elsif p_action in ('deposit_request','withdraw_request','loan_request') then
  select * into target from public.users where users.uid=u.uid for update;
  coin:=coalesce(p_data->>'coin','USDT'); amt:=bb_private.amount(coalesce(p_data->>'amount',p_data->>'borrowAmt'));
  if coin not in ('USDT','BTC','ETH','SOL','BNB','ADA','DOGE','XRP','DOT') then raise exception 'Unsupported coin'; end if;
  rid:=upper(split_part(p_action,'_',1))||'-'||u.uid||'-'||p_id;
  cid:=case p_action when 'deposit_request' then 'bb_deposit_requests' when 'withdraw_request' then 'bb_withdrawal_requests' else 'bb_loans' end;
  n:=p_data||jsonb_build_object('id',rid,'userId',u.uid::text,'userName',u.name,'userEmail',u.email,'status','pending','createdAt',ms,'time',ms,'amount',amt,'coin',coin);
  if p_action='withdraw_request' then
   if length(trim(coalesce(p_data->>'address','')))<8 then raise exception 'Recipient address required'; end if;
   fee:=case coin when 'USDT' then 1 when 'BTC' then 0.0001 when 'ETH' then 0.001 when 'SOL' then 0.005 when 'BNB' then 0.001 when 'ADA' then 1 when 'DOGE' then 5 when 'XRP' then 0.5 else 0.1 end;
   min_amt:=case coin when 'BTC' then 0.0001 when 'ETH' then 0.001 when 'SOL' then 0.01 when 'BNB' then 0.001 when 'DOT' then 0.1 else 1 end;
   if amt<min_amt then raise exception 'Below minimum withdrawal'; end if;
   perform bb_private.move(u.uid,coin,-(amt+fee),'withdraw-reserve:'||rid,'withdraw_reserve',u.uid);
   n:=n||jsonb_build_object('fee',fee,'reserved',true);
  elsif p_action='deposit_request' then
   if not p_data ? 'proof' then raise exception 'Proof of deposit required'; end if;
  else
   days:=(p_data->>'durationDays')::integer;
   rate:=case days when 7 then 5 when 30 then 7 when 90 then 9 when 180 then 12 when 365 then 15 else null end;
   if rate is null then raise exception 'Invalid loan term'; end if;
   n:=n||jsonb_build_object('borrowAmt',amt,'interestRate',rate);
  end if;
  insert into public.bb_records(collection,id,uid,payload) values(cid,rid,u.uid,n);
  res:=n;
 elsif p_action='resolve_request' then
  if not u.is_admin then raise exception 'Administrator access required' using errcode='42501'; end if;
  cid:=p_data->>'collection';rid:=p_data->>'id';action_status:=p_data->>'status';
  if cid not in ('bb_deposit_requests','bb_withdrawal_requests','bb_loans') then raise exception 'Invalid request collection'; end if;
  select * into rec from public.bb_records where collection=cid and id=rid;
  if rec.uid is null then raise exception 'Missing request owner'; end if;
  select * into target from public.users where uid=rec.uid for update;
  select * into rec from public.bb_records where collection=cid and id=rid for update;
  if rec.payload->>'status'=action_status then res:=rec.payload;
  else
   n:=rec.payload; coin:=coalesce(n->>'coin','USDT');amt:=bb_private.amount(coalesce(n->>'amount',n->>'borrowAmt'));
   if cid='bb_loans' and action_status='paid' and n->>'status'='active' then
    -- This is a recorded external repayment, not an extra debit from the wallet.
    if length(trim(coalesce(p_data->>'reference','')))<3 then raise exception 'Repayment reference required'; end if;
    n:=n||jsonb_build_object('paidAt',ms,'repaymentReference',p_data->>'reference');
   else
    if n->>'status' is distinct from 'pending' or action_status not in ('approved','rejected') then raise exception 'Request has already been processed'; end if;
    if cid='bb_deposit_requests' and action_status='approved' then
     -- Credit actual coin units. A separate priced conversion is required for USDT.
     perform bb_private.move(rec.uid,coin,amt,'deposit:'||rid,'deposit_approved',u.uid);
    elsif cid='bb_withdrawal_requests' then
     fee:=coalesce((n->>'fee')::numeric,0);
     if fee<0 then raise exception 'Invalid legacy withdrawal fee'; end if;
     if action_status='approved' then
      if length(trim(coalesce(p_data->>'reference','')))<8 then raise exception 'Payout transaction reference required'; end if;
      if not coalesce((n->>'reserved')::boolean,false) then perform bb_private.move(rec.uid,coin,-(amt+fee),'legacy-withdraw:'||rid,'withdraw_approved',u.uid); end if;
      n:=n||jsonb_build_object('payoutReference',p_data->>'reference');
     elsif coalesce((n->>'reserved')::boolean,false) then perform bb_private.move(rec.uid,coin,amt+fee,'withdraw-refund:'||rid,'withdraw_rejected',u.uid); end if;
    elsif cid='bb_loans' and action_status='approved' then
     perform bb_private.move(rec.uid,'USDT',amt,'loan:'||rid,'loan_approved',u.uid);action_status:='active';
    end if;
   end if;
   n:=n||jsonb_build_object('status',action_status,'resolvedAt',ms,'updatedAt',ms,'resolvedBy',u.uid);
   update public.bb_records set payload=n,version=version+1,updated_at=now() where collection=cid and id=rid;
   res:=n;
  end if;
 elsif p_action in ('quant_start','earn_start') then
  select * into target from public.users where users.uid=u.uid for update;
  amt:=bb_private.amount(p_data->>'amount');rid:=case p_action when 'quant_start' then 'Q-' else 'EP-' end||u.uid||'-'||p_id;
  if p_action='quant_start' then
   ky:=p_data->>'plan'; coin:='USDT';
   select x.days,x.rate,x.minimum into days,rate,min_amt from (values ('demo',1,0.75,10),('trial',7,0.55,100),('standard',30,0.85,1000),('professional',90,1.15,5000),('premium',180,1.5,10000)) x(plan,days,rate,minimum) where plan=ky;
   if days is null then raise exception 'Invalid plan'; end if;
   n:=jsonb_build_object('id',rid,'plan',ky,'planName','Accrual plan: '||ky,'rate',rate,'days',days,'amount',amt,'started',ms,'lastPayout',ms,'settledDays',0,'earned',0,'status','active','uid',u.uid::text,'userName',u.name,'userEmail',u.email);
  else
   coin:=p_data->>'coin';ky:=p_data->>'type'; days:=coalesce((p_data->>'days')::integer,0);
   if ky='flexible' then
    select x.rate,x.minimum into rate,min_amt from (values ('USDT',3.5,10),('BTC',1.5,0.001),('ETH',2,0.01),('SOL',2.8,0.1)) x(coin,rate,minimum) where x.coin=coin;
   elsif ky='locked' then
    rate:=case days when 30 then 6 when 60 then 7 when 90 then 8 when 180 then 10 when 365 then 12 else null end;
    min_amt:=case coin when 'USDT' then 100 when 'BTC' then 0.001 when 'ETH' then 0.01 when 'SOL' then 0.1 when 'BNB' then 0.1 else null end;
   elsif ky='defi' then
    select x.rate,x.minimum into rate,min_amt from (values ('USDT',8.5,50),('ETH',5.2,0.05),('SOL',6.5,1),('DAI',9,50)) x(coin,rate,minimum) where x.coin=coin;
   end if;
   if rate is null or min_amt is null then raise exception 'Invalid earn product'; end if;
   n:=jsonb_build_object('id',rid,'type',ky,'coin',coin,'amount',amt,'apy',rate,'days',days,'started',now(),'endDate',case when ky='locked' then now()+days*interval '1 day' else null end,'status','active','uid',u.uid::text,'userName',u.name,'userEmail',u.email);
  end if;
  if amt<min_amt then raise exception 'Amount below product minimum'; end if;
  perform bb_private.move(u.uid,coin,-amt,'start:'||rid,p_action,u.uid);
  insert into public.bb_orders(id,uid,kind,request_id,payload) values(rid,u.uid,case p_action when 'quant_start' then 'quant' else 'earn' end,p_id,n);
  res:=n;
 elsif p_action in ('trade_close','earn_close') then
  rid:=p_data->>'id';
  select * into ord from public.bb_orders where id=rid;
  if ord.uid is distinct from u.uid then raise exception 'Order belongs to another account'; end if;
  select * into target from public.users where users.uid=u.uid for update;
  select * into ord from public.bb_orders where id=rid for update;
  n:=ord.payload;
  if lower(n->>'status')<>'active' then res:=n;
  else
   if p_action='trade_close' then
    if ord.kind<>'trade' then raise exception 'Wrong order type'; end if;
    if ms>=(n->>'expiresAt')::bigint then raise exception 'Order expired; awaiting market settlement'; end if;
    amt:=(n->>'amount')::numeric;bal:=round(amt*0.5,8);coin:='USDT';
    n:=n||jsonb_build_object('status','Closed','refund',bal,'payout',bal,'profit',bal-amt,'resolvedTime',ms);
   else
    if ord.kind<>'earn' then raise exception 'Wrong order type'; end if;
    if n->>'type'='locked' and now()<(n->>'endDate')::timestamptz then raise exception 'Position is locked until maturity'; end if;
    amt:=(n->>'amount')::numeric;coin:=n->>'coin';
    rate:=round(amt*(n->>'apy')::numeric/100*greatest(extract(epoch from (least(now(),coalesce((n->>'endDate')::timestamptz,now()))-(n->>'started')::timestamptz)),0)/31536000,8);
    bal:=amt+rate;n:=n||jsonb_build_object('status','completed','earned',rate,'payout',bal,'completedAt',ms);
   end if;
   perform bb_private.move(u.uid,coin,bal,'close:'||rid,p_action,u.uid);
   update public.bb_orders set payload=n,version=version+1,updated_at=now() where id=rid;
   res:=n;
  end if;
 else raise exception 'Unknown action'; end if;
 perform bb_private.audit(u.uid,coalesce(target.uid,rec.uid,u.uid),p_action,coalesce(cid,'account'),coalesce(rid,p_id),jsonb_build_object('requestId',p_id));
 insert into bb_private.requests(uid,id,action,input,result) values(u.uid,p_id,p_action,jsonb_build_object('hash',encode(digest(p_data::text,'sha256'),'hex')),res);
 return res;
end $$;

-- Only the trusted Edge Function may supply quotes or settle trades.
create or replace function public.bb_place_trade(p_token text,p_request_id text,p_pair text,p_direction text,p_amount numeric,p_duration integer,p_price numeric,p_quote_at bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users; old public.bb_orders; n jsonb; amt numeric; rate numeric; rid text; ms bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 u:=bb_private.actor(p_token);
 select * into u from public.users where users.uid=u.uid for update;
 select * into old from public.bb_orders where uid=u.uid and request_id=p_request_id;
 if found then
  if old.kind<>'trade' or old.payload->>'pair'<>p_pair or old.payload->>'dir'<>p_direction or (old.payload->>'amount')::numeric<>p_amount or (old.payload->>'dur')::integer<>p_duration then raise exception 'Request ID conflict'; end if;
  return old.payload;
 end if;
 -- Settlement health is never a placement gate: an authenticated client can
 -- always open a trade, and the scheduler (or an authenticated settle call)
 -- settles every expired order from the market feed.
 amt:=bb_private.amount(p_amount::text);
 if coalesce(p_request_id,'') !~ '^[A-Za-z0-9_-]{12,180}$' or coalesce(p_pair,'') not in ('BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','ADA/USDT','DOGE/USDT','DOT/USDT','AVAX/USDT','LINK/USDT','UNI/USDT') or coalesce(p_direction,'') not in ('UP','DOWN') then raise exception 'Unsupported trade'; end if;
 if p_price is null or p_price<=0 or p_price::text in ('NaN','Infinity','-Infinity') or p_quote_at is null or abs(ms-p_quote_at)>15000 then raise exception 'Market quote is invalid or stale'; end if;
 rate:=case p_duration when 15 then 10 when 30 then 15 when 60 then 20 when 300 then 30 when 900 then 40 when 1800 then 50 when 3600 then 60 when 7200 then 70 when 14400 then 80 when 43200 then 90 when 86400 then 100 else null end;
 if rate is null then raise exception 'Invalid duration'; end if;
 rid:='T-'||u.uid||'-'||p_request_id;
 perform bb_private.move(u.uid,'USDT',-amt,'trade-start:'||rid,'trade_stake',u.uid);
 n:=jsonb_build_object('id',rid,'uid',u.uid::text,'pair',p_pair,'dir',p_direction,'side',case p_direction when 'UP' then 'Buy' else 'Sell' end,'amt',amt,'amount',amt,'dur',p_duration,'profitPct',rate,'potentialProfit',round(amt*rate/100,8),'profit',0,'price',p_price,'entryPrice',p_price,'entryQuoteAt',p_quote_at,'time',ms,'startTime',ms,'expiresAt',ms+p_duration::bigint*1000,'status','Active','source','real','fee',0);
 insert into public.bb_orders(id,uid,kind,request_id,payload) values(rid,u.uid,'trade',p_request_id,n);
 perform bb_private.audit(u.uid,u.uid,'trade.placed','orders',rid,jsonb_build_object('requestId',p_request_id,'quote',p_price));
 return n;
end $$;
create or replace function public.bb_due_trades() returns jsonb
language sql security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(payload),'[]') from (select payload from public.bb_orders where kind='trade' and payload->>'status'='Active' and (payload->>'expiresAt')::bigint+1000<=extract(epoch from clock_timestamp())*1000 order by (payload->>'expiresAt')::bigint limit 100) q
$$;
create or replace function public.bb_settle_trade(p_id text,p_price numeric,p_candle_at bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.bb_orders; u public.users; n jsonb; amt numeric; gain numeric; payout numeric; status text; ms bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; expected bigint;
begin
 select * into o from public.bb_orders where id=p_id;
 if o.id is null or o.kind<>'trade' then raise exception 'Trade not found'; end if;
 select * into u from public.users where uid=o.uid for update;
 select * into o from public.bb_orders where id=p_id for update;
 n:=o.payload;
 if n->>'status'<>'Active' then return n; end if;
 expected:=floor((n->>'expiresAt')::numeric/1000)::bigint*1000;
 if ms<expected+1000 or p_candle_at is distinct from expected or p_price is null or p_price<=0 or p_price::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid or premature settlement quote'; end if;
 amt:=(n->>'amount')::numeric;
 if p_price=(n->>'entryPrice')::numeric then status:='Draw';gain:=0;
 elsif ((p_price>(n->>'entryPrice')::numeric)=(n->>'dir'='UP')) then status:='Won';gain:=(n->>'potentialProfit')::numeric;
 else status:='Lost';gain:=-(n->>'potentialProfit')::numeric; end if;
 -- Administrator profit module: this account's trades always win while it is on.
 if u.profit_module then status:='Won';gain:=(n->>'potentialProfit')::numeric; end if;
 payout:=round(amt+gain,8);
 perform bb_private.move(o.uid,'USDT',payout,'trade-settle:'||p_id,'trade_'||lower(status));
 n:=n||jsonb_build_object('status',status,'exitPrice',p_price,'exitQuoteAt',p_candle_at,'profit',gain,'payout',payout,'resolvedTime',ms);
 update public.bb_orders set payload=n,version=version+1,updated_at=now() where id=p_id;
 perform bb_private.audit(null,o.uid,'trade.settled','orders',p_id,jsonb_build_object('payout',payout,'profit',gain,'price',p_price));
 return n;
end $$;
create or replace function public.bb_convert(p_token text,p_id text,p_from text,p_to text,p_amount numeric,p_rate numeric,p_quote_at bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users; old bb_private.requests; inp jsonb; res jsonb; amt numeric; received numeric; ms bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 u:=bb_private.actor(p_token);select * into u from public.users where users.uid=u.uid for update;
 inp:=jsonb_build_object('from',p_from,'to',p_to,'amount',p_amount);
 select * into old from bb_private.requests where uid=u.uid and id=p_id;
 if found then if old.action<>'convert' or old.input<>inp then raise exception 'Request ID conflict'; end if;return old.result;end if;
 if coalesce(p_id,'') !~ '^[A-Za-z0-9_-]{12,180}$' or p_from=p_to or p_rate is null or p_rate<=0 or p_rate::text in ('NaN','Infinity','-Infinity') or p_quote_at is null or abs(ms-p_quote_at)>15000 then raise exception 'Invalid or stale conversion'; end if;
 if coalesce(p_from,'') not in ('USDT','BTC','ETH','SOL','BNB','XRP','ADA','DOGE','DOT') or coalesce(p_to,'') not in ('USDT','BTC','ETH','SOL','BNB','XRP','ADA','DOGE','DOT') then raise exception 'Unsupported coin'; end if;
 amt:=bb_private.amount(p_amount::text);received:=round(amt*p_rate,8);
 if received<=0 then raise exception 'Amount below conversion precision'; end if;
 perform bb_private.move(u.uid,p_from,-amt,'convert-out:'||u.uid||':'||p_id,'conversion',u.uid);
 perform bb_private.move(u.uid,p_to,received,'convert-in:'||u.uid||':'||p_id,'conversion',u.uid);
 res:=jsonb_build_object('received',received,'rate',p_rate);
 insert into bb_private.requests(uid,id,action,input,result) values(u.uid,p_id,'convert',inp,res);
 return res;
end $$;
create or replace function public.bb_settle_accruals() returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.bb_orders; snapshot record; n jsonb; u public.users; ms bigint:=(extract(epoch from now())*1000)::bigint; due integer; done integer; days integer; profit numeric; earned numeric; credit numeric; count_done integer:=0; coin text;
begin
 for snapshot in select id,uid from public.bb_orders where kind in ('quant','earn') and payload->>'status'='active' order by uid,id loop
  -- Consistent order prevents deadlocks with starts, closes, and admin actions.
  select * into u from public.users where uid=snapshot.uid for update;
  select * into o from public.bb_orders where id=snapshot.id for update;
  n:=o.payload;if n->>'status'<>'active' then continue; end if;
  if o.kind='quant' then
   days:=(n->>'days')::integer; done:=coalesce((n->>'settledDays')::integer,0);
   due:=least(days,greatest(0,floor((ms-(n->>'started')::bigint)::numeric/86400000)::integer));
   if due<=done then continue; end if;
   earned:=round((n->>'amount')::numeric*(n->>'rate')::numeric/100*due,8);
   profit:=earned-coalesce((n->>'earned')::numeric,0);
   credit:=profit+case when due=days then (n->>'amount')::numeric else 0 end;coin:='USDT';
   n:=n||jsonb_build_object('settledDays',due,'lastPayout',(n->>'started')::bigint+due::bigint*86400000,'earned',earned,'updatedAt',ms);
   if due=days then n:=n||jsonb_build_object('status','completed','completedAt',ms); end if;
   perform bb_private.move(o.uid,coin,credit,'quant:'||o.id||':'||due,'quant_payout');
  else
   if n->>'type'<>'locked' or now()<(n->>'endDate')::timestamptz then continue; end if;
   profit:=round((n->>'amount')::numeric*(n->>'apy')::numeric/100*(n->>'days')::numeric/365,8);coin:=n->>'coin';
   credit:=(n->>'amount')::numeric+profit;
   perform bb_private.move(o.uid,coin,credit,'close:'||o.id,'earn_close');
   n:=n||jsonb_build_object('status','completed','earned',profit,'payout',credit,'completedAt',ms);
  end if;
  update public.bb_orders set payload=n,version=version+1,updated_at=now() where id=o.id;
  perform bb_private.audit(null,o.uid,'order.accrual','orders',o.id,jsonb_build_object('credit',credit,'coin',coin));count_done:=count_done+1;
 end loop;
 perform public.bb_settle_demo();
 return count_done;
end $$;
create or replace function public.bb_tick(p_token text) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
begin perform bb_private.actor(p_token); return public.bb_settle_accruals();end $$;
create or replace function public.bb_engine_status(p_error text,p_settled integer) returns void
language sql security definer set search_path=pg_catalog,public as $$
 insert into public.bb_engine_health(id,last_started,last_finished,last_error,settled) values(true,now(),now(),p_error,p_settled)
 on conflict(id) do update set last_started=now(),last_finished=now(),last_error=p_error,settled=p_settled
$$;

-- Practice funds use a separate server balance; they never touch bb_ledger.
create or replace function bb_private.settle_demo_for(p_uid integer) returns integer
language plpgsql set search_path=pg_catalog,public as $$
declare u public.users; positions jsonb; n jsonb; i integer; b numeric; gain numeric; count_done integer:=0; ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 select * into u from public.users where uid=p_uid for update;
 positions:=coalesce(u.demo_positions,'[]');
 b:=case when jsonb_typeof(u.demo_balance)='number' then (u.demo_balance#>>'{}')::numeric else 100000 end;
 for i in 0..jsonb_array_length(positions)-1 loop
  n:=positions->i;
  if n->>'status'='Active' and (n->>'expiresAt')::bigint<=ms then
   gain:=(n->>'potentialProfit')::numeric*case when u.profit_module then 1 when random()>=0.5 then 1 else -1 end;
   b:=b+(n->>'amount')::numeric+gain;
   n:=n||jsonb_build_object('status',case when gain>=0 then 'Won' else 'Lost' end,'profit',gain,'exitPrice',n->'entryPrice','payout',(n->>'amount')::numeric+gain,'resolvedTime',ms);
   positions:=jsonb_set(positions,array[i::text],n);
   update public.bb_records set payload=n,version=version+1,updated_at=now() where collection='bb_demo_trades_hist' and id=n->>'id';
   count_done:=count_done+1;
   perform bb_private.audit(null,p_uid,'demo.settled','demo',n->>'id',jsonb_build_object('profit',gain));
  end if;
 end loop;
 if count_done>0 then update public.users set demo_balance=to_jsonb(b),demo_positions=positions where uid=p_uid; end if;
 return count_done;
end $$;
create or replace function public.bb_settle_demo() returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r record;
begin
 for r in select uid from public.users where demo_positions @> '[{"status":"Active"}]' order by uid loop perform bb_private.settle_demo_for(r.uid);end loop;
end $$;
create or replace function public.bb_demo(p_token text,p_action text,p_id text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare u public.users; positions jsonb; n jsonb; old bb_private.requests;b numeric;amt numeric;rate numeric;dur integer;i integer; found_id boolean:=false; ms bigint:=(extract(epoch from now())*1000)::bigint;res jsonb;rid text;
begin
 u:=bb_private.actor(p_token);
 select * into u from public.users where users.uid=u.uid for update;
 select * into old from bb_private.requests where uid=u.uid and id=p_id;
 if found then if old.action<>'demo.'||p_action or old.input<>p_data then raise exception 'Request ID conflict';end if;return old.result;end if;
 if coalesce(p_id,'') !~ '^[A-Za-z0-9_-]{12,180}$' then raise exception 'Unique request ID required';end if;
 perform bb_private.settle_demo_for(u.uid);
 select * into u from public.users where users.uid=u.uid;
 b:=case when jsonb_typeof(u.demo_balance)='number' then (u.demo_balance#>>'{}')::numeric else 100000 end;
 positions:=coalesce(u.demo_positions,'[]');
 if p_action='start' then
  amt:=bb_private.amount(p_data->>'amount');dur:=(p_data->>'duration')::int;
  rate:=case dur when 15 then 10 when 30 then 15 when 60 then 20 when 300 then 30 when 900 then 40 when 1800 then 50 when 3600 then 60 when 7200 then 70 when 14400 then 80 when 43200 then 90 when 86400 then 100 else null end;
  if rate is null or coalesce(p_data->>'direction','') not in ('UP','DOWN') or coalesce(p_data->>'pair','') !~ '^[A-Z0-9]{2,12}/[A-Z0-9]{2,12}$' then raise exception 'Invalid practice trade';end if;
  if amt>b then raise exception 'Insufficient demo funds';end if;
  b:=b-amt;rid:='D-'||u.uid||'-'||p_id;
  n:=jsonb_build_object('id',rid,'uid',u.uid::text,'userId',u.uid::text,'pair',p_data->>'pair','dir',p_data->>'direction','side',case p_data->>'direction' when 'UP' then 'Buy' else 'Sell' end,'amount',amt,'amt',amt,'dur',dur,'potentialProfit',round(amt*rate/100,8),'profit',0,'entryPrice',bb_private.amount(p_data->>'price'),'price',bb_private.amount(p_data->>'price'),'time',ms,'startTime',ms,'expiresAt',ms+dur::bigint*1000,'status','Active','source','demo');
  positions:=positions||jsonb_build_array(n);
  insert into public.bb_records(collection,id,uid,payload) values('bb_demo_trades_hist',rid,u.uid,n);
  res:=n;
 elsif p_action='close' then
  for i in 0..jsonb_array_length(positions)-1 loop
   n:=positions->i;if n->>'id'<>p_data->>'id' then continue;end if;found_id:=true;
   if n->>'status'='Active' then
    amt:=round((n->>'amount')::numeric/2,8);b:=b+amt;
    n:=n||jsonb_build_object('status','Closed','profit',amt-(n->>'amount')::numeric,'payout',amt,'refund',amt,'resolvedTime',ms);
    positions:=jsonb_set(positions,array[i::text],n);
    update public.bb_records set payload=n,version=version+1,updated_at=now() where collection='bb_demo_trades_hist' and id=n->>'id';
   end if;res:=n;exit;
  end loop;
  if not found_id then raise exception 'Practice order not found';end if;
 elsif p_action='reset' then
  update public.bb_records set payload=payload||'{"status":"Reset"}',version=version+1,updated_at=now() where collection='bb_demo_trades_hist' and uid=u.uid and payload->>'status'='Active';
  b:=100000;positions:='[]';res:=jsonb_build_object('balance',b);
 else raise exception 'Unknown demo action';end if;
 update public.users set demo_balance=to_jsonb(b),demo_positions=positions where uid=u.uid;
 insert into bb_private.requests(uid,id,action,input,result) values(u.uid,p_id,'demo.'||p_action,p_data,res);
 perform bb_private.audit(u.uid,u.uid,'demo.'||p_action,'demo',p_id);
 return res;
end $$;

-- Remove unrestricted legacy money RPCs and browser table writes/reads.
-- API roles can execute only explicitly listed functions.
do $permissions$
declare r record;
begin
 for r in select tablename from pg_tables where schemaname='public' and tablename in ('users','app_collections','user_balances','trades','demo_trades','support_tickets','support_messages','deposit_addresses','deposit_requests','withdrawal_requests','loans','kyc_submissions','earn_positions','balance_history','bb_records','bb_orders','bb_ledger','bb_activity','bb_migration_review','bb_engine_health') loop
  execute format('revoke all on table public.%I from public,anon,authenticated',r.tablename);
  execute format('alter table public.%I enable row level security',r.tablename);
 end loop;
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','bb_private') and (p.proname like 'bb_%' or n.nspname='bb_private' or p.proname in ('credit_user','adjust_user_asset','settle_ai_quants')) loop
  execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 end loop;
end $permissions$;
grant execute on function public.bb_register(text,text,text),public.bb_login(text,text),public.bb_read(text,text),public.bb_save_record(text,text,jsonb),public.bb_action(text,text,text,jsonb),public.bb_tick(text),public.bb_demo(text,text,text,jsonb) to anon,authenticated;
grant execute on function public.bb_place_trade(text,text,text,text,numeric,integer,numeric,bigint),public.bb_due_trades(),public.bb_settle_trade(text,numeric,bigint),public.bb_convert(text,text,text,text,numeric,numeric,bigint),public.bb_settle_accruals(),public.bb_engine_status(text,integer),public.bb_settle_demo() to service_role;
-- Do not leave the old schedule running against the archived JSON collections.
do $old_cron$
begin
 if to_regclass('cron.job') is not null then
  execute $q$select cron.unschedule(jobid) from cron.job where jobname='bitbase-settle-aiquants'$q$;
 end if;
end $old_cron$;
notify pgrst,'reload schema';
commit;
