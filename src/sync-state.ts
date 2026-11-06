import { hash, canonical, owner, randomToken } from './security';
import { Sheets } from './sheets';
import { callTool } from './tools';

export function commandInput(tool: string, raw: string) {
  const field = ({log_weight:'weight_kg',log_body_fat:'percentage',log_water:'volume_ml'} as any)[tool];
  if (!field || typeof raw !== 'string' || raw.length > 2048) throw new Error('INVALID_COMMAND');
  let args:any;
  try { args = JSON.parse(raw); } catch { throw new Error('INVALID_COMMAND'); }
  if (!args || Array.isArray(args) || typeof args !== 'object' ||
      Object.keys(args).some(k => ![field,'datetime'].includes(k))) throw new Error('INVALID_COMMAND');
  const value = args[field];
  const limit = tool==='log_weight' ? 500 : tool==='log_water' ? 10000 : 100;
  if (typeof value !== 'number' || !Number.isFinite(value) || value<=0 || value>limit ||
      (tool==='log_body_fat' && value===100)) throw new Error('INVALID_COMMAND');
  if (typeof args.datetime !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(args.datetime) ||
      !Number.isFinite(Date.parse(args.datetime))) throw new Error('INVALID_COMMAND');
  return args;
}
export function dateRange(start: string, end: string) {
  for (const s of [start,end]) if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '') ||
    !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10)!==s) throw new Error('INVALID_DATES');
  const days = (Date.parse(end)-Date.parse(start))/86400000+1;
  if (days<1 || days>7) throw new Error('RANGE_MAX_7_DAYS');
}
export function safeCode(e: any) {
  return /^(SHEETS_HTTP_\d{3}|SHEET_SCHEMA_MISMATCH|SHEET_CAPACITY_REACHED|DUPLICATE_SHEET_KEY|COMMAND_ROW_CHANGED|GOOGLE_RECONNECT_REQUIRED|PAGINATION_INCOMPLETE|CELL_TOO_LARGE)$/.test(e?.message || '')
    ? e.message : 'SYNC_FAILED';
}

