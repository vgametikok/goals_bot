'use strict';

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.json');

const DEFAULT_CALENDAR = {
  categories: [],
  badges: [],
  tasks: [],
  compact: false,
  viewMode: 'week'
};

const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB = process.env.MONGODB_DB || 'goals_bot';

/** @type {'file' | 'mongo' | null} */
let mode = null;
/** @type {import('mongodb').MongoClient | null} */
let client = null;
/** @type {import('mongodb').Db | null} */
let mongoDb = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function emptyStore() {
  return { users: {}, calendars: {}, loginCodes: {} };
}

function loadFile() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const store = emptyStore();
    saveFile(store);
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

function saveFile(store) {
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

function cloneDefaultCalendar() {
  return JSON.parse(JSON.stringify(DEFAULT_CALENDAR));
}

function normalizeCalendar(data) {
  return {
    categories: Array.isArray(data.categories) ? data.categories : DEFAULT_CALENDAR.categories,
    badges: Array.isArray(data.badges) ? data.badges : DEFAULT_CALENDAR.badges,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    compact: !!data.compact,
    viewMode: data.viewMode === 'month' || data.viewMode === 'day' ? data.viewMode : 'week'
  };
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function loginCodeFromDoc(doc) {
  if (!doc) return null;
  return {
    createdAt: toMs(doc.createdAt),
    expiresAt: toMs(doc.expiresAt),
    status: doc.status,
    userId: doc.userId != null ? String(doc.userId) : null,
    claimedAt: toMs(doc.claimedAt),
    authenticatedAt: toMs(doc.authenticatedAt)
  };
}

function userFromDoc(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return {
    telegramId: String(rest.telegramId),
    username: rest.username || null,
    firstName: rest.firstName || null,
    lastName: rest.lastName || null,
    photoUrl: rest.photoUrl || null,
    createdAt: rest.createdAt || null,
    updatedAt: rest.updatedAt || undefined
  };
}

function calendarFromDoc(doc) {
  if (!doc) return null;
  return normalizeCalendar(doc);
}

function assertReady() {
  if (!mode) {
    throw new Error('db.init() must be called before using the database');
  }
}

function col(name) {
  return mongoDb.collection(name);
}

async function ensureIndexes() {
  await col('users').createIndex({ telegramId: 1 }, { unique: true });
  await col('calendars').createIndex({ telegramId: 1 }, { unique: true });
  await col('loginCodes').createIndex({ code: 1 }, { unique: true });
  // TTL: Mongo deletes docs when expiresAt (Date) is in the past
  await col('loginCodes').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

/**
 * One-time import from local data/store.json when Mongo collections are empty.
 */
async function maybeMigrateFromFile() {
  if (!fs.existsSync(DB_PATH)) return;

  const usersCount = await col('users').countDocuments({}, { limit: 1 });
  const calsCount = await col('calendars').countDocuments({}, { limit: 1 });
  const codesCount = await col('loginCodes').countDocuments({}, { limit: 1 });
  if (usersCount + calsCount + codesCount > 0) return;

  let store;
  try {
    store = loadFile();
  } catch (e) {
    console.warn('[db] skip migration: cannot read store.json');
    return;
  }

  const userEntries = Object.entries(store.users || {});
  const calEntries = Object.entries(store.calendars || {});
  const codeEntries = Object.entries(store.loginCodes || {});
  if (!userEntries.length && !calEntries.length && !codeEntries.length) return;

  console.log(
    '[db] migrating local store.json → MongoDB (' +
      userEntries.length +
      ' users, ' +
      calEntries.length +
      ' calendars, ' +
      codeEntries.length +
      ' loginCodes)'
  );

  if (userEntries.length) {
    await col('users').insertMany(
      userEntries.map(([id, u]) => ({
        telegramId: String(u.telegramId || id),
        username: u.username || null,
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        photoUrl: u.photoUrl || null,
        createdAt: u.createdAt || new Date().toISOString(),
        updatedAt: u.updatedAt || undefined
      })),
      { ordered: false }
    ).catch((e) => {
      if (e.code !== 11000) throw e;
    });
  }

  if (calEntries.length) {
    await col('calendars').insertMany(
      calEntries.map(([id, c]) => ({
        telegramId: String(id),
        ...normalizeCalendar(c || {})
      })),
      { ordered: false }
    ).catch((e) => {
      if (e.code !== 11000) throw e;
    });
  }

  const now = Date.now();
  const liveCodes = codeEntries.filter(([, e]) => e && toMs(e.expiresAt) > now);
  if (liveCodes.length) {
    await col('loginCodes').insertMany(
      liveCodes.map(([code, e]) => ({
        code: String(code),
        createdAt: new Date(toMs(e.createdAt) || now),
        expiresAt: new Date(toMs(e.expiresAt) || now),
        status: e.status || 'pending',
        userId: e.userId != null ? String(e.userId) : null,
        claimedAt: e.claimedAt ? new Date(toMs(e.claimedAt)) : undefined,
        authenticatedAt: e.authenticatedAt ? new Date(toMs(e.authenticatedAt)) : undefined
      })),
      { ordered: false }
    ).catch((e) => {
      if (e.code !== 11000) throw e;
    });
  }

  console.log('[db] migration complete');
}

/**
 * Initialize DB. Call once at startup before any other db API.
 * If MONGODB_URI is set, connects to Atlas and fails hard on connection error.
 * Otherwise uses local JSON file store.
 */
async function init() {
  if (mode) return mode;

  if (MONGODB_URI) {
    try {
      // Do not log URI (may contain password)
      console.log('[db] connecting to MongoDB…');
      client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 15000,
        maxPoolSize: 10
      });
      await client.connect();
      mongoDb = client.db(MONGODB_DB);
      await mongoDb.command({ ping: 1 });
      await ensureIndexes();
      mode = 'mongo';
      console.log('[db] MongoDB ready (db=' + MONGODB_DB + ')');
      await maybeMigrateFromFile();
      return mode;
    } catch (err) {
      console.error('[db] MongoDB connection failed — refusing to start');
      console.error('[db]', err && err.message ? err.message : err);
      try {
        if (client) await client.close();
      } catch (_) {}
      client = null;
      mongoDb = null;
      throw err;
    }
  }

  mode = 'file';
  ensureDir();
  loadFile();
  console.log('[db] using file store at data/store.json (set MONGODB_URI for persistence)');
  return mode;
}

function randomLoginCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ─── File-mode implementations ───────────────────────────────────────────────

function fileCreateLoginCode() {
  const store = loadFile();
  cleanupExpiredCodes(store);
  const code = randomLoginCode();
  store.loginCodes[code] = {
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    status: 'pending',
    userId: null
  };
  saveFile(store);
  return code;
}

function fileGetLoginCode(code) {
  const store = loadFile();
  if (cleanupExpiredCodes(store)) saveFile(store);
  return store.loginCodes[code] || null;
}

function fileUpsertTelegramUser(telegramUser) {
  const store = loadFile();
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
    store.calendars[telegramId] = cloneDefaultCalendar();
  } else {
    user.username = telegramUser.username || user.username;
    user.firstName = telegramUser.first_name || user.firstName;
    user.lastName = telegramUser.last_name || user.lastName;
    if (telegramUser.photo_url) user.photoUrl = telegramUser.photo_url;
    user.updatedAt = new Date().toISOString();
  }
  saveFile(store);
  return { userId: telegramId, user };
}

