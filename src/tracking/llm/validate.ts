// Deterministic checks of an LLM tracking answer. The model's answer is a claim; it is accepted only
// when the quoted evidence exists in the page text, the wording of the quote supports the claimed
// state, the date is real and stated for that event in the quote (not a page-update time), and the
// page holds no contrary wording.
// A quote that exists does not prove it was interpreted correctly, so the wording rules are strict
// and anything they cannot confirm stays UNKNOWN.

import type { TrackingState } from "../../domain/types.ts";
import { isNegated, MASK } from "./minimise.ts";

export const EVIDENCE_SOURCES = ["status_text", "tracking_event", "timeline", "other"] as const;
const STATES: readonly TrackingState[] = ["DELIVERED", "IN_TRANSIT", "RETURNING", "UNKNOWN"];
const KEYS = ["status", "event_date", "evidence", "evidence_source", "confidence"];

export interface LlmAnswer {
  status: TrackingState;
  event_date: string | null;
  evidence: string;
  evidence_source: (typeof EVIDENCE_SOURCES)[number];
  confidence: number;
}

/** JSON Schema sent to the provider (structured output). The same rules are re-checked locally. */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: STATES },
    event_date: { type: ["string", "null"] },
    evidence: { type: "string" },
    evidence_source: { type: "string", enum: EVIDENCE_SOURCES },
    confidence: { type: "number" },
  },
  required: KEYS,
  additionalProperties: false,
} as const;

/** Strict parse: exactly the known keys, known enum values, a real calendar date or null. */
export function parseAnswer(content: string): { ok: true; answer: LlmAnswer } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(content);
  } catch {
    return { ok: false, error: "response is not valid JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "response is not a JSON object" };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.includes(k));
  if (extra.length > 0) return { ok: false, error: `unexpected field(s): ${extra.join(", ")}` };
  if (!STATES.includes(o["status"] as TrackingState)) return { ok: false, error: "status is not one of the four states" };
  if (!(EVIDENCE_SOURCES as readonly unknown[]).includes(o["evidence_source"])) return { ok: false, error: "unknown evidence_source" };
  if (typeof o["evidence"] !== "string" || o["evidence"].length > 300) return { ok: false, error: "evidence must be a string of at most 300 characters" };
  const c = o["confidence"];
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) return { ok: false, error: "confidence must be a number in [0, 1]" };
  const d = o["event_date"];
  if (d !== null && (typeof d !== "string" || !isCalendarDate(d))) return { ok: false, error: "event_date is not a valid YYYY-MM-DD date or null" };
  return { ok: true, answer: o as unknown as LlmAnswer };
}

export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && y >= 2000;
}

const norm = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

// Wording that supports each state. Explicit handover to the recipient is required for DELIVERED.
const DELIVERED = /(doručen|předán|vyzvednut|převzal)\p{L}*\s+(?:\p{L}+\s+)?příjem(?:ci|cem|ce)/iu;
const DELIVERED_DOUBT = /soused|nedoručen|nebyl|nezastih|třetí osob|nepodařilo/iu;
const RETURNING = /(vrác|vrací|vracíme)\p{L}*\s+(?:se\s+)?(?:zpět\s+)?odesílatel/iu;
const RETURNING_DOUBT = /nevrac|nebude\s+vrác|pokud/iu;
const IN_TRANSIT = /na cestě|v přepravě|zpracován|převzat\p{L}*\s+od\s+odesílatele|převzato dopravcem|třídicí|u kurýra|připraven\p{L}*\s+k\s+vyzvednutí/iu;
const EVENT: Record<Exclude<TrackingState, "UNKNOWN">, RegExp> = { DELIVERED, RETURNING, IN_TRANSIT };

