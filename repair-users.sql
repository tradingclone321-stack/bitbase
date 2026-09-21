-- BitBase: repair the EXISTING user registry. Run in Supabase SQL Editor.
-- Preserves users, balances, passwords, grants, and all RLS policies.
-- Does not import local-only accounts or copy Supabase Auth users.
begin;

do $check$
begin
  if to_regclass('public.users') is null then
    raise exception 'public.users is missing. Use schema.sql for a fresh installation.';
  end if;
end
$check$;

-- CREATE TABLE IF NOT EXISTS in the original setup never upgraded old tables.
alter table public.users add column if not exists preferences jsonb not null default '{}'::jsonb;
alter table public.users add column if not exists demo_balance jsonb;
alter table public.users add column if not exists demo_positions jsonb;
alter table public.users add column if not exists created_at timestamptz not null default now();

-- Required for race-safe registration. If duplicates exist, the transaction
-- fails without deleting or merging them; review the duplicates first.
create unique index if not exists users_uid_key on public.users (uid);
create unique index if not exists users_email_key on public.users (email);

do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables)
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'users'
     ) then
    alter publication supabase_realtime add table public.users;
  end if;
end
$realtime$;

notify pgrst, 'reload schema';
commit;

-- Read-only confirmation (no personal data).
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'users'
  and column_name in ('uid', 'email', 'preferences', 'demo_balance', 'demo_positions', 'created_at')
order by column_name;