function fileConsumeLoginCode(code, telegramUser) {
  const store = loadFile();
  cleanupExpiredCodes(store);
  const entry = store.loginCodes[code];
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.expiresAt < Date.now()) {
    delete store.loginCodes[code];
    saveFile(store);
    return { ok: false, reason: 'expired' };
  }
  if (entry.status === 'authenticated' || entry.status === 'claimed') {
    return { ok: true, userId: entry.userId, already: true };
  }

  const { userId, user } = fileUpsertTelegramUser(telegramUser);
  const store2 = loadFile();
  const entry2 = store2.loginCodes[code];
  if (!entry2) return { ok: false, reason: 'invalid' };
  entry2.status = 'authenticated';
  entry2.userId = userId;
  entry2.authenticatedAt = Date.now();
  saveFile(store2);
  return { ok: true, userId, user };
}

function fileMarkCodeUsed(code) {
  const store = loadFile();
  const entry = store.loginCodes[code];
  if (!entry) return;
  if (entry.status === 'claimed' && entry.claimedAt) return;
  const now = Date.now();
  entry.status = 'claimed';
  entry.claimedAt = now;
  entry.expiresAt = now + 2 * 60 * 1000;
  saveFile(store);
}

function fileDeleteLoginCode(code) {
  const store = loadFile();
  if (store.loginCodes[code]) {
    delete store.loginCodes[code];
    saveFile(store);
  }
}

