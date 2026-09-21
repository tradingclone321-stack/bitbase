/* Isolated browser regression test. Every network request is intercepted;
   no production database is contacted or changed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sdkPath = process.env.SUPABASE_TEST_SDK || path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js');
const sdk = fs.readFileSync(sdkPath, 'utf8');
const base = 'http://bitbase.local';
const state = { rows: [], readError: null, writeError: null, delay: 0, cap: 250, inserts: [], reads: 0 };
const pageErrors = [];
const contexts = [];
function seed(uid, name, createdAt) {
  return { uid, name, email: `user${uid}@example.test`, password: 'test-password',
    cash_balance: 170, asset_balances: {}, kyc_status: 'none', is_admin: false,
    is_deactivated: false, profit_module: false, created_at: createdAt };
}
function project(row, columns) {
  if (!columns || columns === '*') return { ...row };
  return Object.fromEntries(columns.split(',').map(k => [k, row[k] ?? null]));
}
async function routeRequest(route) {
  const request = route.request();
  const url = new URL(request.url());
  const json = (body, status = 200, extra = {}) => route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...extra }, body: JSON.stringify(body) });
  if (url.hostname === 'bitbase.local') {
    if (url.pathname === '/supabase-config.js') return route.fulfill({ contentType: 'text/javascript',
      body: "var SUPABASE_URL='https://bitbase.test';var SUPABASE_ANON_KEY='isolated-test-key';" });
    if (url.pathname === '/dashboard.html') return route.fulfill({ contentType: 'text/html', body: '<h1>Confirmed registration</h1>' });
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Missing file' });
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
  }
  if (url.hostname === 'bitbase.test') {
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] || '*' } });
    if (url.pathname === '/rest/v1/users') {
      const columns = url.searchParams.get('select');
      if (request.method() === 'POST') {
        const row = request.postDataJSON();
        state.inserts.push(row);
        if (state.delay) await new Promise(r => setTimeout(r, state.delay));
        if (state.writeError) return json(state.writeError, 400);
        const conflict = state.rows.find(r => r.email === row.email || r.uid === row.uid);
        if (conflict) return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409);
        const saved = { ...row, profit_module: false, created_at: new Date().toISOString() };
        state.rows.push(saved);
        return json(project(saved, columns), 201);
      }
      if (request.method() !== 'GET') throw new Error('Unexpected mutation: ' + request.method());
      state.reads++;
      if (state.readError) return json(state.readError, 400);
      let rows = [...state.rows];
      for (const field of ['uid', 'email']) {
        const filter = url.searchParams.get(field);
        if (filter?.startsWith('eq.')) rows = rows.filter(r => String(r[field]) === filter.slice(3));
      }
      if (url.searchParams.get('order')) rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.uid - a.uid);
      const total = rows.length;
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || 1000), state.cap);
      rows = rows.slice(offset, offset + limit).map(r => project(r, columns));
      const singular = (request.headers().accept || '').includes('vnd.pgrst.object');
      return json(singular ? rows[0] : rows, 200, { 'content-range': `${offset}-${offset + rows.length - 1}/${total}` });
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json({ settledOrders: 0 });
    if (url.pathname === '/rest/v1/app_collections') {
      const singular = (request.headers().accept || '').includes('vnd.pgrst.object');
      return json(singular ? { payload: null } : []);
    }
    return json({});
  }
  if (url.href.includes('@supabase/supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: sdk });
  if (url.hostname === 'cdn.tailwindcss.com') return route.fulfill({ contentType: 'text/javascript', body:
    "window.tailwind={};let s=document.createElement('style');s.textContent='.hidden{display:none!important}';document.head.appendChild(s);" });
  if (url.href.includes('lucide')) return route.fulfill({ contentType: 'text/javascript', body: 'window.lucide={createIcons:function(){}};' });
  if (url.pathname.includes('ticker')) return json([]);
  return route.fulfill({ status: 200, body: '' });
}
async function context(browser, values = {}) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  await ctx.route('**/*', routeRequest);
  await ctx.routeWebSocket('**/*', socket => socket.close());
  await ctx.addInitScript(values => { if (location.origin !== 'http://bitbase.local') return; if (!sessionStorage.getItem('__test_seeded')) { for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v); sessionStorage.setItem('__test_seeded', '1'); } }, values);
  ctx.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  return ctx;
}
async function fill(page, email, name = 'New browser user') {
  await page.fill('#fullName', name);
  await page.fill('#email', email);
  await page.fill('#password', 'test-password');
  await page.fill('#confirm-password', 'test-password');
  await page.selectOption('#country', 'us');
  await page.check('#terms');
}
async function registerPage(browser, values) {
  const ctx = await context(browser, values);
  const page = await ctx.newPage();
  await page.goto(base + '/register.html');
  return page;
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox'] });
  const results = [];
  try {
    state.rows = [seed(100001, 'Existing user', '2026-01-01T00:00:00Z')];
    const adminContext = await context(browser, { bb_admin_logged_in: '1' });
    const admin = await adminContext.newPage();
    await admin.goto(base + '/admin.html');
    await admin.evaluate(() => switchTab('users'));
    await admin.waitForFunction(() => document.getElementById('usersSyncText').textContent.includes('1 users loaded live'));
    const signup = await registerPage(browser, { bb_preferences: '{"theme":"light"}', bb_demo_trades_bal: '{"USDT":50000}', bb_kyc_status: 'approved' });
    state.delay = 400;
    await fill(signup, 'new@example.test', '<img src=x onerror="window.nameInjected=true">');
    await signup.click('#submitBtn');
    assert.equal(await signup.locator('#submitBtn').isDisabled(), true);
    assert.equal(await signup.evaluate(() => localStorage.getItem('bb_uid')), null);
    assert.equal(await signup.locator('#submitSuccess').isVisible(), false);
    await signup.waitForURL('**/dashboard.html');
    state.delay = 0;
    const inserted = state.inserts.at(-1);
    assert.equal(inserted.is_admin, false);
    assert.equal(inserted.kyc_status, 'none');
    assert.equal(inserted.cash_balance, 0);
    assert.equal('preferences' in inserted, false);
    assert.equal('demo_balance' in inserted, false);
    // A separate browser has no registration localStorage. Polling must find it.
    await admin.waitForFunction(() => document.getElementById('usersBody').textContent.includes('new@example.test'), null, { timeout: 10000 });
    assert.match(await admin.locator('#usersBody tr').first().innerText(), /new@example.test/);
    assert.equal(await admin.evaluate(() => Boolean(window.nameInjected)), false);
    assert.equal(await signup.evaluate(() => localStorage.getItem('bb_kyc_status')), 'none');
    results.push('PASS: confirmed signup, separate-browser admin polling, newest first, clean account defaults, escaped user content');

    const failed = await registerPage(browser);
    await fill(failed, 'failure@example.test');
    state.writeError = { code: 'PGRST204', message: 'Could not find column' };
    await failed.click('#submitBtn');
    await failed.locator('#submitError').waitFor({ state: 'visible' });
    assert.equal(await failed.evaluate(() => localStorage.getItem('bb_uid')), null);
    assert.equal(await failed.locator('#submitSuccess').isVisible(), false);
    assert.equal(await failed.locator('#submitBtn').isDisabled(), false);
    assert.match(failed.url(), /register\.html$/);
    state.writeError = null;
    results.push('PASS: failed database insert creates no local session and never redirects');

    const duplicate = await registerPage(browser);
    await fill(duplicate, 'new@example.test');
    const beforeDuplicate = state.inserts.length;
    await duplicate.click('#submitBtn');
    await duplicate.locator('#emailError').waitFor({ state: 'visible' });
    assert.match(await duplicate.locator('#emailError').innerText(), /already exists/);
    assert.equal(state.inserts.length, beforeDuplicate);
    results.push('PASS: duplicate email detected centrally from an empty browser');

    const racingA = await registerPage(browser);
    const racingB = await registerPage(browser);
    await fill(racingA, 'race@example.test');
    await fill(racingB, 'race@example.test');
    state.delay = 200;
    await Promise.all([racingA.click('#submitBtn'), racingB.click('#submitBtn')]);
    await Promise.all([racingA.waitForFunction(() => location.pathname === '/dashboard.html' || !document.getElementById('submitError').classList.contains('hidden')),
      racingB.waitForFunction(() => location.pathname === '/dashboard.html' || !document.getElementById('submitError').classList.contains('hidden'))]);
    state.delay = 0;
    assert.equal(state.rows.filter(r => r.email === 'race@example.test').length, 1);
    assert.equal([racingA.url(), racingB.url()].filter(u => u.endsWith('/dashboard.html')).length, 1);
    results.push('PASS: simultaneous duplicate registrations create exactly one account');

    const beforeCollision = state.inserts.length;
    const collision = await registerPage(browser);
    await collision.evaluate(() => { let i = 0; Math.random = () => i++ === 0 ? 1.1 / 900000 : 0.5; });
    await fill(collision, 'collision@example.test');
    await collision.click('#submitBtn');
    await collision.waitForURL('**/dashboard.html');
    assert.equal(state.inserts.length - beforeCollision, 2);
    assert.equal(state.inserts[beforeCollision].uid, 100001);
    assert.equal(state.rows.find(r => r.uid === 100001).email, 'user100001@example.test');
    assert.equal(state.rows.find(r => r.email === 'collision@example.test').uid, 550000);
    results.push('PASS: UID collision retries INSERT without overwriting the existing account');

    await admin.evaluate(() => refreshUsers());
    const cached = await admin.evaluate(() => localStorage.getItem('bb_admin_users'));
    state.readError = { code: '42703', message: 'column users.created_at does not exist' };
    await admin.evaluate(() => refreshUsers());
    assert.equal(await admin.evaluate(() => localStorage.getItem('bb_admin_users')), cached);
    assert.match(await admin.locator('#usersSyncText').innerText(), /repair-users\.sql/);
    assert.doesNotMatch(await admin.locator('#usersSyncText').innerText(), /loaded live/);
    await admin.evaluate(() => DB.pullUsers());
    assert.equal(await admin.evaluate(() => localStorage.getItem('bb_admin_users')), cached);
    state.readError = null;
    results.push('PASS: HTTP database errors preserve cached users and show an actionable admin error');

    state.cap = 2;
    const total = state.rows.length;
    const list = await admin.evaluate(() => DB.fetchUsersLive());
    assert.equal(list.length, total);
    assert.ok(list.every(u => !('password' in u)));
    state.cap = 250;
    state.rows = [];
    await admin.evaluate(() => refreshUsers());
    assert.equal(await admin.locator('#dashUsers').innerText(), '0');
    assert.equal(await admin.evaluate(() => getAllUsers().length), 0);
    results.push('PASS: pagination handles a server row cap and an empty result resets the count');

    const offline = await registerPage(browser);
    await offline.evaluate(() => { DB.ready = false; DB.client = null; DB.init = function() {}; });
    await fill(offline, 'offline@example.test');
    await offline.click('#submitBtn');
    await offline.locator('#submitError').waitFor({ state: 'visible' });
    assert.equal(await offline.evaluate(() => localStorage.getItem('bb_uid')), null);
    assert.match(await offline.locator('#submitError').innerText(), /Connection unavailable/);
    results.push('PASS: missing SDK/configuration blocks local-only signup');

    const timeout = await registerPage(browser);
    await timeout.evaluate(() => { DB.userRequestTimeout = 30; });
    state.delay = 200;
    await fill(timeout, 'timeout@example.test');
    await timeout.click('#submitBtn');
    await timeout.locator('#submitError').waitFor({ state: 'visible' });
    assert.equal(await timeout.evaluate(() => localStorage.getItem('bb_uid')), null);
    assert.match(await timeout.locator('#submitError').innerText(), /could not confirm/);
    results.push('PASS: an unconfirmed timeout never becomes registration success');
    state.delay = 0;
    assert.deepEqual(pageErrors, []);
    console.log(results.join('\n'));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
