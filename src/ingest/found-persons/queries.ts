export const FOUND_PERSON_SOCIAL_QUERIES = [
  '"terremoto Venezuela" (nombre OR "se llama" OR "identificado como" OR "identificada como" OR "encontraron a" OR "localizaron a")',
  '"terremoto Venezuela" ("rescatado a" OR "rescatada a" OR "hallaron a" OR "fue encontrado" OR "fue encontrada")',
];

export function buildFoundPersonSocialQueries(limit = 1) {
  return FOUND_PERSON_SOCIAL_QUERIES.slice(0, Math.max(0, limit));
}