// Event dates. A date counts for the event only when it directly accompanies the event wording:
//   after it:  "… doručena příjemci 30. 10. 2026", "… doručena příjemci dne 30. 10. 2026"
//   before it: "30. 10. 2026 13:12 Zásilka byla doručena příjemci", "30. 10. 2026 – doručeno příjemci"
// Anything else between them (a sentence end, other words, a masked word) breaks the association.
const DATE = /(?<!\d)(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?!\d)/g;
const GAP_AFTER_EVENT = /^\s*,?\s*(?:dne\s+)?$/iu;
const GAP_BEFORE_EVENT = /^\s*(?:v\s+)?(?:\d{1,2}:\d{2}\s*)?[,:–—|-]?\s*(?:(?:zásilka|zásilku|byla|byl|bylo|se|je|jsme|úspěšně)\s+){0,3}$/iu;
/** Wording of a page-update or display timestamp, which is not the time of a shipment event. */
const UPDATE_STAMP = /aktualiz|naposledy|stav\s+ke?\s|ke\s+dni|vygenerov|poslední\s+změn/iu;

// Context of a DELIVERED / RETURNING quote. The model may quote a fragment ("doručena příjemci …")
// of a sentence that negates or conditions it ("Zásilka nemohla […] doručena příjemci …"). The quote
// is therefore located in the page text (whole words, exactly once) and widened to its complete
// sentence, or to its block when there is no sentence end: one line per paragraph, list item, table
// row or timeline step (pageTextForModel). That context, not the quote, must be free of negation,
// condition and uncertainty. Other sentences and events on the page are not part of it. When the
// context cannot be reconstructed, the answer is rejected.
const MAX_CONTEXT_CHARS = 300;
/** Conditional, future, possibility or attempt wording (vocabulary words; unknown words are masked). */
const HEDGE: ReadonlySet<string> = new Set(["pokud", "jakmile", "až", "když", "bude", "budou", "budeme", "lze", "můžete",
  "mohou", "mohl", "mohla", "mohlo", "mohli", "mohly", "pokus", "pokusu", "pokusy", "předpokládaný", "předpokládaná",
  "předpokládané", "předpokládaného", "zatím"]);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{M}\d]/u.test(c);

/** The complete sentence or block around the single occurrence of `quote`, or why it cannot be found. */
export function evidenceContext(quote: string, pageText: string): { context: string } | { reason: string } {
  const lines = pageText.split("\n").map((l) => l.normalize("NFC").replace(/\s+/g, " ").trim()).filter((l) => l !== "");
  const text = lines.join(" ");
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return { reason: "the page text cannot be segmented reliably" };
  const cuts = [0, text.length];
  let pos = 0;
  for (const l of lines.slice(0, -1)) { pos += l.length; cuts.push(pos); pos += 1; }
  for (const m of text.matchAll(/[.!?](?= \p{Lu})/gu)) cuts.push(m.index + 1);
  const hits: number[] = [];
  for (let i = lower.indexOf(quote); i !== -1; i = lower.indexOf(quote, i + 1)) {
    const cutsWord = (isWordChar(quote[0]) && isWordChar(lower[i - 1])) || (isWordChar(quote.at(-1)) && isWordChar(lower[i + quote.length]));
    if (!cutsWord) hits.push(i);
  }
  if (hits.length === 0) return { reason: "evidence quote does not occur as whole words in the page text" };
  if (hits.length > 1) return { reason: "evidence quote occurs more than once on the page; its context is ambiguous" };
  const start = hits[0] as number, end = start + quote.length;
  const from = Math.max(...cuts.filter((c) => c <= start));
  const to = Math.min(...cuts.filter((c) => c >= end));
  const context = lower.slice(from, to).trim();
  if (context.length > MAX_CONTEXT_CHARS) return { reason: "no sentence or event boundary near the quote; its context cannot be reconstructed" };
  return { context };
}

