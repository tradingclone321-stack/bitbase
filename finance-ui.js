/* Shared confirmation, error presentation, and account refresh for mutations. */
var FinanceUI={busy:new Set()};
FinanceUI.message=function(text,error){var n=document.createElement('div');n.setAttribute('role',error?'alert':'status');n.textContent=text;n.style.cssText='position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;max-width:90vw;padding:14px 20px;border-radius:10px;background:'+(error?'#701b24':'#14583d')+';color:white;box-shadow:0 6px 30px #0006';document.body.appendChild(n);setTimeout(function(){n.remove();},6500);};
// An account refresh must never delay the answer to a click. Waiting for
// every collection to come back is what made buttons and replies feel slow, so
// the confirmation is shown as soon as the server accepts the change and the
// refresh runs in the background. Overlapping clicks share one refresh pass.
var _refreshChain=null,_refreshAgain=false;
function refreshInBackground(){
 if(_refreshChain){_refreshAgain=true;return _refreshChain;}
 _refreshChain=Promise.resolve().then(function(){return DB.pullAll();}).then(function(){
  window.dispatchEvent(new CustomEvent('bb:updated'));
 },function(syncError){
  window.dispatchEvent(new CustomEvent('bb:sync-error',{detail:'Action saved. Refresh pending. '+DB.describeUserError(syncError)}));
 }).finally(function(){
  _refreshChain=null;
  if(_refreshAgain){_refreshAgain=false;refreshInBackground();}
 });
 return _refreshChain;
}
FinanceUI.refresh=refreshInBackground;
FinanceUI.run=async function(key,work,message){if(FinanceUI.busy.has(key))return;FinanceUI.busy.add(key);try{var result=await work();if(message)FinanceUI.message(typeof message==='function'?message(result):message,false);refreshInBackground();return result;}catch(e){FinanceUI.message(DB.describeUserError(e),true);throw e;}finally{FinanceUI.busy.delete(key);}};
FinanceUI.do=function(key,work,message){return FinanceUI.run(key,work,message).catch(function(){});};
window.addEventListener('bb:sync-error',function(e){var n=document.getElementById('serverSyncStatus');if(!n){n=document.createElement('div');n.id='serverSyncStatus';n.style.cssText='position:fixed;bottom:65px;right:12px;max-width:340px;background:#701b24;color:#fff;font-size:12px;padding:10px 14px;z-index:99999;border-radius:8px';document.body.appendChild(n);}n.textContent='Sync unavailable — cached data. '+e.detail;});
window.addEventListener('bb:updated',function(){var n=document.getElementById('serverSyncStatus');if(n)n.remove();});
