export type FoundPersonCandidate = {
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
  documentId?: string | null;
  raw?: Record<string, unknown>;
};

export type PublicFoundPerson = {
  fullName: string;
  relevantInfo: string | null;
  sourceUrl: string;
};
