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
      nombre_completo TEXT NOT NULL,
      informacion_relevante TEXT,
      fuente_url TEXT NOT NULL CHECK (fuente_url ~* '^https?://'),
      hash_fuente TEXT UNIQUE NOT NULL,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_found_people_nombre
      ON found_people (lower(nombre_completo));

    CREATE INDEX IF NOT EXISTS idx_found_people_nombre_trgm
      ON found_people USING gin (nombre_completo gin_trgm_ops);

    CREATE INDEX IF NOT EXISTS idx_found_people_updated_at
      ON found_people (updated_at DESC);
  `);
}

export async function listPeople(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    pool.query<FoundPerson>(
      `SELECT id,
              nombre_completo AS "fullName",
              informacion_relevante AS "relevantInfo",
              fuente_url AS "sourceUrl"
       FROM found_people
       ORDER BY lower(nombre_completo) ASC, fuente_url ASC
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
              nombre_completo AS "fullName",
              informacion_relevante AS "relevantInfo",
              fuente_url AS "sourceUrl"
       FROM found_people
       WHERE nombre_completo ILIKE $1
       ORDER BY lower(nombre_completo) ASC, fuente_url ASC
       LIMIT $2 OFFSET $3`,
      [query, pageSize, offset],
    ),
    pool.query<{ count: string }>("SELECT count(*) FROM found_people WHERE nombre_completo ILIKE $1", [query]),
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
      `INSERT INTO found_people (nombre_completo, informacion_relevante, fuente_url, hash_fuente, raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (hash_fuente) DO UPDATE SET
         nombre_completo = EXCLUDED.nombre_completo,
         informacion_relevante = EXCLUDED.informacion_relevante,
         fuente_url = EXCLUDED.fuente_url,
         raw = EXCLUDED.raw,
         updated_at = now()
       RETURNING id,
                 nombre_completo AS "fullName",
                 informacion_relevante AS "relevantInfo",
                 fuente_url AS "sourceUrl"`,
      [person.fullName, person.relevantInfo ?? null, person.sourceUrl, hash, JSON.stringify(person.raw ?? {})],
    );
    rows.push(result.rows[0]);
  }

  return rows;
}

export async function deletePersonBySourceUrl(sourceUrl: string) {
  const result = await pool.query<FoundPerson>(
    `DELETE FROM found_people
     WHERE fuente_url = $1
     RETURNING id,
               nombre_completo AS "fullName",
               informacion_relevante AS "relevantInfo",
               fuente_url AS "sourceUrl"`,
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
