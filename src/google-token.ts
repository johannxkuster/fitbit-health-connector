import { GOOGLE_TOKEN_URL } from './google-auth';
import { owner } from './security';

// Access tokens are held only for this request. No plaintext access-token KV cache.
export async function googleAccessToken(env: any, props: any): Promise<string> {
  owner(env, props);
  if (props.accessToken && props.accessTokenExpiresAt > Date.now() + 30_000) return props.accessToken;
  if (!props.refreshToken) throw new Error('GOOGLE_RECONNECT_REQUIRED');
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
      grant_type:'refresh_token',refresh_token:props.refreshToken}),
    signal:AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('GOOGLE_RECONNECT_REQUIRED');
  const token:any = await response.json();
  if (!token.access_token) throw new Error('GOOGLE_RECONNECT_REQUIRED');
  return token.access_token;
}
