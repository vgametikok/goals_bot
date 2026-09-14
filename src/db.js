'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.json');

const DEFAULT_CALENDAR = {
  categories: [],
  badges: [],
  tasks: [],
  compact: false,
  viewMode: 'week'
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyStore() {
  return { users: {}, calendars: {}, loginCodes: {} };
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const store = emptyStore();
    save(store);
    return store;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      users: parsed.users || {},
      calendars: parsed.calendars || {},
      loginCodes: parsed.loginCodes || {}
    };
  } catch (e) {
    return emptyStore();
  }
}

function save(store) {
  ensureDir();
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function cleanupExpiredCodes(store) {
  const now = Date.now();
  let changed = false;
  for (const [code, entry] of Object.entries(store.loginCodes)) {
    if (!entry) {
      delete store.loginCodes[code];
      changed = true;
      continue;
    }
    // Soft-claimed codes stay ~2 minutes for racing mobile polls, then expire
    const claimedDone =
      entry.status === 'claimed' &&
      entry.claimedAt &&
      now - entry.claimedAt > 2 * 60 * 1000;
    if (entry.expiresAt < now || claimedDone) {
      delete store.loginCodes[code];
      changed = true;
    }
  }
  return changed;
}

function createLoginCode() {
  const store = load();
  cleanupExpiredCodes(store);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  store.loginCodes[code] = {
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    status: 'pending',
    userId: null
  };
  save(store);
  return code;
}

function getLoginCode(code) {
  const store = load();
  if (cleanupExpiredCodes(store)) save(store);
  return store.loginCodes[code] || null;
}

/** Upsert Telegram user from widget or bot payload (id / first_name / …). */
function upsertTelegramUser(telegramUser) {
  const store = load();
  const telegramId = String(telegramUser.id);
  let user = store.users[telegramId];
  if (!user) {
    user = {
      telegramId,
      username: telegramUser.username || null,
      firstName: telegramUser.first_name || null,
      lastName: telegramUser.last_name || null,
      photoUrl: telegramUser.photo_url || null,
      createdAt: new Date().toISOString()
    };
    store.users[telegramId] = user;
    store.calendars[telegramId] = JSON.parse(JSON.stringify(DEFAULT_CALENDAR));
  } else {
    user.username = telegramUser.username || user.username;
    user.firstName = telegramUser.first_name || user.firstName;
    user.lastName = telegramUser.last_name || user.lastName;
    if (telegramUser.photo_url) user.photoUrl = telegramUser.photo_url;
    user.updatedAt = new Date().toISOString();
  }
  save(store);
  return { userId: telegramId, user };
}

function consumeLoginCode(code, telegramUser) {
  const store = load();
  cleanupExpiredCodes(store);
  const entry = store.loginCodes[code];
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.expiresAt < Date.now()) {
    delete store.loginCodes[code];
    save(store);
    return { ok: false, reason: 'expired' };
  }
  if (entry.status === 'authenticated' || entry.status === 'claimed') {
    return { ok: true, userId: entry.userId, already: true };
  }

  const { userId, user } = upsertTelegramUser(telegramUser);
  // reload entry after upsert (upsert saves its own store)
  const store2 = load();
  const entry2 = store2.loginCodes[code];
  if (!entry2) return { ok: false, reason: 'invalid' };
  entry2.status = 'authenticated';
  entry2.userId = userId;
  entry2.authenticatedAt = Date.now();
  save(store2);
  return { ok: true, userId, user };
}

/**
 * Soft-consume: mark claimed but keep ~2 minutes so racing polls
 * (mobile visibility resume) still get { status:'authenticated', user, token }.
 * Hard-delete happens in cleanupExpiredCodes after claimedAt + 2min.
 */
function markCodeUsed(code) {
  const store = load();
  const entry = store.loginCodes[code];
  if (!entry) return;
  if (entry.status === 'claimed' && entry.claimedAt) {
    // already soft-claimed; refresh window slightly if still within grace
    return;
  }
  const now = Date.now();
  entry.status = 'claimed';
  entry.claimedAt = now;
  entry.expiresAt = now + 2 * 60 * 1000;
  save(store);
}

/** Hard-delete a login code immediately (tests / admin). */
function deleteLoginCode(code) {
  const store = load();
  if (store.loginCodes[code]) {
    delete store.loginCodes[code];
    save(store);
  }
}

function getUser(telegramId) {
  const store = load();
  return store.users[String(telegramId)] || null;
}

function getCalendar(telegramId) {
  const store = load();
  const id = String(telegramId);
  if (!store.calendars[id]) {
    store.calendars[id] = JSON.parse(JSON.stringify(DEFAULT_CALENDAR));
    save(store);
  }
  return store.calendars[id];
}

function setCalendar(telegramId, data) {
  const store = load();
  const id = String(telegramId);
  store.calendars[id] = {
    categories: Array.isArray(data.categories) ? data.categories : DEFAULT_CALENDAR.categories,
    badges: Array.isArray(data.badges) ? data.badges : DEFAULT_CALENDAR.badges,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    compact: !!data.compact,
    viewMode: data.viewMode === 'month' || data.viewMode === 'day' ? data.viewMode : 'week'
  };
  save(store);
  return store.calendars[id];
}

module.exports = {
  DEFAULT_CALENDAR,
  createLoginCode,
  getLoginCode,
  consumeLoginCode,
  upsertTelegramUser,
  markCodeUsed,
  deleteLoginCode,
  getUser,
  getCalendar,
  setCalendar
};
