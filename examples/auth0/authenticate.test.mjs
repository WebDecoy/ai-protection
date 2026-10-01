import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createAuth0Authenticator} from './authenticate.mjs';
import {createActionProtection,ActionDenied} from '../../actions.mjs';
const issuer='https://example.auth0.com/',audience='https://records.example/api';
const pair=await generateKeyPair('RS256');const jwk={...await exportJWK(pair.publicKey),kid:'fixture',alg:'RS256',use:'sig'};
async function signed(overrides={},key=pair.privateKey){return new SignJWT({sub:'reader',iss:issuer,aud:audience,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,scope:'record:read',org_id:'org_a',azp:'client_a',...overrides}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(key);}
function fixture(){let calls=0,fetches=0;const auth=createAuth0Authenticator({issuer,audience,
 fetcher:async(url,options)=>{fetches++;assert.equal(String(url),issuer+'.well-known/jwks.json');assert.equal(options.redirect,'error');assert.ok(!JSON.stringify(options).includes('Bearer'));return Response.json({keys:[jwk]});},
 resolveTenant:({subject,organizationId})=>subject==='reader'&&organizationId==='org_a'?'tenant_a':null});
 const guard=createActionProtection({policyVersion:'v1',authenticate:auth,actions:{read:{requiredScopes:['record:read'],validate:()=>true,authorize:({caller,args})=>caller.tenant===args.tenant,execute:()=>{calls++;return 'record';}}}});
 return {calls:()=>calls,fetches:()=>fetches,run:async(token,tenant='tenant_a')=>guard.run('read',{tenant},new Request('https://records.example/api',{headers:{authorization:'Bearer '+token}}))};}
test('verified access token reaches tenant-scoped action and cached keys',async()=>{const f=fixture(),token=await signed();assert.equal(await f.run(token),'record');assert.equal(await f.run(token),'record');assert.equal(f.fetches(),1);assert.equal(f.calls(),2);});
for(const [name,claims] of [['wrong issuer',{iss:'https://evil.example/'}],['wrong audience',{aud:'client_a'}],['expired',{exp:1}],['future not-before',{nbf:Math.floor(Date.now()/1000)+100}],['future issued-at',{iat:Math.floor(Date.now()/1000)+100}],['wrong organization',{org_id:'org_b'}],['missing expiry',{exp:undefined}],['missing scope',{scope:''}]])test(name+' executes nothing',async()=>{const f=fixture();await assert.rejects(f.run(await signed(claims)),e=>e instanceof ActionDenied);assert.equal(f.calls(),0);});
test('cross-tenant input cannot override authenticated membership',async()=>{const f=fixture();await assert.rejects(f.run(await signed(),'tenant_b'),e=>e.reason==='permission_denied');assert.equal(f.calls(),0);});
test('invalid signature is rejected',async()=>{const other=await generateKeyPair('RS256'),f=fixture();await assert.rejects(f.run(await signed({},other.privateKey)),e=>e.reason==='authentication_required');assert.equal(f.calls(),0);});
test('unsigned token rejected',async()=>{const f=fixture();await assert.rejects(f.run('eyJhbGciOiJub25lIn0.e30.'),e=>e.reason==='authentication_required');assert.equal(f.calls(),0);});
test('JWKS outage fails before tenant lookup or action',async()=>{let resolved=0;const auth=createAuth0Authenticator({issuer,audience,fetcher:async()=>new Response('',{status:503}),resolveTenant:()=>{resolved++;return 'tenant_a';}});await assert.rejects(auth(new Request('https://api.example',{headers:{authorization:'Bearer '+await signed()}})));assert.equal(resolved,0);});
test('unexpected signing algorithm is rejected',async()=>{const token=await new SignJWT({sub:'reader',iss:issuer,aud:audience,exp:Math.floor(Date.now()/1000)+60}).setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode('fixture-signing-secret-at-least-32-bytes'));const f=fixture();await assert.rejects(f.run(token),e=>e.reason==='authentication_required');assert.equal(f.calls(),0);});