function fileGetUser(telegramId) {
  const store = loadFile();
  return store.users[String(telegramId)] || null;
}

function fileGetCalendar(telegramId) {
  const store = loadFile();
  const id = String(telegramId);
  if (!store.calendars[id]) {
    store.calendars[id] = cloneDefaultCalendar();
    saveFile(store);
  }
  return store.calendars[id];
}

function fileSetCalendar(telegramId, data) {
  const store = loadFile();
  const id = String(telegramId);
  store.calendars[id] = normalizeCalendar(data || {});
  saveFile(store);
  return store.calendars[id];
}

// ─── Mongo-mode implementations ──────────────────────────────────────────────

async function mongoCreateLoginCode() {
  const code = randomLoginCode();
  const now = Date.now();
  await col('loginCodes').insertOne({
    code,
    createdAt: new Date(now),
    expiresAt: new Date(now + 10 * 60 * 1000),
    status: 'pending',
    userId: null
  });
  return code;
}

async function mongoGetLoginCode(code) {
  const doc = await col('loginCodes').findOne({ code: String(code) });
  if (!doc) return null;
  const entry = loginCodeFromDoc(doc);
  const now = Date.now();
  const claimedDone =
    entry.status === 'claimed' &&
    entry.claimedAt &&
    now - entry.claimedAt > 2 * 60 * 1000;
  if (entry.expiresAt < now || claimedDone) {
    await col('loginCodes').deleteOne({ code: String(code) });
    return null;
  }
  return entry;
}

async function mongoUpsertTelegramUser(telegramUser) {
  const telegramId = String(telegramUser.id);
  const existing = await col('users').findOne({ telegramId });
  if (!existing) {
    const user = {
      telegramId,
      username: telegramUser.username || null,
      firstName: telegramUser.first_name || null,
      lastName: telegramUser.last_name || null,
      photoUrl: telegramUser.photo_url || null,
      createdAt: new Date().toISOString()
    };
    await col('users').insertOne(user);
    await col('calendars').updateOne(
      { telegramId },
      { $setOnInsert: { telegramId, ...cloneDefaultCalendar() } },
      { upsert: true }
    );
    return { userId: telegramId, user };
  }

  const updated = {
    username: telegramUser.username || existing.username,
    firstName: telegramUser.first_name || existing.firstName,
    lastName: telegramUser.last_name || existing.lastName,
    photoUrl: telegramUser.photo_url || existing.photoUrl,
    updatedAt: new Date().toISOString()
  };
  await col('users').updateOne({ telegramId }, { $set: updated });
  return {
    userId: telegramId,
    user: userFromDoc({ ...existing, ...updated })
  };
}

