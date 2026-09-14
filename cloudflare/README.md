# MYGOALS API — Cloudflare Workers + D1

Предпочтительный постоянный бэкенд (бесплатный tier). Telegram — **только webhook** (Workers не умеют long polling).

Фронт на GitHub Pages (`https://vgametikok.github.io`) ходит сюда по CORS с cookie `goals_token` (`SameSite=None; Secure`) и/или Bearer-токеном.

## Структура

```
cloudflare/
  wrangler.toml
  package.json
  src/index.js       # роутер + cron scheduled
  src/db.js          # D1
  src/auth.js        # HMAC-токены (~400 дней)
  src/telegram.js    # Login Widget + webhook /start CODE
  src/backup.js      # ежедневный снимок D1 → R2
  migrations/0001_init.sql
```

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/health` | `{ ok: true, backups: true }` |
| POST | `/api/auth/telegram/start` | `{ loginUrl, code }` |
| GET | `/api/auth/telegram/status?code=` | poll → cookie + `token` |
| POST | `/api/auth/telegram/widget` | Login Widget HMAC |
| POST | `/api/auth/logout` | сброс cookie |
| GET | `/api/me` | текущий пользователь |
| GET/PUT | `/api/calendar` | JSON календаря |
| POST | `/telegram/webhook` | Telegram Update |
| POST | `/api/internal/backup` | ручной бэкап (заголовок `X-Backup-Secret`) |

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

### 4. R2 bucket для бэкапов (отдельный от albums)

```bash
npx wrangler r2 bucket create mygoals-backups
```

В `wrangler.toml` уже есть binding `BACKUPS` → bucket `mygoals-backups`.
**Не трогайте** bucket `albums-media`, Worker `albums`, домен albums.ink.

### 5. Секреты и переменные

Секреты (не в git):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler secret put BACKUP_SECRET
# опционально, если username не mygoals_bot:
# npx wrangler secret put TELEGRAM_BOT_USERNAME
```

В `wrangler.toml` уже заданы `[vars]`:

- `TELEGRAM_BOT_USERNAME = "mygoals_bot"`
- `CORS_ORIGINS = "https://vgametikok.github.io"`

Cron: `0 3 * * *` (ежедневно ~03:00 UTC).

### 6. Деплой Worker

```bash
npx wrangler deploy
```

URL вида: `https://mygoals-api.<ваш-subdomain>.workers.dev`

Проверка: `GET https://…/api/health` → `{ "ok": true, "backups": true }`.

Ручной бэкап (после `BACKUP_SECRET`):

```bash
curl -X POST https://mygoals-api.<subdomain>.workers.dev/api/internal/backup \
  -H "X-Backup-Secret: <BACKUP_SECRET>"
```

### 7. Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://mygoals-api.<subdomain>.workers.dev/telegram/webhook"
```

Проверка: `getWebhookInfo` должен показать тот же URL.

### 8. Фронт (GitHub Pages)

Укажите API:

```js
localStorage.setItem('GOALS_API', 'https://mygoals-api.<subdomain>.workers.dev')
```

BotFather: `/setdomain` → `vgametikok.github.io` (для Login Widget).

## Бэкапы D1 → R2

### Как хранятся

- Bucket: **`mygoals-backups`** (binding `BACKUPS`), отдельно от `albums-media`.
- Cron Worker `mygoals-api`: ежедневно в **03:00 UTC** (`0 3 * * *`).
- Ключи:
  - `daily/YYYY-MM-DD.json` — снимок за день (UTC)
  - `daily/latest.json` — всегда последний снимок (перезаписывается)
- Содержимое JSON: `{ version, createdAt, source, tables: { users, calendars, login_codes }, counts }`.
  Поле `calendars[].data` — распарсенный JSON календаря (не сырая строка).
- Retention: объекты `daily/YYYY-MM-DD.json` старше **14 дней** удаляются при каждом бэкапе. `latest.json` не трогается.

### Скачать снимок

Список объектов: в дашборде Cloudflare → R2 → `mygoals-backups` → prefix `daily/`
(в wrangler 3 нет `r2 object list`; при wrangler 4+ можно использовать CLI list, если доступен).

Скачать последний:

```bash
npx wrangler r2 object get mygoals-backups/daily/latest.json --file ./latest.json
```

Скачать за конкретную дату:

```bash
npx wrangler r2 object get mygoals-backups/daily/2026-09-14.json --file ./backup-2026-09-14.json
```

### Восстановление вручную (outline)

Админ-endpoint restore **не** реализован. Восстановление вручную:

1. Скачайте нужный JSON (см. выше).
2. Проверьте `counts` и структуру `tables`.
3. Вариант A — через `wrangler d1 execute` / SQL-скрипт:
   - Для каждого пользователя: `INSERT OR REPLACE INTO users (...) VALUES (...)`.
   - Для календарей: `INSERT OR REPLACE INTO calendars (telegram_id, data) VALUES (?, ?)` где `data` = `JSON.stringify(row.data)`.
   - `login_codes` обычно можно не восстанавливать (короткоживущие).
4. Вариант B — локально сгенерировать `.sql` из JSON и применить:

```bash
# пример идеи (псевдо):
# node scripts/json-to-sql.js backup.json > restore.sql
# npx wrangler d1 execute mygoals --remote --file=restore.sql
```

5. После restore проверьте `GET /api/me` и `GET /api/calendar` под тестовым пользователем.

**Важно:** не путать с Albums — bucket `albums-media` и Worker `albums` к MYGOALS не относятся и не должны меняться при бэкапе/restore.

## Локальная разработка

```bash
cd cloudflare
npm install
npx wrangler d1 migrations apply mygoals --local
# секреты для dev: создайте .dev.vars (не коммитьте)
# TELEGRAM_BOT_TOKEN=...
# SESSION_SECRET=dev-secret
# BACKUP_SECRET=dev-backup-secret
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

Workers + D1 + R2 Free обычно хватает для личного календаря. Следите за лимитами в дашборде Cloudflare.
