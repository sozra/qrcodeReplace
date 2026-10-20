import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { digest } from '../server/auth.mjs';

// A signed, local Google protocol double. No test identity hook exists in the deployed code.
export async function googleFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'google-fixture', alg: 'RS256', use: 'sig' };
  const codes = new Map(), calls = [];
  let unavailable = false;
  return { calls, setUnavailable(value) { unavailable = value; },
    async authorize(input, claims = {}, signingKey = privateKey) {
      const url = new URL(input), code = crypto.randomUUID();
      const token = await new SignJWT({ sub: 'google-user-a', email: 'alice@example.com', email_verified: true, name: 'Alice Test', nonce: url.searchParams.get('nonce'), ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'google-fixture' }).setIssuer(claims.iss || 'https://accounts.google.com')
        .setAudience(claims.aud || url.searchParams.get('client_id')).setIssuedAt().setExpirationTime(claims.exp || '5m').sign(signingKey);
      codes.set(code, { token, challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
      const callback = new URL(url.searchParams.get('redirect_uri')); callback.search = new URLSearchParams({ code, state: url.searchParams.get('state') }).toString();
      return callback.href;
    },
    async fetch(input, options) {
      if (unavailable) throw new Error('Google unavailable');
      calls.push(String(input));
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
      assert.equal(String(input), 'https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(options.body), entry = codes.get(body.get('code'));
      if (!entry) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      codes.delete(body.get('code'));
      assert.equal(await digest(body.get('code_verifier')), entry.challenge);
      assert.equal(body.get('redirect_uri'), entry.redirect);
      assert.equal(body.get('grant_type'), 'authorization_code');
      return Response.json({ id_token: entry.token });
    },
  };
}

export function client(handle, env, jar = new Map()) {
  return { jar, async request(path = '/api/billing/status', body, headers = {}) {
    const response = await handle(new Request(new URL(path, env.BILLING_ORIGIN), { method: body === undefined ? 'GET' : 'POST', headers: {
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { origin: env.BILLING_ORIGIN, 'content-type': 'application/json' }), ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    for (const value of response.headers.getSetCookie()) {
      const [name, ...rest] = value.split(';')[0].split('='), token = rest.join('=');
      if (token) jar.set(name, token); else jar.delete(name);
    }
    return { response, status: response.status, data: response.status === 303 ? null : await response.json() };
  }, async login(google, claims, bindLegacy = false) {
    const start = await this.request('/api/auth/google', { bindLegacy });
    assert.equal(start.status, 200);
    const callback = await google.authorize(start.data.url, claims);
    return this.request(callback);
  } };
}
