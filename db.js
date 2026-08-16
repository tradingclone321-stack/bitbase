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
DB.VERSION = '2026-08-16-pollfix';
DB._lastPullTime = 0;
DB._lastSyncError = '';

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

DB.deleteUser = function (uid) {
  if (!DB.ready) return Promise.resolve();
  return DB.client.from('users').delete().eq('uid', Number(uid)).then(DB._ok, DB._ok);
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
      if (r.profit_module != null) {
        // Prefer the shared profit-modules map (fresh 5s sync); only fall
        // back to the users-table column when no map entry exists yet.
        var hasMap = false;
        try { var pmMap = JSON.parse(localStorage.getItem('bb_profit_modules') || '{}'); hasMap = Object.prototype.hasOwnProperty.call(pmMap, String(uid)); } catch (e) {}
        if (!hasMap) localStorage.setItem('bb_profit_module_' + uid, r.profit_module ? 'true' : 'false');
      }
      return changed;
    }
    return false;
  }, function (e) { console.warn('[DB] pullLocalUser failed', e); return false; });
};

// Keep the current device's user row in sync from Supabase.
// Polls pullLocalUser every intervalMs; reloads the page when the
// server row differs from localStorage (admin adjustments, approvals).
// Also starts a faster 5s poll for the shared profit-module flags so
// admin toggles apply without waiting for the page reload.
DB.startLocalPolling = function (intervalMs) {
  intervalMs = intervalMs || 10000;
  if (!DB._localPollTimer) {
    var poll = function () {
      DB.pullLocalUser().then(function (changed) {
        if (changed && window.location && window.location.reload) window.location.reload();
        DB.pullProfitModules();
      }, function () {
        DB.pullProfitModules();
      });
    };
    poll();
    DB._localPollTimer = setInterval(poll, intervalMs);
  }
  if (!DB._profitPollTimer) {
    DB.pullProfitModules();
    DB._profitPollTimer = setInterval(DB.pullProfitModules, 5000);
  }
};

// Shared profit-module flags (uid -> bool). Stored in app_collections so
// admin toggles reach every device without depending on the users table.
DB.applyProfitModules = function (map) {
  try {
    if (!map || typeof map !== 'object') return;
    for (var uid in map) {
      if (Object.prototype.hasOwnProperty.call(map, uid)) {
        localStorage.setItem('bb_profit_module_' + uid, map[uid] ? 'true' : 'false');
      }
    }
  } catch (e) {}
};
DB.pullProfitModules = function () {
  if (!DB.ready) return Promise.resolve();
  return DB.client.from('app_collections').select('payload').eq('key', 'bb_profit_modules').single().then(function (res) {
    if (res && res.data && res.data.payload) {
      localStorage.setItem('bb_profit_modules', JSON.stringify(res.data.payload));
      DB.applyProfitModules(res.data.payload);
    }
  }, function () { return null; });
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
  'bb_balance_history',
  'bb_profit_modules',
  'bb_ai_quants'
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

// Merge two id-keyed arrays so neither side clobbers the other's
// records. When the same id exists on both sides, the "resolved"
// version wins (approved / rejected / paid / completed / resolved),
// otherwise the one that changed most recently wins.
DB._mergeById = function (local, server, idKey) {
  idKey = idKey || 'id';
  var map = {};
  var order = [];
  var RESOLVED = ['approved', 'rejected', 'paid', 'completed', 'resolved'];
  function isResolved(v) { return RESOLVED.indexOf((v.status || '').toLowerCase()) >= 0; }
  function newer(a, b) { return (b.resolvedAt || b.createdAt || 0) > (a.resolvedAt || a.createdAt || 0); }
  function add(item) {
    if (!item || item[idKey] == null) return;
    var key = String(item[idKey]);
    if (map[key] === undefined) {
      map[key] = item;
      order.push(key);
      return;
    }
    var cur = map[key];
    // A resolved status beats a pending one, regardless of side.
    if (isResolved(item) && !isResolved(cur)) { map[key] = item; return; }
    if (isResolved(cur) && !isResolved(item)) { return; }
    // Same resolution level: keep the newer change.
    if (newer(item, cur)) map[key] = item;
  }
  for (var i = 0; i < (server || []).length; i++) add(server[i]);
  for (var j = 0; j < (local || []).length; j++) add(local[j]);
  var out = [];
  for (var k = 0; k < order.length; k++) out.push(map[order[k]]);
  return out;
};

// Collections that hold shared id-keyed request/position arrays where
// one device's push must not wipe another device's admin resolutions.
DB.MERGE_COLLECTIONS = [
  'bb_deposit_requests',
  'bb_withdrawal_requests',
  'bb_loans',
  'bb_kyc_submissions',
  'bb_earn_positions',
  'bb_ai_quants'
];

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
      return DB.client.from('app_collections').upsert({ key: key, payload: merged }, { onConflict: 'key' }).then(function (r) { DB._ok(r); DB.broadcastUpdate(key, merged); return r; }, DB._ok);
    }, function () { return DB._ok(null); });
  }
  if (DB.MERGE_COLLECTIONS.indexOf(key) >= 0) {
    if (!Array.isArray(payload)) payload = [];
    // Merge with the current server payload so a user's new deposit
    // doesn't overwrite the admin's earlier approvals/rejections.
    return DB.client.from('app_collections').select('payload').eq('key', key).limit(1).single().then(function (res) {
      var serverPayload = (res && res.data && res.data.payload) ? res.data.payload : [];
      if (!Array.isArray(serverPayload)) serverPayload = [];
      var merged = DB._mergeById(payload, serverPayload);
      localStorage.setItem(key, JSON.stringify(merged));
      return DB.client.from('app_collections').upsert({ key: key, payload: merged }, { onConflict: 'key' }).then(function (r) { DB._ok(r); DB.broadcastUpdate(key, merged); return r; }, DB._ok);
    }, function () { return DB._ok(null); });
  }
  return DB.client.from('app_collections').upsert({ key: key, payload: payload }, { onConflict: 'key' }).then(function (r) { DB._ok(r); DB.broadcastUpdate(key, payload); return r; }, DB._ok);
};

