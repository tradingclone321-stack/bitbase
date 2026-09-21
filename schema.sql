-- BitBase - Supabase schema (run in Supabase SQL Editor)
-- Matches supabase_tables.csv
-- Legacy demo schema: RLS is enabled with permissive demo policies.
-- Use Supabase Auth and restricted policies before handling real accounts.
-- Existing installations: use repair-users.sql, which preserves permissions.

-- ============================================================
-- users (central user registry - fixes "admin sees only one user")
-- ============================================================
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  uid integer not null,
  name text not null default '',
  email text not null default '',
  password text not null default '',
  username text,
  phone text,
  phone_verified boolean not null default false,
  country text,
  cash_balance numeric not null default 0,
  kyc_status text not null default 'none',
  is_deactivated boolean not null default false,
  is_admin boolean not null default false,
  profit_module boolean not null default false,
  asset_balances jsonb not null default '{}'::jsonb,
  preferences jsonb not null default '{}'::jsonb,
  demo_balance jsonb,
  demo_positions jsonb,
  created_at timestamptz not null default now()
);
-- CREATE TABLE IF NOT EXISTS does not add fields to an older table.
alter table public.users add column if not exists preferences jsonb not null default '{}'::jsonb;
alter table public.users add column if not exists demo_balance jsonb;
alter table public.users add column if not exists demo_positions jsonb;
alter table public.users add column if not exists created_at timestamptz not null default now();
-- Existing constraints already own these index names, so reruns are harmless.
create unique index if not exists users_uid_key on public.users (uid);
create unique index if not exists users_email_key on public.users (email);
create index if not exists users_uid_idx on public.users (uid);
create index if not exists users_email_idx on public.users (email);

-- ============================================================
-- app_collections - generic key/value store for all other data
-- (trades, deposits, withdrawals, loans, kyc, earn, tickets,
--  balance history, deposit addresses). Payload is the exact
-- JSON array the app already keeps in localStorage.
-- ============================================================
create table if not exists public.app_collections (
  key text primary key,
  payload jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Optional normalized tables (from supabase_tables.csv).
-- The sync layer currently uses users + app_collections,
-- so these are available if you migrate to strict columns later.
-- ============================================================
create table if not exists public.user_balances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  coin text not null,
  balance numeric not null default 0,
  avg_price numeric,
  updated_at timestamptz not null default now()
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  trade_id text,
  symbol text,
  side text,
  amount numeric,
  entry_price numeric,
  exit_price numeric,
  fee numeric not null default 0,
  profit numeric not null default 0,
  status text not null default 'active',
  source text not null default 'real',
  start_time timestamptz,
  resolved_time timestamptz,
  force_result text
);

create table if not exists public.demo_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  demo_id text,
  symbol text,
  side text,
  amount numeric,
  entry_price numeric,
  exit_price numeric,
  profit numeric not null default 0,
  start_time timestamptz,
  status text not null default 'active'
);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_id text,
  user_id uuid references public.users(id) on delete set null,
  user_name text,
  user_email text,
  subject text,
  status text not null default 'open',
  created_at timestamptz,
  resolved_at timestamptz
);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.support_tickets(id) on delete cascade,
  sender text,
  body text,
  attachment_name text,
  attachment_type text,
  attachment_url text,
  created_at timestamptz
);

create table if not exists public.deposit_addresses (
  id uuid primary key default gen_random_uuid(),
  coin text,
  network text default '',
  address text,
  qr_url text,
  is_active boolean not null default true
);

create table if not exists public.deposit_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  request_id text,
  coin text,
  amount numeric,
  network text,
  address text,
  proof_name text,
  proof_type text,
  proof_url text,
  status text not null default 'pending',
  created_at timestamptz,
  resolved_at timestamptz
);

create table if not exists public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  request_id text,
  coin text,
  amount numeric,
  fee numeric not null default 0,
  network text,
  address text,
  status text not null default 'pending',
  created_at timestamptz,
  resolved_at timestamptz
);

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  loan_id text,
  borrow_amount numeric,
  duration_days integer,
  interest_rate numeric,
  proof_name text,
  status text not null default 'pending',
  created_at timestamptz,
  approved_at timestamptz,
  paid_at timestamptz
);

create table if not exists public.kyc_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  submission_id text,
  first_name text,
  last_name text,
  dob date,
  nationality text,
  address text,
  city text,
  postal_code text,
  doc_type text,
  front_doc_url text,
  back_doc_url text,
  status text not null default 'pending',
  created_at timestamptz,
  resolved_at timestamptz
);

create table if not exists public.earn_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  type text,
  coin text,
  amount numeric,
  apy numeric,
  protocol text,
  duration_days integer,
  started_at timestamptz,
  end_date timestamptz
);

create table if not exists public.balance_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  new_balance numeric,
  reason text,
  created_at timestamptz
);

-- ============================================================
-- Realtime (WebSocket) - lets admin/users receive chat messages
-- instantly instead of waiting for the next poll.
-- ============================================================
do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_collections') then
      alter publication supabase_realtime add table public.app_collections;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'users') then
      alter publication supabase_realtime add table public.users;
    end if;
  end if;
end
$realtime$;

-- ============================================================
-- RLS (permissive legacy demo policies; fresh demo installs only)
-- ============================================================
alter table public.users enable row level security;
alter table public.app_collections enable row level security;
do $policies$
begin
  -- Do not overwrite an installation that already has its own policies.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'users') then
    create policy "public access" on public.users for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_collections') then
    create policy "public access" on public.app_collections for all using (true) with check (true);
  end if;
end
$policies$;
notify pgrst, 'reload schema';
