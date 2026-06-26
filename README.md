# Found People Venezuela Bot

Telegram bot and public API for consulting and reporting people found or located after the June 24, 2026 earthquakes in Venezuela.

The bot shows records collected from public sources, citizen reports, and transcriptions of handwritten medical-attention lists. Each result includes a source link so relatives, volunteers, and community members can verify the information before taking action.

Public bot: https://t.me/encontrados_ve_bot

Main medical-transcription source: https://github.com/ecrespo/OCR-data_Terremoto_Venezuela_24062026

The service runs on Railway and uses Railway Postgres as its database.

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

## Environment variables

```env
PORT=3000
DATABASE_URL=
INGEST_SECRET=
EXTERNAL_API_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ADMIN_CHAT_ID=
PUBLIC_BASE_URL=
```

## External API v1

### List found people

```http
GET /api/v1/found-people?page=1&pageSize=10
```

Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "fullName": "Maria Perez",
      "relevantInfo": "Hospital / shelter / public note",
      "sourceUrl": "https://example.com/source",
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

Security notes:

- Only public-visible records are returned: `verified` and `citizen_report`. Records marked as `needs_review` or `removed`/hidden are excluded.
- Maximum `page`: 500.
- Maximum `pageSize`: 10.
- Rate-limited by IP.

### Report a found person

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
  "location": "La Carlota Shelter",
  "sourceUrl": "https://example.com/optional-source",
  "notes": "Optional additional information",
  "reporter": {
    "service": "service-name",
    "name": "optional name",
    "contact": "optional contact"
  }
}
```

`201` response:

```json
{
  "data": {
    "id": "uuid",
    "fullName": "Maria Perez",
    "relevantInfo": "External report — location: La Carlota Shelter",
    "sourceUrl": "https://example.com/optional-source",
    "status": "citizen_report"
  }
}
```

Applied safeguards:

- Uses a secret separate from `INGEST_SECRET`.
- External clients cannot choose `status`; reports are always stored as `citizen_report`.
- Hashing/idempotency is generated server-side.
- Strict JSON schema: unexpected fields are rejected.
- `sourceUrl`, when provided, must be `http(s)`.
- Maximum body size: 256 KB.
- Invalid JSON returns `400`; oversized bodies return `413`.
- Rate-limited by IP and token.
- Notifies the admin for operational review.

## Ingestion

`POST /api/ingest` upserts records by `sourceHash`. If `sourceHash` is omitted, the backend generates one from `sourceUrl:fullName`.

Optional `documentId` stores a Venezuelan ID number as normalized digits for private exact/partial search. It is not returned by the public listing/search API; public text should only include masked document references such as `cédula terminada en 1234`.

Public list/search responses only include `verified` and `citizen_report` records. `needs_review` is intentionally withheld from public results until an admin verifies it; `removed` is treated as hidden.

```bash
curl -X POST "$PUBLIC_BASE_URL/api/ingest" \
  -H "Authorization: Bearer $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "people": [
      {
        "fullName": "Maria Perez",
        "relevantInfo": "Found at La Carlota shelter",
        "documentId": "12345678",
        "sourceUrl": "https://example.com/source"
      }
    ]
  }'
```

## Analytics / PostHog

The bot can send server-side events to PostHog when `POSTHOG_API_KEY` is configured.

Variables:

```env
POSTHOG_API_KEY=
POSTHOG_HOST=https://us.i.posthog.com
ANALYTICS_HASH_SALT=
```

Privacy notes:

- Searched names, search text, locations, notes, URLs, tokens, and raw IDs are not sent.
- If Telegram provides a `username`, it is used as a readable `distinctId` (`telegram:@username`) and as the `telegramUsername` property in PostHog.
- If Telegram does not provide a `username`, the Telegram ID is hashed with `ANALYTICS_HASH_SALT` or `TELEGRAM_WEBHOOK_SECRET`.
- External client IPs/identifiers are only recorded as hashes when applicable.
- If `POSTHOG_API_KEY` is set, production must also configure `ANALYTICS_HASH_SALT` or `TELEGRAM_WEBHOOK_SECRET`.

Official event taxonomy:

Telegram events:

- `message_received`: message received by the bot. Does not include message text.
- `telegram_command`: command used (`ayuda`, `buscar`, `lista`, `reportar`, etc.; admin commands keep English names).
- `search_performed`: Telegram search executed; includes length bucket, query type (`name`/`document`), and result count. Does not include the search text or ID number.
- `search_matched`: search returned at least one match; emitted for Telegram and public API searches. Includes surface, length bucket, query type, pagination, and counts. Does not include the search text, ID number, names, or source URLs.
- `list_viewed`: list viewed; includes page and counts.
- `citizen_report_created`: citizen report created from Telegram; only flags/buckets, no name, location, or source.
- `feedback_submitted`: feedback sent; only length bucket, not the content.
- `rate_limited`: rate limit applied to a message or callback.

External API events:

- `search_matched`: public `/api/search` returned at least one match; uses a hashed client identifier and contains no query text or raw ID.
- `external_api_list_requested`: `GET /api/v1/found-people` usage; includes pagination/counts and hashed client ID.
- `external_report_created`: report created through `POST /api/v1/found-people/reports`; only flags and hashed client ID.

Identification:

- `identify`: when Telegram provides a `username`, `telegramUsername` is associated and the visible `distinctId` becomes `telegram:@username`. This is not an activity event.

Events outside the taxonomy:

- `openclaw_debug_event` and `openclaw_direct_capture_test` were one-off manual connectivity tests and are not part of the bot.
- No `openclaw_*` event should exist in production instrumentation.

`/health` returns `analytics: "configured" | "disabled"` to verify whether PostHog is active.

## Telegram usage

- `/ayuda` shows the main options and commands.
- `/buscar Nombre Apellido` searches by name.
- `/buscar V12345678` searches by Venezuelan ID number; the search normalizes letters, dots, and hyphens.
- `/lista` shows the paginated list.
- `/reportar` starts a guided flow to report a found person. It also accepts `/reportar Full Name | Location | optional link`.
- `/fuentes` explains where the data comes from and its limitations.
- `/sugerencia` starts a flow to send feedback to the admin. It also accepts `/sugerencia message`.
- `/cancelar` cancels a pending operation.
- Any free-text message is treated as a name search.

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

## Configure the Telegram webhook

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$PUBLIC_BASE_URL/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

## Protected manual deletion

```bash
curl -X DELETE "$PUBLIC_BASE_URL/api/people" \
  -H "Authorization: Bearer $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"https://example.com/source"}'
```

## Security and limits

- `TELEGRAM_WEBHOOK_SECRET` must be configured before exposing the webhook.
- `POST /api/ingest` and `DELETE /api/people` require `Authorization: Bearer $INGEST_SECRET`.
- Public endpoints and the webhook use in-memory rate limits.
- Maximum `pageSize`: 10.
- Maximum `page`: 500.
- Maximum JSON body size: 256 KB.
- Default Postgres pool size: `PG_POOL_MAX=5`.
