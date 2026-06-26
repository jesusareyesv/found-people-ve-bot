const DOCUMENT_PATTERN = /\b(?:V[-\s]?)?(\d{1,3}(?:\.\d{3}){2}|\d{6,9})\b/gi;

export function normalizeDocumentId(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 9 ? digits : null;
}

export function extractDocumentId(value: string | null | undefined) {
  const text = value ?? "";
  for (const match of text.matchAll(DOCUMENT_PATTERN)) {
    const normalized = normalizeDocumentId(match[1]);
    if (normalized) return normalized;
  }
  return null;
}

export function maskDocumentNumbers(value: string) {
  return value.replace(DOCUMENT_PATTERN, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 9) return match;
    return `cédula terminada en ${digits.slice(-4)}`;
  });
}

export function sanitizeRelevantInfo(value: string | null | undefined) {
  const sanitized = maskDocumentNumbers(value ?? "").replace(/\s+/g, " ").trim().slice(0, 5000);
  return sanitized || null;
}
