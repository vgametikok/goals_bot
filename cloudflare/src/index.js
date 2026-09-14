/**
 * MYGOALS Cloudflare Worker — API router (D1 + Telegram webhook + daily R2 backups).
 */

import {
  signAuthToken,
  resolveUserId,
  authCookieHeader,
  clearAuthCookieHeader
} from './auth.js';
import {
  createLoginCode,
  getLoginCode,
  markCodeUsed,
  getUser,
  getCalendar,
  setCalendar,
  upsertTelegramUser,
  publicUser
} from './db.js';
import { verifyTelegramWidgetAuth, handleTelegramUpdate } from './telegram.js';
import { runBackup } from './backup.js';

function parseCorsOrigins(env) {
  const defaults = ['https://vgametikok.github.io', 'http://localhost:3000'];
  const raw = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!raw.length) return defaults;
  return Array.from(new Set([...raw, 'http://localhost:3000']));
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = parseCorsOrigins(env);
  const headers = {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Backup-Secret',
    'Access-Control-Max-Age': '86400'
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(extraHeaders || {})
    }
  });
}

function withCors(res, req, env) {
  const h = corsHeaders(req, env);
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(h)) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function issueAuth(env, userId, baseHeaders) {
  const token = await signAuthToken(userId, env.SESSION_SECRET);
  const headers = { ...(baseHeaders || {}) };
  headers['Set-Cookie'] = authCookieHeader(token);
  return { token, headers };
}

async function requireAuth(req, env) {
  const userId = await resolveUserId(req, env.SESSION_SECRET);
  if (!userId) return { error: json({ error: 'unauthorized' }, 401) };
  const user = await getUser(env.DB, userId);
  if (!user) return { error: json({ error: 'unauthorized' }, 401) };
  return { userId, user };
}

function botUsername(env) {
  return String(env.TELEGRAM_BOT_USERNAME || 'mygoals_bot').replace(/^@/, '');
}

async function handleRequest(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req, env) });
  }

  // ── Health ──────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, backups: !!env.BACKUPS });
  }

  // ── Internal: manual backup (gated by X-Backup-Secret) ──────────────────
  if (method === 'POST' && path === '/api/internal/backup') {
    const secret = env.BACKUP_SECRET;
    const provided = req.headers.get('X-Backup-Secret') || '';
    if (!secret || provided !== secret) {
      return json({ error: 'unauthorized' }, 401);
    }
    const result = await runBackup(env);
    return json(result, result.ok ? 200 : 500);
  }

  // ── Me ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/me') {
    const userId = await resolveUserId(req, env.SESSION_SECRET);
    if (!userId) return json({ error: 'unauthorized' }, 401);
    const user = await getUser(env.DB, userId);
    if (!user) {
      return json({ error: 'unauthorized' }, 401, {
        'Set-Cookie': clearAuthCookieHeader()
      });
    }
    return json(publicUser(user));
  }

  // ── Auth: start (deep link code) ────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/telegram/start') {
    const code = await createLoginCode(env.DB);
    const loginUrl = `https://t.me/${botUsername(env)}?start=${code}`;
    return json({ loginUrl, code });
  }

  // ── Auth: status poll ───────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/auth/telegram/status') {
    const code = String(url.searchParams.get('code') || '')
      .toUpperCase()
      .trim();
    if (!code) return json({ error: 'code required' }, 400);

    const entry = await getLoginCode(env.DB, code);
    if (!entry) return json({ status: 'invalid' });
    if (entry.expiresAt < Date.now()) return json({ status: 'expired' });

    if (
      (entry.status !== 'authenticated' && entry.status !== 'claimed') ||
      !entry.userId
    ) {
      return json({ status: 'pending' });
    }

    const user = await getUser(env.DB, entry.userId);
    if (!user) return json({ status: 'invalid' });

    await markCodeUsed(env.DB, code);
    const { token, headers } = await issueAuth(env, entry.userId);
    return json(
      { status: 'authenticated', user: publicUser(user), token },
      200,
      headers
    );
  }

  // ── Auth: widget ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/telegram/widget') {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return json({ error: 'bot not configured' }, 500);
    }
    const body = (await readJson(req)) || {};
    const verified = await verifyTelegramWidgetAuth(body, env.TELEGRAM_BOT_TOKEN);
    if (!verified.ok) {
      const status = verified.error === 'expired' ? 401 : 403;
      return json({ error: verified.error || 'unauthorized' }, status);
    }
    const { userId, user } = await upsertTelegramUser(env.DB, verified.telegramUser);
    const { token, headers } = await issueAuth(env, userId);
    return json({ user: publicUser(user), token }, 200, headers);
  }

  // ── Auth: logout ────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearAuthCookieHeader() });
  }

  // ── Calendar GET ────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/calendar') {
    const auth = await requireAuth(req, env);
    if (auth.error) return auth.error;
    return json(await getCalendar(env.DB, auth.userId));
  }

  // ── Calendar PUT ────────────────────────────────────────────────────────
  if (method === 'PUT' && path === '/api/calendar') {
    const auth = await requireAuth(req, env);
    if (auth.error) return auth.error;
    const body = (await readJson(req)) || {};
    const saved = await setCalendar(env.DB, auth.userId, body);
    return json(saved);
  }

  // ── Telegram webhook ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/telegram/webhook') {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response('bot not configured', { status: 500 });
    }
    const update = await readJson(req);
    if (!update) return new Response('bad json', { status: 400 });
    try {
      await handleTelegramUpdate(env.DB, env.TELEGRAM_BOT_TOKEN, update);
    } catch (err) {
      console.error('[webhook]', err && err.message ? err.message : err);
      return new Response('error', { status: 500 });
    }
    return new Response(null, { status: 200 });
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      if (!env.SESSION_SECRET) {
        const res = json({ error: 'SESSION_SECRET missing' }, 500);
        return withCors(res, request, env);
      }
      const res = await handleRequest(request, env);
      return withCors(res, request, env);
    } catch (err) {
      console.error('[worker]', err && err.stack ? err.stack : err);
      const res = json({ error: 'internal' }, 500);
      return withCors(res, request, env);
    }
  },

  async scheduled(event, env, ctx) {
    console.log('[cron] backup triggered', event.cron || '', event.scheduledTime || '');
    ctx.waitUntil(
      runBackup(env).then((r) => {
        if (!r.ok) console.error('[cron] backup failed', r.error);
      })
    );
  }
};
