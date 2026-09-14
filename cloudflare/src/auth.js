/**
 * Long-lived HMAC auth tokens (~400 days).
 * Compatible with Express src/authToken.js (same payload/signature format).
 * Uses Web Crypto (Workers) instead of Node crypto.
 */

export const TOKEN_TTL_MS = 400 * 24 * 60 * 60 * 1000;
export const TOKEN_TTL_SEC = Math.floor(TOKEN_TTL_MS / 1000);
export const AUTH_COOKIE = 'goals_token';

const textEncoder = new TextEncoder();

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlJson(obj) {
  return b64url(textEncoder.encode(JSON.stringify(obj)));
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array)) a = new Uint8Array(a);
  if (!(b instanceof Uint8Array)) b = new Uint8Array(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signAuthToken(userId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(userId),
    iat: now,
    exp: now + TOKEN_TTL_SEC
  };
  const body = b64urlJson(payload);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, textEncoder.encode(body));
  return body + '.' + b64url(sig);
}

export async function verifyAuthToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sigB64] = parts;
  if (!body || !sigB64) return null;

  let given;
  try {
    given = fromB64url(sigB64);
  } catch {
    return null;
  }

  let expected;
  try {
    const key = await hmacKey(secret);
    expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, textEncoder.encode(body))
    );
  } catch {
    return null;
  }

  if (!timingSafeEqual(expected, given)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }

  if (!payload || !payload.sub) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  return { userId: String(payload.sub), exp };
}

export function authCookieHeader(token) {
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
}

export function clearAuthCookieHeader() {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;
}

export function extractBearer(req) {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export function extractCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  const parts = raw.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export async function resolveUserId(req, secret) {
  const raw =
    extractBearer(req) || extractCookie(req, AUTH_COOKIE) || null;
  if (!raw) return null;
  const verified = await verifyAuthToken(raw, secret);
  return verified ? verified.userId : null;
}
