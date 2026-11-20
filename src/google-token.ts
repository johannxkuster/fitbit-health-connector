import { GOOGLE_TOKEN_URL, HEALTH_SCOPES } from './google-auth';
import { owner } from './security';

// Access tokens are held only for this request. No plaintext access-token KV cache.
const healthScopes = HEALTH_SCOPES.filter(s => s.startsWith('https://www.googleapis.com/auth/googlehealth.'));
const pendingHealthTokens = new WeakMap<object, Promise<string>>();

export async function googleAccessToken(env: any, props: any, healthOnly = false): Promise<string> {
  owner(env, props);
  if (!healthOnly && props.accessToken && props.accessTokenExpiresAt > Date.now() + 30_000) return props.accessToken;
  if (!props.refreshToken) throw new Error('GOOGLE_RECONNECT_REQUIRED');
  if (healthOnly) {
    let pending = pendingHealthTokens.get(props);
    if (!pending) {
      pending = refreshToken(env, props, healthScopes.join(' '));
      pendingHealthTokens.set(props, pending);
      pending.finally(() => pendingHealthTokens.delete(props)).catch(() => {});
    }
    return pending;
  }
  return refreshToken(env, props);
}

async function refreshToken(env: any, props: any, scope?: string): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
      grant_type:'refresh_token',refresh_token:props.refreshToken,...(scope ? {scope} : {})}),
    signal:AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('GOOGLE_RECONNECT_REQUIRED');
  const token:any = await response.json();
  if (!token.access_token) throw new Error('GOOGLE_RECONNECT_REQUIRED');
  if (scope) {
    const requested = new Set(scope.split(' '));
    const granted = typeof token.scope === 'string' ? token.scope.split(' ').filter(Boolean) : [];
    if (!granted.length || granted.some((s:string) => !requested.has(s)) ||
        [...requested].some(s => !granted.includes(s))) throw new Error('GOOGLE_SCOPED_TOKEN_REQUIRED');
  }
  return token.access_token;
}
