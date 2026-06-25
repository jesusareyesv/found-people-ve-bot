import pg from "pg";

const { Pool } = pg;

export type FoundPerson = {
  id: string;
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
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

    CREATE TABLE IF NOT EXISTS found_people (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name TEXT NOT NULL,
      relevant_info TEXT,
      source_url TEXT NOT NULL CHECK (source_url ~* '^https?://'),
      source_hash TEXT UNIQUE NOT NULL,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'nombre_completo'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'full_name'
      ) THEN
        ALTER TABLE found_people RENAME COLUMN nombre_completo TO full_name;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'informacion_relevante'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'relevant_info'
      ) THEN
        ALTER TABLE found_people RENAME COLUMN informacion_relevante TO relevant_info;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'fuente_url'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'source_url'
      ) THEN
        ALTER TABLE found_people RENAME COLUMN fuente_url TO source_url;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'hash_fuente'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'found_people' AND column_name = 'source_hash'
      ) THEN
        ALTER TABLE found_people RENAME COLUMN hash_fuente TO source_hash;
      END IF;
    END $$;

    ALTER TABLE found_people
      ALTER COLUMN full_name SET NOT NULL,
      ALTER COLUMN source_url SET NOT NULL,
      ALTER COLUMN source_hash SET NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'found_people_source_url_http_check'
      ) THEN
        ALTER TABLE found_people
          ADD CONSTRAINT found_people_source_url_http_check CHECK (source_url ~* '^https?://');
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_found_people_full_name
      ON found_people (lower(full_name));

    CREATE INDEX IF NOT EXISTS idx_found_people_full_name_trgm
      ON found_people USING gin (full_name gin_trgm_ops);

    CREATE INDEX IF NOT EXISTS idx_found_people_updated_at
      ON found_people (updated_at DESC);
  `);
}

export async function listPeople(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    pool.query<FoundPerson>(
      `SELECT id,
              full_name AS "fullName",
              relevant_info AS "relevantInfo",
              source_url AS "sourceUrl"
       FROM found_people
       ORDER BY lower(full_name) ASC, source_url ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    pool.query<{ count: string }>("SELECT count(*) FROM found_people"),
  ]);

  return pageResult(items.rows, page, pageSize, Number(total.rows[0]?.count ?? 0));
}

export async function searchPeople(name: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const query = `%${name}%`;
  const [items, total] = await Promise.all([
    pool.query<FoundPerson>(
      `SELECT id,
              full_name AS "fullName",
              relevant_info AS "relevantInfo",
              source_url AS "sourceUrl"
       FROM found_people
       WHERE full_name ILIKE $1
       ORDER BY lower(full_name) ASC, source_url ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, offset],
    ),
    pool.query<{ count: string }>("SELECT count(*) FROM found_people WHERE full_name ILIKE $1", [query]),
  ]);

  return pageResult(items.rows, page, pageSize, Number(total.rows[0]?.count ?? 0));
}

export async function upsertPeople(people: Array<{
  fullName: string;
  relevantInfo?: string | null;
  sourceUrl: string;
  sourceHash?: string;
  raw?: Record<string, unknown>;
}>) {
  const rows: FoundPerson[] = [];

  for (const person of people) {
    const hash = person.sourceHash ?? await sha256(`${person.sourceUrl}:${person.fullName}`);
    const result = await pool.query<FoundPerson>(
      `INSERT INTO found_people (full_name, relevant_info, source_url, source_hash, raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (source_hash) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         relevant_info = EXCLUDED.relevant_info,
         source_url = EXCLUDED.source_url,
         raw = EXCLUDED.raw,
         updated_at = now()
       RETURNING id,
                 full_name AS "fullName",
                 relevant_info AS "relevantInfo",
                 source_url AS "sourceUrl"`,
      [person.fullName, person.relevantInfo ?? null, person.sourceUrl, hash, JSON.stringify(person.raw ?? {})],
    );
    rows.push(result.rows[0]);
  }

  return rows;
}

export async function deletePersonBySourceUrl(sourceUrl: string) {
  const result = await pool.query<FoundPerson>(
    `DELETE FROM found_people
     WHERE source_url = $1
     RETURNING id,
               full_name AS "fullName",
               relevant_info AS "relevantInfo",
               source_url AS "sourceUrl"`,
    [sourceUrl],
  );
  return result.rows;
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
