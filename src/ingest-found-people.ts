import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeDocumentId, sanitizeRelevantInfo } from "./ingest/found-persons/sanitize.js";
import { searchFoundPersonCandidates, type SearchCandidateInput } from "./ingest/found-persons/search-provider.js";

const DEFAULT_OUTPUT_DIR = "artifacts/found-people-ingest";
const DEFAULT_DB_BATCH_SIZE = 500;

type Args = {
  queryLimit: number;
  write: boolean;
  outputDir: string;
};

type SourceSummary = {
  candidates: number;
  accepted: number;
  skipped: number;
  withDocumentId: number;
};

function loadDotenv(filePath: string) {
  try {
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      process.env[key] ??= rest.join("=").replace(/^[ '\"]|[ '\"]$/g, "");
    }
  } catch {
    // Optional in local/CI.
  }
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const readValue = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
  };

  return {
    queryLimit: Number(readValue("--query-limit", "0")),
    write: args.includes("--write"),
    outputDir: readValue("--output-dir", DEFAULT_OUTPUT_DIR),
  };
}

function envInt(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sourceName(raw: Record<string, unknown> | undefined) {
  const source = raw?.source ?? raw?.provider;
  return typeof source === "string" && source.trim() ? source.trim().slice(0, 80) : "unknown";
}

function emptySourceSummary(): SourceSummary {
  return { candidates: 0, accepted: 0, skipped: 0, withDocumentId: 0 };
}

function incrementSourceSummary(sources: Record<string, SourceSummary>, source: string, field: keyof SourceSummary) {
  sources[source] ??= emptySourceSummary();
  sources[source][field] += 1;
}

function normalizeCandidate(candidate: SearchCandidateInput) {
  const fullName = candidate.fullName.replace(/\s+/g, " ").trim();
  const relevantInfo = sanitizeRelevantInfo(candidate.relevantInfo);
  const documentId = normalizeDocumentId(candidate.documentId);
  const reasons: string[] = [];

  if (fullName.length < 2) reasons.push("name_too_short");
  if (fullName.length > 200) reasons.push("name_too_long");
  if (!/^https?:\/\//i.test(candidate.sourceUrl)) reasons.push("invalid_source_url");

  return {
    accepted: reasons.length === 0,
    reasons,
    person: {
      fullName,
      relevantInfo,
      sourceUrl: candidate.sourceUrl,
      documentId,
      sourceHash: candidate.sourceHash,
      raw: candidate.raw ?? {},
    },
  };
}

function providerErrorSource(error: string) {
  const match = error.match(/^([a-zA-Z0-9_.-]+)\s+(?:page|:)/);
  return match?.[1] ?? "unknown";
}

function countProviderErrorsBySource(errors: string[]) {
  const counts: Record<string, number> = {};
  for (const error of errors) {
    const source = providerErrorSource(error);
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

async function upsertInBatches(people: Array<ReturnType<typeof normalizeCandidate>["person"]>, upsertPeople: (people: Array<ReturnType<typeof normalizeCandidate>["person"]>) => Promise<unknown[]>) {
  const batchSize = envInt("FOUND_PEOPLE_DB_INGEST_BATCH_SIZE", DEFAULT_DB_BATCH_SIZE);
  let upserted = 0;
  for (let index = 0; index < people.length; index += batchSize) {
    upserted += (await upsertPeople(people.slice(index, index + batchSize))).length;
  }
  return upserted;
}

async function main() {
  loadDotenv(".env.local");
  const args = parseArgs();
  const startedAt = new Date();

  const { capture, shutdownAnalytics } = await import("./analytics.js");
  const db = args.write ? await import("./db.js") : null;

  try {
    if (db) await db.ensureSchema();
    const result = await searchFoundPersonCandidates(args.queryLimit);

  const accepted = [];
  const skipped = [];
  const sources: Record<string, SourceSummary> = {};

  for (const candidate of result.candidates) {
    const source = sourceName(candidate.raw);
    incrementSourceSummary(sources, source, "candidates");

    const normalized = normalizeCandidate(candidate);
    if (normalized.accepted) {
      accepted.push(normalized.person);
      incrementSourceSummary(sources, source, "accepted");
      if (normalized.person.documentId) incrementSourceSummary(sources, source, "withDocumentId");
    } else {
      skipped.push({ ...normalized.person, reasons: normalized.reasons });
      incrementSourceSummary(sources, source, "skipped");
    }
  }

  const upserted = db && accepted.length > 0 ? await upsertInBatches(accepted, db.upsertPeople) : 0;
  const finishedAt = new Date();

  mkdirSync(args.outputDir, { recursive: true });
  const filename = `ingest-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  const outputPath = path.join(args.outputDir, filename);
  const report = {
    ok: true,
    dryRun: !args.write,
    wroteToDatabase: args.write,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    queryLimit: args.queryLimit,
    counts: {
      candidates: result.candidates.length,
      accepted: accepted.length,
      skipped: skipped.length,
      rejectedByProvider: result.rejected?.length ?? 0,
      providerErrors: result.errors.length,
      upserted,
    },
    sources,
    providerErrors: result.errors,
    accepted,
    skipped,
    rejectedByProvider: result.rejected ?? [],
  };

  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  const eventProperties = {
    ok: true,
    dryRun: !args.write,
    wroteToDatabase: args.write,
    queryLimit: args.queryLimit,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    candidates: report.counts.candidates,
    accepted: report.counts.accepted,
    skipped: report.counts.skipped,
    rejectedByProvider: report.counts.rejectedByProvider,
    providerErrors: report.counts.providerErrors,
    upserted: report.counts.upserted,
    sources,
    providerErrorsBySource: countProviderErrorsBySource(result.errors),
    sourceCount: Object.keys(sources).length,
    withDocumentId: Object.values(sources).reduce((total, source) => total + source.withDocumentId, 0),
  };
  capture("found_people_scrape_completed", process.env.POSTHOG_INGEST_DISTINCT_ID ?? "found_people_ingest", eventProperties);
  await shutdownAnalytics();

  console.log(JSON.stringify({ outputPath, counts: report.counts, sources }, null, 2));
  } finally {
    await shutdownAnalytics();
    await db?.pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
