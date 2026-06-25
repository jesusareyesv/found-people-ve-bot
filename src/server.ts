import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { ensureSchema, listPeople, requiredEnv, searchPeople, upsertPeople, type FoundPerson } from "./db.js";

const PeopleQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(10).default(5),
});

const SearchQuerySchema = PeopleQuerySchema.extend({
  name: z.string().trim().min(2).max(120),
});

const IngestSchema = z.object({
  people: z.array(z.object({
    nombre_completo: z.string().trim().min(2).max(200),
    informacion_relevante: z.string().trim().max(5000).nullable().optional(),
    fuente_url: z.string().url(),
    hash_fuente: z.string().trim().min(16).max(128).optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  })).min(1).max(200),
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/people") {
      const parsed = PeopleQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return json(response, 400, { error: "Invalid pagination", details: parsed.error.flatten() });
      return json(response, 200, await listPeople(parsed.data.page, parsed.data.pageSize));
    }

    if (request.method === "GET" && url.pathname === "/api/search") {
      const parsed = SearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) return json(response, 400, { error: "Invalid search", details: parsed.error.flatten() });
      return json(response, 200, await searchPeople(parsed.data.name, parsed.data.page, parsed.data.pageSize));
    }

    if (request.method === "POST" && url.pathname === "/api/ingest") {
      const authError = validateBearer(request.headers.authorization, env.ingestSecret);
      if (authError) return json(response, authError.status, { error: authError.message });

      const parsed = IngestSchema.safeParse(await readJson(request));
      if (!parsed.success) return json(response, 400, { error: "Invalid ingest payload", details: parsed.error.flatten() });

      const rows = await upsertPeople(parsed.data.people);
      return json(response, 200, { upserted: rows.length, people: rows });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const secretError = validateTelegramSecret(request.headers["x-telegram-bot-api-secret-token"]);
      if (secretError) return json(response, 401, { error: secretError });

      const update = TelegramUpdateSchema.parse(await readJson(request));
      await handleTelegramUpdate(update);
      return json(response, 200, { ok: true });
    }

    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: error instanceof Error ? error.message : "Internal error" });
  }
});

server.listen(env.port, () => {
  console.log(`found-people-ve-bot listening on :${env.port}`);
});

const TelegramUpdateSchema = z.object({
  message: z.object({
    chat: z.object({ id: z.number() }),
    text: z.string().optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string(),
    data: z.string().optional(),
    message: z.object({
      chat: z.object({ id: z.number() }),
      message_id: z.number(),
    }).optional(),
  }).optional(),
});

function validateTelegramSecret(header: string | string[] | undefined) {
  if (!env.telegramWebhookSecret) return null;
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
  const result = await searchPeople(query, 1, 5);
  const text = result.total === 0
    ? `No encontré resultados para “${query}”.\n\nPrueba con menos palabras o revisa la lista completa.`
    : formatPeopleList(result.items, `Resultados para “${query}”`, result.total);

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

  return `${title}\nTotal: ${total}\n\n${lines.join("\n\n")}`;
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

async function answerCallback(callbackQueryId: string) {
  return telegram("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

async function telegram(method: string, body: Record<string, unknown>) {
  if (!env.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram actions");
  const response = await fetch(`https://api.telegram.org/bot${env.telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Telegram ${method} failed with ${response.status}: ${await response.text()}`);
  return response.json();
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
