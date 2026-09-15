/**
 * D1 access layer for MYGOALS (users, calendars, login_codes).
 */

export const DEFAULT_CALENDAR = {
  categories: [],
  badges: [],
  tasks: [],
  compact: false,
  viewMode: 'week',
  timezone: ''
};

function cloneDefaultCalendar() {
  return JSON.parse(JSON.stringify(DEFAULT_CALENDAR));
}

export function normalizeCalendar(data) {
  const d = data || {};
  const tz = typeof d.timezone === 'string' ? d.timezone.trim() : '';
  return {
    categories: Array.isArray(d.categories) ? d.categories : DEFAULT_CALENDAR.categories,
    badges: Array.isArray(d.badges) ? d.badges : DEFAULT_CALENDAR.badges,
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    compact: !!d.compact,
    viewMode: d.viewMode === 'month' || d.viewMode === 'day' ? d.viewMode : 'week',
    timezone: tz
  };
}

function randomLoginCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[arr[i] % chars.length];
  }
  return code;
}

function rowToUser(row) {
  if (!row) return null;
  return {
    telegramId: String(row.telegram_id),
    username: row.username || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    photoUrl: row.photo_url || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || undefined
  };
}

function rowToLoginCode(row) {
  if (!row) return null;
  return {
    code: row.code,
    status: row.status,
    userId: row.user_id != null ? String(row.user_id) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at != null ? row.claimed_at : null,
    authenticatedAt: row.authenticated_at != null ? row.authenticated_at : null
  };
}

/** Soft-cleanup: drop expired or soft-claimed (>2 min) codes. */
async function cleanupExpiredCodes(db) {
  const now = Date.now();
  const softClaimCutoff = now - 2 * 60 * 1000;
  await db
    .prepare(
      `DELETE FROM login_codes
       WHERE expires_at < ?
          OR (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?)`
    )
    .bind(now, softClaimCutoff)
    .run();
}

export async function createLoginCode(db) {
  await cleanupExpiredCodes(db);
  const code = randomLoginCode();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO login_codes (code, status, user_id, created_at, expires_at)
       VALUES (?, 'pending', NULL, ?, ?)`
    )
    .bind(code, now, now + 10 * 60 * 1000)
    .run();
  return code;
}

export async function getLoginCode(db, code) {
  await cleanupExpiredCodes(db);
  const row = await db
    .prepare('SELECT * FROM login_codes WHERE code = ?')
    .bind(String(code))
    .first();
  if (!row) return null;

  const entry = rowToLoginCode(row);
  const now = Date.now();
  const claimedDone =
    entry.status === 'claimed' &&
    entry.claimedAt &&
    now - entry.claimedAt > 2 * 60 * 1000;
  if (entry.expiresAt < now || claimedDone) {
    await db.prepare('DELETE FROM login_codes WHERE code = ?').bind(String(code)).run();
    return null;
  }
  return entry;
}

export async function upsertTelegramUser(db, telegramUser) {
  const telegramId = String(telegramUser.id);
  const existing = await db
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first();

  if (!existing) {
    const nowIso = new Date().toISOString();
    const user = {
      telegramId,
      username: telegramUser.username || null,
      firstName: telegramUser.first_name || null,
      lastName: telegramUser.last_name || null,
      photoUrl: telegramUser.photo_url || null,
      createdAt: nowIso
    };
    await db
      .prepare(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        telegramId,
        user.username,
        user.firstName,
        user.lastName,
        user.photoUrl,
        nowIso
      )
      .run();

    const calJson = JSON.stringify(cloneDefaultCalendar());
    await db
      .prepare(
        `INSERT OR IGNORE INTO calendars (telegram_id, data) VALUES (?, ?)`
      )
      .bind(telegramId, calJson)
      .run();

    return { userId: telegramId, user };
  }

  const updated = {
    username: telegramUser.username || existing.username,
    firstName: telegramUser.first_name || existing.first_name,
    lastName: telegramUser.last_name || existing.last_name,
    photoUrl: telegramUser.photo_url || existing.photo_url,
    updatedAt: new Date().toISOString()
  };
  await db
    .prepare(
      `UPDATE users
       SET username = ?, first_name = ?, last_name = ?, photo_url = ?, updated_at = ?
       WHERE telegram_id = ?`
    )
    .bind(
      updated.username,
      updated.firstName,
      updated.lastName,
      updated.photoUrl,
      updated.updatedAt,
      telegramId
    )
    .run();

  return {
    userId: telegramId,
    user: {
      telegramId,
      username: updated.username,
      firstName: updated.firstName,
      lastName: updated.lastName,
      photoUrl: updated.photoUrl,
      createdAt: existing.created_at,
      updatedAt: updated.updatedAt
    }
  };
}

/**
 * Bot /start CODE — mark code authenticated and upsert user.
 */
export async function consumeLoginCode(db, code, telegramUser) {
  const entry = await getLoginCode(db, code);
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.expiresAt < Date.now()) {
    await db.prepare('DELETE FROM login_codes WHERE code = ?').bind(String(code)).run();
    return { ok: false, reason: 'expired' };
  }
  if (entry.status === 'authenticated' || entry.status === 'claimed') {
    return { ok: true, userId: entry.userId, already: true };
  }

  const { userId, user } = await upsertTelegramUser(db, telegramUser);
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE login_codes
       SET status = 'authenticated', user_id = ?, authenticated_at = ?
       WHERE code = ? AND status = 'pending'`
    )
    .bind(userId, now, String(code))
    .run();

  if (result.meta && result.meta.changes === 0) {
    const again = await getLoginCode(db, code);
    if (again && (again.status === 'authenticated' || again.status === 'claimed')) {
      return { ok: true, userId: again.userId, already: true };
    }
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, userId, user };
}

/**
 * Soft-claim: keep code ~2 min so racing mobile polls still succeed.
 */
export async function markCodeUsed(db, code) {
  const row = await db
    .prepare('SELECT * FROM login_codes WHERE code = ?')
    .bind(String(code))
    .first();
  if (!row) return;
  if (row.status === 'claimed' && row.claimed_at) return;
  const now = Date.now();
  await db
    .prepare(
      `UPDATE login_codes
       SET status = 'claimed', claimed_at = ?, expires_at = ?
       WHERE code = ?`
    )
    .bind(now, now + 2 * 60 * 1000, String(code))
    .run();
}

export async function getUser(db, telegramId) {
  const row = await db
    .prepare('SELECT * FROM users WHERE telegram_id = ?')
    .bind(String(telegramId))
    .first();
  return rowToUser(row);
}

export async function getCalendar(db, telegramId) {
  const id = String(telegramId);
  let row = await db
    .prepare('SELECT data FROM calendars WHERE telegram_id = ?')
    .bind(id)
    .first();

  if (!row) {
    const cal = cloneDefaultCalendar();
    await db
      .prepare('INSERT OR IGNORE INTO calendars (telegram_id, data) VALUES (?, ?)')
      .bind(id, JSON.stringify(cal))
      .run();
    return cal;
  }

  try {
    return normalizeCalendar(JSON.parse(row.data));
  } catch {
    return cloneDefaultCalendar();
  }
}

export async function setCalendar(db, telegramId, data) {
  const id = String(telegramId);
  const cal = normalizeCalendar(data || {});
  await db
    .prepare(
      `INSERT INTO calendars (telegram_id, data) VALUES (?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET data = excluded.data`
    )
    .bind(id, JSON.stringify(cal))
    .run();
  return cal;
}

export function publicUser(user) {
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