async function mongoConsumeLoginCode(code, telegramUser) {
  const entry = await mongoGetLoginCode(code);
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.expiresAt < Date.now()) {
    await col('loginCodes').deleteOne({ code: String(code) });
    return { ok: false, reason: 'expired' };
  }
  if (entry.status === 'authenticated' || entry.status === 'claimed') {
    return { ok: true, userId: entry.userId, already: true };
  }

  const { userId, user } = await mongoUpsertTelegramUser(telegramUser);
  const result = await col('loginCodes').findOneAndUpdate(
    {
      code: String(code),
      status: 'pending'
    },
    {
      $set: {
        status: 'authenticated',
        userId,
        authenticatedAt: new Date()
      }
    },
    { returnDocument: 'after' }
  );

  // Driver may return doc directly or { value }
  const updated = result && result.value !== undefined ? result.value : result;
  if (!updated) {
    // Race: another request authenticated/claimed it
    const again = await mongoGetLoginCode(code);
    if (again && (again.status === 'authenticated' || again.status === 'claimed')) {
      return { ok: true, userId: again.userId, already: true };
    }
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, userId, user };
}

async function mongoMarkCodeUsed(code) {
  const doc = await col('loginCodes').findOne({ code: String(code) });
  if (!doc) return;
  if (doc.status === 'claimed' && doc.claimedAt) return;
  const now = Date.now();
  await col('loginCodes').updateOne(
    { code: String(code) },
    {
      $set: {
        status: 'claimed',
        claimedAt: new Date(now),
        expiresAt: new Date(now + 2 * 60 * 1000)
      }
    }
  );
}

async function mongoDeleteLoginCode(code) {
  await col('loginCodes').deleteOne({ code: String(code) });
}

async function mongoGetUser(telegramId) {
  const doc = await col('users').findOne({ telegramId: String(telegramId) });
  return userFromDoc(doc);
}

async function mongoGetCalendar(telegramId) {
  const id = String(telegramId);
  let doc = await col('calendars').findOne({ telegramId: id });
  if (!doc) {
    const cal = { telegramId: id, ...cloneDefaultCalendar() };
    try {
      await col('calendars').insertOne(cal);
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
    doc = await col('calendars').findOne({ telegramId: id });
  }
  return calendarFromDoc(doc) || cloneDefaultCalendar();
}

async function mongoSetCalendar(telegramId, data) {
  const id = String(telegramId);
  const cal = normalizeCalendar(data || {});
  await col('calendars').updateOne(
    { telegramId: id },
    { $set: { telegramId: id, ...cal } },
    { upsert: true }
  );
  return cal;
}

// ─── Public async API ────────────────────────────────────────────────────────

async function createLoginCode() {
  assertReady();
  return mode === 'mongo' ? mongoCreateLoginCode() : fileCreateLoginCode();
}

async function getLoginCode(code) {
  assertReady();
  return mode === 'mongo' ? mongoGetLoginCode(code) : fileGetLoginCode(code);
}

async function upsertTelegramUser(telegramUser) {
  assertReady();
  return mode === 'mongo'
    ? mongoUpsertTelegramUser(telegramUser)
    : fileUpsertTelegramUser(telegramUser);
}

async function consumeLoginCode(code, telegramUser) {
  assertReady();
  return mode === 'mongo'
    ? mongoConsumeLoginCode(code, telegramUser)
    : fileConsumeLoginCode(code, telegramUser);
}

async function markCodeUsed(code) {
  assertReady();
  return mode === 'mongo' ? mongoMarkCodeUsed(code) : fileMarkCodeUsed(code);
}

async function deleteLoginCode(code) {
  assertReady();
  return mode === 'mongo' ? mongoDeleteLoginCode(code) : fileDeleteLoginCode(code);
}

async function getUser(telegramId) {
  assertReady();
  return mode === 'mongo' ? mongoGetUser(telegramId) : fileGetUser(telegramId);
}

async function getCalendar(telegramId) {
  assertReady();
  return mode === 'mongo' ? mongoGetCalendar(telegramId) : fileGetCalendar(telegramId);
}

async function setCalendar(telegramId, data) {
  assertReady();
  return mode === 'mongo'
    ? mongoSetCalendar(telegramId, data)
    : fileSetCalendar(telegramId, data);
}

module.exports = {
  DEFAULT_CALENDAR,
  init,
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
