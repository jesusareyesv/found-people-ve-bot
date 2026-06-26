# Personas Encontradas VE Bot

Bot de Telegram para ayudar a consultar personas encontradas/localizadas tras la tragedia de los terremotos ocurridos el 24 de junio de 2026 en Venezuela.

El bot muestra resultados obtenidos de fuentes públicas, reportes ciudadanos y transcripciones de listas manuscritas de pacientes atendidos en centros médicos tras el terremoto. Cada resultado incluye un enlace a la fuente para que familiares, voluntarios y colaboradores puedan verificar la información.

Bot público: https://t.me/encontrados_ve_bot

Fuente principal de transcripciones médicas: https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026


Bot de Telegram para consultar personas encontradas/localizadas en Venezuela.

El servicio vive en Railway y usa Railway Postgres como base de datos propia.

## Endpoints

```txt
GET /health
GET /api/search?name=Maria&page=1&pageSize=5
GET /api/people?page=1&pageSize=5
GET /api/v1/found-people?page=1&pageSize=10
POST /api/v1/found-people/reports
POST /api/ingest
DELETE /api/people
POST /telegram/webhook
```

## Variables

```env
PORT=3000
DATABASE_URL=
INGEST_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ADMIN_CHAT_ID=
PUBLIC_BASE_URL=
```

## API externa v1

### Listar personas encontradas

```http
GET /api/v1/found-people?page=1&pageSize=10
```

Respuesta:

```json
{
  "data": [
    {
      "id": "uuid",
      "fullName": "Maria Perez",
      "relevantInfo": "Hospital / refugio / nota pública",
      "sourceUrl": "https://example.com/fuente",
      "status": "verified"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 352,
    "totalPages": 36
  }
}
```

Notas de seguridad:

- Solo devuelve registros visibles; registros `removed` quedan excluidos.
- `page` máximo: 500.
- `pageSize` máximo: 10.
- Tiene rate limit por IP.

### Reportar una persona encontrada

```http
POST /api/v1/found-people/reports
Authorization: Bearer $EXTERNAL_API_SECRET
Content-Type: application/json
Idempotency-Key: optional-stable-report-id
```

Payload:

```json
{
  "fullName": "Maria Perez",
  "location": "Refugio La Carlota",
  "sourceUrl": "https://example.com/fuente-opcional",
  "notes": "Información adicional opcional",
  "reporter": {
    "service": "nombre-del-servicio",
    "name": "nombre opcional",
    "contact": "contacto opcional"
  }
}
```

Respuesta `201`:

```json
{
  "data": {
    "id": "uuid",
    "fullName": "Maria Perez",
    "relevantInfo": "Reporte externo — ubicación: Refugio La Carlota",
    "sourceUrl": "https://example.com/fuente-opcional",
    "status": "citizen_report"
  }
}
```

Buenas prácticas aplicadas:

- Usa un secreto separado de `INGEST_SECRET`.
- El cliente externo no puede elegir `status`; siempre se guarda como `citizen_report`.
- El hash/idempotencia se genera server-side.
- El JSON usa schema estricto: campos inesperados son rechazados.
- `sourceUrl`, si se envía, debe ser `http(s)`.
- El body máximo es 256 KB.
- JSON inválido responde `400`; body demasiado grande responde `413`.
- Tiene rate limit por IP y por token.
- Notifica al admin para revisión operacional.

## Ingesta

`POST /api/ingest` does an upsert by `sourceHash`. If `sourceHash` is omitted, the backend generates one from `sourceUrl:fullName`.

```bash
curl -X POST "$PUBLIC_BASE_URL/api/ingest" \
  -H "Authorization: Bearer $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "people": [
      {
        "fullName": "Maria Perez",
        "relevantInfo": "Encontrada en refugio La Carlota",
        "sourceUrl": "https://example.com/fuente"
      }
    ]
  }'
```

## Analytics / PostHog

El bot puede enviar eventos server-side a PostHog si `POSTHOG_API_KEY` está configurado.

Variables:

```env
POSTHOG_API_KEY=
POSTHOG_HOST=https://us.i.posthog.com
ANALYTICS_HASH_SALT=
```

Notas de privacidad:

