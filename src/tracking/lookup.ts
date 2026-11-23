// Runtime tracking provider: finds the saved carrier page for an order and classifies it.
// Page file = <trackingNumber>.html (original-readme.md: "název souboru = číslo zásilky").
// Never reads labels.csv.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Order, TrackingVerification } from "../domain/types.ts";
import type { Collection } from "../io/load.ts";
import { SUPPORTED_CARRIERS, classifyTrackingPage } from "./classify.ts";

const SAFE_TRACKING_NUMBER = /^[A-Za-z0-9]+$/;

/**
 * Collision key for detecting a tracking number shared by several orders: surrounding whitespace and
 * letter case are ignored, so "PN1", "pn1" and " PN1 " count as the same parcel.
 * Detection only: page files are still looked up by the exact tracking number, and the result does
 * not depend on whether the file system is case-sensitive.
 */
const collisionKey = (tn: string): string => tn.trim().toUpperCase();

/** Every order row, validated or malformed: a malformed row can still claim a tracking number. */
export const allOrderRows = (orders: Collection<Order>): unknown[] => [...orders.valid.map((v) => v.record), ...orders.invalid.map((i) => i.raw)];

/**
 * @param orders order rows (validated records and/or raw malformed rows), used only to detect a
 *               tracking number shared by different order numbers (ambiguous page mapping).
 */
export function pageTrackingProvider(
  trackingDir: string,
  orders: readonly unknown[],
): (order: Order) => TrackingVerification {
  const owners = new Map<string, Set<string>>();
  orders.forEach((row, i) => {
    const o = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    const tn = typeof o["trackingNumber"] === "string" ? collisionKey(o["trackingNumber"]) : "";
    const owner = typeof o["orderNumber"] === "string" ? o["orderNumber"].trim() : typeof o["orderId"] === "string" ? `orderId:${o["orderId"]}` : `row:${i}`;
    if (tn) owners.set(tn, (owners.get(tn) ?? new Set()).add(owner));
  });

  return (order) => {
    const tn = order.trackingNumber;
    if (!tn) return { status: "unavailable", reason: "NO_TRACKING_NUMBER", detail: "order has no tracking number" };
    if (!SAFE_TRACKING_NUMBER.test(tn)) return { status: "unavailable", reason: "INVALID_TRACKING_NUMBER", detail: `unusable tracking number ${JSON.stringify(tn)}` };
    const shared = [...(owners.get(collisionKey(tn)) ?? [])];
    if (shared.length > 1) {
      return { status: "unavailable", reason: "AMBIGUOUS_PAGE_MAPPING", detail: `tracking number ${tn} is used by several orders: ${shared.sort().join(", ")}` };
    }
    if (order.carrier !== null && !SUPPORTED_CARRIERS.includes(order.carrier.normalize("NFC").trim())) {
      return { status: "unavailable", reason: "UNSUPPORTED_CARRIER", detail: `no page reader for carrier "${order.carrier}"` };
    }
    const page = `${tn}.html`;
    const path = join(trackingDir, page);
    if (!existsSync(path)) return { status: "unavailable", reason: "NO_TRACKING_PAGE", detail: `no saved tracking page ${page}` };
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (e) {
      return { status: "unavailable", reason: "UNREADABLE_PAGE", detail: `${page}: ${(e as Error).message}` };
    }
    const classification = classifyTrackingPage(bytes.toString("utf8"), { declaredCarrier: order.carrier, expectedTrackingNumber: tn, retrievedAt: null });
    return { status: "classified", page, classification };
  };
}
