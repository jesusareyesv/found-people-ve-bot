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

## Uso en Telegram

- `/start` muestra opciones.
- `/list` muestra la lista paginada. `/lista` también funciona.
- `/search Nombre Apellido` busca por nombre. `/buscar` también funciona.
- `/feedback` inicia un flujo para enviar sugerencias al administrador. También acepta `/feedback mensaje`.
- `/report` inicia un flujo guiado para reportar una persona encontrada. También acepta `/report Nombre Apellido | Ubicación | enlace opcional`.
- `/source` explica de dónde salen los datos y sus limitaciones.
- `/cancel` cancela una operación pendiente.
- Cualquier texto libre se interpreta como búsqueda por nombre.


## Comandos admin

Estos comandos solo funcionan desde `TELEGRAM_ADMIN_CHAT_ID`:

- `/admin_stats` muestra totales por estado y métricas.
- `/admin_recent [n] [status]` muestra últimos reportes ciudadanos, máximo 10.
- `/admin_digest` muestra un resumen rápido.
- `/admin_verify id` marca un registro como verificado.
- `/admin_review id` marca un registro como por revisar.
- `/admin_hide id` oculta un registro sin borrarlo.
- `/admin_delete id-o-url` borra definitivamente por ID o URL de fuente.
- `/admin_help` muestra la ayuda admin.

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
