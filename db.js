// ============================================================
// BitBase - Supabase sync layer (db.js)
// Load AFTER supabase-config.js and the supabase-js CDN script.
// localStorage stays the fast local cache (existing code keeps
// working); this layer mirrors key data to Supabase so the
// admin panel sees ALL devices' data, not just one browser.
// ============================================================
var DB = {};
DB.ready = false;
DB.client = null;

DB.init = function () {
  try {
    if (!window.supabase) return;
    if (!SUPABASE_URL || SUPABASE_URL.indexOf('PASTE_') === 0) return;
    if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.indexOf('PASTE_') === 0) return;
    DB.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    DB.ready = true;
    console.log('[DB] Supabase connected');
  } catch (e) {
    DB.ready = false;
    console.warn('[DB] Supabase init failed', e);
  }
};

DB.get = function (key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } };
DB.set = function (key, val) { localStorage.setItem(key, JSON.stringify(val)); };
DB._ok = function (r) { if (r && r.error) console.warn('[DB]', r.error.message || r.error); return r; };
DB.safeParse = function (s) { try { return JSON.parse(s); } catch (e) { return s; } };

// ---------------- USERS ----------------
// Builds the full user list from localStorage (admin_users + current device).
DB.collectUsers = function () {
  var list = [];
  try { list = JSON.parse(localStorage.getItem('bb_admin_users') || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  var uid = localStorage.getItem('bb_uid');
  if (uid) {
    var exists = false;
    for (var i = 0; i < list.length; i++) { if (String(list[i].uid) === String(uid)) { exists = true; break; } }
    if (!exists) {
      list.push({
        uid: uid,
        name: localStorage.getItem('bb_name') || 'User',
        email: localStorage.getItem('bb_email') || '',
        cashBalance: parseFloat(localStorage.getItem('bb_cash_balance')) || 0,
        assetBalances: DB.get('bb_asset_balances') || {}
      });
    }
  }
  return list;
};

DB.usersToRows = function (list) {
  var adminList = []; try { adminList = JSON.parse(localStorage.getItem('bb_admin_access_list') || '[]'); } catch (e) {}
  var deact = []; try { deact = JSON.parse(localStorage.getItem('bb_deactivated_accounts') || '[]'); } catch (e) {}
  var kyc = localStorage.getItem('bb_kyc_status') || 'none';
  var rows = [];
  for (var i = 0; i < list.length; i++) {
    var u = list[i];
    rows.push({
      uid: Number(u.uid) || 0,
      name: u.name || 'User',
      email: u.email || '',
      cash_balance: parseFloat(u.cashBalance) || 0,
      asset_balances: u.assetBalances || {},
      is_admin: adminList.indexOf(String(u.uid)) >= 0 || adminList.indexOf(u.uid) >= 0,
      is_deactivated: deact.indexOf(String(u.uid)) >= 0 || deact.indexOf(u.uid) >= 0,
      profit_module: localStorage.getItem('bb_profit_module_' + u.uid) === 'true',
      kyc_status: u.kycStatus || kyc
    });
  }
  return rows;
};

// Upsert every user from localStorage into the users table.
// Push the current device's user (latest balances) to the central table.
DB.syncLocalUser = function () {
  if (!DB.ready) return Promise.resolve();
  var uid = localStorage.getItem('bb_uid');
  if (!uid) return Promise.resolve();
  var u = {
    uid: uid,
    name: localStorage.getItem('bb_name') || 'User',
    email: localStorage.getItem('bb_email') || '',
    password: localStorage.getItem('bb_password') || '',
    cashBalance: parseFloat(localStorage.getItem('bb_cash_balance')) || 0,
    assetBalances: DB.get('bb_asset_balances') || {}
  };
  return DB.upsertUser(u);
};

DB.pushUsers = function () {
  if (!DB.ready) return Promise.resolve();
  var rows = DB.usersToRows(DB.collectUsers());
  if (!rows.length) return Promise.resolve();
  return DB.client.from('users').upsert(rows, { onConflict: 'uid' }).then(DB._ok, DB._ok);
};

// Upsert a single user object.
DB.upsertUser = function (user) {
  if (!DB.ready || !user) return Promise.resolve();
  var adminList = []; try { adminList = JSON.parse(localStorage.getItem('bb_admin_access_list') || '[]'); } catch (e) {}
  var deact = []; try { deact = JSON.parse(localStorage.getItem('bb_deactivated_accounts') || '[]'); } catch (e) {}
  var row = {
    uid: Number(user.uid) || 0,
    name: user.name || localStorage.getItem('bb_name') || 'User',
    email: user.email || localStorage.getItem('bb_email') || '',
    password: user.password || localStorage.getItem('bb_password') || '',
    cash_balance: parseFloat(user.cashBalance) || parseFloat(localStorage.getItem('bb_cash_balance')) || 0,
    asset_balances: user.assetBalances || DB.get('bb_asset_balances') || {},
    is_admin: adminList.indexOf(String(user.uid)) >= 0,
    is_deactivated: deact.indexOf(String(user.uid)) >= 0,
    kyc_status: localStorage.getItem('bb_kyc_status') || 'none'
  };
  return DB.client.from('users').upsert(row, { onConflict: 'uid' }).then(DB._ok, DB._ok);
};

// Pull the users table into localStorage so admin sees every device's users.
DB.pullUsers = function () {
  if (!DB.ready) return Promise.resolve(null);
  return DB.client.from('users').select('*').order('created_at', { ascending: true }).then(function (res) {
    if (!res || res.error || !res.data || !res.data.length) return DB._ok(res);
    var rows = res.data;
    var list = [];
    var adminList = [];
    var deact = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var uid = String(r.uid);
      list.push({ uid: uid, name: r.name || 'User', email: r.email || '', cashBalance: parseFloat(r.cash_balance) || 0, assetBalances: r.asset_balances || {}, kycStatus: r.kyc_status || 'none' });
      if (r.is_admin && adminList.indexOf(uid) < 0) adminList.push(uid);
      if (r.is_deactivated && deact.indexOf(uid) < 0) deact.push(uid);
      localStorage.setItem('bb_profit_module_' + uid, r.profit_module ? 'true' : 'false');
    }
    // keep the current device's own user even if not in DB yet
    var curUid = localStorage.getItem('bb_uid');
    if (curUid) {
      var found = false;
      for (var j = 0; j < list.length; j++) { if (String(list[j].uid) === String(curUid)) { found = true; break; } }
      if (!found) {
        list.push({ uid: curUid, name: localStorage.getItem('bb_name') || 'User', email: localStorage.getItem('bb_email') || '', cashBalance: parseFloat(localStorage.getItem('bb_cash_balance')) || 0, assetBalances: DB.get('bb_asset_balances') || {}, kycStatus: localStorage.getItem('bb_kyc_status') || 'none' });
      }
    }
    DB.set('bb_admin_users', list);
    DB.set('bb_admin_access_list', adminList);
    DB.set('bb_deactivated_accounts', deact);
    return res;
  }, function (e) { console.warn('[DB] pullUsers failed', e); return null; });
};

DB.updateUser = function (uid, patch) {
  if (!DB.ready) return Promise.resolve();
  return DB.client.from('users').update(patch).eq('uid', Number(uid)).then(DB._ok, DB._ok);
};

// Pull the current device's own user row from Supabase into localStorage.
// Returns true if anything changed (callers may reload/re-render).
DB.pullLocalUser = function () {
  if (!DB.ready) return Promise.resolve(false);
  var uid = localStorage.getItem('bb_uid');
  if (!uid) return Promise.resolve(false);
  return DB.client.from('users').select('*').eq('uid', Number(uid)).limit(1).single().then(function (res) {
    if (res && res.data) {
      var r = res.data;
      var changed = false;
      var oldCash = localStorage.getItem('bb_cash_balance');
      localStorage.setItem('bb_cash_balance', String(r.cash_balance != null ? r.cash_balance : 0));
      if (oldCash !== localStorage.getItem('bb_cash_balance')) changed = true;
      try {
        var oldAb = localStorage.getItem('bb_asset_balances');
        localStorage.setItem('bb_asset_balances', JSON.stringify(r.asset_balances || {}));
        if (oldAb !== localStorage.getItem('bb_asset_balances')) changed = true;
      } catch (e) {}
      if (r.name && r.name !== localStorage.getItem('bb_name')) { localStorage.setItem('bb_name', r.name); changed = true; }
      if (r.email && r.email !== localStorage.getItem('bb_email')) { localStorage.setItem('bb_email', r.email); changed = true; }
      if (r.password) localStorage.setItem('bb_password', r.password);
      if (r.kyc_status && r.kyc_status !== localStorage.getItem('bb_kyc_status')) { localStorage.setItem('bb_kyc_status', r.kyc_status); changed = true; }
      if (r.is_admin != null) {
        var aList = []; try { aList = JSON.parse(localStorage.getItem('bb_admin_access_list') || '[]'); } catch (e) { aList = []; }
        var aIdx = aList.indexOf(String(uid));
        if (r.is_admin && aIdx < 0) { aList.push(String(uid)); localStorage.setItem('bb_admin_access_list', JSON.stringify(aList)); changed = true; }
        else if (!r.is_admin && aIdx >= 0) { aList.splice(aIdx, 1); localStorage.setItem('bb_admin_access_list', JSON.stringify(aList)); changed = true; }
      }
      if (r.profit_module != null) localStorage.setItem('bb_profit_module_' + uid, r.profit_module ? 'true' : 'false');
      return changed;
    }
    return false;
  }, function (e) { console.warn('[DB] pullLocalUser failed', e); return false; });
};

// Keep the current device's user row in sync from Supabase.
// Polls pullLocalUser every intervalMs; reloads the page when the
// server row differs from localStorage (admin adjustments, approvals).
DB.startLocalPolling = function (intervalMs) {
  if (DB._localPollTimer) return;
  intervalMs = intervalMs || 10000;
  var poll = function () {
    DB.pullLocalUser().then(function (changed) {
      if (changed && window.location && window.location.reload) window.location.reload();
    });
  };
  poll();
  DB._localPollTimer = setInterval(poll, intervalMs);
};

// Try logging in against the central users table (used when the
// device has no localStorage for this email yet).
DB.loginUser = function (email, pass) {
  if (!DB.ready || !email) return Promise.resolve(null);
  return DB.client.from('users').select('*').eq('email', email).limit(1).single().then(function (res) {
    if (res && res.data && res.data.password === pass) return res.data;
    return null;
  }, function () { return null; });
};

// ---------------- COLLECTIONS (trades, deposits, etc.) ----------------
DB.COLLECTIONS = [
  'bb_trades_history',
  'bb_demo_trades_hist',
  'bb_support_tickets',
  'bb_deposit_requests',
  'bb_deposit_addresses',
  'bb_withdrawal_requests',
  'bb_loans',
  'bb_kyc_submissions',
  'bb_earn_positions',
  'bb_balance_history'
];

// Merge two ticket arrays by id, unioning messages (deduped) and
// sorting by time. Server first, then local, so nothing is clobbered.
DB._ticketMerge = function (local, server) {
  var map = {};
  var order = [];
  function upsertTicket(t) {
    if (!t || !t.id) return;
    if (!map[t.id]) {
      map[t.id] = { id: t.id, userId: t.userId, userName: t.userName, userEmail: t.userEmail, status: t.status || 'open', createdAt: t.createdAt || Date.now(), messages: [] };
      order.push(t.id);
    }
    var cur = map[t.id];
    if (t.status === 'resolved') cur.status = 'resolved';
    if (!cur.userName && t.userName) cur.userName = t.userName;
    if (!cur.userEmail && t.userEmail) cur.userEmail = t.userEmail;
    if (t.lastAdminReply) cur.lastAdminReply = t.lastAdminReply;
    var seen = {};
    for (var i = 0; i < cur.messages.length; i++) {
      var m = cur.messages[i];
      seen[(m.from || '') + '|' + (m.time || 0) + '|' + (m.text || '')] = true;
    }
    var msgs = t.messages || [];
    for (var j = 0; j < msgs.length; j++) {
      var mm = msgs[j];
      var key = (mm.from || '') + '|' + (mm.time || 0) + '|' + (mm.text || '');
      if (!seen[key]) { cur.messages.push(mm); seen[key] = true; }
    }
    cur.messages.sort(function (a, b) { return (a.time || 0) - (b.time || 0); });
  }
  for (var a = 0; a < (server || []).length; a++) upsertTicket(server[a]);
  for (var b = 0; b < (local || []).length; b++) upsertTicket(local[b]);
  var result = [];
  for (var c = 0; c < order.length; c++) result.push(map[order[c]]);
  return result;
};

// Drop chat messages older than 2 days (keeps ticket shells).
DB.TICKET_TTL = 2 * 24 * 60 * 60 * 1000;
DB._cleanTickets = function (tickets) {
  if (!Array.isArray(tickets)) return tickets;
  var cutoff = Date.now() - DB.TICKET_TTL;
  var out = [];
  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    if (!t) continue;
    t.messages = (t.messages || []).filter(function (m) { return m.time && m.time >= cutoff; });
    out.push(t);
  }
  return out;
};

