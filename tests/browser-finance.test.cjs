const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');
const {createDB,migrate}=require('./finance.test.cjs');
const root=path.resolve(__dirname,'..');
let db,server,browser;let checks=0;let quoteDown=false,dropReply=false;const pageErrors=[];
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
 async function context(){const ctx=await browser.newContext();ctx.on('page',p=>p.on('pageerror',e=>pageErrors.push(e.message)));await ctx.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.hostname==='127.0.0.1')return route.continue();
   if(url.hostname.endsWith('.supabase.co')){
    if(req.method()==='OPTIONS')return route.fulfill({status:200,headers:cors,body:''});
    if(url.pathname.startsWith('/rest/v1/rpc/')){const name=url.pathname.split('/').pop();try{const result=await rpc(name,req.postDataJSON()||{});return route.fulfill({status:200,headers:cors,body:JSON.stringify(result)});}catch(e){return route.fulfill({status:400,headers:cors,body:JSON.stringify({message:e.message,code:e.code})});}}
    if(url.pathname.startsWith('/functions/')){const response=await handle(new Request(req.url(),{method:'POST',headers:req.headers(),body:req.postData()}));const body=await response.text();if(dropReply){dropReply=false;return route.abort('failed');}return route.fulfill({status:response.status,headers:cors,body});}
    return route.fulfill({status:403,headers:cors,body:'{"message":"direct table access disabled"}'});
   }
   if(url.href.includes('supabase-js'))return route.fulfill({contentType:'application/javascript',body:sdk});
   if(url.href.includes('lucide'))return route.fulfill({contentType:'application/javascript',body:'window.lucide={createIcons:function(){}};'});
   if(url.href.includes('tailwind'))return route.fulfill({contentType:'application/javascript',body:'window.tailwind={config:{}};'});
   if(req.resourceType()==='script')return route.fulfill({contentType:'application/javascript',body:''});
   return route.fulfill({status:200,headers:cors,body:url.pathname.includes('ticker/24hr')?'[]':'{}'});
  });return ctx;}
 async function login(ctx,email,password){const page=await ctx.newPage();await page.goto(base+'/login.html');await page.fill('#email',email);await page.fill('#password',password);await page.click('#submitBtn');await page.waitForURL('**/dashboard.html');await page.waitForFunction(()=>!!localStorage.getItem('bb_session_token'));return page;}
 const userCtx=await context();let page=await login(userCtx,'alice@example.test','alice-password');
 assert.equal(await page.evaluate(()=>localStorage.getItem('bb_password')),null);log('real login form creates server session without caching password');
 const adminCtx=await context();const adminPage=await adminCtx.newPage();await adminPage.goto(base+'/admin.html');await adminPage.fill('#adminEmail','admin@example.test');await adminPage.fill('#adminPassword','admin-password');await adminPage.evaluate(()=>adminLogin());await adminPage.waitForFunction(()=>DB.me&&DB.me.is_admin);log('administrator email/password login is verified on server');
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

 const secondAdmin=await context();const ap=await login(secondAdmin,'admin@example.test','admin-password');await ap.goto(base+'/admin.html');await ap.waitForFunction(()=>DB.me&&DB.me.is_admin);await ap.evaluate(()=>DB.pullAll());for(const tab of ['users','trades','withdrawals','loans','kyc','balances','deposits','earn','aiquants','analytics','activity'])await ap.evaluate(t=>switchTab(t),tab);await ap.evaluate(()=>refreshActivity());assert.ok((await ap.locator('#activityRows').innerText()).includes('trade.settled'));log('fresh administrator device restores all tabs and durable audit history');

 const signupCtx=await context(),sp=await signupCtx.newPage();await sp.goto(base+'/register.html');await sp.fill('#fullName','New Device User');await sp.fill('#email','newuser@example.test');await sp.fill('#password','newuser-password');await sp.fill('#confirm-password','newuser-password');const country=await sp.locator('#country option').evaluateAll(opts=>opts.find(x=>x.value).value);await sp.selectOption('#country',country);await sp.check('#terms');await sp.click('#submitBtn');await sp.waitForURL('**/dashboard.html');assert.equal(await sp.evaluate(()=>localStorage.getItem('bb_cash_balance')),'0');await ap.evaluate(()=>DB.fetchUsersLive());assert.ok((await ap.evaluate(()=>DB.cachedUsers())).some(u=>u.email==='newuser@example.test'));log('registration confirms server account and appears in separate admin device');
 assert.deepEqual(pageErrors,[]);log('no uncaught page JavaScript errors during complete browser run');
 console.log('\n'+checks+' browser/worker integration checks passed. All remote calls were intercepted; no live service was touched.');
 global.fetch=originalFetch;
})().catch(e=>{console.error(e.stack||e);if(pageErrors.length)console.error('Page errors:',pageErrors);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)server.close();if(db)await db.close();});
