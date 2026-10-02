// Deterministic local fixture. No HTTP listener, model calls, or paid services.
import assert from 'node:assert/strict';
import {createActionProtection, ActionDenied} from '../../actions.mjs';

// A real server resolves its own validated session/token. Never accept a tool
// argument or a header saying "tenant-a" as proof of tenant membership.
const sessions = new Map([['fixture-session', {
  schema:1,subject:'reader-1',tenant:'tenant-a',issuer:'local-fixture',
  authenticationMethod:'fixture-session',expiresAt:Date.now()+60000,scopes:['record:read'],
}]]);
const records = new Map([['record-a',{tenant:'tenant-a',text:'Authorized record'}],
  ['record-b',{tenant:'tenant-b',text:'Other customer record'}]]);
let reads=0, exports=0;
const events=[];
const protection = createActionProtection({
  policyVersion:'records_v1',
  authenticate:session => sessions.get(session),
  onEvent:event => events.push(event),
  actions:{
    'records.read':{
      requiredScopes:['record:read'],
      validate:args => args !== null && typeof args==='object' &&
        Object.keys(args).length===1 && typeof args.recordId==='string',
      authorize:({caller,args}) => records.get(args.recordId)?.tenant===caller.tenant,
      execute:({caller,args}) => {
        // In production, scope the actual database query/transaction by tenant.
        // Re-check here: ownership can change after a preflight check.
        const row=records.get(args.recordId);
        if(row?.tenant!==caller.tenant)throw Error('Ownership changed');
        reads++;return row.text;
      },
    },
    'records.export':{
      requiredScopes:['record:export'],validate:args=>args===null,
      authorize:()=>false, // This fixture has no export entitlement.
      execute:()=>{exports++;throw Error('Must never execute');},
    },
  },
});
assert.equal(await protection.run('records.read',{recordId:'record-a'},'fixture-session'),'Authorized record');
for(const [action,args,session,reason] of [
  ['records.read',{recordId:'record-b'},'fixture-session','permission_denied'],
  ['records.export',null,'fixture-session','missing_scope'],
  ['records.read',{recordId:'record-a'},'forged-session','authentication_required'],
])await assert.rejects(protection.run(action,args,session),e=>e instanceof ActionDenied&&e.reason===reason);
assert.equal(reads,1);assert.equal(exports,0);
console.log(JSON.stringify({reads,exports,outcomes:events.map(({action,decision,reason,outcome})=>({action,decision,reason,outcome}))},null,2));