DB._pullInFlight = {};
DB._pullQueued = {};
DB.pullCollection = function (key) {
  if (!DB.ready) return Promise.resolve();
  if (DB._pullInFlight[key]) {
    // A pull for this key is already in flight. Never stack another
    // full-payload download on top of it: the support payload can be
    // hundreds of KB, so overlapping pulls saturate the connection
    // pool and starve the push path (sends never reach the server).
    // Note that a refresh is still wanted and re-run once the current
    // pull settles, so the newest data is not lost.
    DB._pullQueued[key] = true;
    return DB._pullInFlight[key];
  }
  var p = DB.client.from('app_collections').select('payload').eq('key', key).single().then(function (res) {
    DB._lastPullTime = Date.now();
    DB._lastSyncError = '';
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
      } else if (DB.MERGE_COLLECTIONS.indexOf(key) >= 0) {
        // Merge with the local copy so locally-added records (e.g. a
        // deposit the user just submitted) survive the pull.
        if (!Array.isArray(serverPayload)) serverPayload = [];
        var localArr = [];
        try { localArr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { localArr = []; }
        if (!Array.isArray(localArr)) localArr = [];
        localStorage.setItem(key, JSON.stringify(DB._mergeById(localArr, serverPayload)));
      } else {
        localStorage.setItem(key, JSON.stringify(res.data.payload));
      }
    }
  }, function (e) { DB._lastSyncError = (e && e.message) || 'pull failed'; return null; });
  DB._pullInFlight[key] = p;
  p.then(function () {
    DB._pullInFlight[key] = null;
    if (DB._pullQueued[key]) { DB._pullQueued[key] = false; DB.pullCollection(key); }
  }, function () {
    DB._pullInFlight[key] = null;
    if (DB._pullQueued[key]) { DB._pullQueued[key] = false; DB.pullCollection(key); }
  });
  return p;
};

DB.pushAll = function () {
  if (!DB.ready) return Promise.resolve();
  var p = DB.pushUsers();
  for (var i = 0; i < DB.COLLECTIONS.length; i++) p = p.then(DB.pushCollection.bind(null, DB.COLLECTIONS[i]));
  return p;
};

