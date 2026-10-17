-- READ ONLY. Run in Supabase SQL Editor as the project owner.
-- No user balances, permissions, or administrator roles are changed.
select current_database() as database_name,
       to_regprocedure('public.bb_read(text,text)') is not null as admin_read_api_installed,
       to_regprocedure('public.bb_login(text,text)') is not null as account_login_api_installed,
       has_schema_privilege('anon','public','USAGE') as api_can_use_public_schema;

-- Expect bb_read and bb_login with security_definer=true and api_can_execute=true.
select p.proname as function_name,p.prosecdef as security_definer,
       has_function_privilege('anon',p.oid,'EXECUTE') as api_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('bb_read','bb_login');

-- Direct table access is intentionally false. Do not enable it to fix the page.
select has_table_privilege('anon','public.users','SELECT') as direct_public_user_reads,
       has_table_privilege('anon','public.users','UPDATE') as direct_public_user_updates;

select count(*) as registered_users,
       count(*) filter(where is_admin and not is_deactivated) as active_admin_accounts
from public.users;

-- Verify the UID/email of your own account before assigning any administrator role.
-- Passwords and session tokens are deliberately omitted.
select uid,name,email,is_admin,is_deactivated
from public.users where is_admin order by uid;
