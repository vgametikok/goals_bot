'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const db = require('./src/db');
const { createBot, startBot } = require('./src/bot');

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || 'mygoals_bot').replace(/^@/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required in .env');
  process.exit(1);
}

const app = express();
const bot = createBot(BOT_TOKEN);

app.set('trust proxy', 1);
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
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === '1',
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  })
);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'unauthorized' });
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

app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const user = db.getUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'unauthorized' });
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

  req.session.userId = entry.userId;
  db.markCodeUsed(code);
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'session' });
    res.json({ status: 'authenticated', user: publicUser(user) });
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

  req.session.userId = entry.userId;
  db.markCodeUsed(code);
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'session' });
    res.json({ ok: true, user: publicUser(user) });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('goals.sid');
    res.json({ ok: true });
  });
});

app.get('/api/calendar', requireAuth, (req, res) => {
  res.json(db.getCalendar(req.session.userId));
});

app.put('/api/calendar', requireAuth, (req, res) => {
  const body = req.body || {};
  const saved = db.setCalendar(req.session.userId, body);
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
  try {
    const me = await bot.api.getMe();
    console.log('[bot] getMe ok: @' + me.username + ' id=' + me.id);
  } catch (e) {
    console.error('[bot] getMe failed:', e.message || e);
    process.exit(1);
  }

  const mode = await startBot(bot);

  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT} (bot: ${mode.mode})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
