const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const repair = fs.readFileSync(path.join(root, 'repair-users.sql'), 'utf8');
(async () => {
  const db = new PGlite();
  try {
    await db.exec('create publication supabase_realtime;');
    await db.exec(schema);
    await db.exec(schema);
    console.log('PASS: fresh schema executes twice without duplicate constraint, policy, or publication errors');
    await db.exec("insert into public.users (uid,name,email,password,cash_balance,is_admin,created_at) values (123456,'Test user','fixture@example.test','fixture-password',456.78,true,'2025-01-01');");
    const before = (await db.query('select uid,name,email,password,cash_balance,is_admin,created_at from public.users')).rows;
    const policies = (await db.query("select policyname,qual,with_check from pg_policies where tablename='users'")).rows;
    await db.exec('alter table public.users drop column preferences, drop column demo_balance, drop column demo_positions;');
    await db.exec(repair);
    await db.exec(repair);
    assert.deepEqual((await db.query('select uid,name,email,password,cash_balance,is_admin,created_at from public.users')).rows, before);
    assert.deepEqual((await db.query("select policyname,qual,with_check from pg_policies where tablename='users'")).rows, policies);
    assert.deepEqual((await db.query('select preferences,demo_balance,demo_positions from public.users')).rows, [{ preferences: {}, demo_balance: null, demo_positions: null }]);
    assert.equal((await db.query("select count(*)::int as total from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='users'")).rows[0].total, 1);
    console.log('PASS: repair executes twice, restores missing columns, and preserves user data and access policies');
  } finally { await db.close(); }
  const duplicates = new PGlite();
  try {
    await duplicates.exec("create table users(uid integer,email text); insert into users values (123456,'first@example.test'),(123456,'second@example.test');");
    await assert.rejects(duplicates.exec(repair), error => error.code === '23505');
    await duplicates.exec('rollback;');
    assert.equal((await duplicates.query('select count(*)::int as total from users')).rows[0].total, 2);
    assert.equal((await duplicates.query("select count(*)::int as total from information_schema.columns where table_schema='public' and table_name='users' and column_name='preferences'")).rows[0].total, 0);
    console.log('PASS: duplicate legacy UIDs abort the repair transaction without altering or deleting accounts');
  } finally { await duplicates.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
