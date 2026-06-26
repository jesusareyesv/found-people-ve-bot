import { createHash } from "node:crypto";
import { extractDocumentId, sanitizeRelevantInfo } from "./sanitize.js";
import type { SearchCandidateInput } from "./search-provider.js";

const OCR_REPO = "ecrespo/OCR-data_Terremoto_Venezuela_24062026";
const OCR_REF = "8d503853f07f0adab9ffa08e8dd513abe699353d";
const GITHUB_API_TREE = `https://api.github.com/repos/${OCR_REPO}/git/trees/${OCR_REF}?recursive=1`;
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/${OCR_REPO}/${OCR_REF}`;
const GITHUB_BLOB_BASE = `https://github.com/${OCR_REPO}/blob/${OCR_REF}`;

const FALLBACK_MARKDOWN_PATHS = [
  "20260625/Hosp_Domingo_Luciani/CirugiaPediatrica.md",
  "20260625/Hosp_Domingo_Luciani/Listado_Domingo_Luciani.md",
  "20260625/Hosp_Domingo_Luciani/PersonasHeridas.md",
  "20260625/Hosp_Perez_Carreño/Hosp_Perez_Carreño.md",
  "20260625/Hosp_Perez_Carreño/Hosp_Perez_Carreño_La_Yaguara.md",
  "20260625/Hosp_Perez_Carreño/Lista_Niños_Hosp_Perez_Carreño.md",
  "20260625/Hosp_Perez_Carreño/lista2.md",
  "20260625/LaGuaira/PersonasRescatadas.md",
];

type GitTreeResponse = { tree?: Array<{ path?: string; type?: string }> };
type MarkdownRow = { lineNumber: number; cells: Record<string, string>; title: string };

function cleanCell(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
}

function normalizeHeader(value: string) {
  return cleanCell(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function splitMarkdownRow(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanCell);
}

function isSeparatorRow(cells: string[]) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTables(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const rows: MarkdownRow[] = [];
  let currentTitle = "Lista OCR";

  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i].match(/^#{1,3}\s+(.+)$/)?.[1];
    if (heading) currentTitle = cleanCell(heading);
    if (!lines[i].trim().startsWith("|") || !lines[i + 1]?.trim().startsWith("|")) continue;

    const headers = splitMarkdownRow(lines[i]).map(normalizeHeader);
    if (!isSeparatorRow(splitMarkdownRow(lines[i + 1]))) continue;

    i += 2;
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      const values = splitMarkdownRow(lines[i]);
      rows.push({
        lineNumber: i + 1,
        title: currentTitle,
        cells: Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
      });
      i += 1;
    }
    i -= 1;
  }

  return rows;
}

function firstMatching(cells: Record<string, string>, patterns: RegExp[]) {
  for (const [key, value] of Object.entries(cells)) {
    if (patterns.some((pattern) => pattern.test(key)) && value && value !== "—") return value;
  }
  return null;
}

function rowToCandidate(path: string, row: MarkdownRow): SearchCandidateInput | null {
  const name = firstMatching(row.cells, [/nombre/, /apellidos/]);
  if (!name || /^\*?\(?en blanco\)?\*?$/i.test(name)) return null;

  const sourceUrl = `${GITHUB_BLOB_BASE}/${path}#L${row.lineNumber}`;
  const relevantInfo = Object.entries(row.cells)
    .filter(([, value]) => value && value !== "—")
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");

  const rawRelevantInfo = `${row.title}${relevantInfo ? ` · ${relevantInfo}` : ""}`;

  return {
    fullName: name.replace(/\s*\(\?\)\s*/g, "").trim(),
    relevantInfo: sanitizeRelevantInfo(rawRelevantInfo),
    sourceUrl,
    documentId: extractDocumentId(relevantInfo),
    sourceHash: createHash("sha256").update(`github-ocr:${OCR_REF}:${path}:${row.lineNumber}:${name}`).digest("hex"),
    raw: { provider: "github_ocr", repo: OCR_REPO, ref: OCR_REF, path, line: row.lineNumber },
  };
}

async function listMarkdownPaths() {
  try {
    const response = await fetch(GITHUB_API_TREE, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!response.ok) return FALLBACK_MARKDOWN_PATHS;
    const data = (await response.json()) as GitTreeResponse;
    const paths = data.tree
      ?.filter((item) => item.type === "blob" && item.path?.endsWith(".md") && item.path !== "README.md")
      .map((item) => item.path!)
      .sort();
    return paths?.length ? paths : FALLBACK_MARKDOWN_PATHS;
  } catch {
    return FALLBACK_MARKDOWN_PATHS;
  }
}

export async function searchGithubOcrCandidates(): Promise<{ candidates: SearchCandidateInput[]; errors: string[] }> {
  const candidates: SearchCandidateInput[] = [];
  const errors: string[] = [];

  for (const path of await listMarkdownPaths()) {
    try {
      const response = await fetch(`${GITHUB_RAW_BASE}/${path}`, {
        headers: { Accept: "text/plain" },
      });
      if (!response.ok) {
        errors.push(`${path}: GitHub raw failed with ${response.status}`);
        continue;
      }
      for (const row of parseMarkdownTables(await response.text())) {
        const candidate = rowToCandidate(path, row);
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : "unknown GitHub OCR error"}`);
    }
  }

  return { candidates, errors };
}
