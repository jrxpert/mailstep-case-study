// Blocking records: existing complaints (any status, any reason) and WMS returns (any status).
// Matching is on orderNumber, the only link field returns and complaints share with orders.
// Exact match → definitive skip. Anything that only *might* refer to the order → review.

import { looseKey, mayDenote, reason } from "../domain/reason.ts";
import type { Complaint, Reason, Return } from "../domain/types.ts";
import type { Collection } from "../io/load.ts";

export interface IntegrityFinding {
  code: "UNLINKED_INVALID_RECORD";
  source: string;
  index: number;
  errors: string[];
  detail: string;
}

const ref = (path: string, index: number, id?: string): string =>
  `${path.split(/[\\/]/).pop()}#${index}${id ? ` (${id})` : ""}`;

const rawField = (raw: unknown, field: string): unknown =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[field] : undefined;

/** Link key of a malformed record, or null when it cannot be tied to any order. */
const rawOrderKey = (raw: unknown): string | null => {
  const v = rawField(raw, "orderNumber");
  return typeof v === "string" && looseKey(v) !== "" ? looseKey(v) : null;
};

/**
 * @param client the order's client, used to detect an orderNumber collision across clients
 *               (complaints carry a client; returns do not).
 */
export function checkBlockers(
  orderNumber: string,
  client: string | null,
  complaints: Collection<Complaint>,
  returns: Collection<Return>,
): Reason[] {
  const reasons: Reason[] = [];

  for (const { index, record: c } of complaints.valid) {
    const evidence = [ref(complaints.path, index, c.complaintId)];
    if (c.orderNumber === orderNumber && (client === null || c.client === client)) {
      reasons.push(reason("EXISTING_COMPLAINT", `${c.status} complaint, reason "${c.reason}", created ${c.createdAt}`, evidence));
    } else if (c.orderNumber === orderNumber) {
      reasons.push(reason("POTENTIAL_BLOCKING_RECORD", `complaint has this orderNumber but client "${c.client}" ≠ "${client}"`, evidence));
    } else if (mayDenote(c.orderNumber, orderNumber)) {
      reasons.push(reason("POTENTIAL_BLOCKING_RECORD", `complaint orderNumber "${c.orderNumber}" differs only in case, spacing, punctuation or look-alike characters`, evidence));
    }
  }

  for (const { index, record: r } of returns.valid) {
    const evidence = [ref(returns.path, index, r.returnId)];
    if (r.orderNumber === orderNumber) {
      reasons.push(reason("EXISTING_RETURN", `WMS return in status "${r.status}", created ${r.createdAt}`, evidence));
    } else if (mayDenote(r.orderNumber, orderNumber)) {
      reasons.push(reason("POTENTIAL_BLOCKING_RECORD", `return orderNumber "${r.orderNumber}" differs only in case, spacing, punctuation or look-alike characters`, evidence));
    }
  }

  for (const [label, coll] of [["complaint", complaints], ["return", returns]] as const) {
    for (const bad of coll.invalid) {
      const raw = rawField(bad.raw, "orderNumber");
      if (typeof raw === "string" && (raw === orderNumber || mayDenote(raw, orderNumber))) {
        reasons.push(
          reason("POTENTIAL_BLOCKING_RECORD", `malformed ${label} record refers to this order: ${bad.errors.join("; ")}`, [ref(coll.path, bad.index)]),
        );
      }
    }
  }
  return reasons;
}

/**
 * Malformed complaint/return records that cannot be linked to any order. Such a record could be a
 * blocker for ANY order, so the decision layer applies a batch-level creation gate.
 */
export function findUnlinkedRecords(complaints: Collection<Complaint>, returns: Collection<Return>): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  for (const coll of [complaints, returns] as Collection<unknown>[]) {
    for (const bad of coll.invalid) {
      if (rawOrderKey(bad.raw) === null) {
        findings.push({
          code: "UNLINKED_INVALID_RECORD",
          source: coll.path,
          index: bad.index,
          errors: bad.errors,
          detail: "malformed record without a usable orderNumber; it may block any order, so automatic creation is gated for the whole batch",
        });
      }
    }
  }
  return findings;
}
