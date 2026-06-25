# found-people-ve-bot

Bot de Telegram para consultar personas encontradas/localizadas en Venezuela.

El servicio vive en Railway y usa Railway Postgres como base de datos propia.

## Endpoints

```txt
GET /health
GET /api/search?name=Maria&page=1&pageSize=5
GET /api/people?page=1&pageSize=5
POST /api/ingest
POST /telegram/webhook
```

## Variables

```env
PORT=3000
DATABASE_URL=
INGEST_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
PUBLIC_BASE_URL=
```

## Ingesta

`POST /api/ingest` hace upsert por `hash_fuente`. Si no se envía `hash_fuente`, el backend genera uno con `fuente_url:nombre_completo`.

```bash
curl -X POST "$PUBLIC_BASE_URL/api/ingest" \
  -H "Authorization: Bearer $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "people": [
      {
        "nombre_completo": "Maria Perez",
        "informacion_relevante": "Encontrada en refugio La Carlota",
        "fuente_url": "https://example.com/fuente"
      }
    ]
  }'
```

## Uso en Telegram

- `/start` muestra opciones.
- `/lista` muestra la lista paginada.
- `/buscar Nombre Apellido` busca por nombre.
- Cualquier texto libre se interpreta como búsqueda por nombre.

## Configurar webhook

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```
