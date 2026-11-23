// Expedo: the state is <strong class="value"> inside <div class="status-card">. The cookie banner,
// hero ad, FAQ and side ads all contain "Doručeno/doručeno" and are never read.
//
// The card is a summary without an event history. Delivery and return are accepted in their exact
// known wording. In transit is accepted only from a card with the known structure, a neutral detail
// sentence and an exact "Poslední aktualizace" time, because definition B may create a loss complaint
// from it (decisions.md D-30). Anything else is UNKNOWN (→ REVIEW).

import { byClass, byTag, czechDateTime, textOf } from "../html.ts";
import { unknown, type CarrierReading } from "./types.ts";

/** The whole card: label, one value, update time, optional detail paragraph; plain text only. */
const CARD = /^\s*<span class="label">Aktuální stav<\/span>\s*<strong class="value">[^<]*<\/strong>\s*<small>[^<]*<\/small>\s*(?:<p>[^<]*<\/p>\s*)?$/;
const UPDATED = /^Poslední aktualizace: \d{1,2}\. \d{1,2}\. \d{4} \d{1,2}:\d{2}$/;
const NEUTRAL_TRANSIT = /^(?:Zásilka opustila třídicí centrum \p{Lu}\p{Ll}+\.)?$/u;

export function parseExpedo(html: string): CarrierReading {
  const tn = /Číslo zásilky:\s*([A-Z0-9]+)(?=\s|$)/.exec(textOf(byTag(html, "main")[0] ?? ""))?.[1] ?? null;
  const cards = byClass(html, "div", "status-card");
  const mentions = html.match(/status-card/g)?.length ?? 0;
  if (cards.length !== 1 || mentions !== 1) return unknown(`expected one status card, found ${Math.max(cards.length, mentions)}`, { pageTrackingNumber: tn });

  const card = cards[0] ?? "";
  const value = textOf(byClass(card, "strong", "value")[0] ?? "");
  const updated = textOf(byTag(card, "small")[0] ?? "");
  const detail = textOf(byTag(card, "p")[0] ?? "");
  const eventTime = czechDateTime(updated);
  const base = {
    pageTrackingNumber: tn, source: ".status-card .value", statusText: value,
    eventText: detail || null, eventTime, warnings: eventTime === null ? ["no carrier event timestamp on the page"] : [],
  };
  if (value === "") return unknown("status card has no status value", base);

  if (/^doručeno$/i.test(value)) {
    if (/^Zásilka byla předána příjemci\.$/.test(detail)) return { ...base, state: "DELIVERED", activity: null, reason: "carrier confirms handover to the recipient" };
    return unknown("status says delivered without confirming the recipient", base);
  }
  if (/^(?:vrací se|vráceno) odesílateli$/i.test(value)) return { ...base, state: "RETURNING", activity: null, reason: "carrier reports the parcel is returning to the sender" };
  if (/^(?:na cestě|převzato dopravcem)$/i.test(value)) {
    if (!CARD.test(card)) return unknown("in-transit status card has an unrecognised structure", base);
    if (!UPDATED.test(updated)) return unknown(`in-transit update time not recognised: "${updated}"`, base);
    if (!NEUTRAL_TRANSIT.test(detail)) return unknown(`in-transit card says "${detail}"; not a recognised transit message`, base);
    return /^na cestě$/i.test(value)
      ? { ...base, state: "IN_TRANSIT", activity: "UNDETERMINED", reason: "carrier reports the parcel in transit" }
      : { ...base, state: "IN_TRANSIT", activity: "UNDETERMINED", reason: "carrier has accepted the parcel" };
  }
  if (/nenašli/i.test(value)) return unknown("carrier has no record of this tracking number", base);
  return unknown(`status "${value}" not recognised`, base);
}
