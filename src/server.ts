import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { deletePersonBySourceUrl, ensureSchema, listPeople, searchPeople, upsertPeople, type FoundPerson } from "./db.js";
import { rateLimit, sweepRateLimitBuckets } from "./rate-limit.js";

const MAX_JSON_BODY_BYTES = 256 * 1024;
const PUBLIC_API_LIMIT = { count: 60, windowMs: 60_000 };
const TELEGRAM_CHAT_LIMIT = { count: 20, windowMs: 60_000 };
const ADMIN_API_LIMIT = { count: 20, windowMs: 60_000 };

const PeopleQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(10).default(5),
});

const SearchQuerySchema = PeopleQuerySchema.extend({
  name: z.string().trim().min(2).max(80),
});

const PersonPayloadSchema = z.object({
  nombre_completo: z.string().trim().min(2).max(200),
  informacion_relevante: z.string().trim().max(5000).nullable().optional(),
  fuente_url: z.string().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed"),
  hash_fuente: z.string().trim().min(16).max(128).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const IngestSchema = z.object({
  people: z.array(PersonPayloadSchema).min(1).max(200),
});

const DeletePersonSchema = z.object({
  fuente_url: z.string().url().refine((url) => /^https?:\/\//i.test(url), "Only http(s) URLs are allowed"),
});

type TelegramUpdate = {
  message?: {
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
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
};

await ensureSchema();
setInterval(sweepRateLimitBuckets, 60_000).unref();

const server = createServer(async (request, response) => {
  try {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const clientKey = clientIp(request);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true });
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

      const rows = await deletePersonBySourceUrl(parsed.data.fuente_url);
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
    chat: z.object({ id: z.number() }),
    text: z.string().max(500).optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string().max(120),
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

async function handleTelegramUpdate(update: TelegramUpdate) {
  if (update.callback_query) return handleCallback(update.callback_query);

  const message = update.message;
  if (!message?.text) return;

  const limited = rateLimit(`chat:${message.chat.id}`, TELEGRAM_CHAT_LIMIT.count, TELEGRAM_CHAT_LIMIT.windowMs);
  if (!limited.allowed) {
    return sendMessage(message.chat.id, `Demasiadas consultas seguidas. Intenta de nuevo en ${limited.retryAfterSeconds}s.`);
  }

  const text = message.text.trim();
  if (text === "/start" || text === "/help") return sendMenu(message.chat.id);
  if (text === "/lista") return sendPeoplePage(message.chat.id, 1);

  if (text.startsWith("/buscar")) {
    const query = text.replace(/^\/buscar\s*/i, "").trim();
    if (!query) return askForSearch(message.chat.id);
    return sendSearchResults(message.chat.id, query);
  }

  return sendSearchResults(message.chat.id, text);
}

async function handleCallback(callback: NonNullable<TelegramUpdate["callback_query"]>) {
  if (!callback.message) return answerCallback(callback.id);

  const chatId = callback.message.chat.id;
  const limited = rateLimit(`chat:${chatId}`, TELEGRAM_CHAT_LIMIT.count, TELEGRAM_CHAT_LIMIT.windowMs);
  if (!limited.allowed) return answerCallback(callback.id, `Intenta de nuevo en ${limited.retryAfterSeconds}s.`);

  const messageId = callback.message.message_id;
  const data = callback.data ?? "";

  if (data === "menu") {
    await answerCallback(callback.id);
    return editMessage(chatId, messageId, menuText(), menuButtons());
  }

  if (data === "search") {
    await answerCallback(callback.id);
    return editMessage(chatId, messageId, "Escribe el nombre o nombre y apellido que quieres buscar.\n\nEjemplo: Maria Perez", [[button("📋 Ver lista", "list:1")]]);
  }

  const listMatch = data.match(/^list:(\d+)$/);
  if (listMatch) {
    await answerCallback(callback.id);
    return sendPeoplePage(chatId, Number(listMatch[1]), messageId);
  }

  return answerCallback(callback.id);
}

async function sendMenu(chatId: number) {
  return sendMessage(chatId, menuText(), menuButtons());
}

function menuText() {
  return "Hola. Puedo ayudarte a consultar personas encontradas/localizadas.\n\nPuedes buscar por nombre o ver la lista completa paginada.";
}

function menuButtons(): InlineButton[][] {
  return [
    [button("🔎 Buscar por nombre", "search")],
    [button("📋 Ver lista", "list:1")],
  ];
}

async function askForSearch(chatId: number) {
  return sendMessage(chatId, "Escribe el nombre o nombre y apellido.\n\nEjemplo: /buscar Maria Perez", [[button("📋 Ver lista", "list:1")]]);
}

async function sendPeoplePage(chatId: number, page: number, messageId?: number) {
  const result = await listPeople(page, 5);
  const text = formatPeopleList(result.items, `Personas encontradas (${result.page}/${result.totalPages})`, result.total);
  const buttons = [...sourceButtons(result.items), ...paginationButtons("list", result.page, result.totalPages)];
  return messageId ? editMessage(chatId, messageId, text, buttons) : sendMessage(chatId, text, buttons);
}

async function sendSearchResults(chatId: number, query: string) {
  const parsed = SearchQuerySchema.shape.name.safeParse(query);
  if (!parsed.success) return sendMessage(chatId, "Escribe al menos 2 caracteres y máximo 80 para buscar.");

  const result = await searchPeople(parsed.data, 1, 5);
  const text = result.total === 0
    ? `No encontré resultados para “${parsed.data}”.\n\nPrueba con menos palabras o revisa la lista completa.`
    : formatPeopleList(result.items, `Resultados para “${parsed.data}”`, result.total);

  return sendMessage(chatId, text, [
    ...sourceButtons(result.items),
    [button("🔎 Buscar otro nombre", "search"), button("📋 Ver lista", "list:1")],
  ]);
}

function formatPeopleList(items: FoundPerson[], title: string, total: number) {
  if (items.length === 0) return `${title}\n\nNo hay personas para mostrar.`;

  const lines = items.map((person, index) => [
    `${index + 1}. ${person.nombre_completo}`,
    person.informacion_relevante ? truncate(person.informacion_relevante, 260) : null,
  ].filter(Boolean).join("\n"));

  return truncate(`${title}\nTotal: ${total}\n\n${lines.join("\n\n")}`, 3500);
}

function sourceButtons(items: FoundPerson[]): InlineButton[][] {
  return items.map((person, index) => [urlButton(`Fuente ${index + 1}`, person.fuente_url)]);
}

function paginationButtons(prefix: string, page: number, totalPages: number): InlineButton[][] {
  const row: InlineButton[] = [];
  if (page > 1) row.push(button("⬅️ Anterior", `${prefix}:${page - 1}`));
  if (page < totalPages) row.push(button("Siguiente ➡️", `${prefix}:${page + 1}`));
  return row.length ? [row, [button("🔎 Buscar", "search")]] : [[button("🔎 Buscar", "search")]];
}

function button(text: string, callbackData: string): InlineButton {
  return { text, callback_data: callbackData };
}

function urlButton(text: string, url: string): InlineButton {
  return { text, url };
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function sendMessage(chatId: number, text: string, inlineKeyboard?: InlineButton[][]) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

async function editMessage(chatId: number, messageId: number, text: string, inlineKeyboard?: InlineButton[][]) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
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

async function readJson(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
