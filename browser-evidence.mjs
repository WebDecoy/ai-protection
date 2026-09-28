export function prepareBrowserOrigin(raw){
 if(raw===undefined)return null;
 const u=new URL(raw);
 if(u.protocol!=='https:'||u.origin!==raw||u.username||u.password)throw Error('browserEvidenceOrigin must be an exact HTTPS origin');
 return raw;
}
export function browserEvidenceInput(origin,property,headers){
 if(!origin)return undefined;
 const name='__Host-wd_runtime_'+property.toLowerCase();
 const entries=(headers.cookie??'').split(';').map(p=>p.trim()).filter(p=>p.startsWith(name+'='));
 const token=entries.length===1?entries[0].slice(name.length+1):'';
 return {origin,token:token.length<=4096&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)?token:''};
}
export function browserEvidenceCheck(status,mode){
 const known=['allow','block','challenge'].includes(status);
 return {id:'browser_evidence',source:'remote',mode,decision:known?(status==='block'?'deny':status):'unavailable',reason:'browser_evidence_'+(known||['missing','invalid'].includes(status)?status:'unsupported'),durationMs:0};
}
