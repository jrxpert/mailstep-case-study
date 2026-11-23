// Small, dependency-free HTML helpers for the carrier parsers. They extract specific elements;
// there is intentionally no "search the whole page for a keyword" helper.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Thrown for content that cannot be decoded safely (e.g. `&#1114112;`). It is caught only at the
 * classifier boundary (classify.ts), where the page becomes UNKNOWN; other errors still propagate.
 */
export class MalformedHtmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedHtmlError";
  }
}

const isScalarValue = (code: number): boolean =>
  Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isScalarValue(code)) throw new MalformedHtmlError(`invalid numeric character reference ${m}`);
      return String.fromCodePoint(code);
    }
    const named = ENTITIES[e.toLowerCase()];
    if (named === undefined) throw new MalformedHtmlError(`unsupported character reference ${m}`);
    return named;
  });
}

/** Invisible characters (soft hyphen, zero-width, fillers) that could split or disguise a word. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u2800]/u;

/**
 * The page body handed to the carrier parsers (the <head> is not read). The body must not contain
 * markup whose browser semantics a regex reader cannot follow reliably: comments, <script>, <style>,
 * <template>, <noscript>, <iframe>, <object>. Any of them makes the page malformed (→ UNKNOWN) instead
 * of being stripped or interpreted (e.g. comment-terminator tricks, hidden table ends).
 */
export function stripInert(html: string): string {
  const start = /<body\b[^>]*>/i.exec(html);
  const body = start ? html.slice(start.index) : html;
  const inert = /<!--|<\/?(?:script|style|template|noscript|iframe|object)\b/i.exec(body);
  if (inert) throw new MalformedHtmlError(`unsupported markup in the page body: ${inert[0]}`);
  return body;
}

/** Visible text of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function textOf(fragment: string): string {
  const text = decodeEntities(fragment.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).normalize("NFC");
  if (INVISIBLE.test(text)) throw new MalformedHtmlError("invisible characters in page text");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Inner HTML of every <tag> whose class list contains `cls`. Assumes the element does not nest
 * another <tag> of the same name (true for the status elements read here).
 */
export function byClass(html: string, tag: string, cls: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*\\bclass="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  return [...html.matchAll(re)].map((m) => m[1] ?? "");
}

/** Inner HTML of every <tag> (no class filter). */
export function byTag(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => m[1] ?? "");
}

export function titleOf(html: string): string | null {
  const t = byTag(html, "title");
  return t.length === 1 ? textOf(t[0] ?? "") : null;
}

/**
 * Czech date ("21. 10. 2026", optionally followed by "16:03" or "v 13:12") → local ISO without
 * offset. The pages state no timezone, so none is invented.
 */
export function czechDateTime(text: string): { text: string; local: string } | null {
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:\s+(?:v\s+)?(\d{1,2}):(\d{2}))?/.exec(text);
  if (!m) return null;
  const [whole, d, mo, y, h, mi] = m;
  const day = Number(d), month = Number(mo), year = Number(y);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59)) return null;
  const pad = (n: string | number) => String(n).padStart(2, "0");
  const date = `${year}-${pad(month)}-${pad(day)}`;
  return { text: whole.trim(), local: h !== undefined ? `${date}T${pad(h)}:${mi}` : date };
}
