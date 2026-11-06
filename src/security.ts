export const COOKIE = '__Host-fitbit-flow';
export function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function owner(env: any, props: any) {
  if (!env.ALLOWED_GOOGLE_EMAIL || !props?.sub || props.authVersion !== 2 ||
      props.email?.toLowerCase() !== env.ALLOWED_GOOGLE_EMAIL.toLowerCase()) {
    throw new Error('OWNER_AUTH_REQUIRED');
  }
}
export function configured(env: any) {
  if (!env.PUBLIC_ORIGIN || new URL(env.PUBLIC_ORIGIN).protocol !== 'https:' ||
      new URL(env.PUBLIC_ORIGIN).origin !== env.PUBLIC_ORIGIN ||
      !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET ||
      !env.ALLOWED_GOOGLE_EMAIL || !env.SYNC_STATE) throw new Error('SETUP_REQUIRED');
}
export function cookieValue(request: Request) {
  return request.headers.get('cookie')?.split(';').map(s => s.trim())
    .find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
}
export function cookie(value: string, age = 600) {
  return COOKIE + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + age;
}
export function html(s: string) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]!));
}
export function safeHeaders() {
  return {'cache-control':'no-store', 'referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff', 'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
}
export async function stateCall(env: any, name: string, path: string, body: any) {
  const stub = env.SYNC_STATE.get(env.SYNC_STATE.idFromName(name));
  const r = await stub.fetch('https://internal' + path, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)
  });
  if (!r.ok) throw new Error('STATE_UNAVAILABLE');
  return r.json() as Promise<any>;
}