/** Negation, condition or uncertainty in the quote's sentence / event that the quote itself may omit. */
function contextReasons(status: "DELIVERED" | "RETURNING", context: string): string[] {
  const reasons: string[] = [];
  const words = context.match(/[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu) ?? [];
  if (context.includes(MASK)) reasons.push("the sentence or event containing the quote has masked words");
  if (words.some(isNegated)) reasons.push("the sentence or event containing the quote is negated");
  if (context.includes("?") || words.some((w) => HEDGE.has(w))) reasons.push("the sentence or event containing the quote is conditional, future or uncertain");
  if ((status === "DELIVERED" ? DELIVERED_DOUBT : RETURNING_DOUBT).test(context)) reasons.push("the sentence or event containing the quote qualifies the claim");
  return reasons;
}

export interface Validation {
  accepted: boolean;
  /** Why it was rejected (empty when accepted). */
  reasons: string[];
}

/**
 * @param pageText exactly the text the model received
 * @param decisionDate YYYY-MM-DD (Prague) of the decision; an event after it is impossible
 * @param unmaskedText the page text before masking (never sent); contrary wording is also looked for there
 */
export function validateAnswer(a: LlmAnswer, pageText: string, decisionDate: string, unmaskedText: string = pageText): Validation {
  if (a.status === "UNKNOWN") return { accepted: true, reasons: [] };
  const reasons: string[] = [];
  const quote = norm(a.evidence.replace(/^["'„“]+|["'“”]+$/g, ""));
  const page = norm(pageText);
  if (quote.length < 4) reasons.push("evidence quote is empty or too short");
  else if (!page.includes(quote)) reasons.push("evidence quote does not occur in the page text (fabricated or altered)");
  // A masked word could have been a negation or a qualifier; the quote's meaning cannot be checked.
  if (quote.includes(MASK)) reasons.push("evidence quote contains masked words");
  // The quote may be a fragment that leaves out a negation or condition; judge its whole sentence/event.
  if ((a.status === "DELIVERED" || a.status === "RETURNING") && quote.length >= 4) {
    const ctx = evidenceContext(quote, pageText);
    if ("reason" in ctx) reasons.push(ctx.reason);
    else reasons.push(...contextReasons(a.status, ctx.context));
  }

  if (a.status === "DELIVERED" && (!DELIVERED.test(quote) || DELIVERED_DOUBT.test(quote))) {
    reasons.push("quote does not state an explicit handover to the recipient");
  }
  if (a.status === "RETURNING" && (!RETURNING.test(quote) || RETURNING_DOUBT.test(quote))) {
    reasons.push("quote does not state a return to the sender");
  }
  if (a.status === "IN_TRANSIT" && (!IN_TRANSIT.test(quote) || DELIVERED.test(quote) || RETURNING.test(quote))) {
    reasons.push("quote does not state that the parcel is with the carrier");
  }

  // Contrary wording elsewhere on the page (in the masked and in the unmasked text).
  const pages = [page, norm(unmaskedText)];
  if (a.status !== "DELIVERED" && pages.some((t) => DELIVERED.test(t))) reasons.push("the page also states a delivery to the recipient");
  if (a.status !== "RETURNING" && pages.some((t) => RETURNING.test(t))) reasons.push("the page also states a return to the sender");

  if (a.event_date !== null) {
    reasons.push(...eventDateReasons(a.event_date, EVENT[a.status], quote));
    if (a.event_date > decisionDate) reasons.push("event_date is after the decision day");
  }
  if (a.confidence < 0.5) reasons.push("model confidence below 0.5");
  return { accepted: reasons.length === 0, reasons };
}

/** The date must be the only date in the quote and directly accompany the event wording. */
function eventDateReasons(eventDate: string, event: RegExp, quote: string): string[] {
  const pad = (n: string | undefined) => (n ?? "").padStart(2, "0");
  const dates = [...quote.matchAll(DATE)].map((m) => ({ iso: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, start: m.index, end: m.index + m[0].length }));
  const own = dates.filter((d) => d.iso === eventDate);
  if (own.length === 0) return ["event_date does not appear in the quoted evidence"];
  const reasons: string[] = [];
  if (new Set(dates.map((d) => d.iso)).size > 1) reasons.push("the quote contains more than one date; the event date is ambiguous");
  if (UPDATE_STAMP.test(quote)) reasons.push("the quote contains a page-update timestamp, which is not the time of the event");
  const events = [...quote.matchAll(new RegExp(event.source, `${event.flags}g`))].map((m) => {
    const end = m.index + m[0].length;
    return { start: m.index, end: end + (/^\p{L}*/u.exec(quote.slice(end))?.[0].length ?? 0) };
  });
  const tied = own.some((d) => events.some((e) =>
    (d.start >= e.end && GAP_AFTER_EVENT.test(quote.slice(e.end, d.start))) ||
    (d.end <= e.start && GAP_BEFORE_EVENT.test(quote.slice(d.end, e.start)))));
  if (!tied) reasons.push("event_date is not stated for the claimed event (the date must directly accompany the event wording)");
  return reasons;
}
