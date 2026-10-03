// Advisory inference only. Never used for permission or execution decisions.
const destructive = new Set(['delete','remove','destroy','drop','truncate','revoke','purge','wipe']);
const mutating = new Set(['create','update','write','set','send','publish','execute','run','export','charge','pay','transfer','deploy','install','invite','approve','refund']);
const reading = new Set(['get','fetch','read','list','search','inspect','find','describe','count','lookup']);
const tokens = value => typeof value === 'string' ? value.replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase().split(/[^a-z0-9]+/) : [];
export function snapshotToolHints(value) {
  if(value === undefined)return undefined;
  if(!value || typeof value !== 'object' || Array.isArray(value))throw Error('Invalid tool annotations');
  const out={};
  for(const key of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'])if(value[key]!==undefined){
    if(typeof value[key]!=='boolean')throw Error('Invalid tool annotation hint');out[key]=value[key];
  }
  return Object.freeze(out);
}
const reasons={unknown:['insufficient_signals'],read_only:['annotation_read_only','name_read_only'],mutating:['annotation_mutating','name_mutating','schema_mutating','conflicting_hints'],destructive:['annotation_destructive','name_destructive','schema_destructive','conflicting_hints']};
export function snapshotToolEffect(value) {
  if(value===undefined)return undefined;
  if(!value || value.schema!==1 || !Object.hasOwn(reasons,value.level) || !reasons[value.level].includes(value.reason))throw Error('Invalid tool effect evidence');
  return Object.freeze({schema:1,level:value.level,reason:value.reason});
}
export function inferToolEffect(name,schema,hints) {
  const nameTokens=tokens(name);
  const schemaTokens=[];
  // Only inspect explicit operation selectors, never descriptions or free text.
  // No refs, nested schema resolution, arguments, network or model calls.
  for(const key of ['action','operation','method']){
    const selector=schema?.properties?.[key];
    for(const value of [selector?.const,...(Array.isArray(selector?.enum)?selector.enum.slice(0,64):[])]){
      if(typeof value!=='string'||value.length>128)continue;
      schemaTokens.push(...tokens(value));
      if(key==='method'&&['POST','PUT','PATCH'].includes(value.toUpperCase()))schemaTokens.push('write');
    }
  }
  let level='unknown',reason='insufficient_signals';
  if(nameTokens.some(t=>destructive.has(t))){level='destructive';reason='name_destructive';}
  else if(schemaTokens.some(t=>destructive.has(t))){level='destructive';reason='schema_destructive';}
  else if(hints?.readOnlyHint!==true&&hints?.destructiveHint===true){level='destructive';reason='annotation_destructive';}
  else if(nameTokens.some(t=>mutating.has(t))){level='mutating';reason='name_mutating';}
  else if(schemaTokens.some(t=>mutating.has(t))){level='mutating';reason='schema_mutating';}
  else if(hints?.readOnlyHint===false){level='mutating';reason='annotation_mutating';}
  else if(hints?.readOnlyHint===true){level='read_only';reason='annotation_read_only';}
  else if(nameTokens.some(t=>reading.has(t))){level='read_only';reason='name_read_only';}
  if(hints?.readOnlyHint===true&&['mutating','destructive'].includes(level))reason='conflicting_hints';
  return snapshotToolEffect({schema:1,level,reason});
}

// Configuration evidence only; never evaluates the customer's callbacks.
export function snapshotToolPermissions(value) {
  if(value===undefined)return undefined;
  if(!value || value.schema!==1 || !Number.isInteger(value.required_scopes) || value.required_scopes<0 || value.required_scopes>64 || value.application_authorization!==true || typeof value.additional_policy!=='boolean')throw Error('Invalid tool permission evidence');
  return Object.freeze({schema:1,required_scopes:value.required_scopes,application_authorization:true,additional_policy:value.additional_policy});
}