- No se envían nombres de personas buscadas, búsquedas, ubicaciones, notas, URLs, tokens ni IDs raw.
- Si Telegram provee `username`, se usa como `distinctId` legible (`telegram:@usuario`) y como propiedad `telegramUsername` en PostHog.
- Si Telegram no provee `username`, el ID de Telegram se hashea con `ANALYTICS_HASH_SALT` o `TELEGRAM_WEBHOOK_SECRET`.
- IPs/clientes externos se registran solo como hash cuando aplica.
- Si `POSTHOG_API_KEY` existe, producción debe tener `ANALYTICS_HASH_SALT` o `TELEGRAM_WEBHOOK_SECRET` configurado.

Taxonomía oficial de eventos:

Eventos de Telegram:

- `message_received`: mensaje recibido por el bot. No incluye el texto.
- `telegram_command`: comando usado (`ayuda`, `buscar`, `lista`, `reportar`, etc.; admin mantiene nombres en inglés).
- `search_performed`: búsqueda ejecutada; incluye bucket de longitud, tipo (`name`/`document`) y conteo de resultados, no la búsqueda ni la cédula.
- `list_viewed`: lista vista; incluye página y conteos.
- `citizen_report_created`: reporte ciudadano creado desde Telegram; solo flags/buckets, sin nombre, ubicación ni fuente.
- `feedback_submitted`: feedback enviado; solo bucket de longitud, no el contenido.
- `callback_clicked`: botón/callback usado; por ahora navegación de lista.
- `rate_limited`: rate limit aplicado en mensaje o callback.

Eventos de API externa:

- `external_api_list_requested`: consumo de `GET /api/v1/found-people`; incluye paginación/conteos y client ID hasheado.
- `external_report_created`: reporte creado vía `POST /api/v1/found-people/reports`; solo flags y client ID hasheado.

Identificación:

- `identify`: cuando Telegram provee `username`, se asocia `telegramUsername` y el `distinctId` visible queda como `telegram:@usuario`. No es un evento de actividad.

Eventos fuera de taxonomía:

- `openclaw_debug_event` y `openclaw_direct_capture_test` fueron pruebas manuales únicas de conectividad y no forman parte del bot.
- No debe existir ningún evento `openclaw_*` en la instrumentación de producción.

``/health`` devuelve `analytics: "configured" | "disabled"` para verificar si PostHog está activo.

## Uso en Telegram

- `/ayuda` muestra opciones y comandos principales.
- `/buscar Nombre Apellido` busca por nombre.
- `/buscar V12345678` busca por cédula; la búsqueda normaliza letras, puntos y guiones.
- `/lista` muestra la lista paginada.
- `/reportar` inicia un flujo guiado para reportar una persona encontrada. También acepta `/reportar Nombre Apellido | Ubicación | enlace opcional`.
- `/fuentes` explica de dónde salen los datos y sus limitaciones.
- `/sugerencia` inicia un flujo para enviar comentarios al administrador. También acepta `/sugerencia mensaje`.
- `/cancelar` cancela una operación pendiente.
- Cualquier texto libre se interpreta como búsqueda por nombre.


## Admin commands

These commands only work from `TELEGRAM_ADMIN_CHAT_ID`:

- `/admin_stats` shows totals by status and metrics.
- `/admin_recent [n] [status]` shows the latest citizen reports, max 10.
- `/admin_digest` shows a quick digest.
- `/admin_verify id` marks a record as verified.
- `/admin_review id` marks a record as needs review.
- `/admin_hide id` hides a record without deleting it.
- `/admin_delete id-or-url` permanently deletes by ID or source URL.
- `/admin_help` shows admin help.

## Configurar webhook

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Borrado manual protegido

```bash
curl -X DELETE "$PUBLIC_BASE_URL/api/people" \
  -H "Authorization: Bearer $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"https://example.com/fuente"}'
```

## Seguridad y límites

- `TELEGRAM_WEBHOOK_SECRET` debe estar configurado antes de exponer el webhook.
- `POST /api/ingest` y `DELETE /api/people` requieren `Authorization: Bearer $INGEST_SECRET`.
- Endpoints públicos y webhook tienen rate limit en memoria.
- `pageSize` máximo: 10.
- `page` máximo: 500.
- Body JSON máximo: 256 KB.
- Pool Postgres por defecto: `PG_POOL_MAX=5`.
