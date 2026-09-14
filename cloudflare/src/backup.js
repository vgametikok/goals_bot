/**
 * Daily D1 → R2 JSON backups for MYGOALS (bucket: mygoals-backups).
 * Retention: 14 days under daily/. Never touches albums resources.
 */

const RETENTION_DAYS = 14;
const PREFIX = 'daily/';

function utcDateString(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Snapshot users, calendars, and login_codes from D1; write to R2; prune old.
 * @returns {{ ok: boolean, key?: string, users?: number, calendars?: number, loginCodes?: number, pruned?: number, error?: string }}
 */
export async function runBackup(env) {
  if (!env.BACKUPS) {
    console.error('[backup] BACKUPS binding missing');
    return { ok: false, error: 'BACKUPS binding missing' };
  }
  if (!env.DB) {
    console.error('[backup] DB binding missing');
    return { ok: false, error: 'DB binding missing' };
  }

  const started = Date.now();
  try {
    const [usersRes, calendarsRes, codesRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM users').all(),
      env.DB.prepare('SELECT * FROM calendars').all(),
      env.DB.prepare('SELECT * FROM login_codes').all()
    ]);

    const users = usersRes.results || [];
    const calendars = (calendarsRes.results || []).map((row) => {
      let data = row.data;
      try {
        data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      } catch {
        /* keep raw string */
      }
      return { ...row, data };
    });
    const loginCodes = codesRes.results || [];

    const date = utcDateString();
    const snapshot = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'mygoals',
      tables: {
        users,
        calendars,
        login_codes: loginCodes
      },
      counts: {
        users: users.length,
        calendars: calendars.length,
        login_codes: loginCodes.length
      }
    };

    const body = JSON.stringify(snapshot, null, 2);
    const datedKey = `${PREFIX}${date}.json`;
    const latestKey = `${PREFIX}latest.json`;

    await Promise.all([
      env.BACKUPS.put(datedKey, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { createdAt: snapshot.createdAt, source: 'mygoals' }
      }),
      env.BACKUPS.put(latestKey, body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { createdAt: snapshot.createdAt, source: 'mygoals' }
      })
    ]);

    const pruned = await pruneOldBackups(env.BACKUPS, date);

    const ms = Date.now() - started;
    console.log(
      `[backup] ok key=${datedKey} users=${users.length} calendars=${calendars.length} codes=${loginCodes.length} pruned=${pruned} ${ms}ms`
    );

    return {
      ok: true,
      key: datedKey,
      users: users.length,
      calendars: calendars.length,
      loginCodes: loginCodes.length,
      pruned
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('[backup] failed:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * Delete daily/YYYY-MM-DD.json objects older than RETENTION_DAYS (UTC).
 * Skips latest.json.
 */
async function pruneOldBackups(bucket, todayYmd) {
  const cutoff = new Date(`${todayYmd}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffYmd = utcDateString(cutoff);

  let pruned = 0;
  let cursor;
  do {
    const listed = await bucket.list({ prefix: PREFIX, cursor, limit: 1000 });
    for (const obj of listed.objects || []) {
      const name = obj.key;
      if (name === `${PREFIX}latest.json`) continue;
      // Expect daily/YYYY-MM-DD.json
      const m = /^daily\/(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (!m) continue;
      if (m[1] < cutoffYmd) {
        await bucket.delete(name);
        pruned += 1;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return pruned;
}
