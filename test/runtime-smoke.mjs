// Local-only workerd smoke. No Google requests or health data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions }=wranglerRequire('miniflare');
const options={workers:[{name:'smoke',modules:true,scriptPath:'dist-worker/index.js',compatibilityDate:'2026-08-01',
  durableObjects:{SYNC_STATE:{className:'SyncState',useSQLite:true}},kvNamespaces:['OAUTH_KV'],
  bindings:{SYNC_ENABLED:'false'}}]};
const mf=new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
try {
  const ns=await mf.getDurableObjectNamespace('SYNC_STATE');
  const stub=ns.get(ns.idFromName('oauth-smoke'));
  const call=async(path,body)=>(await stub.fetch('https://internal'+path,{method:'POST',body:JSON.stringify(body)})).json();
  assert.equal((await call('/flow/create',{browserHash:'b',expires:Date.now()+600000,info:{clientId:'test'}})).ok,true);
  assert.equal((await call('/flow/start',{browserHash:'b',verifier:'v'})).ok,true);
  const results=await Promise.all([call('/flow/consume',{browserHash:'b'}),call('/flow/consume',{browserHash:'b'})]);
  assert.equal(results.filter(r=>r.ok).length,1);
  const denied=await mf.dispatchFetch('http://localhost/mcp',{method:'POST',body:'{}'});
  assert.equal(denied.status,401);
  console.log('workerd: SQLite OAuth flow, atomic replay rejection and anonymous MCP denial passed');
} finally { await mf.dispose(); }
