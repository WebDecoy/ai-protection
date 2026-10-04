import {createRemoteJWKSet, jwtVerify, customFetch} from 'jose';

// Configure from trusted server settings, never token iss/jku or tool arguments.
export function createAuth0Authenticator({issuer, audience, resolveTenant, fetcher=fetch}) {
  const url=new URL(issuer);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash ||
    typeof audience!=='string' || !audience || typeof resolveTenant!=='function')throw Error('Invalid Auth0 configuration');
  const bounded=value=>typeof value==='string'&&value.isWellFormed()&&value.length>0&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
  const keys=createRemoteJWKSet(new URL('.well-known/jwks.json',url),{
    timeoutDuration:1000,cooldownDuration:30000,cacheMaxAge:600000,
    [customFetch]:async (target,options)=>{
      const response=await fetcher(target,{...options,redirect:'error'});
      if(response.status!==200)throw Error('JWKS unavailable');
      // Bound the keyset before jose parses it. No token is sent to this endpoint.
      const reader=response.body?.getReader();if(!reader)throw Error('Missing JWKS');
      const chunks=[];let size=0;
      try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw Error('JWKS too large');chunks.push(value);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      return new Response(Buffer.concat(chunks),{status:200,headers:{'Content-Type':'application/json'}});
    },
  });
  return async function authenticate(request,{signal}={}) {
    signal?.throwIfAborted();
    const authorization=request.headers.get('authorization');
    if(typeof authorization!=='string'||authorization.length>16384||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorization))throw Error('Bearer access token required');
    const {payload}=await jwtVerify(authorization.slice(7),keys,{
      issuer:url.href,audience,algorithms:['RS256'],requiredClaims:['sub','exp','iat'],clockTolerance:0,
    });
    signal?.throwIfAborted();
    if(!bounded(payload.sub) || !Number.isSafeInteger(payload.exp)||
      !Number.isSafeInteger(payload.iat)||payload.iat>Math.floor(Date.now()/1000)||
      typeof payload.scope!=='string'||payload.scope.length>4096 ||
      (payload.azp!==undefined && !bounded(payload.azp)) ||
      (payload.org_id!==undefined && !bounded(payload.org_id)) ||
      payload.act!==undefined || payload.may_act!==undefined)throw Error('Invalid caller claims');
    // Delegation chains are unsupported: do not silently treat the actor as the subject.
    const scopes=payload.scope.split(' ').filter(Boolean);
    if(scopes.length>64 || scopes.some(scope=>!bounded(scope)||!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)))throw Error('Invalid caller scopes');
    // A signed org_id still requires application membership/tenant mapping.
    // Never use a requested tenant from the body as this result.
    const tenant=await resolveTenant(Object.freeze({issuer:url.href,subject:payload.sub,
      clientId:payload.azp,organizationId:payload.org_id}),{signal});
    signal?.throwIfAborted();
    if(!bounded(tenant))throw Error('Tenant membership required');
    return {schema:1,subject:payload.sub,tenant,issuer:url.href,authenticationMethod:'oauth-access-token',
      expiresAt:payload.exp*1000,scopes,
      ...(payload.azp ? {clientId:payload.azp} : {})};
  };
}
