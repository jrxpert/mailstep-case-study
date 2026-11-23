import { REASON_EFFECT, type Reason, type ReasonCode } from "./types.ts";

export function reason(code: ReasonCode, detail?: string, evidence?: string[]): Reason {
  return {
    code,
    effect: REASON_EFFECT[code],
    ...(detail !== undefined ? { detail } : {}),
    ...(evidence !== undefined && evidence.length > 0 ? { evidence } : {}),
  };
}

export const hasEffect = (reasons: readonly Reason[], effect: Reason["effect"]): boolean =>
  reasons.some((r) => r.effect === effect);

/** Printable ASCII, or a Latin letter that decomposes into an ASCII letter plus diacritics. */
const plainChar = (ch: string): boolean => /^[\x20-\x7E]$/.test(ch.normalize("NFD").replace(/\p{M}/gu, ""));

/**
 * Detection key (order numbers, shipping methods, client names): NFKD, with combining marks,
 * default-ignorable characters, whitespace, punctuation and symbols removed, lower-cased.
 */
export const looseKey = (s: string): string =>
  s.normalize("NFKD").replace(/[\p{M}\p{Default_Ignorable_Code_Point}\p{Z}\s\p{P}\p{S}\u2800]/gu, "").toLowerCase();

/**
 * Collision candidate (detection only, never a match): `a` and `b` differ but MIGHT denote the same
 * identifier — equal `looseKey`, or the same length with every differing position holding a non-plain
 * character on either side (a look-alike from another script, e.g. Cyrillic "е" for "e"). Only the
 * records that are candidates for a given identifier are affected; unrelated records are not.
 */
export function mayDenote(a: string, b: string): boolean {
  if (a === b) return false;
  if (looseKey(a) === looseKey(b)) return true;
  const x = [...a.normalize("NFC")], y = [...b.normalize("NFC")];
  return x.length === y.length && x.every((ch, i) => ch === y[i] || !plainChar(ch) || !plainChar(y[i] ?? ""));
}
