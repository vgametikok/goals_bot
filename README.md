# MYGOALS — календарь с входом через Telegram

Небольшой тестовый стек: Express + MongoDB Atlas (или JSON-файл) + бот Grammy + фронтенд-календарь.

> Это приложение для тестов. Не используйте в продакшене без доработки безопасности и бэкапов.
> Без `MONGODB_URI` данные живут в `data/store.json` и на Render Free **эфемерны** (сброс при редеплое / sleep).

## Предпочтительный бэкенд: Cloudflare Workers + D1

Для **постоянного** бесплатного API используйте каталог [`cloudflare/`](./cloudflare/) (Workers + D1, Telegram **webhook**). Express + Render/Mongo в корне репозитория остаётся для локальной разработки и как запасной вариант — его пока не убираем.

Краткий деплой: см. **[cloudflare/README.md](./cloudflare/README.md)** (`wrangler login` → `d1 create` → secrets → migrations → `deploy` → `setWebhook`).

На Pages после деплоя:

```js
localStorage.setItem('GOALS_API', 'https://mygoals-api.<subdomain>.workers.dev')
```

## Возможности

- Вход через Telegram Login Widget (GitHub Pages) или deep link `/start CODE` (локальный `public/`)
- Персональный календарь на пользователя (`GET/PUT /api/calendar`)
- Неделя / день / месяц, категории, бейджи, повторяющиеся задачи
- Новый аккаунт стартует с пустым календарём (без школьных пресетов) — категории и метки создаёт пользователь
- Long polling бота на Render Free (webhook не обязателен)
- Постоянное хранилище на **MongoDB Atlas** (бесплатный кластер M0)

## Требования

