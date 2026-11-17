import { configured, randomToken, hash, cookie, cookieValue, html, safeHeaders, stateCall } from './security';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const HEALTH_SCOPES = [
  'openid', 'email', 'https://www.googleapis.com/auth/spreadsheets',
  ...['activity_and_fitness', 'sleep', 'health_metrics_and_measurements', 'settings', 'nutrition']
    .map(s => 'https://www.googleapis.com/auth/googlehealth.' + s + '.readonly'),
  ...['health_metrics_and_measurements', 'nutrition']
    .map(s => 'https://www.googleapis.com/auth/googlehealth.' + s + '.writeonly'),
];

async function authorize(request: Request, env: any) {
  const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const client = await env.OAUTH_PROVIDER.lookupClient(info.clientId);
  if (!client || !client.redirectUris?.includes(info.redirectUri) ||
      !info.codeChallenge || info.codeChallengeMethod !== 'S256') throw new Error('INVALID_CLIENT');
  const allowed = JSON.parse(env.ALLOWED_REDIRECT_URIS || '[]');
  if (!allowed.includes(info.redirectUri) || new URL(info.redirectUri).protocol !== 'https:') {
    throw new Error('CLIENT_REDIRECT_NOT_ALLOWED');
  }
  const flow = randomToken(), browser = randomToken();
  await stateCall(env, 'oauth:' + flow, '/flow/create', {
    browserHash:await hash(browser), info, expires:Date.now() + 600_000
  });
  return new Response('<!doctype html><meta charset="utf-8"><title>Fitbit: подключение</title>' +
    '<body style="font-family:system-ui;max-width:46rem;margin:3rem auto">' +
    '<h1>Разрешить подключение?</h1><p>Клиент: ' + html(client.clientName || info.clientId) + '</p>' +
    '<p>Адрес возврата: <code>' + html(info.redirectUri) + '</code></p>' +
    '<p>Доступ: чтение здоровья, запись ручного веса/жира/воды и синхронизация с вашей таблицей. ' +
    'Разрешайте только собственному клиенту ChatGPT. Следующий экран — согласие Google.</p>' +
    '<form method="post" action="/consent"><input type="hidden" name="flow" value="' + flow + '">' +
    '<button type="submit">Разрешить и перейти в Google</button></form></body>', {
      headers:{...safeHeaders(), 'content-type':'text/html;charset=utf-8', 'set-cookie':cookie(browser)}
    });
}
async function consent(request: Request, env: any) {
  if (request.headers.get('origin') !== env.PUBLIC_ORIGIN) throw new Error('CSRF');
  const flow = String((await request.formData()).get('flow') || '');
  if (!/^[\w-]{43}$/.test(flow)) throw new Error('INVALID_FLOW');
  const browser = cookieValue(request);
  if (!browser) throw new Error('CSRF');
  const verifier = randomToken();
  const result = await stateCall(env, 'oauth:' + flow, '/flow/start', {
    browserHash:await hash(browser), verifier
  });
  if (!result.ok) throw new Error('INVALID_FLOW');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const params = new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,
    redirect_uri:env.PUBLIC_ORIGIN + '/callback', response_type:'code',
    scope:HEALTH_SCOPES.join(' '), access_type:'offline', prompt:'consent',
    state:flow, code_challenge:challenge, code_challenge_method:'S256'});
  return new Response(null,{status:302,headers:{...safeHeaders(),location:'https://accounts.google.com/o/oauth2/v2/auth?' + params}});
}
async function callback(request: Request, env: any) {
  const url = new URL(request.url), flow = url.searchParams.get('state') || '';
  const browser = cookieValue(request);
  if (!/^[\w-]{43}$/.test(flow) || !browser) throw new Error('CSRF');
  // Atomic consume before token exchange; KV get/delete would allow concurrent replay.
  const saved = await stateCall(env, 'oauth:' + flow, '/flow/consume', {browserHash:await hash(browser)});
  if (!saved.ok) throw new Error('INVALID_FLOW');
  if (url.searchParams.has('error') || !url.searchParams.get('code')) throw new Error('GOOGLE_CONSENT_REQUIRED');
  const resp = await fetch(GOOGLE_TOKEN_URL, {method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
      grant_type:'authorization_code',code:url.searchParams.get('code')!,
      redirect_uri:env.PUBLIC_ORIGIN + '/callback',code_verifier:saved.verifier}),
    signal:AbortSignal.timeout(15_000)});
  if (!resp.ok) throw new Error('GOOGLE_TOKEN_EXCHANGE_FAILED');
  const tokens:any = await resp.json();
  if (!tokens.access_token || !tokens.refresh_token ||
      !HEALTH_SCOPES.filter(s => s.startsWith('https:')).every(s => (tokens.scope || '').split(' ').includes(s))) {
    throw new Error('GOOGLE_SCOPES_OR_REFRESH_MISSING');
  }
  // Authenticate through Google's HTTPS UserInfo endpoint; never decode an unverified JWT.
  const identity = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers:{authorization:'Bearer ' + tokens.access_token},signal:AbortSignal.timeout(15_000)});
  if (!identity.ok) throw new Error('IDENTITY_FAILED');
  const user:any = await identity.json();
  if (!user.sub || user.email_verified !== true ||
      user.email?.toLowerCase() !== env.ALLOWED_GOOGLE_EMAIL.toLowerCase()) throw new Error('OWNER_ONLY');
  const {redirectTo} = await env.OAUTH_PROVIDER.completeAuthorization({request:saved.info,
    userId:user.sub,metadata:{label:user.email},scope:saved.info.scope,
    props:{authVersion:2,sub:user.sub,email:user.email,refreshToken:tokens.refresh_token,
      accessToken:tokens.access_token,accessTokenExpiresAt:Date.now() + tokens.expires_in * 1000}});
  return new Response(null,{status:302,headers:{...safeHeaders(),location:redirectTo,'set-cookie':cookie('',0)}});
}
export const GoogleAuthHandler = {
  async fetch(request: Request, env: any): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response('Fitbit Health Hub: MCP /mcp. Sheets sync requires protected OAuth and setup.',{headers:safeHeaders()});
    try {
      configured(env);
      if (new URL(request.url).origin !== env.PUBLIC_ORIGIN) throw new Error('WRONG_ORIGIN');
      if (request.method === 'GET' && path === '/authorize') return await authorize(request,env);
      if (request.method === 'POST' && path === '/consent') return await consent(request,env);
      if (request.method === 'GET' && path === '/callback') return await callback(request,env);
      return new Response('Not found',{status:404,headers:safeHeaders()});
    } catch {
      return new Response('Подключение не завершено. Проверьте настройки и начните подключение заново.',
        {status:400,headers:{...safeHeaders(),'set-cookie':cookie('',0)}});
    }
  }
};

