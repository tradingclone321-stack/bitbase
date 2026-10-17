// No third-party runtime dependency. Quotes and privileged RPCs never run in a browser.
const env = (key: string) => Deno.env.get(key) || '';
const headers = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type,apikey,authorization,x-engine-secret','Content-Type':'application/json'};
const respond = (data: unknown, status=200) => new Response(JSON.stringify(data),{status,headers});
async function rpc(name: string, args: unknown, privileged=true) {
  const key=env(privileged?'SUPABASE_SERVICE_ROLE_KEY':'SUPABASE_ANON_KEY');
  const r=await fetch(env('SUPABASE_URL')+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(15000)});
  const body=await r.json();if(!r.ok)throw Object.assign(new Error(body.message||'Database request failed'),{code:body.code});return body;
}
const coins=new Set(['BTC','ETH','SOL','BNB','XRP','ADA','DOGE','DOT','AVAX','LINK','UNI','USDT']);
function symbol(pair: string){const [base,quote]=String(pair).split('/');if(!coins.has(base)||quote!=='USDT'||base==='USDT')throw Object.assign(new Error('This pair has no configured settlement feed'),{code:'P0001'});return base+quote;}
async function market(path: string){const r=await fetch('https://data-api.binance.vision/api/v3/'+path,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('Market feed unavailable ('+r.status+'); no balance changed');return await r.json();}
async function price(coin: string){if(coin==='USDT')return 1;const d=await market('ticker/price?symbol='+symbol(coin+'/USDT'));const p=Number(d.price);if(!Number.isFinite(p)||p<=0)throw new Error('Invalid market quote');return p;}
export async function handle(request: Request){
 if(request.method==='OPTIONS')return new Response(null,{headers});
 if(request.method!=='POST')return respond({error:'POST required'},405);
 try{
  const d=await request.json();
  if(d.action==='settle'){
   const secret=env('BITBASE_ENGINE_SECRET');
   const scheduler=!!secret&&request.headers.get('x-engine-secret')===secret;
   if(!scheduler){
    // A signed-in client may also drive a settlement pass. Prices are fetched
    // here, never supplied by the caller, so this cannot choose an outcome.
    if(typeof d.token!=='string'||d.token.length!==64)return respond({error:'Unauthorized scheduler'},401);
    try{await rpc('bb_read',{p_token:d.token,p_resource:'me'},false);}catch{return respond({error:'Sign in required',code:'28000'},401);}
   }
   let settled=0;const errors:string[]=[];
   const due=await rpc('bb_due_trades',{});
   // Four bounded workers. One unavailable symbol never blocks other accounts.
   const queue=[...due];
   await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{
    while(queue.length){const order=queue.shift();try{
     const t=Math.floor(Number(order.expiresAt)/1000)*1000;
     const bars=await market('klines?symbol='+symbol(order.pair)+'&interval=1s&startTime='+t+'&endTime='+(t+999)+'&limit=1');
     const bar=bars[0];if(!bar||Number(bar[0])!==t||Number(bar[6])!==t+999||Date.now()<t+1000)throw new Error('Expiry candle unavailable; will retry');
     await rpc('bb_settle_trade',{p_id:order.id,p_price:bar[4],p_candle_at:t});settled++;
    }catch(e){errors.push(order.id+': '+(e as Error).message);}}
   }));
   await rpc('bb_settle_accruals',{});
   await rpc('bb_engine_status',{p_error:errors.length?errors.join('; ').slice(0,3000):null,p_settled:settled});
   return respond({settled,pending:errors.length},errors.length?207:200);
  }
  if(typeof d.token!=='string'||d.token.length!==64)return respond({error:'Sign in required',code:'28000'},401);
  // Validate before fetching quotes; the financial RPC rechecks at commit.
  await rpc('bb_read',{p_token:d.token,p_resource:'me'},false);
  if(d.action==='trade'){
   symbol(d.pair);const p=await price(d.pair.split('/')[0]);
   return respond(await rpc('bb_place_trade',{p_token:d.token,p_request_id:d.requestId,p_pair:d.pair,p_direction:d.direction,p_amount:d.amount,p_duration:d.duration,p_price:p,p_quote_at:Date.now()}));
  }
  if(d.action==='convert'){
   if(!coins.has(d.from)||!coins.has(d.to))throw Object.assign(new Error('Unsupported conversion'),{code:'P0001'});
   const values=await Promise.all([price(d.from),price(d.to)]);
   return respond(await rpc('bb_convert',{p_token:d.token,p_id:d.requestId,p_from:d.from,p_to:d.to,p_amount:d.amount,p_rate:values[0]/values[1],p_quote_at:Date.now()}));
  }
  return respond({error:'Unknown action',code:'P0001'},400);
 }catch(e){const err=e as Error & {code?:string};return respond({error:err.message,code:err.code},err.code==='28000'?401:err.code?400:503);}
}
if(import.meta.main)Deno.serve(handle);
