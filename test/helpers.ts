// SYNTHETIC_TEST builders. In-memory only; nothing here is written to data/.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideAll, type DecisionReport } from "../src/decision/decide.ts";
import type { Complaint, DeliveryActivity, Order, ReporterMatrix, Return, Rules, TrackingState, TrackingVerification } from "../src/domain/types.ts";
import { loadInputs, loadRules, type Collection } from "../src/io/load.ts";
import { allOrderRows, pageTrackingProvider } from "../src/tracking/lookup.ts";
import { REFERENCE_NOW } from "../src/time/pragueDays.ts";

export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
/** The provided rules (rules.yaml) — tests use the real configuration, not a copy. */
export const RULES: Rules = loadRules(join(DATA_DIR, "rules.yaml"));
export const NOW = REFERENCE_NOW;
/** SYNTHETIC example in which MS-EX-A-0001 (definition A) and MS-EX-B-0001 (definition B) are CREATE. */
export const EXAMPLE_DIR = fileURLToPath(new URL("../examples/create/", import.meta.url));

export type Mutation = (dir: string) => void;
export const editJson = (file: string, fn: (v: any) => void): Mutation => (dir) => {
  const p = join(dir, file);
  const v = JSON.parse(readFileSync(p, "utf8"));
  fn(v);
  writeFileSync(p, JSON.stringify(v));
};

/** Same pipeline as the CLI (loaders → page classifier → decision engine) on a mutated temp copy of the example. */
export function decideExample(...mutations: Mutation[]): DecisionReport {
  const dir = mkdtempSync(join(tmpdir(), "mailstep-example-"));
  try {
    cpSync(EXAMPLE_DIR, dir, { recursive: true });
    for (const m of mutations) m(dir);
    const inputs = loadInputs(dir);
    return decideAll(inputs, NOW, { tracking: pageTrackingProvider(join(dir, "tracking"), allOrderRows(inputs.orders)) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Default: a definition-B candidate, 23 Prague days in carrier_picked_up, non-excluded method. */
export function order(over: Partial<Order> = {}): Order {
  return {
    orderId: "id-1",
    orderNumber: "MS-T-1",
    client: "Client One",
    carrier: "Kurýr Vltava",
    shippingMethod: "Kurýr Vltava Standard",
    trackingNumber: "KV1",
    trackingUrl: null,
    status: "carrier_picked_up",
    createdAt: "2026-10-08T10:00:00+02:00",
    packedAt: "2026-10-09T10:00:00+02:00",
    shippedAt: "2026-10-10T10:00:00+02:00",
    updatedAt: "2026-10-10T10:00:00+02:00",
    ...over,
  };
}

export function complaint(over: Partial<Complaint> = {}): Complaint {
  return {
    complaintId: "c-1",
    orderNumber: "MS-OTHER",
    client: "Client One",
    status: "closed",
    reason: "loss",
    reporter: "history@client-one.example",
    createdAt: "2026-09-01T10:00:00+02:00",
    ...over,
  };
}

export function ret(over: Partial<Return> = {}): Return {
  return { returnId: "r-1", orderNumber: "MS-T-1", status: "Připraveno", createdAt: "2026-10-31T10:00:00+01:00", ...over };
}

/** Builds a loader-shaped collection: valid records get indices 0..n-1, invalid ones follow. */
export function coll<T>(valid: T[], invalid: { raw: unknown; errors?: string[] }[] = [], path = "test.json"): Collection<T> {
  return {
    path,
    valid: valid.map((record, index) => ({ index, record, raw: record })),
    invalid: invalid.map((x, i) => ({ index: valid.length + i, raw: x.raw, errors: x.errors ?? ["synthetic error"] })),
    warnings: [],
  };
}

export function matrix(rows: Record<string, string>[], columns = ["client", "reporter"]): ReporterMatrix {
  return { status: "available", path: "reporters.csv", columns, rows };
}

export const MISSING_MATRIX: ReporterMatrix = { status: "missing", path: "reporters.csv" };

/**
 * A classified tracking page as the provider would return it. `event` is the carrier-local event
 * time printed on the page ("YYYY-MM-DDTHH:MM" or "YYYY-MM-DD"); null = no date on the page.
 * Default: in transit without last-mile activity, dated after the default order's shipment.
 */
export function classified(
  state: TrackingState = "IN_TRANSIT",
  { activity = state === "IN_TRANSIT" ? "UNDETERMINED" : null, event = "2026-10-12T04:37" as string | null, reason = `synthetic ${state}` }:
    { activity?: DeliveryActivity | null; event?: string | null; reason?: string } = {},
): TrackingVerification {
  return {
    status: "classified",
    page: "SYNTHETIC.html",
    classification: {
      state, activity, reliable: state !== "UNKNOWN", reason,
      evidence: {
        carrier: "Kurýr Vltava", pageTrackingNumber: "KV1", source: "synthetic", statusText: null, eventText: null,
        eventTime: event === null ? null : { text: event, local: event },
      },
      freshness: { retrievedAt: null, established: false },
      warnings: [],
    },
  };
}
