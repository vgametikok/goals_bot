# MYGOALS

Календарь целей с входом через Telegram.

## Стек (актуально)

- **Фронт:** GitHub Pages — https://vgametikok.github.io/goals_bot/
- **API + бот:** Cloudflare Workers — https://mygoals-api.vgametikok.workers.dev
- **База:** Cloudflare D1 `mygoals`
- **Бэкапы:** R2 `mygoals-backups` (ежедневно 03:00 UTC)

Render **не используется**.

## Локальная разработка API (Cloudflare)

```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler dev
```

Секреты: `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET`, опционально `BACKUP_SECRET`.

Подробнее: [cloudflare/README.md](cloudflare/README.md).

## Express (`server.js`)

Оставлен только для локальных экспериментов. Telegram-бот на Express **по умолчанию выключен** (чтобы не сбрасывать Cloudflare webhook). Не деплоить на Render.
