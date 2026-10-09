import type { Account, Label, LabelHit } from "./types";

/**
 * Normalises text for matching: lowercase, NFKC (so fancy unicode fonts like 𝐛𝐨𝐥𝐝 fold to ascii),
 * strips combining marks, collapses whitespace.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .normalize("NFD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds one regex per keyword with "soft" word boundaries that work for terms starting or
 * ending in non-word characters (e.g. "18+", "f4f", "c++", "#buildinpublic").
 */
export function compileKeyword(keyword: string): RegExp {
  const k = normalize(keyword);
  const startsWord = /^[\p{L}\p{N}]/u.test(k);
  const endsWord = /[\p{L}\p{N}]$/u.test(k);
  const lead = startsWord ? "(?<![\\p{L}\\p{N}])" : "";
  const trail = endsWord ? "(?![\\p{L}\\p{N}])" : "";
  // Allow any whitespace / hyphen between words of a multi-word keyword.
  const body = k.split(" ").map(escapeRegExp).join("[\\s\\-_]*");
  return new RegExp(`${lead}${body}${trail}`, "iu");
}

export interface CompiledLabel {
  label: Label;
  matchers: { term: string; re: RegExp }[];
}

export function compileLabels(labels: Label[]): CompiledLabel[] {
  return labels.map((label) => ({
    label,
    matchers: label.keywords
      .map((t) => t.trim())
      .filter(Boolean)
      .map((term) => ({ term, re: compileKeyword(term) })),
  }));
}

/** Text that keyword rules run against: bio, display name and handle. */
export function accountText(a: Pick<Account, "bio" | "name" | "handle">): string {
  return normalize(`${a.bio}\n${a.name}\n${a.handle}`);
}

export function matchLabels(a: Pick<Account, "bio" | "name" | "handle">, compiled: CompiledLabel[]): LabelHit[] {
  const text = accountText(a);
  const hits: LabelHit[] = [];
  for (const c of compiled) {
    const terms: string[] = [];
    for (const m of c.matchers) if (m.re.test(text)) terms.push(m.term);
    if (terms.length) hits.push({ labelId: c.label.id, terms });
  }
  return hits;
}

/** Free-text search across handle, name and bio. Multiple words are ANDed. */
export function matchesQuery(a: Pick<Account, "bio" | "name" | "handle">, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const text = accountText(a);
  return q.split(" ").every((w) => text.includes(w));
}

/** Cheap stable hash so AI labels can be cached per bio version. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, "").toLowerCase();
}
