/**
 * Telegram Login Widget HMAC verify + webhook /start CODE handler (no Grammy).
 */

import { consumeLoginCode } from './db.js';

const textEncoder = new TextEncoder();

function timingSafeEqualHex(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (aHex.length !== bHex.length) return false;
  const a = new Uint8Array(aHex.length / 2);
  const b = new Uint8Array(bHex.length / 2);
  for (let i = 0; i < a.length; i++) {
    a[i] = parseInt(aHex.slice(i * 2, i * 2 + 2), 16);
    b[i] = parseInt(bHex.slice(i * 2, i * 2 + 2), 16);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bytesToHex(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Verify Telegram Login Widget payload (HMAC-SHA-256).
 * Secret key = SHA256(botToken); then HMAC-SHA256(secret, data_check_string).
 */
export async function verifyTelegramWidgetAuth(payload, botToken) {
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

  const secretKeyBytes = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(botToken)
  );
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const computedBuf = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    textEncoder.encode(dataCheckString)
  );
  const computed = bytesToHex(computedBuf);

  if (!timingSafeEqualHex(computed, hash.toLowerCase())) {
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

async function telegramApi(botToken, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[telegram]', method, res.status, text.slice(0, 200));
  }
  return res;
}

async function replyMessage(botToken, chatId, text) {
  return telegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text
  });
}

/**
 * Handle Telegram Update JSON (webhook). Supports /start and /start CODE.
 */
export async function handleTelegramUpdate(db, botToken, update) {
  const message = update && update.message;
  if (!message || !message.text) return;

  const text = String(message.text).trim();
  if (!text.startsWith('/start')) return;

  const parts = text.split(/\s+/);
  const payload = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
  const chatId = message.chat && message.chat.id;
  const from = message.from;

  if (!chatId) return;

  if (!payload) {
    await replyMessage(
      botToken,
      chatId,
      'Привет! 👋\n\n' +
        'Это бот для входа в приложение MYGOALS.\n' +
        'Откройте сайт и нажмите «Войти через Telegram» — я пришлю вам код для входа.'
    );
    return;
  }

  const code = payload.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) {
    await replyMessage(botToken, chatId, 'Неверный код входа. Запросите новый на сайте.');
    return;
  }

  if (!from) {
    await replyMessage(botToken, chatId, 'Не удалось определить пользователя Telegram.');
    return;
  }

  const result = await consumeLoginCode(db, code, from);
  if (!result.ok) {
    if (result.reason === 'expired') {
      await replyMessage(botToken, chatId, '⏳ Код истёк. Запросите новый вход на сайте.');
    } else {
      await replyMessage(
        botToken,
        chatId,
        '❌ Код не найден или уже использован. Запросите новый на сайте.'
      );
    }
    return;
  }

  const name =
    [from.first_name, from.last_name].filter(Boolean).join(' ') ||
    from.username ||
    'друг';
  await replyMessage(
    botToken,
    chatId,
    `✅ Вход выполнен, ${name}!\n\n` +
      'Можете вернуться на сайт — авторизация завершится автоматически.'
  );
}
