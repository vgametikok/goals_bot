'use strict';

const { Bot } = require('grammy');
const db = require('./db');

function createBot(token) {
  const bot = new Bot(token);

  bot.command('start', async (ctx) => {
    const text = (ctx.message && ctx.message.text) || '';
    const parts = text.trim().split(/\s+/);
    const payload = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';

    if (!payload) {
      await ctx.reply(
        'Привет! 👋\n\n' +
          'Это бот для входа в приложение «Цели / Расписание».\n' +
          'Откройте сайт и нажмите «Войти через Telegram» — я пришлю вам код для входа.'
      );
      return;
    }

    const code = payload.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) {
      await ctx.reply('Неверный код входа. Запросите новый на сайте.');
      return;
    }

    const from = ctx.from;
    if (!from) {
      await ctx.reply('Не удалось определить пользователя Telegram.');
      return;
    }

    const result = db.consumeLoginCode(code, from);
    if (!result.ok) {
      if (result.reason === 'expired') {
        await ctx.reply('⏳ Код истёк. Запросите новый вход на сайте.');
      } else {
        await ctx.reply('❌ Код не найден или уже использован. Запросите новый на сайте.');
      }
      return;
    }

    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'друг';
    await ctx.reply(
      `✅ Вход выполнен, ${name}!\n\n` +
        'Можете вернуться на сайт — авторизация завершится автоматически.'
    );
  });

  bot.catch((err) => {
    console.error('[bot] error', err.error || err);
  });

  return bot;
}

async function startBot(bot) {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    const path = process.env.WEBHOOK_PATH || '/telegram/webhook';
    await bot.api.setWebhook(webhookUrl.replace(/\/$/, '') + path);
    console.log('[bot] webhook set:', webhookUrl.replace(/\/$/, '') + path);
    return { mode: 'webhook', path };
  }

  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  bot.start({
    onStart: (info) => {
      console.log('[bot] long polling as @' + (info.username || '?'));
    }
  });
  return { mode: 'polling' };
}

module.exports = { createBot, startBot };
