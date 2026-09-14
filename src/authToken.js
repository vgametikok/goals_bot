'use strict';

const crypto = require('crypto');

/** ~400 days — survive Render Free sleep/restarts without re-widget. */
const TOKEN_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const TOKEN_TTL_SEC = Math.floor(TOKEN_TTL_MS / 1000);

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function signAuthToken(userId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(userId),
    iat: now,
    exp: now + TOKEN_TTL_SEC
  };
  const body = b64urlJson(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return body + '.' + b64url(sig);
}

function verifyAuthToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sigB64] = parts;
  if (!body || !sigB64) return null;

  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(body).digest();
  } catch (e) {
    return null;
  }

  let given;
  try {
    given = fromB64url(sigB64);
  } catch (e) {
    return null;
  }

  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch (e) {
    return null;
  }

  if (!payload || !payload.sub) return null;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  return { userId: String(payload.sub), exp };
}

module.exports = {
  TOKEN_TTL_MS,
  TOKEN_TTL_SEC,
  signAuthToken,
  verifyAuthToken
};
