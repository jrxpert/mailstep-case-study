// Order identity and duplicate grouping. Every source row — valid or malformed — lands in exactly
// one group; nothing is dropped. Identity = orderNumber, the field complaints and returns link by.

import type { Collection } from "../io/load.ts";
import type { Order } from "../domain/types.ts";

export interface SourceRow {
  index: number;
  raw: unknown;
  /** Validated record, or null when the loader rejected the row. */
  order: Order | null;
  errors: string[];
}

export type GroupKind =
  | "single" // one valid row
  | "identical_duplicate" // several valid rows, all fields equal
  | "conflicting_duplicate" // several valid rows that disagree
  | "invalid_record" // reliable orderNumber, but at least one row failed validation
  | "invalid_identity"; // orderNumber missing or unusable → one group per row

export interface OrderGroup {
  /** orderNumber, or "row:<index>" when identity is unusable. */
  key: string;
  orderNumber: string | null;
  kind: GroupKind;
  rows: SourceRow[];
  /** The validated order to evaluate; null when it would mean picking one row arbitrarily. */
  order: Order | null;
  conflictingFields: string[];
  /** Other group keys sharing an orderId with this group (identity collision). */
  orderIdCollisions: string[];
}

const ORDER_FIELDS: (keyof Order)[] = [
  "orderId", "orderNumber", "client", "carrier", "shippingMethod", "trackingNumber",
  "trackingUrl", "status", "createdAt", "packedAt", "shippedAt", "updatedAt",
];

/** A usable identity is a non-empty string without surrounding whitespace. No format is assumed. */
function identityOf(raw: unknown): string | null {
  const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["orderNumber"] : undefined;
  return typeof v === "string" && v !== "" && v === v.trim() ? v : null;
}

export function groupOrders(orders: Collection<Order>): OrderGroup[] {
  const rows: SourceRow[] = [
    ...orders.valid.map((v) => ({ index: v.index, raw: v.raw, order: v.record, errors: [] })),
    ...orders.invalid.map((i) => ({ index: i.index, raw: i.raw, order: null, errors: i.errors })),
  ].sort((a, b) => a.index - b.index);

  const byKey = new Map<string, SourceRow[]>();
  const groups: OrderGroup[] = [];
  for (const row of rows) {
    const id = identityOf(row.raw);
    if (id === null) {
      groups.push({
        key: `row:${row.index}`, orderNumber: null, kind: "invalid_identity", rows: [row],
        order: row.order, conflictingFields: [], orderIdCollisions: [],
      });
    } else {
      byKey.set(id, [...(byKey.get(id) ?? []), row]);
    }
  }

  for (const [orderNumber, members] of byKey) {
    const valid = members.map((m) => m.order).filter((o): o is Order => o !== null);
    let kind: GroupKind;
    let conflictingFields: string[] = [];
    if (valid.length < members.length) kind = "invalid_record";
    else if (members.length === 1) kind = "single";
    else {
      const first = valid[0] as Order;
      conflictingFields = ORDER_FIELDS.filter((f) => valid.some((o) => o[f] !== first[f]));
      kind = conflictingFields.length === 0 ? "identical_duplicate" : "conflicting_duplicate";
    }
    const order = kind === "single" || kind === "identical_duplicate" ? (valid[0] ?? null) : null;
    groups.push({ key: orderNumber, orderNumber, kind, rows: members, order, conflictingFields, orderIdCollisions: [] });
  }

  // orderId shared by different identities → neither can be trusted. Malformed rows count too.
  const orderIdOf = (r: SourceRow): string | null => {
    const v = r.order?.orderId ?? (typeof r.raw === "object" && r.raw !== null ? (r.raw as Record<string, unknown>)["orderId"] : undefined);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const keysByOrderId = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const r of g.rows) {
      const id = orderIdOf(r);
      if (id !== null) keysByOrderId.set(id, (keysByOrderId.get(id) ?? new Set()).add(g.key));
    }
  }
  for (const g of groups) {
    const others = new Set<string>();
    for (const r of g.rows) {
      const id = orderIdOf(r);
      for (const k of (id !== null && keysByOrderId.get(id)) || []) if (k !== g.key) others.add(k);
    }
    g.orderIdCollisions = [...others].sort();
  }

  return groups.sort(compareGroups);
}

/** Deterministic order: real order numbers (code-unit order), then unusable identities by row. */
function compareGroups(a: OrderGroup, b: OrderGroup): number {
  if (a.orderNumber !== null && b.orderNumber !== null) return a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0;
  if (a.orderNumber !== null) return -1;
  if (b.orderNumber !== null) return 1;
  return (a.rows[0]?.index ?? 0) - (b.rows[0]?.index ?? 0);
}