// ---------------- REALTIME (WebSocket broadcast) ----------------
// True live pub/sub via the Supabase Realtime service. Works without
// any SQL/publication setup: when a device upserts a collection it
// broadcasts on the shared 'bb-realtime' channel; every subscribed
// device receives the signal in ~100ms and pulls the fresh payload.
// Falls back silently to the caller's polling loop if unavailable.
DB._broadcastChannel = null;
DB._broadcastReady = false;
DB._broadcastSubscribers = {};
DB._pendingBroadcasts = [];
DB._ensureBroadcast = function () {
  if (!DB.ready) return;
  if (DB._broadcastChannel) return;
  try {
    DB._broadcastChannel = DB.client.channel('bb-realtime', { config: { broadcast: { self: true } } });
    DB._broadcastChannel
      .on('broadcast', { event: 'update' }, function (data) {
        // supabase-js delivers the full message:
        //   { type:'broadcast', event:'update', payload:{ key, payload } }
        // Older builds deliver just { key, payload }. Handle both.
        var key = null, pld = null;
        if (data) {
          if (data.payload && typeof data.payload === 'object' && data.payload.key !== undefined) {
            key = data.payload.key;
            pld = (data.payload.payload !== undefined) ? data.payload.payload : null;
          } else if (data.key !== undefined) {
            key = data.key;
            pld = (data.payload !== undefined) ? data.payload : null;
          }
        }
        if (key && DB._broadcastSubscribers[key]) DB._broadcastSubscribers[key](key, pld);
      })
      .subscribe(function (status) {
        DB._broadcastReady = (status === 'SUBSCRIBED');
        if (DB._broadcastReady && DB._pendingBroadcasts.length) {
          var pend = DB._pendingBroadcasts.splice(0);
          for (var i = 0; i < pend.length; i++) DB._sendBroadcast(pend[i].key, pend[i].payload);
        }
      });
  } catch (e) {
    console.warn('[DB] realtime broadcast failed', e);
  }
};
DB._sendBroadcast = function (key, payload) {
  try {
    var msg = { type: 'broadcast', event: 'update', payload: { key: key } };
    // Include the data so receivers update instantly without a pull round-trip.
    if (payload !== undefined && payload !== null) {
      var s;
      try { s = JSON.stringify(payload); } catch (e) { s = null; }
      if (!s || s.length < 400000) msg.payload.payload = payload;
    }
    DB._broadcastChannel.send(msg);
  } catch (e) {}
};
DB.broadcastUpdate = function (key, payload) {
  if (!DB.ready) return;
  DB._ensureBroadcast();
  if (!DB._broadcastChannel) return;
  if (!DB._broadcastReady) {
    // Channel not connected yet: buffer so the update is not lost.
    if (DB._pendingBroadcasts.indexOf(key) < 0) DB._pendingBroadcasts.push({ key: key, payload: payload });
    return;
  }
  DB._sendBroadcast(key, payload);
};
DB.subscribe = function (key, callback) {
  if (!DB.ready) return;
  DB._ensureBroadcast();
  DB._broadcastSubscribers[key] = callback;
};
DB.unsubscribe = function (key) {
  delete DB._broadcastSubscribers[key];
};

DB.pullAll = function () {
  if (!DB.ready) return Promise.resolve();
  var p = DB.pushUsers();
  for (var i = 0; i < DB.COLLECTIONS.length; i++) p = p.then(DB.pullCollection.bind(null, DB.COLLECTIONS[i]));
  return p;
};

// Diagnostic helper: returns a snapshot of the sync layer state so the
// admin page can show exactly what is (or is not) working.
DB.diagnose = function () {
  var t = {};
  try { t = JSON.parse(localStorage.getItem('bb_support_tickets') || '[]'); } catch (e) { t = []; }
  var myUid = localStorage.getItem('bb_uid') || '(none)';
  var myTicket = null;
  for (var i = 0; i < (t || []).length; i++) {
    if (String(t[i].userId) === String(myUid)) { myTicket = t[i]; break; }
  }
  return {
    version: DB.VERSION,
    ready: !!DB.ready,
    realtime: !!DB._broadcastReady,
    client: !!DB.client,
    lastPullAgoSec: DB._lastPullTime ? Math.round((Date.now() - DB._lastPullTime) / 1000) : -1,
    lastError: DB._lastSyncError || '',
    serverTickets: (t || []).length,
    myTicket: myTicket ? { id: myTicket.id, msgs: (myTicket.messages || []).length } : null
  };
};

DB.init();
