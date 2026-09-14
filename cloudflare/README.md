# MYGOALS API — Cloudflare Workers + D1

Предпочтительный постоянный бэкенд (бесплатный tier). Telegram — **только webhook** (Workers не умеют long polling).

Фронт на GitHub Pages (`https://vgametikok.github.io`) ходит сюда по CORS с cookie `goals_token` (`SameSite=None; Secure`) и/или Bearer-токеном.

## Структура

```
cloudflare/
  wrangler.toml
  package.json
  src/index.js       # роутер
  src/db.js          # D1
  src/auth.js        # HMAC-токены (~400 дней)
  src/telegram.js    # Login Widget + webhook /start CODE
  migrations/0001_init.sql
```

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| POST | `/api/auth/telegram/start` | `{ loginUrl, code }` |
| GET | `/api/auth/telegram/status?code=` | poll → cookie + `token` |
| POST | `/api/auth/telegram/widget` | Login Widget HMAC |
| POST | `/api/auth/logout` | сброс cookie |
| GET | `/api/me` | текущий пользователь |
| GET/PUT | `/api/calendar` | JSON календаря |
| POST | `/telegram/webhook` | Telegram Update |

## Деплой (чеклист)

Нужны: аккаунт [Cloudflare](https://dash.cloudflare.com), Node 18+, токен бота от BotFather.

### 1. Логин и зависимости

```bash
cd cloudflare
npm install
npx wrangler login
```

### 2. Создать D1 и подставить database_id

```bash
npx wrangler d1 create mygoals
```

Скопируйте `database_id` из вывода → в `wrangler.toml` вместо `REPLACE_ME`.

### 3. Применить миграции (remote)

```bash
npx wrangler d1 migrations apply mygoals --remote
```

Локально (для `wrangler dev`):

```bash
npx wrangler d1 migrations apply mygoals --local
```

### 4. Секреты и переменные

Секреты (не в git):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put SESSION_SECRET
# опционально, если username не mygoals_bot:
# npx wrangler secret put TELEGRAM_BOT_USERNAME
```

В `wrangler.toml` уже заданы `[vars]`:

- `TELEGRAM_BOT_USERNAME = "mygoals_bot"`
- `CORS_ORIGINS = "https://vgametikok.github.io"`

При необходимости поправьте или добавьте origins через запятую.

### 5. Деплой Worker

```bash
npx wrangler deploy
```

URL вида: `https://mygoals-api.<ваш-subdomain>.workers.dev`

Проверка: `GET https://…/api/health` → `{ "ok": true }`.

### 6. Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://mygoals-api.<subdomain>.workers.dev/telegram/webhook"
```

Проверка: `getWebhookInfo` должен показать тот же URL.

### 7. Фронт (GitHub Pages)

Укажите API:

```js
localStorage.setItem('GOALS_API', 'https://mygoals-api.<subdomain>.workers.dev')
```

BotFather: `/setdomain` → `vgametikok.github.io` (для Login Widget).

## Локальная разработка

```bash
cd cloudflare
npm install
npx wrangler d1 migrations apply mygoals --local
# секреты для dev: создайте .dev.vars (не коммитьте)
# TELEGRAM_BOT_TOKEN=...
# SESSION_SECRET=dev-secret
# TELEGRAM_BOT_USERNAME=mygoals_bot
npx wrangler dev
```

Webhook на localhost нужен туннель (cloudflared / ngrok) либо тестируйте widget/status отдельно.

## Заметки

- Cookie: `goals_token`, `HttpOnly; Secure; SameSite=None; Max-Age≈400 дней`. Токен также возвращается в JSON (`token`) для Bearer.
- Soft-claim кода входа ~2 минуты после первого успешного `status` (как в Express `db.markCodeUsed`).
- Пустой календарь по умолчанию: `{ categories:[], badges:[], tasks:[], compact:false, viewMode:"week" }`.
- Express-приложение в корне репозитория **не ломаем** — это запасной / локальный стек.

## Free tier

Workers + D1 Free обычно хватает для личного календаря. Следите за лимитами в дашборде Cloudflare.
