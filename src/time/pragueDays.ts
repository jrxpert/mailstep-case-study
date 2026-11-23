// Calendar-day arithmetic as the claims department counts it (docs/assignments/order-states.md):
// "picked up on Monday is two days in the status on Wednesday, regardless of the hour",
// with calendar dates as seen in Prague. Independent of the machine's local timezone.

import type { Order } from "../domain/types.ts";

export const PRAGUE_TIME_ZONE = "Europe/Prague";

/** Run instant fixed by the assignment: 2. 11. 2026 07:30 Prague (CET, UTC+1 after the 25 Oct DST end). */
export const REFERENCE_NOW = "2026-11-02T07:30:00+01:00";

const MS_PER_DAY = 86_400_000;

// ISO 8601 with a mandatory explicit offset. A timestamp without an offset is ambiguous → rejected.
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses a strict ISO 8601 timestamp with offset into epoch milliseconds.
 * Returns null for anything malformed or out of range (e.g. 2026-02-29, 24:00, missing offset).
 * Date.parse is deliberately not used: it silently accepts and normalises many invalid inputs.
 */
export function parseIsoInstant(value: string): number | null {
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "0", zone, sign, oh = "0", om = "0"] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);
  const offH = Number(oh), offM = Number(om);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59 || offH > 14 || offM > 59) return null;

  const millis = Math.floor(Number(`0.${frac}`) * 1000);
  const offsetMinutes = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (offH * 60 + offM);
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
}

const pragueDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: PRAGUE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) of an instant, as seen in Prague. */
export function pragueDate(epochMs: number): string {
  const parts = pragueDateFormat.formatToParts(epochMs);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole-day difference between two YYYY-MM-DD dates. Exact: both are taken at UTC midnight. */
function daysBetweenDates(from: string, to: string): number {
  const toUtc = (date: string): number => {
    const [y, m, d] = date.split("-").map(Number);
    return Date.UTC(y ?? NaN, (m ?? NaN) - 1, d ?? NaN);
  };
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY);
}

export type DaysError = "MISSING_TIMESTAMP" | "INVALID_TIMESTAMP" | "FUTURE_TIMESTAMP" | "INVALID_REFERENCE_TIMESTAMP";

export type DaysResult =
  | { ok: true; days: number; entryPragueDate: string; nowPragueDate: string }
  | { ok: false; error: DaysError; detail: string };

/**
 * Calendar days in Prague between `entry` and `now` — NOT elapsed 24 h intervals.
 * Same Prague date → 0. Entry after `now` → FUTURE_TIMESTAMP (never a negative count).
 */
export function calendarDaysInPrague(entry: string | null | undefined, now: string): DaysResult {
  const nowMs = parseIsoInstant(now);
  if (nowMs === null) {
    return { ok: false, error: "INVALID_REFERENCE_TIMESTAMP", detail: `reference timestamp is not ISO 8601 with offset: ${JSON.stringify(now)}` };
  }
  if (entry === null || entry === undefined) {
    return { ok: false, error: "MISSING_TIMESTAMP", detail: "state-entry timestamp is missing" };
  }
  const entryMs = parseIsoInstant(entry);
  if (entryMs === null) {
    return { ok: false, error: "INVALID_TIMESTAMP", detail: `not ISO 8601 with offset: ${JSON.stringify(entry)}` };
  }
  if (entryMs > nowMs) {
    return { ok: false, error: "FUTURE_TIMESTAMP", detail: `${entry} is after reference ${now}` };
  }
  const entryPragueDate = pragueDate(entryMs);
  const nowPragueDate = pragueDate(nowMs);
  return { ok: true, days: daysBetweenDates(entryPragueDate, nowPragueDate), entryPragueDate, nowPragueDate };
}

/**
 * Which timestamp marks entry into the order's current status (order-states.md).
 * Returns null for statuses that are not complaint candidates. `updatedAt` is never used.
 */
export function stateEntryTimestamp(
  order: Pick<Order, "status" | "packedAt" | "shippedAt">,
): { field: "packedAt" | "shippedAt"; value: string | null } | null {
  switch (order.status) {
    case "waiting_for_carrier":
      return { field: "packedAt", value: order.packedAt };
    case "carrier_picked_up":
      return { field: "shippedAt", value: order.shippedAt };
    default:
      return null;
  }
}
