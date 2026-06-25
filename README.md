# Found Persons Telegram Bot

Backend standalone para Railway. Consulta `personas_encontradas` en Supabase y expone:

- `GET /health`
- `GET /api/search?name=...`
- `GET /api/people?page=1&pageSize=5`
- `POST /telegram/webhook`

## Variables

```env
PORT=3000
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
PUBLIC_BASE_URL=
```

## Local

```bash
npm install
npm run dev
```

## Railway

Configurar root directory: `apps/found-persons-telegram-bot`.

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

Webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```
