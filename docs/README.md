# GitHub Pages (фронт)

Сайт: https://vgametikok.github.io/goals_bot/

Статический фронт ходит на Cloudflare Worker API:
`https://mygoals-api.vgametikok.workers.dev`
(или переопределение через `localStorage.GOALS_API`).

Бэкенд и бот — только Cloudflare Workers + D1. См. корневой `README.md` и `cloudflare/README.md`.
