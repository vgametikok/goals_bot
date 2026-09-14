# Goals — тестовый календарь с входом через Telegram

Небольшой тестовый стек: Express + JSON-хранилище + бот Grammy + фронтенд-календарь (адаптация `schedule.html`).

> Это приложение для тестов. Не используйте в продакшене без доработки безопасности и бэкапов.

## Возможности

- Вход через Telegram-бота (одноразовый код / deep link)
- Персональный календарь на пользователя (`GET/PUT /api/calendar`)
- Неделя / день / месяц, категории, бейджи, повторяющиеся задачи
- Long polling бота локально; опционально `WEBHOOK_URL`

## Требования

- Node.js 18+
- Бот в [@BotFather](https://t.me/BotFather)

## Настройка бота (BotFather)

1. Создайте бота командой `/newbot` (или возьмите существующего).
2. Скопируйте токен в `.env` → `TELEGRAM_BOT_TOKEN`.
3. Задайте username бота (например `mygoals_bot`) и пропишите его в `TELEGRAM_BOT_USERNAME`.
4. Для deep link `/start CODE` ничего дополнительно включать не нужно.

## Локальный запуск

```bash
cp .env.example .env
# заполните TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, SESSION_SECRET

npm install
npm start
```

Откройте http://localhost:3000

Режим разработки с автоперезапуском:

```bash
npm run dev
```

Данные пользователей пишутся в `data/store.json` (каталог в `.gitignore`).

## Вход

1. На сайте нажмите **«Войти через Telegram»**.
2. Откроется бот со ссылкой `https://t.me/<bot>?start=CODE`.
3. Бот подтвердит вход на русском.
4. Сайт опросит `/api/auth/telegram/status` и выставит cookie-сессию.

## Переменные окружения

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен от BotFather |
| `TELEGRAM_BOT_USERNAME` | Username бота без `@` |
| `PORT` | Порт HTTP (по умолчанию 3000) |
| `SESSION_SECRET` | Секрет для cookie-сессий |
| `WEBHOOK_URL` | (опц.) Базовый URL для webhook вместо polling |
| `WEBHOOK_PATH` | (опц.) Путь webhook, по умолчанию `/telegram/webhook` |
| `COOKIE_SECURE` | `1` — Secure-cookie (HTTPS) |

## GitHub

Репозиторий: https://github.com/vladsrilanka/goals

```bash
git init
git remote add origin https://github.com/vladsrilanka/goals.git
git add .
git commit -m "Initial goals test app"
git push -u origin main
```

**Не коммитьте** `.env`, `data/`, `node_modules/`, `*.db`.

## Деплой (кратко)

1. Задайте env-переменные на хосте.
2. `npm install && npm start`
3. Для webhook укажите `WEBHOOK_URL` (HTTPS) и откройте путь webhook наружу.
4. Без webhook бот работает через long polling (удобно для тестов).

## Стек

- Node.js + Express
- JSON-файл (`data/`) вместо SQLite (native `better-sqlite3` не собрался в среде без `make`)
- Grammy (Telegram)
- express-session (cookie)
- Статика из `public/`
