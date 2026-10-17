const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');
const {createDB,migrate}=require('./finance.test.cjs');
const root=path.resolve(__dirname,'..');
let db,server,browser;let checks=0;let quoteDown=false,dropReply=false,directUserReads=0;const pageErrors=[];
const log=msg=>{checks++;console.log('PASS '+msg);};
const rpc=async(name,args,role='anon')=>db.transaction(async t=>{await t.exec('set local role '+role);const keys=Object.keys(args);return(await t.query('select public.'+name+'('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+') as r',keys.map(k=>typeof args[k]==='object'&&args[k]!==null?JSON.stringify(args[k]):args[k]))).rows[0].r;});
const env={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',SUPABASE_ANON_KEY:'fixture-anon',BITBASE_ENGINE_SECRET:'fixture-scheduler-secret-00000000000000'};
const cors={'access-control-allow-origin':'*','access-control-allow-headers':'*','content-type':'application/json'};
async function api(url,init){
 const name=new URL(url).pathname.split('/').pop();try{const result=await rpc(name,JSON.parse(init.body||'{}'),new Headers(init.headers).get('apikey')==='fixture-service'?'service_role':'anon');return new Response(JSON.stringify(result),{headers:cors});}
 catch(e){return new Response(JSON.stringify({message:e.message,code:e.code}),{status:400,headers:cors});}
}
(async()=>{
 db=await createDB();await db.exec("insert into users(uid,name,email,password,cash_balance,is_admin) values(100001,'Admin','admin@example.test','admin-password',1000,true),(100002,'Alice','alice@example.test','alice-password',1000,false),(100003,'Bob','bob@example.test','bob-password',200,false);");await migrate(db);
 global.Deno={env:{get:k=>env[k]}};
 const originalFetch=global.fetch;
 global.fetch=async(url,init={})=>{
  const u=new URL(url);
  if(u.hostname==='fixture.supabase.co')return api(url,init);
  if(u.hostname==='data-api.binance.vision'){
   if(quoteDown)return new Response('{}',{status:503});
   if(u.pathname.endsWith('klines')){const t=Number(u.searchParams.get('startTime'));return Response.json([[t,'100','101','99','101','10',t+999]]);}
   return Response.json({price:'100'});
  }
  throw new Error('Unexpected external network '+u.hostname);
 };
 const {handle}=await import(pathToFileURL(path.join(root,'supabase/functions/trade-engine/index.ts')).href);
 const engine=body=>handle(new Request('https://fixture.supabase.co/functions/v1/trade-engine',{method:'POST',headers:{'content-type':'application/json','x-engine-secret':env.BITBASE_ENGINE_SECRET},body:JSON.stringify(body)}));
 await engine({action:'settle'});
 server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 let executable=process.env.CHROMIUM_EXECUTABLE_PATH;
 if(!executable){try{const c=require('@sparticuz/chromium');executable=await (c.default||c).executablePath();}catch{}}
 browser=await chromium.launch({headless:true,executablePath:executable,args:['--no-sandbox']});
 const sdk=fs.readFileSync(process.env.SUPABASE_TEST_SDK||path.join(path.dirname(require.resolve('@supabase/supabase-js')),'umd/supabase.js'),'utf8');
 async function context(options={}){const ctx=await browser.newContext();ctx.on('page',p=>p.on('pageerror',e=>pageErrors.push(e.message)));await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.hostname==='127.0.0.1'){
    if(options.legacyClient&&url.pathname==='/db.js')return route.fulfill({contentType:'application/javascript',body:"var DB={VERSION:'2026-09-22-user-registration-fix',ready:false};"});
    return route.continue();
   }
   if(url.hostname.endsWith('.supabase.co')){
    if(req.method()==='OPTIONS')return route.fulfill({status:200,headers:cors,body:''});
    if(url.pathname.startsWith('/rest/v1/rpc/')){const name=url.pathname.split('/').pop(),args=req.postDataJSON()||{};try{
     if(name==='bb_read'&&args.p_resource==='users'&&options.usersFault)return route.fulfill({status:400,headers:cors,body:JSON.stringify(options.usersFault)});
     const result=await rpc(name,args);
     if(name==='bb_read'&&args.p_resource==='users'&&options.holdUsers){const gate=options.holdUsers;options.holdUsers=null;gate.started();await gate.promise;}
     return route.fulfill({status:200,headers:cors,body:JSON.stringify(result)});
    }catch(e){return route.fulfill({status:400,headers:cors,body:JSON.stringify({message:e.message,code:e.code})});}}
    if(url.pathname.startsWith('/functions/')){const response=await handle(new Request(req.url(),{method:'POST',headers:req.headers(),body:req.postData()}));const body=await response.text();if(dropReply){dropReply=false;return route.abort('failed');}return route.fulfill({status:response.status,headers:cors,body});}
    if(url.pathname==='/rest/v1/users'){
     directUserReads++;
     try{await db.transaction(async t=>{await t.exec('set local role anon');await t.query('select uid from public.users');});throw new Error('User table unexpectedly public');}
     catch(e){if(e.code!=='42501')throw e;return route.fulfill({status:403,headers:cors,body:JSON.stringify({message:e.message,code:e.code})});}
    }
    return route.fulfill({status:403,headers:cors,body:'{"message":"direct table access disabled"}'});
   }
   if(url.href.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:options.missingSDK?'':sdk});
   if(url.href.includes('lucide'))return route.fulfill({contentType:'application/javascript',body:'window.lucide={createIcons:function(){}};'});
   if(url.href.includes('tailwind'))return route.fulfill({contentType:'application/javascript',body:'window.tailwind={config:{}};'});
   if(req.resourceType()==='script')return route.fulfill({contentType:'application/javascript',body:''});
   return route.fulfill({status:200,headers:cors,body:url.pathname.includes('ticker/24hr')?'[]':'{}'});
  });return ctx;}
 async function login(ctx,email,password){const page=await ctx.newPage();await page.goto(base+'/login.html');await page.fill('#email',email);await page.fill('#password',password);await page.click('#submitBtn');await page.waitForURL('**/dashboard.html');await page.waitForFunction(()=>!!localStorage.getItem('bb_session_token'));return page;}
 const userCtx=await context();let page=await login(userCtx,'alice@example.test','alice-password');
 assert.equal(await page.evaluate(()=>localStorage.getItem('bb_password')),null);log('real login form creates server session without caching password');
 const adminCtx=await context();const adminPage=await adminCtx.newPage();await adminPage.goto(base+'/admin.html');await adminPage.fill('#adminEmail','admin@example.test');await adminPage.fill('#adminPassword','admin-password');await adminPage.evaluate(()=>adminLogin());await adminPage.waitForFunction(()=>DB.me&&DB.me.is_admin);log('administrator email/password login is verified on server');
 await adminPage.evaluate(()=>refreshUsers());assert.match(await adminPage.locator('#usersSyncText').innerText(),/3 users loaded live/);assert.match(await adminPage.locator('#usersBody').innerText(),/alice@example.test/);log('admin table renders every registered account through the protected RPC');
 const legacyError=await adminPage.evaluate(async()=>(await DB.client.from('users').select('uid')).error);assert.equal(legacyError.code,'42501');await adminPage.evaluate(()=>refreshUsers());assert.match(await adminPage.locator('#usersSyncText').innerText(),/3 users loaded live/);log('legacy direct-table request reproduces 42501 while the current admin API succeeds');
 await page.goto(base+'/trade.html');await page.waitForFunction(()=>DB.me&&DB.me.uid===100002);await page.fill('#amtInput','100');await page.selectOption('#durSelect','60');await page.evaluate(()=>placeTrade('UP'));
 assert.equal(await page.evaluate(()=>localStorage.getItem('bb_cash_balance')),'900');const order=await page.evaluate(()=>DB.get('bb_trades_history').find(x=>x.status==='Active'));assert.ok(order);log('actual trade page debits 100 from 1000 after confirmed placement');
 await adminPage.evaluate(()=>DB.pullCollection('bb_trades_history'));await adminPage.evaluate(()=>refreshTrades());assert.ok((await adminPage.locator('#tradesBody').innerText()).includes(order.id));log('active trade appears in a separate admin browser');
 // Close all user and admin browsers before invoking the actual scheduler handler.
 await userCtx.close();await adminCtx.close();
 const expiry=Date.now()-4000;await db.query("update bb_orders set payload=payload||jsonb_build_object('expiresAt',$2::bigint) where id=$1",[order.id,expiry]);
 let response=await engine({action:'settle'});assert.equal(response.status,200);let body=await response.json();assert.equal(body.settled,1);response=await engine({action:'settle'});assert.equal((await response.json()).settled,0);log('actual price worker settles once with every browser closed');
 const freshCtx=await context();page=await login(freshCtx,'alice@example.test','alice-password');await page.evaluate(()=>DB.pullAll());assert.equal(await page.evaluate(()=>localStorage.getItem('bb_cash_balance')),'1020');assert.equal(await page.evaluate(()=>DB.get('bb_trades_history')[0].status),'Won');log('fresh device restores settled trade and 1020 balance');
 await page.goto(base+'/trade.html');await page.waitForFunction(()=>DB.me&&DB.me.uid===100002);await page.fill('#amtInput','10');dropReply=true;await page.evaluate(()=>placeTrade('UP'));const afterLost=(await db.query('select cash_balance from users where uid=100002')).rows[0].cash_balance;assert.equal(Number(afterLost),1010);
 await page.evaluate(()=>placeTrade('UP'));assert.equal(Number((await db.query('select cash_balance from users where uid=100002')).rows[0].cash_balance),1010);log('lost response and same-form retry do not debit twice');
 quoteDown=true;await page.fill('#amtInput','12');await page.evaluate(()=>placeTrade('UP'));assert.equal(Number((await db.query('select cash_balance from users where uid=100002')).rows[0].cash_balance),1010);quoteDown=false;await page.evaluate(()=>placeTrade('UP'));assert.equal(Number((await db.query('select cash_balance from users where uid=100002')).rows[0].cash_balance),998);log('price-provider outage changes no funds and recovers on retry');
 // Unauthenticated scheduler and client-provided settlement quotes denied.
 response=await handle(new Request('https://fixture.supabase.co/functions/v1/trade-engine',{method:'POST',body:JSON.stringify({action:'settle'})}));assert.equal(response.status,401);log('scheduler requires private secret');
 // Old cache tampering cannot become an absolute balance upload.
 await page.evaluate(async()=>{localStorage.setItem('bb_cash_balance','99999999');DB._localDirty=true;await DB.syncLocalUser(true);});assert.equal(await page.evaluate(()=>localStorage.getItem('bb_cash_balance')),'998');log('stale or edited local balances are overwritten from server, never uploaded');
 // Every main page loads under an authenticated session.
 for(const file of ['assets.html','history.html','ai-quants.html','earn.html','settings.html','demo.html','markets.html','dashboard.html']){await page.goto(base+'/'+file);await page.waitForFunction(()=>DB.me&&DB.me.uid===100002);await page.evaluate(async()=>{await DB.pullAll();window.dispatchEvent(new CustomEvent('bb:updated'));});}
 log('all eight account pages load and refresh against real SQL responses');
 await page.goto(base+'/demo.html');await page.waitForFunction(()=>DB.me&&DB.me.uid===100002);await page.fill('#amtInput','100');await page.evaluate(()=>placeTrade('UP'));
 assert.equal(Number((await db.query('select cash_balance from users where uid=100002')).rows[0].cash_balance),998);
 assert.equal(await page.evaluate(()=>DB.get('bb_demo_trades_bal')),99900);
 const demoId=await page.evaluate(()=>DB.get('bb_demo_trades_pos')[0].id);
 await page.evaluate(id=>closePos(id),demoId);await page.evaluate(id=>closePos(id),demoId);
 assert.equal(await page.evaluate(()=>DB.get('bb_demo_trades_bal')),99950);
 log('demo trades use separate durable funds and cannot double-refund');

 const adminOptions={};const secondAdmin=await context(adminOptions);const ap=await login(secondAdmin,'admin@example.test','admin-password');await ap.goto(base+'/admin.html');await ap.waitForFunction(()=>DB.me&&DB.me.is_admin);await ap.evaluate(()=>DB.pullAll());for(const tab of ['users','trades','withdrawals','loans','kyc','balances','deposits','earn','aiquants','analytics','activity'])await ap.evaluate(t=>switchTab(t),tab);await ap.evaluate(()=>refreshActivity());assert.ok((await ap.locator('#activityRows').innerText()).includes('trade.settled'));log('fresh administrator device restores all tabs and durable audit history');

 const signupCtx=await context(),sp=await signupCtx.newPage();await sp.goto(base+'/register.html');await sp.fill('#fullName','New Device User');await sp.fill('#email','newuser@example.test');await sp.fill('#password','newuser-password');await sp.fill('#confirm-password','newuser-password');const country=await sp.locator('#country option').evaluateAll(opts=>opts.find(x=>x.value).value);await sp.selectOption('#country',country);await sp.check('#terms');await sp.click('#submitBtn');await sp.waitForURL('**/dashboard.html');assert.equal(await sp.evaluate(()=>localStorage.getItem('bb_cash_balance')),'0');await ap.evaluate(()=>DB.fetchUsersLive());assert.ok((await ap.evaluate(()=>DB.cachedUsers())).some(u=>u.email==='newuser@example.test'));log('registration confirms server account and appears in separate admin device');
 await ap.evaluate(()=>refreshUsers());assert.match(await ap.locator('#usersBody').innerText(),/newuser@example.test/);assert.match(await ap.locator('#usersSyncText').innerText(),/4 users loaded live/);
 adminOptions.usersFault={message:'Connection unavailable'};await ap.evaluate(()=>refreshUsers());assert.match(await ap.locator('#usersSyncText').innerText(),/4 cached users/);assert.equal((await ap.evaluate(()=>DB.cachedUsers())).length,4);delete adminOptions.usersFault;await ap.evaluate(()=>refreshUsers());log('temporary user-list failure preserves confirmed cache and recovers on refresh');
 adminOptions.usersFault={code:'PGRST202',message:'Could not find bb_read'};await ap.evaluate(()=>refreshUsers());assert.match(await ap.locator('#usersSyncText').innerText(),/repair-finance.sql/);delete adminOptions.usersFault;await ap.evaluate(()=>refreshUsers());log('missing database RPC produces a specific installation instruction');
 await db.exec('update users set is_admin=false where uid=100001');await ap.evaluate(()=>refreshUsers());assert.match(await ap.locator('#usersSyncText').innerText(),/not an administrator/);assert.equal(await ap.evaluate(()=>localStorage.getItem('bb_admin_users')),null);assert.equal(await ap.locator('#usersBody tr button').count(),0);await db.exec('update users set is_admin=true where uid=100001');await ap.evaluate(()=>DB.loginUser('admin@example.test','admin-password'));await ap.evaluate(()=>{localStorage.setItem('bb_admin_logged_in','1');showAdminPanel();});await ap.evaluate(()=>refreshUsers());log('revoked administrator access removes cached users; restoring the role and signing in recovers');
 let started,release;const begun=new Promise(r=>started=r),gate=new Promise(r=>release=r);adminOptions.holdUsers={started,promise:gate};await ap.evaluate(()=>{window.delayedUsers=DB.fetchUsersLive().then(()=>null,e=>e.code);});await begun;await ap.evaluate(()=>DB.loginUser('alice@example.test','alice-password'));release();assert.equal(await ap.evaluate(()=>window.delayedUsers),'SESSION_CHANGED');assert.equal(await ap.evaluate(()=>localStorage.getItem('bb_admin_users')),null);assert.equal(await ap.evaluate(()=>DB.me.uid),100002);assert.deepEqual(await ap.evaluate(()=>DB.cachedUsers()),[]);log('late admin user-list response cannot overwrite a newly signed-in regular account');
 const mixed=await context({legacyClient:true}),mp=await mixed.newPage();await mp.goto(base+'/admin.html');assert.match(await mp.locator('#adminLoginError').innerText(),/different updates/);assert.ok(await mp.locator('#adminSignIn').isDisabled());await mp.evaluate(()=>adminLogin());assert.equal(await mp.locator('#adminPanel').isVisible(),false);await mixed.close();log('mixed old/new admin scripts stop with a clear redeployment instruction');
 const oldSession=await context();await oldSession.addInitScript(origin=>{if(location.origin!==origin)return;localStorage.setItem('bb_admin_logged_in','1');localStorage.setItem('bb_uid','100001');localStorage.setItem('bb_name','Cached profile');localStorage.setItem('bb_admin_users','[{"uid":"100001","name":"Cached profile"}]');},base);const op=await oldSession.newPage();await op.goto(base+'/admin.html');assert.equal(await op.locator('#adminPanel').isVisible(),false);assert.deepEqual(await op.evaluate(()=>getAllUsers()),[]);await oldSession.close();log('legacy browser login flags cannot reveal an admin registry or create a fake single-user list');
 const noSDK=await context({missingSDK:true}),np=await noSDK.newPage();await np.goto(base+'/admin.html');await np.fill('#adminEmail','admin@example.test');await np.fill('#adminPassword','admin-password');await np.evaluate(()=>adminLogin());assert.match(await np.locator('#adminLoginError').innerText(),/Database unavailable/);await noSDK.close();log('missing database SDK displays a persistent login error without opening admin');
 assert.equal(directUserReads,1);log('all normal admin and account screens avoid direct user-table reads');
 assert.deepEqual(pageErrors,[]);log('no uncaught page JavaScript errors during complete browser run');
 console.log('\n'+checks+' browser/worker integration checks passed. All remote calls were intercepted; no live service was touched.');
 global.fetch=originalFetch;
})().catch(e=>{console.error(e.stack||e);if(pageErrors.length)console.error('Page errors:',pageErrors);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.close();if(db)await db.close();});
