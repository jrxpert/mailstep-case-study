// Kurýr Vltava: the state is the sentence in <div class="shipment-message">. The progress bar width
// is only a consistency check (returns still show 66 %). Every page carries the step label
// "Doručeno příjemci", so step labels are never read.
//
// Event time: the page has no event history and no structured timestamp, only free text.
// A date is taken from the sentence only when it is the ONLY date in it, and only as evidence for a
// delivery / return / handover sentence (checked against the order dates). For an in-transit
// sentence any date is descriptive text, not an established "last carrier event", so no event time is
// reported and an in-transit page of this carrier never supports a definition-B CREATE.

import { byClass, czechDateTime, textOf } from "../html.ts";
import { unknown, type CarrierReading } from "./types.ts";

const DATE_LIKE = /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/g;
// Return and delivery are accepted only in their exact known wording: a negated ("nevracíme"),
// future or conditional sentence is not a return; any other sentence naming the sender is UNKNOWN.
const RETURNING = /^(?:Zásilku vracíme odesílateli\.(?: Důvod: [^.]+\.)?|Zásilka (?:byla )?vrácena odesílateli\.)$/;
const DELIVERED = /^Zásilka byla doručena příjemci \d{1,2}\. \d{1,2}\. \d{4} v \d{1,2}:\d{2}\.$/;

/** Tracking number from every `p.tracking-number`; several different numbers → none. */
function trackingNumber(html: string): string | null {
  const found = new Set(byClass(html, "p", "tracking-number").map((p) => /Číslo zásilky:\s*([A-Z0-9]+)(?=\s|$)/.exec(textOf(p))?.[1] ?? "?"));
  return found.size === 1 ? [...found][0] ?? null : null;
}

export function parseKuryrVltava(html: string): CarrierReading {
  const tn = trackingNumber(html);
  const messages = byClass(html, "div", "shipment-message");
  if (messages.length !== 1) return unknown(`expected one shipment message, found ${messages.length}`, { pageTrackingNumber: tn });

  const msg = textOf(messages[0] ?? "");
  const width = Number(/class="progress__fill"[^>]*style="width:\s*(\d+)%/.exec(html)?.[1] ?? NaN);
  const base = { pageTrackingNumber: tn, source: ".shipment-message", statusText: msg, eventText: msg, warnings: [] as string[] };
  const dates = msg.match(DATE_LIKE)?.length ?? 0;
  const eventTime = dates === 1 ? czechDateTime(msg) : null;
  if (dates === 0) base.warnings.push("no carrier event timestamp on the page");
  if (dates > 1) base.warnings.push(`shipment message contains ${dates} dates; no event time established`);
  /** In-transit sentences: a date there is descriptive text, never the last carrier event. */
  const inTransit = (activity: "ACTIVE" | "UNDETERMINED", reason: string): CarrierReading => ({
    ...base, eventTime: null, state: "IN_TRANSIT", activity, reason,
    warnings: dates === 1 ? [...base.warnings, "date in an in-transit message is not used as the last carrier event (no structured event time on the page)"] : base.warnings,
  });

  let r: CarrierReading;
  if (RETURNING.test(msg)) {
    r = { ...base, eventTime, state: "RETURNING", activity: null, reason: "carrier reports the parcel is returning to the sender" };
  } else if (/odesílatel/i.test(msg)) {
    return unknown("message mentions the sender but is not a recognised return", { ...base, eventTime });
  } else if (/doručena/i.test(msg)) {
    const takenBy = /Převzal:\s*([^.,]+(?:\([^)]*\))?)/i.exec(msg)?.[1]?.trim();
    if (takenBy && !/^příjemce/i.test(takenBy)) {
      return unknown(`marked delivered, but taken over by "${takenBy}", not confirmed as the recipient`, {
        ...base, eventTime, warnings: [...base.warnings, "handover to a third party is not proof of delivery to the recipient"],
      });
    }
    if (!/doručena příjemci/i.test(msg)) return unknown("marked delivered without naming the recipient", { ...base, eventTime });
    if (!DELIVERED.test(msg)) return unknown("delivery sentence not recognised", { ...base, eventTime });
    r = { ...base, eventTime, state: "DELIVERED", activity: null, reason: "carrier confirms delivery to the recipient" };
  } else if (/nebyl zastižen|doručení zopakujeme/i.test(msg)) {
    r = inTransit("ACTIVE", "failed delivery attempt; parcel held at depot, redelivery scheduled");
  } else if (/nakládáme k doručení|předpokládaný čas doručení/i.test(msg)) {
    r = inTransit("ACTIVE", "parcel is out for delivery");
  } else if (/na cestě/i.test(msg)) {
    r = inTransit("UNDETERMINED", "carrier reports the parcel in transit (no date on the page)");
  } else {
    return unknown("shipment message not recognised", { ...base, eventTime });
  }

  // Consistency: a full progress bar must mean delivered, and delivered must show a full bar.
  if ((width === 100) !== (r.state === "DELIVERED")) {
    return unknown(`contradictory page: message says ${r.state} but progress bar is ${Number.isNaN(width) ? "missing" : `${width} %`}`, {
      ...base, eventTime: r.eventTime, warnings: [...r.warnings, "progress bar contradicts the shipment message"],
    });
  }
  return r;
}
