/* BitBase v2: server owns balances, orders, permissions, and durable records.
 * Browser storage is a replaceable cache. No cached balance is ever uploaded. */
var DB = {VERSION:'2026-10-17-instant-v4',ready:false,client:null,_lastSyncError:'',_lastUsersError:'',_lastPullTime:0,_localDirty:false,_pulls:{},_pushChains:{},_subscribers:{},_snapshot:{}};
DB.get=function(k){try{return JSON.parse(localStorage.getItem(k)||'null');}catch(e){return null;}};
DB.set=function(k,v){localStorage.setItem(k,JSON.stringify(v));};
DB.safeParse=function(s){try{return JSON.parse(s);}catch(e){return s;}};
DB.userError=function(code,msg){var e=new Error(msg);e.code=code;return e;};
DB.describeUserError=function(e){
 var code=String(e&&e.code||''),message=e&&e.message||'Connection unavailable. Try again.';
 if(code==='42501')return /Administrator access required/i.test(message)?'This account is not an administrator. Sign in with your admin account. The project owner can verify users.is_admin for your account.':'Database API permission denied (42501). Verify repair-finance.sql completed in the Supabase project configured in supabase-config.js. Keep direct user-table access private.';
 if(['PGRST202','42883','42P01','42703'].indexOf(code)>=0)return 'The finance database update is missing or incomplete ('+code+'). Run repair-finance.sql in the Supabase project configured in supabase-config.js, then sign in again.';
 if(['PGRST301','PGRST303'].indexOf(code)>=0)return 'The project API key was rejected. Check the public project URL and key in supabase-config.js.';
 return message;
};
DB.init=function(){if(DB.ready)return;try{if(window.supabase&&typeof SUPABASE_URL!=='undefined'&&SUPABASE_URL){DB.client=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);DB.ready=true;}}catch(e){DB._lastSyncError=e.message;}};
DB.requireUserConnection=function(){DB.init();if(!DB.ready)throw new Error('Database unavailable. Reload and try again.');};
DB.userRequestTimeout=20000;
DB.userRequest=async function(query){
 var timer;var ctl=new AbortController();if(query.abortSignal)query=query.abortSignal(ctl.signal);
 try{var r=await Promise.race([query,new Promise(function(_,reject){timer=setTimeout(function(){ctl.abort();reject(DB.userError('DB_TIMEOUT','Response not confirmed. Retry the same operation; its request ID prevents duplicates.'));},DB.userRequestTimeout);})]);if(!r||r.error)throw r&&r.error||new Error('No server response');if(r.data&&r.data.error)throw new Error(r.data.error);return r;}
 finally{clearTimeout(timer);}
};
DB.rpc=async function(name,args){DB.requireUserConnection();try{var r=await DB.userRequest(DB.client.rpc(name,args));DB._lastSyncError='';return r.data;}catch(e){DB._lastSyncError=DB.describeUserError(e);if(e.code==='28000'&&(!args||!args.p_token||args.p_token===localStorage.getItem('bb_session_token'))){DB.clearSession();}throw e;}};
DB.token=function(){var t=localStorage.getItem('bb_session_token');if(!t)throw DB.userError('28000','Please sign in again after the database update.');return t;};
DB.clearSession=function(){Object.keys(localStorage).filter(function(k){return k.indexOf('bb_')===0;}).forEach(function(k){localStorage.removeItem(k);});DB._snapshot={};DB.me=null;DB._userRows=[];DB._usersFetchPromise=null;DB._usersFetchToken=null;};
DB.cacheUser=function(u){
 if(!u)return;var old=localStorage.getItem('bb_uid');if(old&&old!==String(u.uid))DB.clearSession();
 localStorage.setItem('bb_uid',String(u.uid));localStorage.setItem('bb_name',u.name||'User');localStorage.setItem('bb_email',u.email||'');
 localStorage.setItem('bb_cash_balance',String(u.cash_balance||0));DB.set('bb_asset_balances',u.asset_balances||{});DB.set('bb_funding_balances',u.funding_balances||{});
 localStorage.setItem('bb_kyc_status',u.kyc_status||'none');DB.set('bb_preferences',u.preferences||{});
 localStorage.setItem('bb_phone',u.phone||'');localStorage.setItem('bb_username',u.username||'');
 if(u.demo_balance!=null)DB.set('bb_demo_trades_bal',u.demo_balance);else localStorage.removeItem('bb_demo_trades_bal');
 if(u.demo_positions!=null)DB.set('bb_demo_trades_pos',u.demo_positions);else localStorage.removeItem('bb_demo_trades_pos');
 DB.set('bb_admin_access_list',u.is_admin?[String(u.uid)]:[]);DB.set('bb_deactivated_accounts',u.is_deactivated?[String(u.uid)]:[]);
 if(!u.is_admin){localStorage.removeItem('bb_admin_users');localStorage.removeItem('bb_admin_logged_in');DB._userRows=[];}
 localStorage.removeItem('bb_password');DB.me=u;DB._localDirty=false;
};
DB.acceptSession=function(result){DB.clearSession();DB.cacheUser(result.user);localStorage.setItem('bb_session_token',result.token);localStorage.setItem('bb_login_time',String(Date.now()));return result.user;};
DB.registerUser=async function(d){return DB.acceptSession(await DB.rpc('bb_register',{p_name:d.name,p_email:d.email,p_password:d.password}));};
DB.loginUser=async function(email,password){return DB.acceptSession(await DB.rpc('bb_login',{p_email:email,p_password:password}));};
DB.read=function(resource){return DB.rpc('bb_read',{p_token:DB.token(),p_resource:resource});};
DB.newId=function(){return crypto.randomUUID();};
// Persist one ID BEFORE sending. Retry after timeout/reload reuses that same ID.
DB.operation=async function(action,data,runner){
 var key='bb_pending:'+localStorage.getItem('bb_uid')+':'+action;
 var input=JSON.stringify(data),pending=DB.get(key);
 if(pending&&pending.input!==input)throw new Error('A previous '+action+' request is unconfirmed. Retry its original values before starting another.');
 if(!pending){pending={id:DB.newId(),input:input};DB.set(key,pending);}
 try{var result=await runner(pending.id);localStorage.removeItem(key);return result;}
 catch(e){
  // A PostgreSQL validation error confirms rollback. Network/timeout/5xx is ambiguous.
  if(e.code&&/^(22|23|28|42|P0001|40001)/.test(e.code))localStorage.removeItem(key);
  throw e;
 }
};
DB.action=function(action,data){return DB.operation(action,data,function(id){return DB.rpc('bb_action',{p_token:DB.token(),p_action:action,p_id:id,p_data:data});});};
DB.demo=function(action,data){return DB.operation('demo.'+action,data,function(id){return DB.rpc('bb_demo',{p_token:DB.token(),p_action:action,p_id:id,p_data:data});});};
DB.edge=function(action,data){return DB.operation(action,data,async function(id){
 DB.requireUserConnection();var controller=new AbortController();var timer=setTimeout(function(){controller.abort();},25000);
 try{var r=await fetch(SUPABASE_URL+'/functions/v1/trade-engine',{method:'POST',headers:{'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY},body:JSON.stringify(Object.assign({},data,{action:action,requestId:id,token:DB.token()})),signal:controller.signal});var body=await r.json();if(!r.ok||body.error){var e=new Error(body.error||'Trade service unavailable');e.code=body.code;throw e;}return body;}
 finally{clearTimeout(timer);}
});};
DB.settleDue=function(force){
 // Ask the trusted worker to settle expired orders now. Idempotent and safe to
 // retry; it never supplies a price. Non-forced calls are throttled; a forced
 // call (used the instant an order expires) skips the throttle but never runs
 // two settlement passes at once. When anything settles, refresh trades and
 // notify the page so the result appears immediately.
 var now=Date.now();
 if(DB._settling)return DB._settling;
 if(!force&&DB._settleAt&&now-DB._settleAt<8000)return Promise.resolve(null);
 DB._settleAt=now;
 try{DB.requireUserConnection();}catch(e){return Promise.resolve(null);}
 var token;try{token=DB.token();}catch(e){return Promise.resolve(null);}
 var ctl=new AbortController();var timer=setTimeout(function(){ctl.abort();},15000);
 DB._settling=fetch(SUPABASE_URL+'/functions/v1/trade-engine',{method:'POST',headers:{'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY},body:JSON.stringify({action:'settle',token:token}),signal:ctl.signal}).then(function(r){return r.json();}).then(function(res){
  if(force||(res&&Number(res.settled)>0))return Promise.all([
   DB.pullCollection('bb_trades_history').catch(function(){}),
   DB.pullLocalUser().catch(function(){})
  ]).then(function(){try{window.dispatchEvent(new CustomEvent('bb:updated'));}catch(e){}return res;});
  return res;
 }).catch(function(){return null;}).then(function(res){clearTimeout();DB._settling=null;return res;},function(e){clearTimeout();DB._settling=null;throw e;});
 return DB._settling;
};
DB.cachedUsers=function(){return DB.me&&DB.me.is_admin&&localStorage.getItem('bb_session_token')?DB.get('bb_admin_users')||[]:[];};
DB.fetchUsersLive=function(){
 var token;try{token=DB.token();}catch(e){return Promise.reject(e);}
 if(DB._usersFetchPromise&&DB._usersFetchToken===token)return DB._usersFetchPromise;
 DB._usersFetchToken=token;
 var task=DB.rpc('bb_read',{p_token:token,p_resource:'users'}).then(function(rows){
  if(token!==localStorage.getItem('bb_session_token'))throw DB.userError('SESSION_CHANGED','The account changed while users were loading. Sign in to the administrator account again.');
  if(!Array.isArray(rows))throw DB.userError('INVALID_RESPONSE','The server did not return a valid user list.');
  DB._userRows=rows;var list=rows.map(function(r){return{uid:String(r.uid),name:r.name,email:r.email,cashBalance:Number(r.cash_balance),assetBalances:r.asset_balances||{},kycStatus:r.kyc_status,createdAt:r.created_at,updatedAt:r.updated_at,isAdmin:r.is_admin,profitModule:!!r.profit_module};});
  DB.set('bb_admin_users',list);DB.set('bb_admin_access_list',rows.filter(function(r){return r.is_admin;}).map(function(r){return String(r.uid);}));DB.set('bb_deactivated_accounts',rows.filter(function(r){return r.is_deactivated;}).map(function(r){return String(r.uid);}));DB._lastUsersError='';return list;
 }).catch(function(e){
  if(token===localStorage.getItem('bb_session_token')){
   DB._lastUsersError=DB.describeUserError(e);
   if(e.code==='42501'||e.code==='28000'){
    localStorage.removeItem('bb_admin_users');DB._userRows=[];
    if(e.code==='28000'||/Administrator access required/i.test(e.message||'')){localStorage.removeItem('bb_admin_logged_in');localStorage.removeItem('bb_admin_access_list');if(DB.me)DB.me.is_admin=false;}
   }
  }
  throw e;
 }).finally(function(){if(DB._usersFetchPromise===task){DB._usersFetchPromise=null;DB._usersFetchToken=null;}});
 DB._usersFetchPromise=task;return task;
};
DB.pullUsers=function(){return DB.fetchUsersLive().then(function(data){return {data:data,error:null};},function(error){return{data:null,error:error};});};
DB.pullLocalUser=async function(){if(!localStorage.getItem('bb_session_token'))return false;var before=localStorage.getItem('bb_cash_balance')+localStorage.getItem('bb_asset_balances');var token=DB.token(),row=await DB.read('me');if(token!==localStorage.getItem('bb_session_token'))return false;DB.cacheUser(row);return before!==localStorage.getItem('bb_cash_balance')+localStorage.getItem('bb_asset_balances');};
DB.syncLocalUser=function(){return DB.pullLocalUser();}; // deliberately pull-only
DB.pushUsers=function(){return Promise.reject(new Error('Bulk browser balance uploads are disabled.'));};
DB.upsertUser=function(u){return DB.action('profile',{name:u.name,email:u.email}).then(DB.pullLocalUser);};
DB.updateUser=function(uid,patch){return DB.action('admin_user',Object.assign({},patch,{uid:Number(uid)})).then(function(){return DB.pullUsers();});};
DB.deleteUser=function(uid){return DB.action('admin_delete_user',{uid:Number(uid)}).then(function(){return DB.pullUsers();});}; // anonymises the account and wipes credentials; financial history is retained
DB.COLLECTIONS=['bb_trades_history','bb_demo_trades_hist','bb_support_tickets','bb_deposit_requests','bb_deposit_addresses','bb_withdrawal_requests','bb_loans','bb_kyc_submissions','bb_earn_positions','bb_balance_history','bb_ai_quants'];
DB.pullCollection=function(key){
 if(DB._pulls[key])return DB._pulls[key];
 var token=DB.token(),uid=localStorage.getItem('bb_uid');
 DB._pulls[key]=DB.read(key).then(function(payload){
  if(token!==localStorage.getItem('bb_session_token')||uid!==localStorage.getItem('bb_uid'))return;
  if(key==='bb_deposit_addresses'&&payload._version){DB._addressVersion=payload._version;delete payload._version;}DB.set(key,payload);DB._snapshot[key]=JSON.stringify(payload);DB._lastPullTime=Date.now();
  if(key==='bb_trades_history'){
   DB.set('bb_trade_positions',payload.filter(function(p){return String(p.uid)===uid;}).map(function(p){return Object.assign({},p,{amt:Number(p.amount||p.amt),profit:Number(p.potentialProfit||Math.abs(p.profit)||0)});}));
   localStorage.setItem('bb_trade_pnl',String(payload.filter(function(p){return String(p.uid)===uid;}).reduce(function(sum,p){return sum+Number(p.profit||0);},0)));
  }
  if(DB._subscribers[key])DB._subscribers[key](key,payload);
  return payload;
 }).finally(function(){DB._pulls[key]=null;});return DB._pulls[key];
};
DB.pushCollection=function(key){
 var data=DB.get(key),prior=DB._snapshot[key];
 var run=async function(){
  if(['bb_trades_history','bb_ai_quants','bb_earn_positions','bb_balance_history','bb_profit_modules'].indexOf(key)>=0)throw new Error('Orders and balances can only be changed through server transactions.');
  if(key==='bb_deposit_addresses'){await DB.rpc('bb_save_record',{p_token:DB.token(),p_collection:key,p_record:Object.assign({},data,{_version:DB._addressVersion||0})});}
  else{var old=prior?JSON.parse(prior):[];for(var item of data||[]){var before=old.find(function(r){return r.id===item.id;});if(JSON.stringify(before)!==JSON.stringify(item))await DB.rpc('bb_save_record',{p_token:DB.token(),p_collection:key,p_record:item});}}
  await DB.pullCollection(key);
 };
 var p=(DB._pushChains[key]||Promise.resolve()).catch(function(){}).then(run);DB._pushChains[key]=p;return p.catch(async function(e){await DB.pullCollection(key).catch(function(){});throw e;});
};
// Returns the saved record without waiting for the collection re-read; the
// caller renders from `result` and the next refresh brings the cache level.
DB.saveRecord=async function(key,item){var result=await DB.rpc('bb_save_record',{p_token:DB.token(),p_collection:key,p_record:item});DB.pullCollection(key).catch(function(e){DB._lastSyncError='Saved; refresh pending. '+DB.describeUserError(e);});return result;};
DB.pullAll=function(){var tasks=[DB.pullLocalUser()];if(DB.me&&DB.me.is_admin)tasks.push(DB.fetchUsersLive());DB.COLLECTIONS.forEach(function(k){tasks.push(DB.pullCollection(k));});return Promise.all(tasks);};
DB.TAB_MAP={deposits:['bb_deposit_requests','bb_deposit_addresses'],withdrawals:['bb_withdrawal_requests'],loans:['bb_loans'],kyc:['bb_kyc_submissions'],trades:['bb_trades_history'],earn:['bb_earn_positions'],aiquants:['bb_ai_quants'],support:['bb_support_tickets'],balances:['bb_balance_history'],analytics:['bb_trades_history','bb_earn_positions','bb_ai_quants'],dashboard:['bb_trades_history']};
DB.pullTab=function(tab){return Promise.all((DB.TAB_MAP[tab]||[]).map(DB.pullCollection));};
DB.settleRealTrades=function(){return [];}; // pricing/settlement belongs to the scheduler
DB.pullProfitModules=function(){return Promise.resolve();};DB.applyProfitModules=function(){};
DB.getAdminPassword=function(){return DB.pullLocalUser().then(function(){return null;});};
DB.saveAdminPassword=function(){return Promise.reject(new Error('Use your account password settings.'));};
DB._ticketMerge=function(local,server){return server;};DB._cleanTickets=function(a){return a||[];};DB._mergeById=function(local,server){return server;};
DB.broadcastUpdate=function(){};DB.subscribe=function(k,cb){DB._subscribers[k]=cb;};DB.unsubscribe=function(k){delete DB._subscribers[k];};
DB.whenReady=function(cb){DB.init();if(DB.ready)cb();};
// True when the cached trade list already holds an order whose expiry has passed.
// Any page can then drive settlement immediately, so leaving the trade screen
// never leaves a due trade waiting for the next scheduled pass. Both the real
// trade cache and the practice-account positions are checked.
DB.hasDueTrade=function(){
 try{
  var now=Date.now();
  var due=function(list,grace){
   if(!Array.isArray(list))return false;
   var wait=typeof grace==='number'?grace:1000;
   return list.some(function(p){
    if(!p||p.status!=='Active')return false;
    var end=Number(p.expiresAt)||(Number(p.startTime)+Number(p.dur)*1000);
    return Number.isFinite(end)&&end+wait<=now;
   });
  };
  return due(DB.get('bb_trade_positions'),1000)||due(DB.get('bb_demo_trades_pos'),0);
 }catch(e){return false;}
};
DB.startLocalPolling=function(interval){
 if(DB._pollTimer)return;
 async function poll(){if(document.hidden||!localStorage.getItem('bb_session_token')||DB._polling)return;DB._polling=true;try{
  // When a cached order is already past its expiry, settle first and wait for
  // it, so the balance pulled right after reflects the credited result in the
  // same pass instead of one poll later.
  if(DB.hasDueTrade()){await DB.settleDue(true);}else{DB.settleDue();}
  await DB.pullLocalUser();await Promise.all(DB.COLLECTIONS.map(DB.pullCollection));window.dispatchEvent(new CustomEvent('bb:updated'));}catch(e){DB._lastSyncError=DB.describeUserError(e);window.dispatchEvent(new CustomEvent('bb:sync-error',{detail:DB._lastSyncError}));}finally{DB._polling=false;}}
 DB._pollTimer=setInterval(poll,interval||5000);poll();window.addEventListener('online',poll);document.addEventListener('visibilitychange',poll);
};
DB.diagnose=function(){return{version:DB.VERSION,ready:DB.ready,lastError:DB._lastSyncError,lastPullAgoSec:DB._lastPullTime?Math.round((Date.now()-DB._lastPullTime)/1000):-1,realtime:false,serverTickets:(DB.get('bb_support_tickets')||[]).length};};
DB.init();
// Old browser sessions are never treated as authenticated.
if(localStorage.getItem('bb_uid')&&!localStorage.getItem('bb_session_token')){
 var page=(location.pathname.split('/').pop()||'index.html');
 if(['index.html','login.html','register.html','admin.html'].indexOf(page)<0)location.replace('login.html');
}
window.addEventListener('DOMContentLoaded',function(){if(localStorage.getItem('bb_session_token'))DB.startLocalPolling(5000);});
window.addEventListener('storage',function(e){if(e.key==='bb_session_token'&&!e.newValue&&location.pathname.indexOf('login')<0)location.replace('login.html');});

DB.logout=async function(){try{await DB.action('logout',{});}finally{DB.clearSession();location.href='login.html';}};
