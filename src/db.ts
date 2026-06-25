import pg from "pg";

const { Pool } = pg;

export type RecordStatus = "verified" | "citizen_report" | "needs_review" | "removed";

export type FoundPerson = {
  id: string;
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
  status: RecordStatus;
};

export type FoundPersonWithMetadata = FoundPerson & {
  createdAt: string;
  updatedAt: string;
  provider: string | null;
};

export const pool = new Pool({
  connectionString: requiredEnv("DATABASE_URL"),
  max: Number(process.env.PG_POOL_MAX ?? 5),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

export function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS unaccent;

    CREATE TABLE IF NOT EXISTS found_people (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name TEXT NOT NULL,
      relevant_info TEXT,
      source_url TEXT NOT NULL CHECK (source_url ~* '^https?://'),
      source_hash TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'verified',
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'nombre_completo')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'full_name') THEN
        ALTER TABLE found_people RENAME COLUMN nombre_completo TO full_name;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'informacion_relevante')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'relevant_info') THEN
        ALTER TABLE found_people RENAME COLUMN informacion_relevante TO relevant_info;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'fuente_url')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'source_url') THEN
        ALTER TABLE found_people RENAME COLUMN fuente_url TO source_url;
      END IF;

      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'hash_fuente')
        AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'found_people' AND column_name = 'source_hash') THEN
        ALTER TABLE found_people RENAME COLUMN hash_fuente TO source_hash;
      END IF;
    END $$;

    ALTER TABLE found_people
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'verified';

    UPDATE found_people
    SET status = 'citizen_report'
    WHERE raw->>'provider' = 'telegram_report'
      AND status = 'verified';

    ALTER TABLE found_people
      ALTER COLUMN full_name SET NOT NULL,
      ALTER COLUMN source_url SET NOT NULL,
      ALTER COLUMN source_hash SET NOT NULL,
      ALTER COLUMN status SET NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'found_people_source_url_http_check') THEN
        ALTER TABLE found_people ADD CONSTRAINT found_people_source_url_http_check CHECK (source_url ~* '^https?://');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'found_people_status_check') THEN
        ALTER TABLE found_people ADD CONSTRAINT found_people_status_check CHECK (status IN ('verified', 'citizen_report', 'needs_review', 'removed'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_found_people_full_name ON found_people (lower(full_name));
    CREATE INDEX IF NOT EXISTS idx_found_people_full_name_trgm ON found_people USING gin (full_name gin_trgm_ops);
    -- Keep trigram on raw name. Search uses unaccent() for recall; table is small enough for now.
    CREATE INDEX IF NOT EXISTS idx_found_people_status ON found_people (status);
    CREATE INDEX IF NOT EXISTS idx_found_people_updated_at ON found_people (updated_at DESC);

    CREATE TABLE IF NOT EXISTS bot_metrics (
      name TEXT PRIMARY KEY,
      value BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function listPeople(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    pool.query<FoundPerson>(
      `${baseSelect()}
       WHERE status <> 'removed'
       ORDER BY lower(full_name) ASC, source_url ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    pool.query<{ count: string }>("SELECT count(*) FROM found_people WHERE status <> 'removed'"),
  ]);

  return pageResult(items.rows, page, pageSize, Number(total.rows[0]?.count ?? 0));
}

export async function searchPeople(name: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const query = `%${name}%`;
  const [items, total] = await Promise.all([
    pool.query<FoundPerson>(
      `${baseSelect()}
       WHERE status <> 'removed'
         AND unaccent(lower(full_name)) ILIKE unaccent(lower($1))
       ORDER BY lower(full_name) ASC, source_url ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, offset],
    ),
    pool.query<{ count: string }>(
      "SELECT count(*) FROM found_people WHERE status <> 'removed' AND unaccent(lower(full_name)) ILIKE unaccent(lower($1))",
      [query],
    ),
  ]);

  return pageResult(items.rows, page, pageSize, Number(total.rows[0]?.count ?? 0));
}

