import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {verifyAuth0} from '../verify-auth0.mjs';
const keys=await generateKeyPair('RS256');
const jwk={...await exportJWK(keys.publicKey),kid:'owned',alg:'RS256',use:'sig'};
const issuer='https://fixture.auth0.com/',resource='https://owned.example/mcp';
async function config(overrides={}){
 const token=await new SignJWT({sub:'private-subject',org_id:'private-org',iss:issuer,aud:resource,scope:'records:read',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,...overrides}).setProtectedHeader({alg:'RS256',kid:'owned'}).sign(keys.privateKey);
 return {issuer,resource,subject:'private-subject',organization:'private-org',token,fetcher:async(url,options)=>{
  assert.equal(String(url),issuer+'.well-known/jwks.json');assert.ok(!JSON.stringify(options).includes(token));return Response.json({keys:[jwk]});
 }};
}
test('provider verification runs real MCP client and returns only sanitized evidence',async()=>{
 const c=await config();const result=await verifyAuth0(c);
 assert.equal(result.passed,true);assert.equal(result.allowed_callbacks,1);assert.equal(result.forbidden_callbacks,0);
 for(const secret of [c.token,c.subject,c.organization,issuer,resource])assert.ok(!JSON.stringify(result).includes(secret));
});
for(const [name,claims] of [['wrong audience',{aud:'wrong'}],['expired',{exp:1}],['delegated',{act:{sub:'actor'}}],['overprivileged',{scope:'records:read records:export'}]])test('provider verification rejects '+name,async()=>{await assert.rejects(verifyAuth0(await config(claims)));});
test('provider verification requires configured membership',async()=>{const c=await config();await assert.rejects(verifyAuth0({...c,subject:'different'}));});

test('CLI errors never print token file contents',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const dir=await mkdtemp(join(tmpdir(),'wd-auth0-file-'));
 try {
  const path=join(dir,'token');const secret='private-token-that-must-not-be-printed';
  await writeFile(path,secret,{mode:0o644});
  const result=spawnSync(process.execPath,[new URL('../verify-auth0.mjs',import.meta.url).pathname],{env:{...process.env,AUTH0_TOKEN_FILE:path},encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);assert.match(result.stderr,/Auth0 verification failed/);
  assert.ok(!(result.stdout+result.stderr).includes(secret));
 } finally {await rm(dir,{recursive:true,force:true});}
});
