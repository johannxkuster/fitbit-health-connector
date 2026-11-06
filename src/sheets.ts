import { googleAccessToken } from './google-token';

export const SCHEMA: Record<string, string[]> = {
  Daily:['date','steps','distance_km','active_kcal','total_kcal','floors','sleep_minutes','synced_at','warnings'],
  Records:['record_id','kind','date','data_json','synced_at'],
  Commands:['command_id','tool','arguments_json','approved','status','attempts','operation','error_code','updated_at','payload_hash'],
  Sync_Log:['run_id','started_at','finished_at','status','pulled_days','processed_commands','error_code'],
};
export class Sheets {
  token = '';
  constructor(public env: any, public props: any) {}
  async init() {
    if (!/^[\w-]{20,}$/.test(this.env.SPREADSHEET_ID || '')) throw new Error('SHEET_SETUP_REQUIRED');
    this.token = await googleAccessToken(this.env,this.props);
    for (const [tab, header] of Object.entries(SCHEMA)) {
      const rows = await this.read(tab,'A1:J1');
      if (JSON.stringify(rows[0]) !== JSON.stringify(header)) throw new Error('SHEET_SCHEMA_MISMATCH');
    }
  }
  async call(path: string, method = 'GET', body?: any) {
    const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + this.env.SPREADSHEET_ID + path, {
      method, headers:{authorization:'Bearer ' + this.token, 'content-type':'application/json'},
      body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(15_000)
    });
    if (!r.ok) throw new Error('SHEETS_HTTP_' + r.status);
    return r.json() as Promise<any>;
  }
  async read(tab: string, range: string) {
    const r = await this.call('/values/' + encodeURIComponent("'" + tab + "'!" + range) + '?valueRenderOption=UNFORMATTED_VALUE');
    return (r.values || []) as any[][];
  }
  async write(tab: string, range: string, values: any[][]) {
    // RAW prevents formula injection from health data and command strings.
    return this.call('/values/' + encodeURIComponent("'" + tab + "'!" + range) + '?valueInputOption=RAW','PUT',{values});
  }
  async upsert(tab: string, rows: any[][]) {
    if (!rows.length) return;
    const width = SCHEMA[tab].length, end = String.fromCharCode(64 + width);
    const old = await this.read(tab,'A2:' + end + '1000');
    const indexes = new Map<string,number>();
    old.forEach((r,i) => { if (r[0]) {
      if (indexes.has(String(r[0]))) throw new Error('DUPLICATE_SHEET_KEY');
      indexes.set(String(r[0]),i+2);
    }});
    let next = old.length + 2;
    const data = rows.map(row => {
      let index = indexes.get(String(row[0]));
      if (!index) { index = next++; indexes.set(String(row[0]),index); }
      if (index > 1000) throw new Error('SHEET_CAPACITY_REACHED');
      if (row.some(v => typeof v === 'string' && v.length > 45000)) throw new Error('CELL_TOO_LARGE');
      return {range:"'" + tab + "'!A" + index + ':' + end + index,values:[row.map(v => v ?? '')]};
    });
    await this.call('/values:batchUpdate','POST',{valueInputOption:'RAW',data});
  }
  async commandStatus(id: string, tool: string, raw: string, status: any) {
    // Locate by identity again: never trust a stale row number after a user sorts/deletes rows.
    const rows = await this.read('Commands','A2:J1000');
    const matches = rows.map((r,i)=>({r,i})).filter(({r})=>r[0]===id);
    if (matches.length !== 1 || matches[0].r[1]!==tool || matches[0].r[2]!==raw) {
      throw new Error('COMMAND_ROW_CHANGED');
    }
    const index = matches[0].i + 2;
    await this.write('Commands','E'+index+':J'+index,[[
      status.status,status.attempts || 0,status.operation || '',status.error || '',status.updatedAt,status.hash
    ]]);
  }
}
