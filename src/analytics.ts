import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";

const apiKey = process.env.POSTHOG_API_KEY;
const host = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
const salt = process.env.ANALYTICS_HASH_SALT ?? process.env.TELEGRAM_WEBHOOK_SECRET;

if (apiKey && !salt) {
  throw new Error("ANALYTICS_HASH_SALT or TELEGRAM_WEBHOOK_SECRET is required when POSTHOG_API_KEY is configured");
}

const client = apiKey
  ? new PostHog(apiKey, {
      host,
      flushAt: 1,
      flushInterval: 1_000,
    })
  : null;

export type AnalyticsProperty = string | number | boolean | null | undefined | AnalyticsProperty[] | { [key: string]: AnalyticsProperty };
export type AnalyticsProperties = Record<string, AnalyticsProperty>;

export function analyticsEnabled() {
  return client !== null;
}

export function hashIdentifier(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (!salt) return null;
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 32);
}

export function capture(event: string, distinctId: string, properties: AnalyticsProperties = {}) {
  if (!client) return;
  try {
    client.capture({
      distinctId,
      event,
      properties: {
        app: "found-people-ve-bot",
        env: process.env.NODE_ENV ?? "development",
        ...cleanProperties(properties),
      },
    });
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", event: "analytics_capture_failed", message: error instanceof Error ? error.message : "unknown" }));
  }
}

export function captureSystem(event: string, properties: AnalyticsProperties = {}) {
  capture(event, "system", properties);
}

export function identify(distinctId: string, properties: AnalyticsProperties = {}) {
  if (!client) return;
  try {
    client.identify({
      distinctId,
      properties: cleanProperties(properties),
    });
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", event: "analytics_identify_failed", message: error instanceof Error ? error.message : "unknown" }));
  }
}

export async function shutdownAnalytics() {
  try {
    await client?.shutdown();
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", event: "analytics_shutdown_failed", message: error instanceof Error ? error.message : "unknown" }));
  }
}

function cleanProperties(properties: AnalyticsProperties) {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined),
  );
}
