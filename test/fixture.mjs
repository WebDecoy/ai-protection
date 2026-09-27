import {createServer} from 'node:http';
export async function fixture(t) {
  const state = {decision:'allow', status:200, mode:'enforce', calls:0, events:[], payload:null, configCalls:0, configStatus:200, reports:[], reportStatus:202};
  const server = createServer(async (req,res) => {
    if (req.url.endsWith('/config')) { state.configCalls++; res.writeHead(state.configStatus); return res.end(JSON.stringify({schema:1, mode:state.mode,
      property_id:'11111111-1111-4111-8111-111111111111', organization_id:'22222222-2222-4222-8222-222222222222', observe:true,enforce:true})); }
    if (req.url.endsWith('/reports')) {
      let body=''; for await (const chunk of req) body+=chunk;
      state.reports.push({body:JSON.parse(body),property:req.headers['x-webdecoy-property-id']});
      res.writeHead(state.reportStatus);return res.end('{}');
    }
    state.calls++;
    let body=''; for await (const chunk of req) body+=chunk;
    state.payload=JSON.parse(body);
    state.onDetect?.();
    res.writeHead(state.status);
    res.end(JSON.stringify({decision_mode:'unified_v1',decision:state.decision}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const options={webdecoyUrl:`http://127.0.0.1:${server.address().port}`,webdecoyKey:'fixture',
    propertyId:'11111111-1111-4111-8111-111111111111',scopeId:'chat',subjectSecret:'x'.repeat(32),
    reportToWebDecoy:false, resolveClientIP:()=> '192.0.2.1',onObservation:e=>state.events.push(e)};
  return {state, options};
}