export async function upsertPeople(people: Array<{
  fullName: string;
  relevantInfo?: string | null;
  sourceUrl: string;
  sourceHash?: string;
  status?: RecordStatus;
  raw?: Record<string, unknown>;
}>) {
  const rows: FoundPerson[] = [];

  for (const person of people) {
    const hash = person.sourceHash ?? await sha256(`${person.sourceUrl}:${person.fullName}`);
    const status = person.status ?? "verified";
    const result = await pool.query<FoundPerson>(
      `INSERT INTO found_people (full_name, relevant_info, source_url, source_hash, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (source_hash) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         relevant_info = EXCLUDED.relevant_info,
         source_url = EXCLUDED.source_url,
         status = CASE WHEN found_people.status = 'removed' THEN found_people.status ELSE EXCLUDED.status END,
         raw = EXCLUDED.raw,
         updated_at = now()
       RETURNING ${returningColumns()}`,
      [person.fullName, person.relevantInfo ?? null, person.sourceUrl, hash, status, JSON.stringify(person.raw ?? {})],
    );
    rows.push(result.rows[0]);
  }

  return rows;
}

export async function deletePersonBySourceUrl(sourceUrl: string) {
  const result = await pool.query<FoundPerson>(
    `DELETE FROM found_people WHERE source_url = $1 RETURNING ${returningColumns()}`,
    [sourceUrl],
  );
  return result.rows;
}

export async function deletePersonById(id: string) {
  const result = await pool.query<FoundPerson>(
    `DELETE FROM found_people WHERE id = $1 RETURNING ${returningColumns()}`,
    [id],
  );
  return result.rows;
}

export async function updatePersonStatus(id: string, status: RecordStatus) {
  const result = await pool.query<FoundPerson>(
    `UPDATE found_people SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${returningColumns()}`,
    [id, status],
  );
  return result.rows;
}

export async function getFoundPeopleStats() {
  const result = await pool.query<{ total: string; visible: string; citizen_reports: string; needs_review: string; verified: string; removed: string }>(
    `SELECT
       count(*) AS total,
       count(*) FILTER (WHERE status <> 'removed') AS visible,
       count(*) FILTER (WHERE status = 'citizen_report') AS citizen_reports,
       count(*) FILTER (WHERE status = 'needs_review') AS needs_review,
       count(*) FILTER (WHERE status = 'verified') AS verified,
       count(*) FILTER (WHERE status = 'removed') AS removed
     FROM found_people`,
  );
  const metrics = await getBotMetrics();
  return {
    total: Number(result.rows[0]?.total ?? 0),
    visible: Number(result.rows[0]?.visible ?? 0),
    citizenReports: Number(result.rows[0]?.citizen_reports ?? 0),
    needsReview: Number(result.rows[0]?.needs_review ?? 0),
    verified: Number(result.rows[0]?.verified ?? 0),
    removed: Number(result.rows[0]?.removed ?? 0),
    metrics,
  };
}

export async function listRecentCitizenReports(limit: number, status?: RecordStatus) {
  const params: Array<string | number> = [limit];
  const statusFilter = status ? "AND status = $2" : "";
  if (status) params.push(status);

  const result = await pool.query<FoundPersonWithMetadata>(
    `${baseSelect()},
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            raw->>'provider' AS provider
     FROM found_people
     WHERE raw->>'provider' = 'telegram_report'
       AND status <> 'removed'
       ${statusFilter}
     ORDER BY updated_at DESC
     LIMIT $1`,
    params,
  );
  return result.rows;
}

export async function getPersonById(id: string) {
  const result = await pool.query<FoundPersonWithMetadata>(
    `${baseSelect()},
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            raw->>'provider' AS provider
     FROM found_people
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function incrementMetric(name: string, amount = 1) {
  await pool.query(
    `INSERT INTO bot_metrics (name, value)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET value = bot_metrics.value + EXCLUDED.value, updated_at = now()`,
    [name, amount],
  );
}

export async function getBotMetrics() {
  const result = await pool.query<{ name: string; value: string }>("SELECT name, value FROM bot_metrics ORDER BY name");
  return Object.fromEntries(result.rows.map((row) => [row.name, Number(row.value)]));
}

function baseSelect() {
  return `SELECT id,
              full_name AS "fullName",
              relevant_info AS "relevantInfo",
              source_url AS "sourceUrl",
              status AS "status"
       FROM found_people`;
}

function returningColumns() {
  return `id,
          full_name AS "fullName",
          relevant_info AS "relevantInfo",
          source_url AS "sourceUrl",
          status AS "status"`;
}

function pageResult(items: FoundPerson[], page: number, pageSize: number, total: number) {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
