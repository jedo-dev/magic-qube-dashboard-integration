# Magic Qube Mail Dashboard

Node.js-сервис для Raspberry Pi:
- опрашивает почтовые интеграции (`yandex_imap`, подготовлен `mailru_imap`),
- хранит состояние в MongoDB,
- рисует дашборд на ESP через `POST /api/v1/draw/batch` и обновляет счетчики через `POST /api/v1/draw/text`.

## Стек

- Express + TypeScript
- MongoDB + Mongoose
- imapflow
- pino
- внутренний scheduler (`SCHEDULER_TICK_SEC`)

## Быстрый старт

```bash
npm install
cp .env.example .env
npm run dev
```

Прод:

```bash
npm run build
npm start
```

## ENV (минимум)

- `MONGO_URI`
- `ESP_BASE_URL`
- `DEFAULT_POLL_INTERVAL_SEC`
- `SCHEDULER_TICK_SEC`
- `STOP_GIF_ON_RENDER=true|false`
- `CREDENTIALS_ENCRYPTION_KEY`
- `API_KEY`
- `MAX_CONCURRENT_JOBS`

Дополнительно:
- `HOST` (по умолчанию `127.0.0.1`)
- `PORT` (по умолчанию `3000`)
- `ESP_TIMEOUT_MS`
- `ESP_RETRY_COUNT`
- `ESP_RETRY_DELAY_MS`
- `IMAP_CONNECT_TIMEOUT_MS` (по умолчанию 10000)

## API

- `GET /health` (без API-ключа)
- `GET /integrations`
- `POST /integrations`
- `PATCH /integrations/:id`
- `POST /sync`
- `GET /dashboard/state`

Все endpoint кроме `/health` требуют header:

```http
X-API-Key: <API_KEY>
```

## Scheduler

- каждый тик выбирает `enabled=true && nextRunAt <= now`
- mutex на интеграцию (одновременно одна и та же не запускается)
- глобальный лимит параллелизма: `MAX_CONCURRENT_JOBS`
- после успеха: `nextRunAt = now + pollIntervalSec`
- после ошибки: `nextRunAt = now + min(pollIntervalSec, backoff)`

## IMAP

- Yandex: `imap.yandex.ru:993 TLS`
- Mail.ru: `imap.mail.ru:993 TLS`
- login + app-password
- retry: `2s/5s/15s`

## Mongo

### `integrations`

- `type`: `yandex_imap | mailru_imap`
- `enabled`
- `label`
- `color`
- `sortOrder`
- `pollIntervalSec`
- `credentialsEnc`
- `lastUnreadCount`
- `lastCheckedAt`
- `lastSuccessAt`
- `lastError`
- `errorStreak`
- `nextRunAt`

Индексы:
- `{ enabled: 1, nextRunAt: 1 }`
- `{ sortOrder: 1 }`

### `dashboard_snapshots`

- `state`
- `createdAt`
- TTL индекс `7d`

## ESP рендер

- старт сервиса: full render
- первый успешный poll после старта: full render
- изменение count: только delta по изменившимся строкам
- при ошибке ESP: retry и не блокируем IMAP pipeline
- после восстановления ESP: full render

Экран 240x240, max 4 интеграции:
- title `MAIL`: `x=12,y=10,size=2,color=#ffffff`
- row `i`: `y = 50 + i*42`
- label: `x=44,y=(y-2),size=1,color=#aaaaaa`
- count: `x=170,y=(y-6),size=3,color=<integration.color>`
- delta обновление всегда с `bg:"#000000", clear:true`

## Systemd (Raspberry Pi)

Файл: `deploy/magic-qube-mail.service`

```bash
sudo cp deploy/magic-qube-mail.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable magic-qube-mail
sudo systemctl start magic-qube-mail
sudo systemctl status magic-qube-mail
```