// Strongly consistent state, deliberately separate from eventually consistent OAuth KV.
// No health payloads or Google tokens are persisted here.
export class SyncState {
  constructor(public ctx: any, public env: any) {}
  async alarm() { await this.ctx.storage.deleteAll(); } // Only OAuth-flow instances set an alarm.
  async flow(path: string, body: any) {
    return this.ctx.storage.transaction(async (tx: any) => {
      const saved = await tx.get('flow');
      if (path==='/flow/create') {
        if (saved || !body.browserHash || body.expires < Date.now() || body.expires>Date.now()+601000) return {ok:false};
        await tx.put('flow',{...body,phase:'consent'});
        await tx.setAlarm(body.expires);
        return {ok:true};
      }
      if (!saved || saved.expires < Date.now() || saved.browserHash!==body.browserHash) return {ok:false};
      if (path==='/flow/start' && saved.phase==='consent') {
        await tx.put('flow',{...saved,phase:'google',verifier:body.verifier}); return {ok:true};
      }
      if (path==='/flow/consume' && saved.phase==='google') {
        await tx.delete('flow'); return {ok:true,info:saved.info,verifier:saved.verifier};
      }
      return {ok:false};
    });
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname, body:any = await request.json();
      if (path.startsWith('/flow/')) return Response.json(await this.flow(path,body));
      if (path!=='/sync') return new Response('Not found',{status:404});
      owner(this.env,body.props);
      if (this.env.SYNC_ENABLED!=='true') return Response.json({error:'SYNC_DISABLED'},{status:403});
      dateRange(body.start_date,body.end_date);
      const lease = randomToken();
      const acquired = await this.ctx.storage.transaction(async (tx:any) => {
        const active = await tx.get('lease');
        if (active && active.expires > Date.now()) return false;
        await tx.put('lease',{id:lease,expires:Date.now()+600000}); return true;
      });
      if (!acquired) return Response.json({error:'SYNC_BUSY'});
      try { return Response.json(await this.run(body)); }
      finally {
        await this.ctx.storage.transaction(async (tx:any) => {
          if ((await tx.get('lease'))?.id===lease) await tx.delete('lease');
        });
      }
    } catch { return Response.json({error:'SYNC_FAILED'},{status:400}); }
  }
  async process(sheets: Sheets, props: any, commands: any[][]) {
    const ids = new Set<string>();
    // Fail the whole batch before any side effect if IDs are duplicated or missing.
    const pending = commands.filter(r => r[0] || r[1] || r[2] || r[3]===true);
    for (const r of pending) {
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(r[0] || '') || ids.has(r[0])) throw new Error('INVALID_COMMAND_IDS');
      ids.add(r[0]);
    }
    let processed = 0, pendingCount = 0, reviewCount = 0;
    for (const row of pending) {
      const [id,tool,raw,approved] = row;
      if (approved!==true) continue;
      let args:any;
      try { args=commandInput(tool,raw); }
      catch {
        const invalid={status:'REJECTED',error:'INVALID_COMMAND',updatedAt:new Date().toISOString(),hash:''};
        await sheets.commandStatus(id,tool,raw,invalid); continue;
      }
      const digest = await hash(canonical({tool,args}));
      const key = 'command:' + await hash(this.env.SPREADSHEET_ID + ':' + id);
      let record:any = await this.ctx.storage.get(key);
      if (record) {
        if (record.hash!==digest) {
          await sheets.commandStatus(id,tool,raw,{...record,status:'CONFLICT',error:'ID_PAYLOAD_CONFLICT'});
          continue;
        }
        if (record.status==='IN_FLIGHT') {
          record={...record,status:'NEEDS_REVIEW',error:'INTERRUPTED_WRITE',updatedAt:new Date().toISOString()};
          await this.ctx.storage.put(key,record);
        }
        // A failed projection cannot trigger a second Health POST. Avoid unnecessary API calls.
        if (record.status==='ACCEPTED') pendingCount++;
        if (record.status==='NEEDS_REVIEW') reviewCount++;
        const projection=[record.status,record.attempts || 0,record.operation || '',record.error || '',record.updatedAt,record.hash];
        if (JSON.stringify(row.slice(4,10))!==JSON.stringify(projection)) await sheets.commandStatus(id,tool,raw,record);
        continue;
      }
      if (processed >= 10) continue;
      // Re-read approval + exact payload immediately before reserving and dispatching.
      const current = (await sheets.read('Commands','A2:J1000')).filter(r=>r[0]===id);
      if (current.length!==1 || current[0][1]!==tool || current[0][2]!==raw || current[0][3]!==true) continue;
      record={hash:digest,status:'IN_FLIGHT',attempts:1,updatedAt:new Date().toISOString()};
      await this.ctx.storage.put(key,record); // Durable reservation MUST precede the Health API write.
      try {
        const result = await callTool(tool,args,this.env,props);
        record={...record,operation:result.operation || '',
          status:result.done && result.createdPoint ? 'SUCCEEDED' : 'ACCEPTED',
          updatedAt:new Date().toISOString()};
      } catch {
        // Health create has no documented requestId. Never retry an ambiguous POST.
        record={...record,status:'NEEDS_REVIEW',error:'HEALTH_WRITE_UNCERTAIN',updatedAt:new Date().toISOString()};
      }
      await this.ctx.storage.put(key,record);
      await sheets.commandStatus(id,tool,raw,record);
      if (record.status==='ACCEPTED') pendingCount++;
      if (record.status==='NEEDS_REVIEW') reviewCount++;
      processed++;
    }
    return {submitted:processed,pending:pendingCount,review:reviewCount};
  }
  async pull(sheets: Sheets, props: any, start: string, end: string) {
    // Use a bounded seven-day window. Replay upserts the same logical keys.
    const activity = await callTool('get_activity',{start_date:start,end_date:end},this.env,props);
    const sleep = await callTool('get_sleep',{start_date:start,end_date:end},this.env,props);
    if (activity.warnings?.length) throw new Error('HEALTH_PARTIAL_READ');
    const stamp = new Date().toISOString(), daily:any[][]=[], records:any[][]=[];
    for (let d=start;d<=end;d=new Date(Date.parse(d)+86400000).toISOString().slice(0,10)) {
      const day=activity.days?.find((r:any)=>r.date===d);
      const sessions=sleep.sessions.filter((s:any)=>s.end?.slice(0,10)===d);
      // Missing source data stays blank; do not invent zero values.
      daily.push([d,day?.steps,day?.distanceKm,day?.activeCaloriesKcal,day?.totalCaloriesKcal,day?.floors,
        sessions.length ? sessions.reduce((n:number,s:any)=>n+(s.minutesAsleep||0),0) : '',
        stamp,day ? '' : 'NO_ACTIVITY_DATA']);
      for (const s of sessions) {
        if (!s.name) throw new Error('SOURCE_ID_MISSING');
        records.push([s.name,'sleep',d,JSON.stringify(s),stamp]);
      }
    }
    await sheets.upsert('Records',records);
    await sheets.upsert('Daily',daily);
    return daily.length;
  }
  async run(body: any) {
    const sheets = new Sheets(this.env,body.props);
    await sheets.init();
    const runId=randomToken(),started=new Date().toISOString();
    let pulled=0,processed=0,error='',status='SUCCEEDED';
    await sheets.upsert('Sync_Log',[[runId,started,'','RUNNING',0,0,'']]);
    try {
      pulled=await this.pull(sheets,body.props,body.start_date,body.end_date);
      if (body.process_commands===true) {
        const commands=await this.process(sheets,body.props,await sheets.read('Commands','A2:J1000'));
        processed=commands.submitted;
        if (commands.pending || commands.review) status='COMPLETED_WITH_PENDING';
      }
    } catch(e) { error=safeCode(e);status='FAILED'; }
    await sheets.upsert('Sync_Log',[[runId,started,new Date().toISOString(),status,pulled,processed,error]]);
    return {run_id:runId,status,pulled_days:pulled,processed_commands:processed,error_code:error};
  }
}
