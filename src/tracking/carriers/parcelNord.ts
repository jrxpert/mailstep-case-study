// ParcelNord: dated event table (<table class="events">). The latest event (by its own date and
// time, not by row position) decides the state.
//
// Fail-closed reading: EVERY row of the table is read, whatever <tbody>/<tfoot> it sits
// in, and the page must contain exactly one table with the known layout. Each row needs four cells,
// one date and one time, and an event text that matches a known sentence EXACTLY (no substrings, so a
// negated, future or conditional sentence is not recognised). Anything else, and any history that
// contradicts the latest event (earlier delivery or return), is UNKNOWN.
//
// Undetermined in transit: accepted only for the single history "picked up from the
// sender → processed at a sorting centre (zero or more times)", listed in one unambiguous order without
// equal timestamps. Any other in-transit history without last-mile activity is UNKNOWN (→ REVIEW).

import type { DeliveryActivity, TrackingState } from "../../domain/types.ts";
import { byClass, byTag, czechDateTime, textOf } from "../html.ts";
import { unknown, type CarrierReading } from "./types.ts";

type EventClass = { state: TrackingState; activity: DeliveryActivity | null; reason: string };
const PICKED_UP = /^Zásilka převzata od odesílatele\.?$/;
const PROCESSED = /^Zásilka zpracována\.?$/;
const SORTING_CENTRE = /^Třídicí centrum \p{Lu}\p{Ll}+$/u;

const EVENTS: [RegExp, EventClass][] = [
  [/^Zásilka vyzvednuta příjemcem\.?$/, { state: "DELIVERED", activity: null, reason: "collected by the recipient" }],
  [/^Doručeno příjemci(?:, podepsal: [^,]+)?$/, { state: "DELIVERED", activity: null, reason: "delivered to the recipient" }],
  [/^(?:Zásilka vrácena odesílateli|Úložní doba uplynula, zásilka se vrací odesílateli)\.?$/, { state: "RETURNING", activity: null, reason: "returning / returned to the sender" }],
  [/^Zásilka je připravena k vyzvednutí\.(?: Úložní doba končí \d{1,2}\. \d{1,2}\. \d{4}\.)?$/, { state: "IN_TRANSIT", activity: "ACTIVE", reason: "waiting at a pickup point for the recipient" }],
  [/^Zásilka předána (?:kurýrovi )?k doručení(?: do boxu)?\.?$/, { state: "IN_TRANSIT", activity: "ACTIVE", reason: "handed over for delivery" }],
  [/^Zásilka (?:zpracována|převzata od odesílatele)\.?$/, { state: "IN_TRANSIT", activity: "UNDETERMINED", reason: "in the carrier network (sorting / accepted)" }],
];
const classifyEvent = (text: string): EventClass | null => EVENTS.find(([re]) => re.test(text))?.[1] ?? null;

const DATE_CELL = /^\d{1,2}\.\s*\d{1,2}\.\s*\d{4}$/;
const TIME_CELL = /^\d{1,2}:\d{2}$/;
const count = (html: string, tag: string): number => html.match(new RegExp(`<${tag}\\b`, "gi"))?.length ?? 0;

/**
 * Tracking number from the <h1>, cross-checked against every "Zásilka <number>" in <main>: several
 * different numbers (or a number glued to other characters) → none (identity not established).
 */
function trackingNumber(html: string): string | null {
  const mainOutsideTable = (byTag(html, "main")[0] ?? "").replace(/<table\b[\s\S]*?<\/table>/gi, " ");
  const texts = [...byTag(html, "h1"), mainOutsideTable].map(textOf);
  const found = new Set(texts.flatMap((t) => [...t.matchAll(/Zásilka\s+(\S+)/g)].map((m) => (/^[A-Z0-9]+$/.test(m[1] ?? "") ? m[1] : "?"))));
  return found.size === 1 && byTag(html, "h1").length > 0 ? [...found][0] ?? null : null;
}

