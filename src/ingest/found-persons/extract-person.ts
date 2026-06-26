const PERSON_NAME_PATTERN = String.raw`[A-ZÁÉÍÓÚÑ][\p{L}'’-]+(?:\s+(?:de\s+la|del|de|das|dos|da|do|van|von|y|[A-ZÁÉÍÓÚÑ][\p{L}'’-]+)){1,5}`;

const NAME_PATTERNS = [
  new RegExp(String.raw`(?:encontrad[oa]s?|localizad[oa]s?|rescatad[oa]s?|hallad[oa]s?)\s+(?:a\s+)?(${PERSON_NAME_PATTERN})`, "iu"),
  new RegExp(String.raw`(?:identificad[oa]\s+como|se\s+llama|nombre|persona)\s*[:\-]?\s*(${PERSON_NAME_PATTERN})`, "iu"),
];

const NAME_PARTICLES = new Set(["de", "del", "da", "das", "do", "dos", "van", "von", "y"]);
const CONTEXT_STOP_WORDS = new Set(["en", "con", "por", "tras", "despues", "después", "luego"]);

const NON_NAME_WORDS = new Set([
  "asi",
  "así",
  "bajo",
  "colapsado",
  "con",
  "es",
  "derrumbe",
  "edificio",
  "el",
  "en",
  "rescatada",
  "rescatado",
  "una",
  "un",
  "entre",
  "escombros",
  "familia",
  "guaira",
  "heridos",
  "hospital",
  "la",
  "los",
  "milagro",
  "personas",
  "rescatados",
  "rescate",
  "sismo",
  "terremoto",
  "tras",
  "venezuela",
  "vida",
]);

export function extractFoundPerson(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const fullName = NAME_PATTERNS.map((pattern) => normalized.match(pattern)?.[1])
    .map((name) => name ? trimContextWords(name) : null)
    .find((name) => Boolean(name && looksLikePersonName(name)))
    ?.replace(/[.,;:]+$/, "")
    .trim() ?? null;

  return { fullName };
}

export function looksLikePersonName(value: string) {
  const cleaned = value.replace(/[.,;:]+$/g, "").trim();
  if (cleaned.length < 5 || cleaned.length > 80) return false;
  if (/[#@/\\]|https?:|\d|[😀-🙏]/u.test(cleaned)) return false;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return false;

  let properNameWords = 0;
  return words.every((word, index) => {
    const normalized = normalizeWord(word);
    const isParticle = NAME_PARTICLES.has(normalized);

    if (isParticle) return index > 0 && index < words.length - 1;
    if (NON_NAME_WORDS.has(normalized)) return false;
    if (!/^[A-ZÁÉÍÓÚÑ][\p{L}'’-]{1,}$/u.test(word)) return false;

    properNameWords += 1;
    return true;
  }) && properNameWords >= 2;
}

function trimContextWords(value: string) {
  const words = value.replace(/[.,;:]+$/g, "").trim().split(/\s+/).filter(Boolean);
  const stopIndex = words.findIndex((word) => CONTEXT_STOP_WORDS.has(normalizeWord(word)));
  return (stopIndex >= 0 ? words.slice(0, stopIndex) : words).join(" ");
}

function normalizeWord(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