DB.pushCollection = function (key) {
  if (!DB.ready) return Promise.resolve();
  var data = localStorage.getItem(key);
  if (data === null || data === undefined) return Promise.resolve();
  var payload = DB.safeParse(data);
  if (key === 'bb_support_tickets') {
    if (!Array.isArray(payload)) payload = [];
    payload = DB._cleanTickets(payload);
    // Read the current server payload, merge local into it, then upsert.
    // Prevents one device's array from clobbering everyone else's chats.
    return DB.client.from('app_collections').select('payload').eq('key', key).limit(1).single().then(function (res) {
      var serverPayload = (res && res.data && res.data.payload) ? res.data.payload : [];
      if (!Array.isArray(serverPayload)) serverPayload = [];
      serverPayload = DB._cleanTickets(serverPayload);
      var merged = DB._ticketMerge(payload, serverPayload);
      localStorage.setItem(key, JSON.stringify(merged));
      return DB.client.from('app_collections').upsert({ key: key, payload: merged }, { onConflict: 'key' }).then(DB._ok, DB._ok);
    }, function () { return DB._ok(null); });
  }
  return DB.client.from('app_collections').upsert({ key: key, payload: payload }, { onConflict: 'key' }).then(DB._ok, DB._ok);
};

DB.pullCollection = function (key) {
  if (!DB.ready) return Promise.resolve();
  return DB.client.from('app_collections').select('payload').eq('key', key).single().then(function (res) {
    if (res && res.data && res.data.payload !== null && res.data.payload !== undefined) {
      var serverPayload = res.data.payload;
      if (key === 'bb_support_tickets') {
        if (!Array.isArray(serverPayload)) serverPayload = [];
        serverPayload = DB._cleanTickets(serverPayload);
        var localTickets = [];
        try { localTickets = JSON.parse(localStorage.getItem('bb_support_tickets') || '[]'); } catch (e) { localTickets = []; }
        if (!Array.isArray(localTickets)) localTickets = [];
        localTickets = DB._cleanTickets(localTickets);
        localStorage.setItem(key, JSON.stringify(DB._ticketMerge(localTickets, serverPayload)));
      } else {
        localStorage.setItem(key, JSON.stringify(res.data.payload));
      }
    }
  }, function () { return null; });
};

DB.pushAll = function () {
  if (!DB.ready) return Promise.resolve();
  var p = DB.pushUsers();
  for (var i = 0; i < DB.COLLECTIONS.length; i++) p = p.then(DB.pushCollection.bind(null, DB.COLLECTIONS[i]));
  return p;
};

DB.pullAll = function () {
  if (!DB.ready) return Promise.resolve();
  var p = DB.pullUsers();
  for (var i = 0; i < DB.COLLECTIONS.length; i++) p = p.then(DB.pullCollection.bind(null, DB.COLLECTIONS[i]));
  return p;
};

DB.init();
