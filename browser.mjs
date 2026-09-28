// Browser-only optional entrypoint; no server key, Node imports or scoring code.
export function prepareBrowserEvidence({timeoutMs=1500}={}) {
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('Invalid browser evidence timeout');
 if(typeof window==='undefined'||typeof window.dispatchEvent!=='function')return Promise.resolve({available:false});
 return new Promise(resolve=>{
  let ended=false;
  const finish=available=>{if(ended)return;ended=true;clearTimeout(timer);resolve({available:available===true})};
  const timer=setTimeout(()=>finish(false),timeoutMs);
  try{window.dispatchEvent(new CustomEvent('webdecoy:runtime-prepare',{detail:{done:finish}}))}catch{finish(false)}
 });
}
