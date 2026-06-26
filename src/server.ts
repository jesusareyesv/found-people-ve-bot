import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { deletePersonById, deletePersonBySourceUrl, ensureSchema, getFoundPeopleStats, getPersonById, incrementMetric, listPeople, listRecentCitizenReports, searchPeople, updatePersonStatus, upsertPeople, type FoundPerson, type RecordStatus } from "./db.js";
import { analyticsEnabled, capture, captureSystem, hashIdentifier, identify, shutdownAnalytics } from "./analytics.js";
import { rateLimit, sweepRateLimitBuckets } from "./rate-limit.js";

const MAX_JSON_BODY_BYTES = 256 * 1024;
const PUBLIC_API_LIMIT = { count: 60, windowMs: 60_000 };
const TELEGRAM_CHAT_LIMIT = { count: 20, windowMs: 60_000 };
const ADMIN_API_LIMIT = { count: 20, windowMs: 60_000 };
const EXTERNAL_REPORT_API_LIMIT = { count: 30, windowMs: 60_000 };

const PeopleQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(10).default(5),
});

const SearchQuerySchema = PeopleQuerySchema.extend({
  name: z.string().trim().min(2).max(80),
});

const PersonPayloadSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  relevantInfo: z.string().trim().max(5000).nullable().optional(),
  sourceUrl: z.string().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed"),
  sourceHash: z.string().trim().min(16).max(128).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const IngestSchema = z.object({
  people: z.array(PersonPayloadSchema).min(1).max(200),
});

const DeletePersonSchema = z.object({
  sourceUrl: z.string().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed"),
});

const ExternalReportSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  location: z.string().trim().min(2).max(300),
  sourceUrl: z.string().trim().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed").optional(),
  notes: z.string().trim().max(1000).optional(),
  reporter: z.object({
    name: z.string().trim().max(120).optional(),
    contact: z.string().trim().max(200).optional(),
    service: z.string().trim().max(80).optional(),
  }).strict().optional(),
}).strict();

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramUpdate = {
  message?: {
    message_id: number;
    chat: { id: number };
    from?: TelegramUser;
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: TelegramUser;
    data?: string;
    message?: {
      chat: { id: number };
      message_id: number;
    };
  };
};

type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

const env = {
  port: Number(process.env.PORT ?? 3000),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  ingestSecret: process.env.INGEST_SECRET,
  externalApiSecret: process.env.EXTERNAL_API_SECRET,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID ? Number(process.env.TELEGRAM_ADMIN_CHAT_ID) : null,
};

type PendingChatAction =
  | { kind: "search"; expiresAt: number }
  | { kind: "feedback"; expiresAt: number }
  | { kind: "report_name"; draft: Partial<ReportDraft>; expiresAt: number }
  | { kind: "report_location"; draft: Partial<ReportDraft>; expiresAt: number }
  | { kind: "report_source"; draft: Partial<ReportDraft>; expiresAt: number }
  | { kind: "report_confirm"; draft: ReportDraft; expiresAt: number };

type ReportDraft = { fullName: string; location: string; sourceUrl?: string | null };

const pendingChatActions = new Map<number, PendingChatAction>();
const shortPersonIds = new Map<string, { id: string; expiresAt: number }>();
const PENDING_ACTION_TTL_MS = 15 * 60_000;

await ensureSchema();
setInterval(sweepRateLimitBuckets, 60_000).unref();

