import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { BillingError, json, b64, browserCookie, rawCookie, readCookie, limitedJSON, sameOrigin } from './shared.mjs';

const encoder = new TextEncoder();
const SESSION_AGE = 30 * 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
export const digest = async text => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const cookieName = (url, kind) => `${url.protocol === 'https:' ? '__Host-' : ''}qr_${kind}`;
export function authConfigured(env) {
  return /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID || '') && (env.GOOGLE_CLIENT_SECRET || '').length >= 16;
}

export function createAuth(googleFetch = fetch) {
  // Only public Google signing keys may be cached; no user/session state is global.
  const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { [customFetch]: googleFetch, timeoutDuration: 8000 });

  async function user(request, db) {
    const token = browserCookie(request, cookieName(new URL(request.url), 'session'));
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return db.prepare('SELECT u.* FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?')
      .bind(await digest(token), now()).first();
  }
  async function legacy(request, env, db) {
    const buyer = await readCookie(request, 'qr_buyer', env), receipt = await readCookie(request, 'qr_checkout', env);
    if (!buyer?.id || receipt?.buyer !== buyer.id) return null;
    return db.prepare('SELECT o.* FROM billing_orders o LEFT JOIN billing_owners b ON b.buyer = o.buyer WHERE o.session = ? AND o.buyer = ? AND b.user_id IS NULL')
      .bind(receipt.session, buyer.id).first();
  }
  function redirect(env, result, cookies) {
    const headers = new Headers({ Location: `${env.BILLING_ORIGIN}/?auth=${result}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 303, headers });
  }
  async function route(request, env, db) {
    const url = new URL(request.url), sessionName = cookieName(url, 'session'), flowName = cookieName(url, 'oauth');
    if (url.pathname === '/api/auth/logout') {
      sameOrigin(request, env);
      await limitedJSON(request, 2048);
      const token = browserCookie(request, sessionName), flow = browserCookie(request, flowName);
      await db.batch([
        db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await digest(token)),
        db.prepare('DELETE FROM auth_flows WHERE state_hash = ?').bind(await digest(flow)),
      ]);
      return json({ signedOut: true }, 200, [rawCookie(sessionName, '', url, 0), rawCookie(flowName, '', url, 0), rawCookie('qr_checkout', '', url, 0), rawCookie('qr_buyer', '', url, 0)]);
    }
    if (!authConfigured(env)) throw new BillingError(503, 'Google 登录尚未配置，请稍后重试');
    if (url.pathname === '/api/auth/google') {
      sameOrigin(request, env);
      const body = await limitedJSON(request, 2048);
      const order = body?.bindLegacy === true ? await legacy(request, env, db) : null;
      const state = random(), nonce = random(), verifier = random();
      const previous = browserCookie(request, sessionName), previousFlow = browserCookie(request, flowName);
      await db.batch([
        db.prepare('DELETE FROM auth_flows WHERE expires <= ? OR state_hash = ?').bind(now(), await digest(previousFlow)),
        db.prepare('DELETE FROM auth_sessions WHERE expires <= ?').bind(now()),
        db.prepare('INSERT INTO auth_flows (state_hash, nonce, verifier, legacy_buyer, previous_session, expires) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(await digest(state), nonce, verifier, order?.buyer || null, previous ? await digest(previous) : null, now() + 600),
      ]);
      const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      target.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.BILLING_ORIGIN}/api/auth/google/callback`, response_type: 'code',
        scope: 'openid email profile', state, nonce, code_challenge: await digest(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
      return json({ url: target.href }, 200, [rawCookie(flowName, state, url, 600)]);
    }
    // Consume a browser-bound, one-time flow before contacting Google. Never echo codes/tokens.
    const state = url.searchParams.get('state'), stateCookie = browserCookie(request, flowName);
    const cleared = [rawCookie(flowName, '', url, 0)];
    if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || state !== stateCookie) return redirect(env, 'invalid', cleared);
    const flow = await db.prepare('DELETE FROM auth_flows WHERE state_hash = ? AND expires > ? RETURNING *').bind(await digest(state), now()).first();
    if (!flow) return redirect(env, 'expired', cleared);
    if (url.searchParams.get('error')) return redirect(env, 'cancel', cleared);
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || (url.searchParams.has('iss') && url.searchParams.get('iss') !== 'https://accounts.google.com')) return redirect(env, 'invalid', cleared);
    let identity, stage = 'token_request', providerError;
    try {
      // workerd supports manual/follow; reject non-2xx below without following redirects.
      const response = await googleFetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${env.BILLING_ORIGIN}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: flow.verifier }) });
      if (!response.ok) {
        const failure = await limitedJSON(response, 64 * 1024).catch(() => null);
        if (['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request'].includes(failure?.error)) providerError = failure.error;
        throw new Error('token exchange');
      }
      stage = 'token_response';
      const tokens = await limitedJSON(response, 64 * 1024);
      stage = 'token_verify';
      const { payload } = await jwtVerify(tokens.id_token, googleKeys, { algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: env.GOOGLE_CLIENT_ID, requiredClaims: ['sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'], maxTokenAge: '10m', clockTolerance: 30 });
      stage = 'identity_claims';
      if (payload.nonce !== flow.nonce || payload.email_verified !== true || typeof payload.sub !== 'string' || payload.sub.length > 255 || !payload.sub
        || typeof payload.email !== 'string' || payload.email.length > 320 || (payload.azp && payload.azp !== env.GOOGLE_CLIENT_ID)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== env.GOOGLE_CLIENT_ID)) throw new Error('identity claims');
      identity = payload;
    } catch (error) {
      // Log only fixed diagnostic codes, never OAuth codes, tokens, claims or error messages.
      const verifierError = ['ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_EXPIRED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC', 'ERR_JWS_INVALID'].includes(error?.code) ? error.code : undefined;
      console.warn('Google login failed', { stage, providerError, verifierError });
      return redirect(env, 'failed', cleared);
    }
    // sub is the identity; email is only display/contact data and never merges accounts.
    await db.prepare('INSERT INTO auth_users (id, google_sub, email, name, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name')
      .bind(crypto.randomUUID(), identity.sub, identity.email, typeof identity.name === 'string' ? identity.name.slice(0, 160) : '', now()).run();
    const account = await db.prepare('SELECT * FROM auth_users WHERE google_sub = ?').bind(identity.sub).first();
    const token = random();
    const statements = [
      db.prepare('INSERT OR IGNORE INTO billing_owners (buyer, user_id) VALUES (?, ?)').bind(account.id, account.id),
      db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').bind(await digest(token), account.id, now() + SESSION_AGE),
      db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(flow.previous_session || ''),
    ];
    if (flow.legacy_buyer) statements.push(db.prepare('INSERT OR IGNORE INTO billing_owners (buyer, user_id) VALUES (?, ?)').bind(flow.legacy_buyer, account.id));
    await db.batch(statements);
    let result = 'success';
    if (flow.legacy_buyer) {
      const owner = await db.prepare('SELECT user_id FROM billing_owners WHERE buyer = ?').bind(flow.legacy_buyer).first();
      result = owner?.user_id === account.id ? 'linked' : 'linked_elsewhere';
    }
    return redirect(env, result, [...cleared, rawCookie(sessionName, token, url, SESSION_AGE), rawCookie('qr_checkout', '', url, 0), rawCookie('qr_buyer', '', url, 0)]);
  }
  return { user, legacy, route };
}