- Node.js 18+
- Бот в [@BotFather](https://t.me/BotFather)
- (для продакшена / Render) аккаунт [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)

## Настройка бота (BotFather)

1. Создайте бота командой `/newbot` (или возьмите существующего).
2. Скопируйте токен в `.env` → `TELEGRAM_BOT_TOKEN`.
3. Задайте username бота (например `mygoals_bot`) и пропишите его в `TELEGRAM_BOT_USERNAME`.
4. Для Login Widget: `/setdomain` → бот → домен `vgametikok.github.io`.
5. Для deep link `/start CODE` ничего дополнительно включать не нужно.

## MongoDB Atlas (бесплатно, M0)

Нужен на Render, иначе после каждого редеплоя / пробуждения пользователи и календари пропадут.

1. Зайдите на [cloud.mongodb.com](https://cloud.mongodb.com) → зарегистрируйтесь / войдите.
2. **Create** → **M0 Free** → выберите регион (например ближайший к Render) → создайте кластер.
3. **Database Access** → **Add New Database User** → пароль (сохраните) → роль `Atlas admin` или `Read and write to any database`.
4. **Network Access** → **Add IP Address** → **Allow Access from Anywhere** (`0.0.0.0/0`) — нужно для Render Free (динамические IP).
5. **Database** → **Connect** → **Drivers** → скопируйте URI вида  
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
6. В URI подставьте пароль пользователя; можно добавить имя БД:  
   `...mongodb.net/goals_bot?retryWrites=true&w=majority`  
   или оставить путь пустым и задать `MONGODB_DB=goals_bot` отдельно.
7. На **Render** → Environment → задайте секрет **`MONGODB_URI`** (и при желании `MONGODB_DB=goals_bot`) → **Redeploy**.
8. Локально: добавьте те же переменные в `.env`, либо **не задавайте** `MONGODB_URI` — тогда останется файловый режим `data/store.json`.

При первом старте с пустой MongoDB, если рядом есть локальный `data/store.json`, приложение один раз импортирует его (в логах будет `migrating local store.json`).

**Не коммитьте** URI с паролем и не печатайте его в логах.

## Локальный запуск

```bash
cp .env.example .env
# заполните TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, SESSION_SECRET
# опционально: MONGODB_URI / MONGODB_DB

npm install
npm start
```

Откройте http://localhost:3000 (same-origin UI из `public/`).

Режим разработки с автоперезапуском:

```bash
npm run dev
```

Без `MONGODB_URI` данные пишутся в `data/store.json` (каталог в `.gitignore`).

## Вход

### GitHub Pages (кросс-домен)

1. Откройте https://vgametikok.github.io/goals_bot/
2. «Войти» → Telegram Login Widget `@mygoals_bot`
3. Фронт шлёт `POST` на Render API (`/api/auth/telegram/widget`) с `credentials: include`
4. Календарь синхронизируется через `GET/PUT /api/calendar` (cookie-сессия, `SameSite=None`)

API URL по умолчанию: `https://goals-bot.onrender.com`. Чтобы переопределить:

```js
localStorage.setItem('GOALS_API', 'https://YOUR-SERVICE.onrender.com')
```

### Локально (`npm start`)

1. На сайте нажмите **«Войти через Telegram»**.
2. Откроется бот со ссылкой `https://t.me/<bot>?start=CODE`.
3. Бот подтвердит вход; сайт опросит `/api/auth/telegram/status` и выставит cookie.

## Переменные окружения

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен от BotFather |
| `TELEGRAM_BOT_USERNAME` | Username бота без `@` |
| `PORT` | Порт HTTP (Render задаёт сам; локально 3000) |
| `SESSION_SECRET` | Секрет для cookie-сессий и auth-токенов |
| `CORS_ORIGINS` | Разрешённые Origin через запятую (Pages → API) |
| `COOKIE_SECURE` | `1` — Secure + SameSite=None (нужно для Pages→Render) |
| `NODE_ENV` | `production` на Render (тоже включает secure cookies) |
| `MONGODB_URI` | Connection string Atlas. Если задан — MongoDB; иначе JSON-файл |
| `MONGODB_DB` | Имя БД (по умолчанию `goals_bot`) |
| `WEBHOOK_URL` | (опц.) Базовый URL для webhook вместо polling |
| `WEBHOOK_PATH` | (опц.) Путь webhook, по умолчанию `/telegram/webhook` |

## Деплой на Render Free (бесплатно)

1. Зайдите на [render.com](https://render.com) → **New +** → **Web Service**.
2. Подключите репозиторий **`vgametikok/goals_bot`** (или Blueprint из `render.yaml`).
3. Plan: **Free**. Runtime: **Node**. Build: `npm install`, Start: `npm start`.
4. Env: задайте **`TELEGRAM_BOT_TOKEN`** и **`MONGODB_URI`** (остальное из `render.yaml`: `SESSION_SECRET` generate, `COOKIE_SECURE=1`, `CORS_ORIGINS=https://vgametikok.github.io`, `TELEGRAM_BOT_USERNAME=mygoals_bot`, `NODE_ENV=production`, `MONGODB_DB=goals_bot`).
5. **Deploy**. URL вида `https://goals-bot.onrender.com` (имя сервиса может отличаться).
6. Проверка: `GET /api/health` → `{ "ok": true }`. В логах должно быть `[db] MongoDB ready`.

**Важно (Free):**

- Сервис **засыпает ~через 15 минут** без трафика; первый запрос после сна может ждать 30–60 с.
- Без `MONGODB_URI` диск **эфемерный** — JSON не переживает редеплой. С Atlas данные сохраняются.
- Webhook не нужен: бот идёт через **long polling**.
- Cookie-сессия кросс-сайтовая: `Secure` + `SameSite=None` + CORS `credentials`.

Если имя сервиса не `goals-bot`, на Pages задайте:

```js
localStorage.setItem('GOALS_API', 'https://<ваше-имя>.onrender.com')
```

## GitHub Pages (статика)

Статика: корневой `index.html` и копия в `docs/` (в синхроне).

1. Settings → Pages → Source: **Deploy from a branch**
2. Branch: **main**, folder: **/docs** (или корневой, если так настроено)
3. Сайт: https://vgametikok.github.io/goals_bot/

Pages остаётся статикой; API живёт на Render. Без API календарь работает офлайн через `localStorage`.

## GitHub

Репозиторий: https://github.com/vgametikok/goals_bot

**Не коммитьте** `.env`, `data/`, `node_modules/`, `*.db`.

## Стек

- Node.js + Express + `cors`
- **MongoDB Atlas** (официальный драйвер `mongodb`) или JSON-файл (`data/`) для локальной разработки
- Grammy (Telegram), express-session
- Статика `public/` для локального same-origin
- GitHub Pages + Render Free + Atlas M0 — бесплатный стек
