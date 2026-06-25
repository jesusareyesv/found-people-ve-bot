# found-people-ve-bot

Bot de Telegram para consultar personas encontradas/localizadas en Venezuela.

Consulta la tabla `personas_encontradas` en Supabase y expone endpoints separados para:

- búsqueda por nombre
- lista paginada en orden alfabético
- webhook de Telegram con botones inline

## Endpoints

```txt
GET /health
GET /api/search?name=Maria&page=1&pageSize=5
GET /api/people?page=1&pageSize=5
POST /telegram/webhook
```

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

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

## Configurar webhook

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Uso en Telegram

- `/start` muestra opciones.
- `/lista` muestra la lista paginada.
- `/buscar Nombre Apellido` busca por nombre.
- Cualquier texto libre se interpreta como búsqueda por nombre.
