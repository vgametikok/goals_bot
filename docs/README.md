# GitHub Pages

Эта папка публикуется как сайт на GitHub Pages.

В репозитории: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` → Folder: `/docs` → Save**.

Сайт: `https://vgametikok.github.io/goals_bot/`

Статический фронт ходит на API Render Free (`https://goals-bot.onrender.com` или `localStorage.GOALS_API`).
Вход — Telegram Login Widget → `POST /api/auth/telegram/widget` (cookie-сессия, CORS).
Без API календарь работает офлайн через `localStorage`.

См. корневой `README.md` → раздел «Деплой на Render Free».
