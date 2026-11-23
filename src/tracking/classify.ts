// Tracking classifier: carrier page HTML → state + evidence. Pure; reads page content only.
// It never sees labels.csv, order status, order number or file names (test/tracking/isolation.test.ts).

import type { TrackingClassification } from "../domain/types.ts";
import { parseDoructo } from "./carriers/doructo.ts";
import { parseExpedo } from "./carriers/expedo.ts";
import { parseKuryrVltava } from "./carriers/kuryrVltava.ts";
import { parseParcelNord } from "./carriers/parcelNord.ts";
import type { CarrierReading } from "./carriers/types.ts";
import { MalformedHtmlError, stripInert, titleOf } from "./html.ts";

interface CarrierParser {
  /** Carrier name as used in orders.json `carrier`. */
  carrier: string;
  /** Recognises the carrier's page by its <title>. */
  detect: RegExp;
  parse: (html: string) => CarrierReading;
}

const PARSERS: CarrierParser[] = [
  { carrier: "Kurýr Vltava", detect: /\|\s*Kurýr Vltava$/, parse: parseKuryrVltava },
  { carrier: "ParcelNord", detect: /^ParcelNord\b/, parse: parseParcelNord },
  { carrier: "Expedo", detect: /^Expedo\b/, parse: parseExpedo },
  { carrier: "Doručto", detect: /^Doručto\b/, parse: parseDoructo },
];

export const SUPPORTED_CARRIERS: readonly string[] = PARSERS.map((p) => p.carrier);

export interface ClassifyContext {
  /** Carrier the order says it ships with; cross-checked against the page. */
  declaredCarrier?: string | null;
  /** Tracking number the page is expected to show; cross-checked against the page. */
  expectedTrackingNumber?: string | null;
  /** When the page was fetched, if known. Unknown for the supplied fixtures. */
  retrievedAt?: string | null;
}

const norm = (s: string): string => s.normalize("NFC").trim();

/**
 * Classifies one page. Malformed HTML (MalformedHtmlError) makes only this page UNKNOWN, with a
 * diagnostic; the batch continues. Any other error is a programming error and propagates.
 */
export function classifyTrackingPage(html: string, ctx: ClassifyContext = {}): TrackingClassification {
  try {
    return classifyWellFormed(html, ctx);
  } catch (e) {
    if (!(e instanceof MalformedHtmlError)) throw e;
    return {
      state: "UNKNOWN", activity: null, reliable: false, reason: `malformed tracking page: ${e.message}`,
      evidence: { carrier: null, pageTrackingNumber: null, source: null, statusText: null, eventText: null, eventTime: null },
      freshness: { retrievedAt: ctx.retrievedAt ?? null, established: false },
      warnings: ["page could not be decoded; classified UNKNOWN without reading its status"],
    };
  }
}

function classifyWellFormed(html: string, ctx: ClassifyContext): TrackingClassification {
  const retrievedAt = ctx.retrievedAt ?? null;
  const freshness = { retrievedAt, established: false };
  const freshnessWarning = retrievedAt === null ? ["page retrieval time unknown; evidence freshness not established"] : [];
  const unknownResult = (reason: string, carrier: string | null, warnings: string[] = []): TrackingClassification => ({
    state: "UNKNOWN", activity: null, reliable: false, reason,
    evidence: { carrier, pageTrackingNumber: null, source: null, statusText: null, eventText: null, eventTime: null },
    freshness, warnings: [...warnings, ...freshnessWarning],
  });

  const title = titleOf(html);
  const matches = title === null ? [] : PARSERS.filter((p) => p.detect.test(title));
  if (matches.length !== 1) {
    return unknownResult(title === null ? "page has no single <title>; carrier not recognised" : `carrier not recognised from title "${title}"`, null);
  }
  const parser = matches[0] as CarrierParser;

  const warnings: string[] = [];
  if (ctx.declaredCarrier === null) warnings.push("order has no carrier; carrier taken from the page only");
  if (ctx.declaredCarrier && norm(ctx.declaredCarrier) !== norm(parser.carrier)) {
    return unknownResult(`page belongs to ${parser.carrier}, but the order ships with ${ctx.declaredCarrier}`, parser.carrier);
  }

  const r = parser.parse(stripInert(html));
  const evidence = {
    carrier: parser.carrier, pageTrackingNumber: r.pageTrackingNumber, source: r.source,
    statusText: r.statusText, eventText: r.eventText, eventTime: r.eventTime,
  };
  if (ctx.expectedTrackingNumber && r.pageTrackingNumber !== ctx.expectedTrackingNumber) {
    return {
      ...unknownResult(`page shows tracking number ${r.pageTrackingNumber ?? "none"}, expected ${ctx.expectedTrackingNumber}`, parser.carrier),
      evidence,
    };
  }
  return {
    state: r.state,
    activity: r.state === "IN_TRANSIT" ? r.activity ?? "UNDETERMINED" : null,
    reliable: r.state !== "UNKNOWN",
    reason: r.reason,
    evidence,
    ...(r.earliestEventTime ? { earliestEventTime: r.earliestEventTime } : {}),
    freshness,
    warnings: [...warnings, ...r.warnings, ...freshnessWarning],
  };
}