const server = createServer(async (request, response) => {
  try {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const clientKey = clientIp(request);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, analytics: analyticsEnabled() ? "configured" : "disabled" });
    }

    if (request.method === "GET" && url.pathname === "/api/people") {
      const limited = applyRateLimit(response, `public:${clientKey}`, PUBLIC_API_LIMIT.count, PUBLIC_API_LIMIT.windowMs);
      if (limited) return;

      const parsed = PeopleQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return json(response, 400, { error: "Invalid pagination" });
      return json(response, 200, await listPeople(parsed.data.page, parsed.data.pageSize));
    }

    if (request.method === "GET" && url.pathname === "/api/search") {
      const limited = applyRateLimit(response, `public:${clientKey}`, PUBLIC_API_LIMIT.count, PUBLIC_API_LIMIT.windowMs);
      if (limited) return;

      const parsed = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return json(response, 400, { error: "Invalid search" });
      return json(response, 200, await searchPeople(parsed.data.name, parsed.data.page, parsed.data.pageSize));
    }

    if (request.method === "GET" && url.pathname === "/api/v1/found-people") {
      const limited = applyRateLimit(response, `external-list:${clientKey}`, PUBLIC_API_LIMIT.count, PUBLIC_API_LIMIT.windowMs);
      if (limited) return;

      const parsed = PeopleQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return json(response, 400, { error: "Invalid pagination" });

      const result = await listPeople(parsed.data.page, parsed.data.pageSize);
      await incrementMetric("external_api_list");
      captureSystem("external_api_list_requested", {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
        total: result.total,
        clientId: hashIdentifier(clientKey),
      });
      return json(response, 200, {
        data: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/v1/found-people/reports") {
      const limited = applyRateLimit(response, `external-report:${clientKey}`, EXTERNAL_REPORT_API_LIMIT.count, EXTERNAL_REPORT_API_LIMIT.windowMs);
      if (limited) return;

      const authError = validateBearerSecure(request.headers.authorization, env.externalApiSecret, "EXTERNAL_API_SECRET");
      if (authError) return json(response, authError.status, { error: authError.message });

      const authLimited = applyRateLimit(response, `external-report-auth:${clientKey}:${hashForRateLimit(request.headers.authorization ?? "")}`, EXTERNAL_REPORT_API_LIMIT.count, EXTERNAL_REPORT_API_LIMIT.windowMs);
      if (authLimited) return;

      if (!isJsonRequest(request)) return json(response, 415, { error: "Content-Type must be application/json" });

      const parsed = ExternalReportSchema.safeParse(await readJson(request, MAX_JSON_BODY_BYTES));
      if (!parsed.success) return json(response, 400, { error: "Invalid report payload" });

      const report = await createExternalReport(parsed.data, request.headers["idempotency-key"]);
      await incrementMetric("external_api_report");
      captureSystem("external_report_created", {
        hasSourceUrl: Boolean(parsed.data.sourceUrl),
        hasNotes: Boolean(parsed.data.notes),
        hasReporter: Boolean(parsed.data.reporter),
        hasReporterService: Boolean(parsed.data.reporter?.service),
        idempotencyKeyPresent: typeof request.headers["idempotency-key"] === "string",
        clientId: hashIdentifier(clientKey),
      });
      await notifyAdmin(`🆕 <b>Reporte externo insertado</b>

${formatAdminPerson(report)}`, adminActionButtons(report.id));
      return json(response, 201, { data: report });
    }

    if (request.method === "POST" && url.pathname === "/api/ingest") {
      const limited = applyRateLimit(response, `admin:${clientKey}`, ADMIN_API_LIMIT.count, ADMIN_API_LIMIT.windowMs);
      if (limited) return;

      const authError = validateBearer(request.headers.authorization, env.ingestSecret);
      if (authError) return json(response, authError.status, { error: authError.message });

      const parsed = IngestSchema.safeParse(await readJson(request, MAX_JSON_BODY_BYTES));
      if (!parsed.success) return json(response, 400, { error: "Invalid ingest payload" });

      const rows = await upsertPeople(parsed.data.people);
      return json(response, 200, { upserted: rows.length, people: rows });
    }

    if (request.method === "DELETE" && url.pathname === "/api/people") {
      const limited = applyRateLimit(response, `admin:${clientKey}`, ADMIN_API_LIMIT.count, ADMIN_API_LIMIT.windowMs);
      if (limited) return;

      const authError = validateBearer(request.headers.authorization, env.ingestSecret);
      if (authError) return json(response, authError.status, { error: authError.message });

      const parsed = DeletePersonSchema.safeParse(await readJson(request, MAX_JSON_BODY_BYTES));
      if (!parsed.success) return json(response, 400, { error: "Invalid delete payload" });

      const rows = await deletePersonBySourceUrl(parsed.data.sourceUrl);
      return json(response, 200, { deleted: rows.length, people: rows });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const secretError = validateTelegramSecret(request.headers["x-telegram-bot-api-secret-token"]);
      if (secretError) return json(response, 401, { error: secretError });

      const update = TelegramUpdateSchema.parse(await readJson(request, MAX_JSON_BODY_BYTES));
      await handleTelegramUpdate(update);
      return json(response, 200, { ok: true });
    }

    return json(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return json(response, 413, { error: "Request body too large" });
    if (error instanceof InvalidJsonError) return json(response, 400, { error: "Invalid JSON" });
    console.error(error instanceof Error ? error.message : error);
    return json(response, 500, { error: "Internal error" });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 16_000;
server.keepAliveTimeout = 5_000;

server.listen(env.port, () => {
  console.log(`found-people-ve-bot listening on :${env.port}`);
});

const TelegramUpdateSchema = z.object({
  message: z.object({
    message_id: z.number(),
    chat: z.object({ id: z.number() }),
    from: z.object({
      id: z.number(),
      username: z.string().max(64).optional(),
      first_name: z.string().max(128).optional(),
      last_name: z.string().max(128).optional(),
    }).optional(),
    text: z.string().max(1500).optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string().max(120),
    from: z.object({
      id: z.number(),
      username: z.string().max(64).optional(),
      first_name: z.string().max(128).optional(),
      last_name: z.string().max(128).optional(),
    }).optional(),
    data: z.string().max(64).optional(),
    message: z.object({
      chat: z.object({ id: z.number() }),
      message_id: z.number(),
    }).optional(),
  }).optional(),
});

function validateTelegramSecret(header: string | string[] | undefined) {
  if (!env.telegramWebhookSecret) return "Telegram webhook secret is not configured";
  return header === env.telegramWebhookSecret ? null : "Invalid Telegram webhook secret";
}

function validateBearer(header: string | undefined, expected: string | undefined) {
  if (!expected) return { status: 503, message: "INGEST_SECRET is not configured" };
  if (header !== `Bearer ${expected}`) return { status: 401, message: "Unauthorized" };
  return null;
}

function validateBearerSecure(header: string | undefined, expected: string | undefined, secretName: string) {
  if (!expected) return { status: 503, message: `${secretName} is not configured` };
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return { status: 401, message: "Unauthorized" };
  return timingSafeEqualString(header.slice(prefix.length), expected) ? null : { status: 401, message: "Unauthorized" };
}

function timingSafeEqualString(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isJsonRequest(request: IncomingMessage) {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0].trim() === "application/json";
}

function hashForRateLimit(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function createExternalReport(payload: z.infer<typeof ExternalReportSchema>, idempotencyKeyHeader: string | string[] | undefined) {
  const idempotencyKey = typeof idempotencyKeyHeader === "string" ? idempotencyKeyHeader.trim().slice(0, 120) : "";
  const stableHashInput = idempotencyKey || JSON.stringify({ fullName: payload.fullName, location: payload.location, sourceUrl: payload.sourceUrl ?? null });
  const reportHash = createHash("sha256").update(stableHashInput).digest("hex");
  const sourceUrl = payload.sourceUrl ?? `${publicBaseUrl()}/api/v1/found-people/reports/${reportHash.slice(0, 16)}`;
  const relevantInfo = [
    `Reporte externo — ubicación: ${payload.location}`,
    payload.notes ? `nota: ${payload.notes}` : null,
    payload.sourceUrl ? "fuente enviada por servicio externo" : "sin enlace externo",
  ].filter(Boolean).join(" — ");

  const [person] = await upsertPeople([{
    fullName: payload.fullName,
    relevantInfo,
    sourceUrl,
    status: "citizen_report",
    sourceHash: `external-report:${reportHash}`,
    raw: {
      provider: "external_report_api",
      location: payload.location,
      notes: payload.notes ?? null,
      reporter: payload.reporter ?? null,
      submittedSourceUrl: payload.sourceUrl ?? null,
      idempotencyKeyHash: idempotencyKey ? createHash("sha256").update(idempotencyKey).digest("hex") : null,
    },
  }]);

  return person;
}

function publicBaseUrl() {
  return (env.publicBaseUrl ?? `http://localhost:${env.port}`).replace(/\/$/, "");
}

function normalizeTelegramUsername(username: string | null | undefined) {
  const normalized = username?.trim().replace(/^@/, "");
  return normalized ? `@${normalized.toLowerCase()}` : null;
}

function telegramDistinctId(chatId: number, user?: TelegramUser) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) return `telegram:${username}`;
  return hashIdentifier(user?.id ?? chatId) ?? "telegram_unknown";
}

function telegramEvent(event: string, chatId: number) {
  return event;
}

function identifyTelegramUser(message: NonNullable<TelegramUpdate["message"]>) {
  const username = message.from?.username?.trim();
  if (!username) return;
  const normalizedUsername = normalizeTelegramUsername(username);
  if (!normalizedUsername) return;
  identify(telegramDistinctId(message.chat.id, message.from), {
    telegramUsername: normalizedUsername,
    telegramHasUsername: true,
  });
}

function captureTelegramCommand(message: NonNullable<TelegramUpdate["message"]>, command: string, properties: Record<string, string | number | boolean | null | undefined> = {}) {
  capture("telegram_command", telegramDistinctId(message.chat.id, message.from), {
    command,
    chatId: hashIdentifier(message.chat.id),
    userId: hashIdentifier(message.from?.id),
    ...properties,
  });
}

function commandName(text: string) {
  const match = text.match(/^\/([a-zA-Z_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase() ?? null;
}

function isCommand(text: string, command: string) {
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?(?:\\s|$)`, "i").test(text);
}

function commandPayload(text: string) {
  return text.replace(/^\/[a-zA-Z_]+(?:@[A-Za-z0-9_]+)?\s*/i, "").trim();
}

function lengthBucket(length: number) {
  if (length <= 0) return "empty";
  if (length <= 10) return "1-10";
  if (length <= 30) return "11-30";
  if (length <= 80) return "31-80";
  if (length <= 200) return "81-200";
  return "201+";
}

async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.callback_query) return handleCallback(update.callback_query);

  const message = update.message;
  if (!message?.text) return;

  const limited = rateLimit(`chat:${message.chat.id}`, TELEGRAM_CHAT_LIMIT.count, TELEGRAM_CHAT_LIMIT.windowMs);
  if (!limited.allowed) {
    capture(telegramEvent("rate_limited", message.chat.id), telegramDistinctId(message.chat.id, message.from), { surface: "telegram_message", retryAfterSeconds: limited.retryAfterSeconds });
    return sendMessage(message.chat.id, `Demasiadas consultas seguidas. Intenta de nuevo en ${limited.retryAfterSeconds}s.`);
  }

  const text = message.text.trim();
  identifyTelegramUser(message);
  capture(telegramEvent("message_received", message.chat.id), telegramDistinctId(message.chat.id, message.from), {
    chatType: "direct_or_group",
    isCommand: text.startsWith("/"),
    command: text.startsWith("/") ? commandName(text) : null,
    textLengthBucket: lengthBucket(text.length),
  });
  const pending = getPendingChatAction(message.chat.id);
  if (pending && !text.startsWith("/")) return handlePendingChatAction(message, text, pending);

  if (isCommand(text, "start") || isCommand(text, "ayuda")) {
    pendingChatActions.delete(message.chat.id);
    captureTelegramCommand(message, isCommand(text, "ayuda") ? "ayuda" : "start");
    return sendMenu(message.chat.id);
  }
  if (isCommand(text, "cancelar")) {
    captureTelegramCommand(message, "cancelar");
    return cancelPendingAction(message.chat.id);
  }
  if (isCommand(text, "fuentes")) {
    pendingChatActions.delete(message.chat.id);
    captureTelegramCommand(message, "fuentes");
    return handleSourceCommand(message, text);
  }

  if (text.startsWith("/admin")) {
    return handleAdminCommand(message, text);
  }

  if (isCommand(text, "lista")) {
    pendingChatActions.delete(message.chat.id);
    await incrementMetric("telegram_list");
    captureTelegramCommand(message, "lista");
    return sendPeoplePage(message.chat.id, 1, undefined, message.from);
  }

  if (isCommand(text, "sugerencia")) {
    pendingChatActions.delete(message.chat.id);
    captureTelegramCommand(message, "sugerencia");
    return handleFeedbackCommand(message, text);
  }

  if (isCommand(text, "reportar")) {
    pendingChatActions.delete(message.chat.id);
    captureTelegramCommand(message, "reportar");
    return handleReportCommand(message, text);
  }

  if (isCommand(text, "buscar")) {
    pendingChatActions.delete(message.chat.id);
    const query = commandPayload(text);
    captureTelegramCommand(message, "buscar", { hasQuery: Boolean(query) });
    if (!query) return askForSearch(message.chat.id);
    return sendSearchResults(message.chat.id, query, message);
  }

  if (text.startsWith("/")) return sendMessage(message.chat.id, "No reconozco ese comando. Usa /ayuda para ver las opciones.");

  return sendSearchResults(message.chat.id, text, message);
}

function getPendingChatAction(chatId: number) {
  const pending = pendingChatActions.get(chatId);
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    pendingChatActions.delete(chatId);
    return null;
  }
  return pending;
}

function setPendingChatAction(chatId: number, action: Record<string, unknown> & { kind: PendingChatAction["kind"] }) {
  pendingChatActions.set(chatId, { ...action, expiresAt: Date.now() + PENDING_ACTION_TTL_MS } as PendingChatAction);
}

function cancelPendingAction(chatId: number) {
  pendingChatActions.delete(chatId);
  return sendMessage(chatId, "Listo, cancelé la operación pendiente.");
}

async function handlePendingChatAction(message: NonNullable<TelegramUpdate["message"]>, text: string, pending: PendingChatAction) {
  if (text.toLowerCase() === "cancelar" || isCommand(text, "cancelar")) return cancelPendingAction(message.chat.id);

  if (pending.kind === "search") {
    pendingChatActions.delete(message.chat.id);
    return sendSearchResults(message.chat.id, text.trim(), message);
  }

  if (pending.kind === "feedback") {
    pendingChatActions.delete(message.chat.id);
    return submitFeedback(message, text.trim());
  }
  return handleReportStep(message, text.trim(), pending);
}

function rememberPersonId(id: string) {
  const shortId = id.replace(/-/g, "").slice(0, 12);
  shortPersonIds.set(shortId, { id, expiresAt: Date.now() + 60 * 60_000 });
  return shortId;
}

function resolvePersonId(value: string) {
  const cleaned = value.trim();
  const cached = shortPersonIds.get(cleaned);
  if (cached && cached.expiresAt >= Date.now()) return cached.id;
  return cleaned;
}

async function handleAdminCommand(message: NonNullable<TelegramUpdate["message"]>, text: string) {
  if (!isAdminChat(message.chat.id)) {
    captureTelegramCommand(message, "admin_unauthorized", { attemptedCommand: commandName(text) });
    return sendMessage(message.chat.id, "No autorizado.");
  }
  await incrementMetric("telegram_admin_command");
  captureTelegramCommand(message, commandName(text) ?? "admin");

  if (text === "/admin" || text === "/admin_help") return sendMessage(message.chat.id, adminHelpText());

  if (text === "/admin_stats") {
    const stats = await getFoundPeopleStats();
    return sendMessage(message.chat.id, `📊 <b>Stats</b>

Visible: ${stats.visible}
Total in database: ${stats.total}
Verified: ${stats.verified}
Citizen reports: ${stats.citizenReports}
Needs review: ${stats.needsReview}
Hidden: ${stats.removed}

Metrics:
${formatMetrics(stats.metrics)}`);
  }

  if (text.startsWith("/admin_recent")) {
    const parts = text.split(/\s+/).slice(1);
    const limit = Math.min(Number(parts[0]) || 5, 10);
    const status = parseStatus(parts[1]);
    const reports = await listRecentCitizenReports(limit, status ?? undefined);
    if (reports.length === 0) return sendMessage(message.chat.id, "No recent citizen reports.");
    return sendMessage(message.chat.id, formatAdminPeopleList(reports, `Latest citizen reports (${reports.length})`));
  }

  if (text.startsWith("/admin_digest")) {
    const stats = await getFoundPeopleStats();
    const reports = await listRecentCitizenReports(5);
    return sendMessage(message.chat.id, `🧾 <b>Admin digest</b>

Visible: ${stats.visible}
Citizen reports: ${stats.citizenReports}
Needs review: ${stats.needsReview}

${reports.length ? formatAdminPeopleList(reports, "Latest reports") : "No recent reports."}`);
  }

  if (text.startsWith("/admin_verify") || text.startsWith("/admin_review") || text.startsWith("/admin_hide")) {
    const [command, rawId] = text.split(/\s+/, 2);
    if (!rawId) return sendMessage(message.chat.id, `Usage: ${command} id`);
    const status: RecordStatus = command === "/admin_verify" ? "verified" : command === "/admin_review" ? "needs_review" : "removed";
    const rows = await updatePersonStatus(resolvePersonId(rawId), status);
    if (rows.length === 0) return sendMessage(message.chat.id, "Record not found.");
    await incrementMetric(`admin_${status}`);
    return sendMessage(message.chat.id, `✅ Status updated to <b>${escapeHtml(statusLabel(status))}</b>:

${formatAdminPerson(rows[0])}`);
  }

  if (text.startsWith("/admin_delete")) {
    const target = text.replace(/^\/admin_delete\s*/i, "").trim();
    if (!target) return sendMessage(message.chat.id, "Usage: /admin_delete id-or-url");

    const rows = isHttpUrl(target) ? await deletePersonBySourceUrl(target) : await deletePersonById(resolvePersonId(target));
    if (rows.length === 0) return sendMessage(message.chat.id, "No matching record found to delete.");
    await incrementMetric("admin_delete");
    return sendMessage(message.chat.id, `🗑️ Record permanently deleted:

${formatAdminPerson(rows[0])}`);
  }

  return sendMessage(message.chat.id, adminHelpText());
}

function isAdminChat(chatId: number) {
  return env.adminChatId !== null && chatId === env.adminChatId;
}

function adminHelpText() {
  return "🔐 <b>Admin commands</b>\n\n/admin_stats — metrics and totals\n/admin_recent [n] [status] — latest citizen reports\n/admin_digest — quick digest\n/admin_verify id — mark as verified\n/admin_review id — mark as needs review\n/admin_hide id — hide without deleting\n/admin_delete id-or-url — permanently delete\n/admin_help — show this help";
}

async function handleCallback(callback: NonNullable<TelegramUpdate["callback_query"]>) {
  if (!callback.message) return answerCallback(callback.id);

  const chatId = callback.message.chat.id;
  const limited = rateLimit(`chat:${chatId}`, TELEGRAM_CHAT_LIMIT.count, TELEGRAM_CHAT_LIMIT.windowMs);
  if (!limited.allowed) {
    capture(telegramEvent("rate_limited", chatId), telegramDistinctId(chatId, callback.from), { surface: "telegram_callback", retryAfterSeconds: limited.retryAfterSeconds });
    return answerCallback(callback.id, `Intenta de nuevo en ${limited.retryAfterSeconds}s.`);
  }

  const messageId = callback.message.message_id;
  const data = callback.data ?? "";

  if (data === "menu") {
    await answerCallback(callback.id);
    return editMessage(chatId, messageId, menuText(), menuButtons());
  }

  if (data === "search") {
    await answerCallback(callback.id);
    setPendingChatAction(chatId, { kind: "search" });
    return editMessage(chatId, messageId, "Escribe el nombre, apellido o cédula que quieres buscar.\n\nEjemplos: Maria Perez · V12345678", [[button("📋 Ver lista", "list:1")]]);
  }

  const adminActionMatch = data.match(/^adm:(verify|review|hide):([a-f0-9]{12})$/);
  if (adminActionMatch && isAdminChat(chatId)) {
    const status = adminActionMatch[1] === "verify" ? "verified" : adminActionMatch[1] === "review" ? "needs_review" : "removed";
    const rows = await updatePersonStatus(resolvePersonId(adminActionMatch[2]), status as RecordStatus);
    await answerCallback(callback.id, rows.length ? "Actualizado" : "No encontrado");
    return rows.length ? sendMessage(chatId, `Estado actualizado:

${formatAdminPerson(rows[0])}`) : undefined;
  }

  const listMatch = data.match(/^list:(\d+)$/);
  if (listMatch) {
    await answerCallback(callback.id);
    return sendPeoplePage(chatId, Number(listMatch[1]), messageId, callback.from);
  }

  return answerCallback(callback.id);
}

async function sendMenu(chatId: number) {
  return sendMessage(chatId, menuText(), menuButtons());
}

function menuText() {
  return `<b>Personas Encontradas 🇻🇪</b>

Este bot ayuda a consultar y reportar personas encontradas tras el terremoto en Venezuela.

Reúne información de fuentes públicas, transcripciones de listas de atención médica y reportes ciudadanos para apoyar a familiares, voluntarios y comunidades durante la emergencia.

Antes de tomar decisiones, verifica siempre la información con familiares, fuentes oficiales o contactos directos.

<b>Cómo usarlo</b>
• Escribe un nombre directamente para buscar.
• /buscar nombre — buscar por nombre
• /buscar V12345678 — buscar por cédula
• /lista — ver lista de personas encontradas
• /reportar — reportar una persona encontrada
• /fuentes — fuentes y limitaciones
• /sugerencia — enviar correcciones o comentarios
• /cancelar — cancelar una operación

Código fuente:
https://github.com/edwinvrgs/found-people-ve-bot`;
}
function menuButtons(): InlineButton[][] {
  return [
    [button("🔎 Buscar", "search"), button("📋 Lista", "list:1")],
  ];
}

async function askForSearch(chatId: number) {
  setPendingChatAction(chatId, { kind: "search" });
  return sendMessage(chatId, "Escribe el nombre, apellido o cédula.\n\nEjemplos: Maria Perez · V12345678", [[button("📋 Ver lista", "list:1")]]);
}

async function handleSourceCommand(message: NonNullable<TelegramUpdate["message"]>, text: string) {
  await incrementMetric("telegram_source");
  const id = commandPayload(text);
  if (!id) return sendMessage(message.chat.id, sourceText());

  const person = await getPersonById(resolvePersonId(id));
  if (!person) return sendMessage(message.chat.id, "No encontré ese registro.");
  return sendMessage(message.chat.id, `ℹ️ <b>Fuente del registro</b>

${formatAdminPerson(person)}

Estado: ${statusEmoji(person.status)} ${escapeHtml(statusLabel(person.status))}`);
}

function sourceText() {
  return `ℹ️ <b>Sobre las fuentes</b>

Los datos vienen de fuentes públicas, reportes ciudadanos y transcripciones de listas manuscritas de pacientes atendidos en centros médicos.

Cada resultado muestra un enlace cuando está disponible. Los reportes ciudadanos ayudan en la emergencia, pero no reemplazan confirmación familiar, canales oficiales o la fuente original.

Si ves un error, escribe /sugerencia para reportarlo.`;
}

async function handleFeedbackCommand(message: NonNullable<TelegramUpdate["message"]>, text: string) {
  const feedback = commandPayload(text);
  if (!feedback) {
    setPendingChatAction(message.chat.id, { kind: "feedback" });
    return sendMessage(message.chat.id, "Claro. Escríbeme tu sugerencia en el próximo mensaje.");
  }
  return submitFeedback(message, feedback);
}

async function submitFeedback(message: NonNullable<TelegramUpdate["message"]>, feedback: string) {
  if (feedback.length < 3) {
    setPendingChatAction(message.chat.id, { kind: "feedback" });
    return sendMessage(message.chat.id, "El mensaje está muy corto. Escríbeme un poco más de detalle, por favor.");
  }

  capture(telegramEvent("feedback_submitted", message.chat.id), telegramDistinctId(message.chat.id, message.from), { textLengthBucket: lengthBucket(feedback.length) });
  await notifyAdmin(`💬 <b>Feedback recibido</b>

${formatReporter(message)}

<b>Mensaje:</b>
${escapeHtml(feedback)}`);
  return sendMessage(message.chat.id, "Gracias. Recibí tu sugerencia y se la envié al equipo.");
}

async function handleReportCommand(message: NonNullable<TelegramUpdate["message"]>, text: string) {
  const payload = commandPayload(text);
  if (payload) return submitReport(message, parseReportPayload(payload));
  setPendingChatAction(message.chat.id, { kind: "report_name", draft: {} });
  return sendMessage(message.chat.id, "Vamos a agregar un reporte ciudadano.\n\n¿Cuál es el <b>nombre y apellido</b> de la persona encontrada?\n\nPuedes escribir /cancelar para cancelar.");
}

async function handleReportStep(message: NonNullable<TelegramUpdate["message"]>, text: string, pending: PendingChatAction) {
  if (pending.kind === "report_name") {
    if (text.length < 4) {
      setPendingChatAction(message.chat.id, { kind: "report_name", draft: pending.draft });
      return sendMessage(message.chat.id, "El nombre parece muy corto. Escríbelo de nuevo, por favor.");
    }
    setPendingChatAction(message.chat.id, { kind: "report_location", draft: { ...pending.draft, fullName: text } });
    return sendMessage(message.chat.id, "¿Dónde fue encontrada o dónde está?\n\nEjemplo: Refugio La Carlota, Hospital Pérez Carreño, La Guaira...");
  }

  if (pending.kind === "report_location") {
    if (text.length < 2) {
      setPendingChatAction(message.chat.id, { kind: "report_location", draft: pending.draft });
      return sendMessage(message.chat.id, "La ubicación parece muy corta. Escríbela de nuevo, por favor.");
    }
    setPendingChatAction(message.chat.id, { kind: "report_source", draft: { ...pending.draft, location: text } });
    return sendMessage(message.chat.id, "Si tienes un enlace/fuente, envíalo ahora. Si no tienes, escribe <b>omitir</b>.");
  }

  if (pending.kind === "report_source") {
    const sourceUrl = /^omitir$/i.test(text) ? null : normalizeOptionalSourceUrl(text);
    if (!sourceUrl && !/^omitir$/i.test(text)) {
      setPendingChatAction(message.chat.id, { kind: "report_source", draft: pending.draft });
      return sendMessage(message.chat.id, "No pude leer ese enlace. Envía un link http(s) o escribe <b>omitir</b>.");
    }
    const draft = { ...pending.draft, sourceUrl } as ReportDraft;
    setPendingChatAction(message.chat.id, { kind: "report_confirm", draft });
    return sendMessage(message.chat.id, `Confirma el reporte:

<b>Nombre:</b> ${escapeHtml(draft.fullName)}
<b>Ubicación:</b> ${escapeHtml(draft.location)}
<b>Fuente:</b> ${draft.sourceUrl ? `<a href="${escapeHtmlAttribute(draft.sourceUrl)}">abrir enlace</a>` : "sin enlace"}

Responde <b>sí</b> para publicar o <b>no</b> para cancelar.`);
  }

  if (pending.kind === "report_confirm") {
    if (!/^s[ií]$/i.test(text)) return cancelPendingAction(message.chat.id);
    pendingChatActions.delete(message.chat.id);
    return submitReport(message, pending.draft);
  }
}

function parseReportPayload(payload: string): ReportDraft {
  const [fullName, location, submittedSourceUrl] = payload.split("|").map((part) => part.trim());
  return { fullName, location, sourceUrl: normalizeOptionalSourceUrl(submittedSourceUrl) };
}

async function submitReport(message: NonNullable<TelegramUpdate["message"]>, draft: Partial<ReportDraft>) {
  const { fullName, location } = draft;
  if (!fullName || !location || fullName.length < 4 || location.length < 2) {
    setPendingChatAction(message.chat.id, { kind: "report_name", draft: {} });
    return sendMessage(message.chat.id, "No pude leer el reporte. Empecemos de nuevo: ¿cuál es el nombre y apellido?");
  }

  const sourceUrl = draft.sourceUrl ?? fallbackReportSourceUrl(message);
  const relevantInfo = `Reporte ciudadano — ubicación: ${location}${draft.sourceUrl ? " — fuente enviada por usuario" : " — sin enlace externo"}`;
  const [person] = await upsertPeople([{
    fullName,
    relevantInfo,
    sourceUrl,
    status: "citizen_report",
    sourceHash: `telegram-report:${message.chat.id}:${message.message_id}`,
    raw: { provider: "telegram_report", location, submittedSourceUrl: draft.sourceUrl ?? null, reporter: reporterRaw(message), messageId: message.message_id, chatId: message.chat.id },
  }]);
  await incrementMetric("telegram_report");
  capture(telegramEvent("citizen_report_created", message.chat.id), telegramDistinctId(message.chat.id, message.from), {
    hasSourceUrl: Boolean(draft.sourceUrl),
    sourceKind: draft.sourceUrl ? "user_url" : "fallback",
    locationLengthBucket: lengthBucket(location.length),
  });

  await notifyAdmin(`🆕 <b>Reporte ciudadano insertado</b>

${formatReporter(message)}

${formatAdminPerson(person)}`, adminActionButtons(person.id));

  return sendMessage(message.chat.id, `Gracias. Agregué el reporte de <b>${escapeHtml(fullName)}</b> a la lista.\n\nSi luego detectas un error, puedes escribir /sugerencia.`);
}

async function sendPeoplePage(chatId: number, page: number, messageId?: number, user?: TelegramUser) {
  const result = await listPeople(page, 5);
  capture(telegramEvent("list_viewed", chatId), telegramDistinctId(chatId, user), { page, total: result.total, resultCount: result.items.length });
  const text = formatPeopleList(result.items, `Personas encontradas (${result.page}/${result.totalPages})`, result.total);
  const buttons = paginationButtons("list", result.page, result.totalPages);
  return messageId ? editMessage(chatId, messageId, text, buttons) : sendMessage(chatId, text, buttons);
}

async function sendSearchResults(chatId: number, query: string, message?: NonNullable<TelegramUpdate["message"]>) {
  const parsed = SearchQuerySchema.shape.name.safeParse(query);
  if (!parsed.success) return sendMessage(chatId, "Escribe al menos 2 caracteres y máximo 80 para buscar. Puedes buscar por nombre o cédula.");

  await incrementMetric("telegram_search");
  const result = await searchPeople(parsed.data, 1, 5);
  const documentSearch = documentSearchLabel(parsed.data);
  capture(telegramEvent("search_performed", chatId), telegramDistinctId(chatId, message?.from), {
    queryLengthBucket: lengthBucket(parsed.data.length),
    queryType: documentSearch ? "document" : "name",
    resultCount: result.items.length,
    total: result.total,
  });
  const displayQuery = documentSearch ?? `“${escapeHtml(parsed.data)}”`;
  const text = result.total === 0
    ? `No encontré resultados para ${displayQuery}.\n\nPrueba con menos caracteres o revisa la lista completa.`
    : formatPeopleList(result.items, `Resultados para ${displayQuery}`, result.total);

  return sendMessage(chatId, text, [[button("🔎 Buscar", "search"), button("📋 Lista", "list:1")]]);
}

function documentSearchLabel(query: string) {
  const digits = query.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return `cédula terminada en ${escapeHtml(digits.slice(-4))}`;
}

function normalizeOptionalSourceUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function fallbackReportSourceUrl(message: NonNullable<TelegramUpdate["message"]>) {
  return `https://t.me/encontrados_ve_bot?start=report_${message.chat.id}_${message.message_id}`;
}

function reporterRaw(message: NonNullable<TelegramUpdate["message"]>) {
  return {
    id: message.from?.id ?? null,
    username: message.from?.username ?? null,
    firstName: message.from?.first_name ?? null,
    lastName: message.from?.last_name ?? null,
  };
}

function formatReporter(message: NonNullable<TelegramUpdate["message"]>) {
  const user = message.from;
  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Usuario sin nombre";
  const username = user?.username ? `@${user.username}` : "sin username";
  return `<b>Usuario:</b> ${escapeHtml(displayName)} (${escapeHtml(username)})\n<b>User ID:</b> ${escapeHtml(String(user?.id ?? "desconocido"))}\n<b>Chat ID:</b> ${escapeHtml(String(message.chat.id))}`;
}

async function notifyAdmin(text: string, inlineKeyboard?: InlineButton[][]) {
  if (!env.adminChatId) return;
  await sendMessage(env.adminChatId, text, inlineKeyboard);
}

function adminActionButtons(personId: string): InlineButton[][] {
  const shortId = rememberPersonId(personId);
  return [[
    button("✅ Verificar", `adm:verify:${shortId}`),
    button("⚠️ Revisar", `adm:review:${shortId}`),
    button("🙈 Ocultar", `adm:hide:${shortId}`),
  ]];
}

function statusLabel(status: RecordStatus) {
  return status === "verified" ? "verificado" : status === "citizen_report" ? "reporte ciudadano" : status === "needs_review" ? "por revisar" : "oculto";
}

function statusEmoji(status: RecordStatus) {
  return status === "verified" ? "✅" : status === "citizen_report" ? "🧾" : status === "needs_review" ? "⚠️" : "🙈";
}

function parseStatus(value: string | undefined): RecordStatus | null {
  return value === "verified" || value === "citizen_report" || value === "needs_review" || value === "removed" ? value : null;
}

function formatMetrics(metrics: Record<string, number>) {
  const entries = Object.entries(metrics);
  if (entries.length === 0) return "sin métricas todavía";
  return entries.map(([key, value]) => `${escapeHtml(key)}: ${value}`).join("\n");
}

function formatAdminPeopleList(items: FoundPerson[], title: string) {
  const lines = items.map(formatAdminPerson);
  return truncate(`${escapeHtml(title)}\n\n${lines.join("\n\n")}`, 3500);
}

function formatAdminPerson(person: FoundPerson) {
  return [
    `<b>${escapeHtml(person.fullName)}</b> ${statusEmoji(person.status)}`,
    `ID: <code>${escapeHtml(rememberPersonId(person.id))}</code>`,
    person.relevantInfo ? escapeHtml(truncate(person.relevantInfo, 180)) : null,
    `<a href="${escapeHtmlAttribute(person.sourceUrl)}">Ver fuente</a>`,
  ].filter(Boolean).join("\n");
}

function formatPeopleList(items: FoundPerson[], title: string, total: number) {
  if (items.length === 0) return `${escapeHtml(title)}\n\nNo hay personas para mostrar.`;

  const lines = items.map((person, index) => [
    `${index + 1}. <b>${escapeHtml(person.fullName)}</b>`,
    person.relevantInfo ? escapeHtml(truncate(person.relevantInfo, 220)) : null,
    `<a href="${escapeHtmlAttribute(person.sourceUrl)}">Fuente</a>`,
  ].filter(Boolean).join("\n"));

  return truncate(`${escapeHtml(title)}\nTotal: ${total}\n\n${lines.join("\n\n")}`, 3500);
}

function paginationButtons(prefix: string, page: number, totalPages: number): InlineButton[][] {
  const row: InlineButton[] = [];
  if (page > 1) row.push(button("⬅️", `${prefix}:${page - 1}`));
  if (page < totalPages) row.push(button("➡️", `${prefix}:${page + 1}`));
  return row.length ? [row] : [];
}

function button(text: string, callbackData: string): InlineButton {
  return { text, callback_data: callbackData };
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

async function sendMessage(chatId: number, text: string, inlineKeyboard?: InlineButton[][]) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

async function editMessage(chatId: number, messageId: number, text: string, inlineKeyboard?: InlineButton[][]) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

async function answerCallback(callbackQueryId: string, text?: string) {
  return telegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

async function telegram(method: string, body: Record<string, unknown>) {
  if (!env.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram actions");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Telegram ${method} failed with ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

class RequestBodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

process.once("SIGTERM", () => {
  void shutdownAnalytics().finally(() => process.exit(0));
});

process.once("SIGINT", () => {
  void shutdownAnalytics().finally(() => process.exit(0));
});

async function readJson(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new RequestBodyTooLargeError("Request body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new InvalidJsonError("Invalid JSON");
  }
}

function applyRateLimit(response: ServerResponse, key: string, limit: number, windowMs: number) {
  const limited = rateLimit(key, limit, windowMs);
  if (limited.allowed) return false;
  response.setHeader("retry-after", String(limited.retryAfterSeconds));
  json(response, 429, { error: "Too many requests", retryAfterSeconds: limited.retryAfterSeconds });
  return true;
}

function clientIp(request: IncomingMessage) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return request.socket.remoteAddress ?? "unknown";
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
