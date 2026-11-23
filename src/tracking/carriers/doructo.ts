// Doručto: the page shows a five-step SVG timeline. All step labels are always present as text; the
// current step is distinguished ONLY by the circle's fill colour. There is no status text, no
// aria-current and no "active" class.
//
// Policy (docs/decisions.md D-20): colour alone is not a reliable semantic indicator, so
// these pages are UNKNOWN. The visually highlighted step is reported as a warning for the human
// reviewer and is NOT used for classification.

import { byClass, byTag, textOf } from "../html.ts";
import { unknown, type CarrierReading } from "./types.ts";

export function parseDoructo(html: string): CarrierReading {
  const tn = /Zásilka\s+([A-Z0-9]+)/.exec(textOf(byTag(html, "main")[0] ?? ""))?.[1] ?? null;
  const updated = textOf(byClass(html, "p", "updated")[0] ?? "");
  const warnings: string[] = [];
  if (updated) warnings.push(`page says "${updated}" (page update time, not a dated carrier event)`);

  const steps = [...(byClass(html, "svg", "timeline")[0] ?? "").matchAll(/<circle\b[^>]*\bfill="([^"]+)"[^>]*\/?>[\s\S]*?<text\b[^>]*>([^<]*)<\/text>/gi)]
    .map((m) => ({ fill: (m[1] ?? "").toLowerCase(), label: textOf(m[2] ?? "") }));
  const fills = new Map<string, string[]>();
  for (const s of steps) fills.set(s.fill, [...(fills.get(s.fill) ?? []), s.label]);
  const singled = [...fills.values()].filter((labels) => labels.length === 1).flat();
  if (steps.length > 1 && singled.length === 1) {
    warnings.push(`visually highlighted step: "${singled[0]}" (colour only; not used for classification)`);
  }

  return unknown("current step is conveyed only by SVG fill colour; no textual or semantic status indicator", {
    pageTrackingNumber: tn,
    source: "svg.timeline",
    statusText: null,
    eventTime: null,
    warnings: [...warnings, "no carrier event timestamp on the page"],
  });
}
