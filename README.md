# Goals — тестовый календарь с входом через Telegram

Небольшой тестовый стек: Express + JSON-хранилище + бот Grammy + фронтенд-календарь.

> Это приложение для тестов. Не используйте в продакшене без доработки безопасности и бэкапов.
> На Render Free диск **эфемерный**: `data/store.json` сбрасывается при редеплое / sleep — только для проб.

## Возможности

- Вход через Telegram Login Widget (GitHub Pages) или deep link `/start CODE` (локальный `public/`)
- Персональный календарь на пользователя (`GET/PUT /api/calendar`)
- Неделя / день / месяц, категории, бейджи, повторяющиеся задачи
- Long polling бота на Render Free (webhook не обязателен)

## Требования

- Node.js 18+
- Бот в [@BotFather](https://t.me/BotFather)

## Настройка бота (BotFather)

1. Создайте бота командой `/newbot` (или возьмите существующего).
2. Скопируйте токен в `.env` → `TELEGRAM_BOT_TOKEN`.
3. Задайте username бота (например `mygoals_bot`) и пропишите его в `TELEGRAM_BOT_USERNAME`.
4. Для Login Widget: `/setdomain` → бот → домен `vgametikok.github.io`.
5. Для deep link `/start CODE` ничего дополнительно включать не нужно.

## Локальный запуск

```bash
cp .env.example .env
# заполните TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, SESSION_SECRET

npm install
npm start
```

Откройте http://localhost:3000 (same-origin UI из `public/`).

Режим разработки с автоперезапуском:

```bash
npm run dev
```

Данные пользователей пишутся в `data/store.json` (каталог в `.gitignore`).

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
| `SESSION_SECRET` | Секрет для cookie-сессий |
| `CORS_ORIGINS` | Разрешённые Origin через запятую (Pages → API) |
| `COOKIE_SECURE` | `1` — Secure + SameSite=None (нужно для Pages→Render) |
| `NODE_ENV` | `production` на Render (тоже включает secure cookies) |
| `WEBHOOK_URL` | (опц.) Базовый URL для webhook вместо polling |
| `WEBHOOK_PATH` | (опц.) Путь webhook, по умолчанию `/telegram/webhook` |

## Деплой на Render Free (бесплатно)

1. Зайдите на [render.com](https://render.com) → **New +** → **Web Service**.
2. Подключите репозиторий **`vgametikok/goals_bot`** (или Blueprint из `render.yaml`).
3. Plan: **Free**. Runtime: **Node**. Build: `npm install`, Start: `npm start`.
4. Env: задайте **`TELEGRAM_BOT_TOKEN`** (остальное из `render.yaml`: `SESSION_SECRET` generate, `COOKIE_SECURE=1`, `CORS_ORIGINS=https://vgametikok.github.io`, `TELEGRAM_BOT_USERNAME=mygoals_bot`, `NODE_ENV=production`).
5. **Deploy**. URL вида `https://goals-bot.onrender.com` (имя сервиса может отличаться).
6. Проверка: `GET /api/health` → `{ "ok": true }`.

**Важно (Free):**

- Сервис **засыпает ~через 15 минут** без трафика; первый запрос после сна может ждать 30–60 с.
- Диск **эфемерный** — JSON-хранилище пользователей не переживает редеплой / новый инстанс. Только для тестов.
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
- JSON-файл (`data/`) — бесплатно, но эфемерно на Render Free
- Grammy (Telegram), express-session
- Статика `public/` для локального same-origin
- GitHub Pages + Render Free — исключительно бесплатный стек
