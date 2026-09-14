'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const db = require('./src/db');
const { createBot, startBot } = require('./src/bot');
const { TOKEN_TTL_MS, signAuthToken, verifyAuthToken } = require('./src/authToken');

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'mygoals_bot').replace(/^@/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const AUTH_COOKIE = 'goals_token';

const defaultCorsOrigins = [
  'https://vgametikok.github.io',
  'http://localhost:3000'
];
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = corsOrigins.length
  ? Array.from(new Set([...corsOrigins, 'http://localhost:3000']))
  : defaultCorsOrigins;

const cookieSecure =
  process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required in .env');
  process.exit(1);
}

const app = express();
const bot = createBot(BOT_TOKEN);

app.set('trust proxy', 1);

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser / same-origin requests (no Origin header)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(
  session({
    name: 'goals.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: cookieSecure ? 'none' : 'lax',
      secure: cookieSecure,
      maxAge: TOKEN_TTL_MS
    }
  })
);

function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: cookieSecure ? 'none' : 'lax',
    secure: cookieSecure,
    maxAge: TOKEN_TTL_MS,
    path: '/'
  };
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, authCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    sameSite: cookieSecure ? 'none' : 'lax',
    secure: cookieSecure,
    path: '/'
  });
}

function extractBearer(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Resolve userId from session, Bearer token, or goals_token cookie. */
function resolveUserId(req) {
  if (req.session && req.session.userId) {
    return String(req.session.userId);
  }

  const raw = extractBearer(req) || (req.cookies && req.cookies[AUTH_COOKIE]) || null;
  if (!raw) return null;

  const verified = verifyAuthToken(raw, SESSION_SECRET);
  if (!verified) return null;
  return verified.userId;
}

function issueAuth(req, res, userId, cb) {
  const token = signAuthToken(userId, SESSION_SECRET);
  setAuthCookie(res, token);
  req.session.userId = userId;
  req.session.save((err) => {
    if (err) return cb(err);
    cb(null, token);
  });
}

function requireAuth(req, res, next) {
  const userId = resolveUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const user = db.getUser(userId);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.userId = userId;
  req.user = user;
  // Keep session warm when possible
  if (req.session && !req.session.userId) {
    req.session.userId = userId;
  }
  next();
}

function publicUser(user) {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
  return {
    telegramId: user.telegramId,
    username: user.username,
    name,
    firstName: user.firstName,
    lastName: user.lastName
  };
}

/** Verify Telegram Login Widget payload (HMAC-SHA-256). */
function verifyTelegramWidgetAuth(payload, botToken) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid' };
  const hash = String(payload.hash || '');
  if (!hash) return { ok: false, error: 'hash missing' };

  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate)) return { ok: false, error: 'auth_date' };
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > 86400) return { ok: false, error: 'expired' };
  if (ageSec < -60) return { ok: false, error: 'auth_date' };

  const fields = {};
  for (const key of Object.keys(payload)) {
    if (key === 'hash') continue;
    const val = payload[key];
    if (val === undefined || val === null || val === '') continue;
    fields[key] = String(val);
  }
  if (!fields.id) return { ok: false, error: 'id missing' };

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => k + '=' + fields[k])
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const computed = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad hash' };
  }

  return {
    ok: true,
    telegramUser: {
      id: fields.id,
      first_name: fields.first_name || null,
      last_name: fields.last_name || null,
      username: fields.username || null,
      photo_url: fields.photo_url || null
    }
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const userId = resolveUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const user = db.getUser(userId);
  if (!user) {
    if (req.session) req.session.destroy(() => {});
    clearAuthCookie(res);
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.session && !req.session.userId) {
    req.session.userId = userId;
  }
  res.json(publicUser(user));
});

app.post('/api/auth/telegram/start', (req, res) => {
  const code = db.createLoginCode();
  const loginUrl = `https://t.me/${BOT_USERNAME}?start=${code}`;
  res.json({ loginUrl, code });
});

app.get('/api/auth/telegram/status', (req, res) => {
  const code = String(req.query.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'code required' });

  const entry = db.getLoginCode(code);
  if (!entry) {
    return res.json({ status: 'invalid' });
  }
  if (entry.expiresAt < Date.now()) {
    return res.json({ status: 'expired' });
  }
  if (entry.status !== 'authenticated' || !entry.userId) {
    return res.json({ status: 'pending' });
  }

  const user = db.getUser(entry.userId);
  if (!user) return res.json({ status: 'invalid' });

  db.markCodeUsed(code);
  issueAuth(req, res, entry.userId, (err, token) => {
    if (err) return res.status(500).json({ error: 'session' });
    res.json({ status: 'authenticated', user: publicUser(user), token });
  });
});

app.post('/api/auth/telegram/complete', (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: 'code required' });

  const entry = db.getLoginCode(code);
  if (!entry || entry.status !== 'authenticated' || !entry.userId) {
    return res.status(400).json({ error: 'not ready', status: entry ? entry.status : 'invalid' });
  }

  const user = db.getUser(entry.userId);
  if (!user) return res.status(400).json({ error: 'user missing' });

  db.markCodeUsed(code);
  issueAuth(req, res, entry.userId, (err, token) => {
    if (err) return res.status(500).json({ error: 'session' });
    res.json({ ok: true, user: publicUser(user), token });
  });
});

app.post('/api/auth/telegram/widget', (req, res) => {
  const verified = verifyTelegramWidgetAuth(req.body || {}, BOT_TOKEN);
  if (!verified.ok) {
    const status = verified.error === 'expired' ? 401 : 403;
    return res.status(status).json({ error: verified.error || 'unauthorized' });
  }

  const { userId, user } = db.upsertTelegramUser(verified.telegramUser);
  issueAuth(req, res, userId, (err, token) => {
    if (err) return res.status(500).json({ error: 'session' });
    res.json({ user: publicUser(user), token });
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  req.session.destroy(() => {
    res.clearCookie('goals.sid', {
      httpOnly: true,
      sameSite: cookieSecure ? 'none' : 'lax',
      secure: cookieSecure
    });
    res.json({ ok: true });
  });
});

app.get('/api/calendar', requireAuth, (req, res) => {
  res.json(db.getCalendar(req.userId));
});

app.put('/api/calendar', requireAuth, (req, res) => {
  const body = req.body || {};
  const saved = db.setCalendar(req.userId, body);
  res.json(saved);
});

const webhookPath = process.env.WEBHOOK_PATH || '/telegram/webhook';
app.post(webhookPath, (req, res) => {
  if (!process.env.WEBHOOK_URL) {
    return res.status(404).end();
  }
  bot.handleUpdate(req.body)
    .then(() => res.status(200).end())
    .catch((err) => {
      console.error('[webhook]', err);
      res.status(500).end();
    });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function main() {
  // Bind HTTP first so Render Free health checks / PORT bind succeed even if bot is slow.
  await new Promise((resolve, reject) => {
    const server = app.listen(PORT, () => {
      console.log(`[server] listening on :${PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });

  try {
    const me = await bot.api.getMe();
    console.log('[bot] getMe ok: @' + me.username + ' id=' + me.id);
  } catch (e) {
    console.error('[bot] getMe failed (continuing; bot may be unavailable):', e.message || e);
  }

  try {
    const mode = await startBot(bot);
    console.log('[bot] started mode=' + mode.mode);
  } catch (e) {
    console.error('[bot] startBot failed (HTTP still up for API):', e.message || e);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
