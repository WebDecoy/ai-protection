// Bound control-plane responses independently of the customer's model stream.
export async function readJSON(response, maxBytes = 65536) {
 const reader=response.body?.getReader();
 if(!reader)throw Error('Missing WebDecoy response');
 let size=0;const chunks=[];
 try {
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
   if(size>maxBytes)throw Error('Oversized WebDecoy response');chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Each waiter owns cancellation, even when an account refresh is shared.
export async function abortable(promise, signal) {
 if(signal.aborted){Promise.resolve(promise).catch(()=>{});signal.throwIfAborted();}
 let listener;
 const aborted=new Promise((_,reject)=>{listener=()=>reject(signal.reason);signal.addEventListener('abort',listener,{once:true});});
 try{return await Promise.race([promise,aborted]);}
 finally{signal.removeEventListener('abort',listener);}
}