export function parseParcelNord(html: string): CarrierReading {
  const tn = trackingNumber(html);
  const tables = byClass(html, "table", "events");
  if (tables.length !== 1) return unknown(`expected one events table, found ${tables.length}`, { pageTrackingNumber: tn });
  if (count(html, "table") !== 1) return unknown("page contains tables besides the events table; the event history may be incomplete", { pageTrackingNumber: tn });
  if (count(html, "main") !== 1) return unknown("expected exactly one <main>", { pageTrackingNumber: tn });

  const table = tables[0] ?? "";
  // Allowlisted table layout: one known header row, then only rows of plain-text cells.
  const HEADER = /^\s*<thead>\s*<tr>\s*<th>Datum<\/th>\s*<th>Čas<\/th>\s*<th>Místo<\/th>\s*<th>Událost<\/th>\s*<\/tr>\s*<\/thead>/i;
  const residue = table.replace(HEADER, "").replace(/<td>[^<]*<\/td>/gi, "").replace(/<\/?(?:tbody|tfoot|tr)>/gi, "");
  if (!HEADER.test(table) || residue.trim() !== "") return unknown("events table layout not recognised", { pageTrackingNumber: tn });
  const rows = byTag(table, "tr");
  if (rows.length !== count(table, "tr")) return unknown("events table has malformed rows", { pageTrackingNumber: tn });
  const cells = rows.filter((row) => count(row, "td") > 0).map((row) => byTag(row, "td").map(textOf));
  if (cells.some((c) => c.length !== 4)) return unknown("an events row does not have exactly four cells", { pageTrackingNumber: tn });
  const events = cells.map(([date = "", time = "", place = "", text = ""]) => ({
    when: DATE_CELL.test(date) && TIME_CELL.test(time) ? czechDateTime(`${date} ${time}`) : null,
    place, text, cls: classifyEvent(text),
  }));
  if (events.length === 0) return unknown("events table is empty", { pageTrackingNumber: tn });
  if (events.some((e) => e.when === null)) return unknown("an event has no readable date/time", { pageTrackingNumber: tn });

  const key = (e: (typeof events)[number]): string => e.when?.local ?? "";
  const sorted = [...events].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  const latest = sorted[0];
  if (!latest) return unknown("no events", { pageTrackingNumber: tn });
  const warnings: string[] = [];
  if (sorted.some((e, i) => e !== events[i])) warnings.push("events are not listed newest first; the latest by date was used");
  const hint = textOf(byClass(html, "p", "hint")[0] ?? "");
  if (hint) warnings.push(`carrier note: ${hint}`);

  const base = {
    pageTrackingNumber: tn, source: "table.events (latest event)", statusText: latest.text,
    eventText: `${latest.place}: ${latest.text}`, eventTime: latest.when, warnings,
  };
  const earliestEventTime = sorted[sorted.length - 1]?.when ?? undefined;
  const sameTime = sorted.filter((e) => e.when?.local === latest.when?.local);
  if (sameTime.some((e) => e.cls === null)) return unknown(`latest event not recognised: "${latest.text}"`, base);
  if (new Set(sameTime.map((e) => `${e.cls?.state}/${e.cls?.activity}`)).size > 1) return unknown("several latest events at the same time disagree", base);
  const unrecognised = events.find((e) => e.cls === null);
  if (unrecognised) {
    return unknown(`an earlier event is not recognised: "${unrecognised.text}"`, { ...base, warnings: [...warnings, "event history not fully understood"] });
  }

  const c = latest.cls as EventClass;
  if (c.state !== "DELIVERED" && events.some((e) => e.cls?.state === "DELIVERED")) {
    return unknown("an earlier event reports delivery but the latest event does not", {
      ...base, warnings: [...warnings, "contradictory event history"],
    });
  }
  if (c.state === "IN_TRANSIT" && events.some((e) => e.cls?.state === "RETURNING")) {
    return unknown("an earlier event reports a return to the sender but the latest event does not", {
      ...base, warnings: [...warnings, "contradictory event history"],
    });
  }
  if (c.state === "IN_TRANSIT" && c.activity === "UNDETERMINED") {
    // The only undetermined history accepted: one pick-up, then sorting scans, in one unambiguous
    // source order (strictly newest-first or strictly oldest-first; equal times are ambiguous).
    const keys = events.map(key);
    const newestFirst = keys.every((k, i) => i === 0 || k < (keys[i - 1] ?? ""));
    const oldestFirst = keys.every((k, i) => i === 0 || k > (keys[i - 1] ?? ""));
    const [first, ...rest] = newestFirst ? [...events].reverse() : events;
    const plain = (newestFirst || oldestFirst) && first !== undefined && PICKED_UP.test(first.text) && first.place === "Odesílatel" &&
      rest.every((e) => PROCESSED.test(e.text) && SORTING_CENTRE.test(e.place));
    if (!plain) return unknown("in-transit history is not the plain sequence 'picked up → processed'; it cannot be assessed for loss", base);
  }
  return { ...base, state: c.state, activity: c.activity, reason: c.reason, ...(earliestEventTime ? { earliestEventTime } : {}) };
}
