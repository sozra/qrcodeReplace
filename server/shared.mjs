const YEAR = 365 * 24 * 60 * 60;
const encoder = new TextEncoder();
export class BillingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function json(data, status = 200, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}
export function b64(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function unb64(value) { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), ch => ch.charCodeAt(0)); }
export async function key(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function sign(value, secret) {
  const payload = b64(encoder.encode(JSON.stringify({ ...value, exp: Math.floor(Date.now() / 1000) + YEAR })));
  return `${payload}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload))))}`;
}
export async function readCookie(request, name, env) {
  try {
    const value = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!value || value.length > 2048) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await key(env.BILLING_COOKIE_SECRET), unb64(parts[1]), encoder.encode(parts[0]))) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    return data.exp > Date.now() / 1000 && data.kind === name ? data : null;
  } catch { return null; }
}
export async function cookie(name, value, env, url) {
  return `${name}=${await sign({ ...value, kind: name }, env.BILLING_COOKIE_SECRET)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
export async function limitedText(message, limit) {
  const reader = message.body?.getReader();
  if (!reader) throw new BillingError(400, '请求内容为空');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new BillingError(413, '请求内容过大'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError(400, '无法读取请求内容');
  } finally { reader.releaseLock(); }
}
export async function limitedJSON(message, limit) {
  const text = await limitedText(message, limit);
  try { return JSON.parse(text); } catch { throw new BillingError(400, '无法读取请求内容'); }
}


export function browserCookie(request, name) {
  return (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
export function rawCookie(name, value, url, age) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
export function sameOrigin(request, env) {
  if (request.headers.get('origin') !== env.BILLING_ORIGIN || !request.headers.get('content-type')?.startsWith('application/json')) throw new BillingError(403, '请求来源无效，请从应用内重试');
}
