import { createHash } from "node:crypto";
import { buildFoundPersonSocialQueries } from "./queries.js";
import { extractFoundPerson, looksLikePersonName } from "./extract-person.js";
import { searchGithubOcrCandidates } from "./ocr-github-source.js";
import { extractDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import { searchTiltelyFoundPersonCandidates } from "./tiltely-source.js";
import type { FoundPersonCandidate } from "./types.js";

export type SearchCandidateInput = FoundPersonCandidate & {
  sourceHash: string;
  raw?: Record<string, unknown>;
};

export type RejectedSearchCandidate = {
  provider: "socialcrawl";
  query: string;
  reason: string;
  url: string | null;
  title: string | null;
  text: string | null;
};

export type SearchProviderResult = {
  candidates: SearchCandidateInput[];
  errors: string[];
  rejected?: RejectedSearchCandidate[];
};

type SocialCrawlEnvelope = {
  success?: boolean;
  platform?: string;
  request_id?: string;
  data?: unknown;
  error?: { message?: string };
};

type CandidateSource = {
  provider: "socialcrawl";
  query: string;
  url: string;
  title: string | null;
  text: string | null;
  platform?: string | null;
  requestId?: string | null;
};

const SOCIALCRAWL_BASE_URL = "https://www.socialcrawl.dev/v1";
const SOCIAL_SOURCE_HOSTS = ["x.com", "twitter.com", "instagram.com", "facebook.com", "tiktok.com"];

export function canonicalizeSourceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

export function hashSource(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSocialUrl(url: string) {
  const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  return SOCIAL_SOURCE_HOSTS.some((sourceHost) => host === sourceHost || host.endsWith(`.${sourceHost}`));
}

function toStringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function readPath(record: unknown, paths: string[][]) {
  for (const path of paths) {
    let current: unknown = record;
    for (const key of path) {
      if (!current || typeof current !== "object" || !(key in current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    const value = toStringValue(current);
    if (value) return value;
  }
  return null;
}

function findFirstUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return isHttpUrl(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findFirstUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["url", "post_url", "permalink", "link", "source_url"]) {
      const url = findFirstUrl(record[key]);
      if (url) return url;
    }
    for (const nested of Object.values(record)) {
      const url = findFirstUrl(nested);
      if (url) return url;
    }
  }
  return null;
}

function extractItems(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.breakdown)) return record.breakdown;
  if (Array.isArray(record.posts)) return record.posts;
  return [];
}

function toCandidate(source: CandidateSource): SearchCandidateInput | RejectedSearchCandidate {
  const sourceUrl = canonicalizeSourceUrl(source.url);
  const rawRelevantInfo = [source.title, source.text].filter(Boolean).join(". ");
  const relevantInfo = sanitizeRelevantInfo(rawRelevantInfo);
  const fullName = extractFoundPerson(rawRelevantInfo).fullName;

  if (!fullName) return reject(source, "no_name_detected");
  if (!looksLikePersonName(fullName)) return reject(source, "invalid_name_shape");

  return {
    fullName,
    relevantInfo,
    sourceUrl,
    documentId: extractDocumentId(rawRelevantInfo),
    sourceHash: hashSource(`${sourceUrl}:${fullName}`),
    raw: {
      provider: source.provider,
      query: source.query,
      platform: source.platform ?? null,
      request_id: source.requestId ?? null,
    },
  };
}

function reject(source: Omit<CandidateSource, "url"> & { url?: string | null }, reason: string): RejectedSearchCandidate {
  return {
    provider: "socialcrawl",
    query: source.query,
    reason,
    url: source.url ?? null,
    title: source.title,
    text: source.text,
  };
}

function isRejected(candidate: SearchCandidateInput | RejectedSearchCandidate): candidate is RejectedSearchCandidate {
  return "reason" in candidate;
}

async function searchSocialCrawl(queryLimit: number): Promise<SearchProviderResult> {
  if (queryLimit <= 0) return { candidates: [], errors: [], rejected: [] };
  const apiKey = process.env.SOCIALCRAWL_API_KEY;
  if (!apiKey) return { candidates: [], errors: ["SOCIALCRAWL_API_KEY is not configured; skipped social search"], rejected: [] };

  const candidates: SearchCandidateInput[] = [];
  const rejected: RejectedSearchCandidate[] = [];
  const errors: string[] = [];

  for (const query of buildFoundPersonSocialQueries(queryLimit)) {
    try {
      const url = new URL(`${SOCIALCRAWL_BASE_URL}/search/everywhere`);
      url.searchParams.set("query", query);
      url.searchParams.set("lookback_days", "30");
      url.searchParams.set("sources", "twitter,instagram,facebook,tiktok");

      const response = await fetch(url, {
        headers: { Accept: "application/json", "x-api-key": apiKey },
      });
      const envelope = (await response.json().catch(() => ({}))) as SocialCrawlEnvelope;

      if (!response.ok || envelope.success === false) {
        errors.push(`${query}: SocialCrawl failed with ${response.status}${envelope.error?.message ? ` (${envelope.error.message})` : ""}`);
        continue;
      }

      for (const item of extractItems(envelope.data)) {
        const title = readPath(item, [["title"], ["post", "title"], ["author", "display_name"], ["post", "author", "display_name"]]);
        const text = readPath(item, [["text"], ["content"], ["description"], ["caption"], ["post", "content", "text"], ["post", "text"]]);
        const sourceUrl = findFirstUrl(item);

        if (!sourceUrl) {
          rejected.push(reject({ provider: "socialcrawl", query, title, text, platform: envelope.platform, requestId: envelope.request_id }, "no_url"));
          continue;
        }
        if (!isSocialUrl(sourceUrl)) {
          rejected.push(reject({ provider: "socialcrawl", query, url: sourceUrl, title, text, platform: envelope.platform, requestId: envelope.request_id }, "non_social_url"));
          continue;
        }

        const candidate = toCandidate({
          provider: "socialcrawl",
          query,
          url: sourceUrl,
          title,
          text,
          platform: envelope.platform,
          requestId: envelope.request_id,
        });

        if (isRejected(candidate)) rejected.push(candidate);
        else candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${query}: ${error instanceof Error ? error.message : "unknown SocialCrawl error"}`);
    }
  }

  return { candidates, errors, rejected };
}

export async function searchFoundPersonCandidates(queryLimit = 1): Promise<SearchProviderResult> {
  const [social, githubOcr, tiltely] = await Promise.all([
    searchSocialCrawl(queryLimit),
    searchGithubOcrCandidates(),
    searchTiltelyFoundPersonCandidates(),
  ]);

  const byHash = new Map<string, SearchCandidateInput>();
  for (const candidate of [...social.candidates, ...githubOcr.candidates, ...tiltely.candidates]) {
    byHash.set(candidate.sourceHash, candidate);
  }

  return {
    candidates: [...byHash.values()],
    errors: [...social.errors, ...githubOcr.errors, ...tiltely.errors],
    rejected: social.rejected ?? [],
  };
}
