// Decision layer: business eligibility (rules) is computed separately from the execution decision
// (may the system act automatically?). Pure: inputs + reference time in, report out.
//
// Precedence: any skip-effect reason → skip; else any review-effect reason → review; else create.
// `create` additionally requires an explicit positive checklist; a mismatch is a bug and throws.

import { basename } from "node:path";
import { hasEffect, mayDenote, reason } from "../domain/reason.ts";
import type {
  Action, BusinessEligibility, Complaint, ExecutionDecision, Order, Reason, ReasonCode,
  ReporterMatrix, ReporterResolution, Return, Rules, TrackingClassification, TrackingVerification,
} from "../domain/types.ts";
import type { Collection } from "../io/load.ts";
import { checkBlockers, findUnlinkedRecords, type IntegrityFinding } from "../rules/blockers.ts";
import { evaluateEligibility } from "../rules/eligibility.ts";
import { groupOrders, type GroupKind, type OrderGroup } from "../rules/identity.ts";
import { parseReporterMatrix, resolveReporter } from "../rules/reporter.ts";
import { parseIsoInstant, pragueDate } from "../time/pragueDays.ts";

export interface DecisionInputs {
  orders: Collection<Order>;
  complaints: Collection<Complaint>;
  returns: Collection<Return>;
  rules: Rules;
  reporterMatrix: ReporterMatrix;
}

export interface DecideOptions {
  /** Tracking per order. Defaults to not_verified (no provider). The CLI passes pageTrackingProvider. */
  tracking?: (order: Order) => TrackingVerification;
}

export interface OrderDecision {
  key: string;
  orderNumber: string | null;
  orderIds: string[];
  client: string | null;
  sourceRows: number[];
  identity: { kind: GroupKind; conflictingFields: string[]; orderIdCollisions: string[] };
  eligibility: BusinessEligibility;
  reporter: ReporterResolution | null;
  tracking: TrackingVerification | null;
  execution: ExecutionDecision;
}

export interface DecisionReport {
  referenceTime: string;
  policy: Record<string, string>;
  summary: {
    sourceRows: { orders: number; complaints: { valid: number; invalid: number }; returns: { valid: number; invalid: number } };
    logicalOrders: number;
    duplicateGroups: { key: string; kind: GroupKind; sourceRows: number[] }[];
    eligibility: Record<BusinessEligibility["status"], number>;
    actions: Record<Action, number>;
    categories: Record<string, number>;
    reasonCounts: Record<string, number>;
  };
  integrityFindings: IntegrityFinding[];
  decisions: OrderDecision[];
  sourceRowMap: { row: number; decision: string }[];
}

export const POLICY = {
  reporterMatrixMissing:
    "review (REPORTER_MATRIX_UNAVAILABLE). Conservative implementation policy (docs/decisions.md D-14), not an assignment requirement: without the matrix no client can be classified as large or non-large; history is shown as evidence only.",
  trackingVerification:
    "saved carrier pages are classified (no labels used). DELIVERED / carrier RETURNING → skip only with a carrier event date between the expedition day (A: packedAt, B: shippedAt) and the decision day, in Prague calendar days; otherwise review. Definition A: no page needed (absent pickup is the complaint itself); an in-transit page contradicts it → review. Definition B: create only on IN_TRANSIT without last-mile activity and with a consistent event date; UNKNOWN, unavailable, active delivery → review.",
  unlinkedInvalidRecords:
    "a malformed complaint/return without a usable orderNumber gates automatic creation for the whole batch (BATCH_INTEGRITY_GATE).",
} as const;

const UNEVALUATED: BusinessEligibility = {
  status: "undetermined", definition: null, complaintReason: null, stateEntry: null,
  daysInStatus: null, minDaysInStatus: null, reasons: [],
};

const DATA_QUALITY_CODES: ReasonCode[] = [
  "INVALID_ORDER_IDENTITY", "INVALID_RECORD", "CONFLICTING_DUPLICATE", "POTENTIAL_BLOCKING_RECORD",
  "MISSING_TIMESTAMP", "INVALID_TIMESTAMP", "FUTURE_TIMESTAMP", "AMBIGUOUS_SHIPPING_METHOD", "REPORTER_DATA_INVALID",
];

function identityReasons(g: OrderGroup, file: string): Reason[] {
  const rows = g.rows.map((r) => `${file}#${r.index}`);
  const out: Reason[] = [];
  if (g.kind === "invalid_identity") out.push(reason("INVALID_ORDER_IDENTITY", "orderNumber missing or unusable; complaints and returns cannot be checked", rows));
  if (g.rows.some((r) => r.order === null)) {
    out.push(reason("INVALID_RECORD", g.rows.flatMap((r) => r.errors).join("; "), g.rows.filter((r) => r.order === null).map((r) => `${file}#${r.index}`)));
  }
  if (g.kind === "conflicting_duplicate") out.push(reason("CONFLICTING_DUPLICATE", `rows disagree on: ${g.conflictingFields.join(", ")}`, rows));
  if (g.kind === "identical_duplicate") out.push(reason("IDENTICAL_DUPLICATE_GROUPED", `${g.rows.length} identical rows → one decision`, rows));
  if (g.orderIdCollisions.length > 0) out.push(reason("CONFLICTING_DUPLICATE", `orderId also used by: ${g.orderIdCollisions.join(", ")}`, rows));
  return out;
}

function reporterReasons(r: ReporterResolution): Reason[] {
  switch (r.status) {
    case "resolved":
      return [reason("REPORTER_RESOLVED", `${r.reporter} (from ${r.source})`, [r.evidence])];
    case "needs_missing_data":
      return [reason("REPORTER_MATRIX_UNAVAILABLE",
        `reporters.csv not supplied; history candidate: ${r.historyCandidate?.reporter ?? "none"} (evidence only)`,
        r.historyCandidate ? [r.historyCandidate.evidence] : undefined)];
    case "not_found":
      return [reason("REPORTER_NOT_FOUND", r.detail)];
    case "invalid":
      return [reason("REPORTER_DATA_INVALID", r.detail)];
  }
}

/**
 * Carrier event dates vs the order (time consistency). The page prints no time zone, so only calendar dates are
 * compared, with the Prague calendar dates of the expedition and the decision: every dated event must
 * lie from the expedition day through the decision day (both inclusive). A missing or invalid date of
 * the latest event is not consistent.
 */
function eventDateProblem(c: TrackingClassification, expedition: string | null, now: string): string | null {
  const latest = c.evidence.eventTime;
  if (latest === null) return "the page shows no valid carrier event date";
  const expeditionMs = expedition === null ? null : parseIsoInstant(expedition);
  if (expeditionMs === null) return "expedition timestamp missing or invalid; the carrier event date cannot be checked";
  const [from, to] = [pragueDate(expeditionMs), pragueDate(parseIsoInstant(now) as number)];
  const earliest = c.earliestEventTime ?? latest;
  if (earliest.local.slice(0, 10) < from) return `carrier event ${earliest.text} is before the expedition day ${from}`;
  if (latest.local.slice(0, 10) > to) return `carrier event ${latest.text} is after the decision day ${to}`;
  return null;
}

/**
 * Tracking gate (decisions.md D-30). Returns the reasons and whether tracking permits CREATE.
 *   A (not collected): absence of a page or pickup is the complaint itself, so it never blocks.
 *   B (loss): CREATE needs a page in transit without last-mile activity and with a consistent date.
 *   Both: DELIVERED / RETURNING → skip only with a consistent date; UNKNOWN → review.
 */
function trackingGate(t: TrackingVerification, definition: BusinessEligibility["definition"], order: Order, now: string): { reasons: Reason[]; permits: boolean } {
  const expedition = definition === "A" ? order.packedAt : order.shippedAt;
  const notRequired = (detail: string) => ({ reasons: [reason("TRACKING_NOT_REQUIRED", `${detail}; definition A does not require carrier pickup or tracking`)], permits: true });
  const block = (r: Reason) => ({ reasons: [r], permits: false });
  if (t.status === "not_verified") {
    return definition === "A" ? notRequired("no tracking provider configured") : block(reason("TRACKING_NOT_VERIFIED", "no tracking provider configured; carrier tracking not verified"));
  }
  if (t.status === "unavailable") {
    // A page that exists but cannot be used, or one that may belong to another order, stays REVIEW.
    const noEvidence = t.reason === "NO_TRACKING_NUMBER" || t.reason === "NO_TRACKING_PAGE" || t.reason === "UNSUPPORTED_CARRIER";
    return definition === "A" && noEvidence ? notRequired(`${t.reason}: ${t.detail}`) : block(reason("TRACKING_UNAVAILABLE", `${t.reason}: ${t.detail}`));
  }
  const c = t.classification;
  const ev = [`tracking/${t.page}`, ...(c.evidence.statusText ? [`status: "${c.evidence.statusText}"`] : []),
    ...(c.evidence.eventTime ? [`event time (carrier-local): ${c.evidence.eventTime.local}`] : [])];
  const timing = (state: string): Reason | null => {
    const problem = eventDateProblem(c, expedition, now);
    return problem === null ? null : reason("TRACKING_TIME_INCONSISTENT", `${state}: ${problem}`, ev);
  };
  switch (c.state) {
    case "DELIVERED":
    case "RETURNING": {
      const inconsistent = timing(c.state);
      if (inconsistent) return block(inconsistent);
      return c.state === "DELIVERED"
        ? block(reason("TRACKING_DELIVERED", c.reason, ev))
        : block(reason("TRACKING_RETURNING", `${c.reason} (carrier status; conservative policy, not the WMS return rule)`, ev));
    }
    case "UNKNOWN":
      return block(reason("TRACKING_UNKNOWN", c.reason, [...ev, ...c.warnings]));
    case "IN_TRANSIT": {
      if (definition !== "B") {
        return block(reason("TRACKING_CONTRADICTS_COMPLAINT_REASON", `carrier page shows the parcel in the carrier network (${c.reason}); this contradicts 'not_collected_by_carrier'`, ev));
      }
      if (c.activity === "ACTIVE") return block(reason("TRACKING_ACTIVE_DELIVERY", c.reason, ev));
      if (c.evidence.eventTime === null) return block(reason("TRACKING_ACTIVITY_UNDETERMINED", `${c.reason}; the page has no dated carrier event, so a stalled shipment cannot be told from a moving one`, ev));
      const inconsistent = timing(c.state);
      if (inconsistent) return block(inconsistent);
      return { reasons: [reason("TRACKING_IN_TRANSIT", `${c.reason}; last carrier event ${c.evidence.eventTime.text}, no last-mile activity`, ev)], permits: true };
    }
  }
}

/** createdAt ≤ packedAt ≤ shippedAt ≤ now, updatedAt ≤ now; definition A has no shippedAt. */
function timestampProblem(o: Order, definition: BusinessEligibility["definition"], now: string): string | null {
  const at = (v: string | null) => (v === null ? null : parseIsoInstant(v));
  if (definition === "A" && o.shippedAt !== null) return "order waits for the carrier but has shippedAt";
  const [created, packed, shipped, updated, nowMs] = [at(o.createdAt), at(o.packedAt), at(o.shippedAt), at(o.updatedAt), at(now)];
  if (created === null || updated === null || nowMs === null) return "createdAt and updatedAt must be valid instants";
  const chain = [created, ...[packed, shipped].filter((t): t is number => t !== null), nowMs];
  if (chain.some((t, i) => i > 0 && t < (chain[i - 1] as number)) || updated > nowMs) return "order timestamps are out of order or after the decision time";
  return null;
}

function decideAction(key: string, reasons: Reason[], readyToCreate: boolean): Action {
  if (hasEffect(reasons, "skip")) return "skip";
  if (hasEffect(reasons, "review")) return "review";
  if (!readyToCreate) throw new Error(`internal inconsistency for ${key}: no blocking reason but creation preconditions are not met`);
  return "create";
}

export function decideAll(inputs: DecisionInputs, now: string, options: DecideOptions = {}): DecisionReport {
  if (parseIsoInstant(now) === null) throw new Error(`reference time is not ISO 8601 with offset: ${JSON.stringify(now)}`);
  const trackingFor = options.tracking ?? ((): TrackingVerification => ({ status: "not_verified" }));
  const matrix = parseReporterMatrix(inputs.reporterMatrix);
  const findings = findUnlinkedRecords(inputs.complaints, inputs.returns);
  const groups = groupOrders(inputs.orders);
  // Order numbers that may denote the same order (case, spacing, punctuation, look-alikes; including
  // the raw number of a row whose identity was unusable, e.g. padded with spaces): none of them can be
  // acted on automatically.
  const clientOf = (orderNumber: string): string | null => groups.find((g) => g.orderNumber === orderNumber.trim())?.order?.client ?? null;
  const numbers = groups.flatMap((g) => g.rows.map((r) => (typeof r.raw === "object" && r.raw !== null ? (r.raw as Record<string, unknown>)["orderNumber"] : null)))
    .filter((n): n is string => typeof n === "string");

  const decisions: OrderDecision[] = groups.map((g) => {
    const order = g.order;
    const eligibility = order ? evaluateEligibility(order, inputs.rules, now) : UNEVALUATED;
    const blockers = g.orderNumber !== null ? checkBlockers(g.orderNumber, order?.client ?? null, inputs.complaints, inputs.returns) : [];

    // Reporter and tracking only matter if the order could still be eligible.
    const relevant = order !== null && eligibility.status !== "ineligible";
    const reporter = relevant ? resolveReporter(order.client, matrix, inputs.complaints, now, clientOf) : null;
    const tracking = relevant ? trackingFor(order) : null;
    const gate = tracking && order ? trackingGate(tracking, eligibility.definition, order, now) : null;

    const lookalikes = g.orderNumber !== null ? [...new Set(numbers.filter((n) => mayDenote(n, g.orderNumber as string)))] : [];
    const reasons: Reason[] = [
      ...identityReasons(g, basename(inputs.orders.path)),
      ...(lookalikes.length > 0 ? [reason("CONFLICTING_DUPLICATE", `orderNumber differs only in case, spacing, punctuation or look-alike characters from: ${lookalikes.map((n) => JSON.stringify(n)).join(", ")}`)] : []),
      ...eligibility.reasons,
      ...blockers,
      ...(reporter ? reporterReasons(reporter) : []),
      ...(gate ? gate.reasons : []),
    ];
    const timing = order && eligibility.status === "eligible" ? timestampProblem(order, eligibility.definition, now) : null;
    if (timing !== null) reasons.push(reason("INVALID_TIMESTAMP", timing));
    if (findings.length > 0 && !hasEffect(reasons, "skip")) {
      reasons.push(reason("BATCH_INTEGRITY_GATE", `${findings.length} unlinked malformed record(s) could block this order`, findings.map((f) => `${basename(f.source)}#${f.index}`)));
    }

    // Explicit CREATE checklist, independent of the reason effects (double guard).
    const ready =
      eligibility.status === "eligible" && g.orderNumber !== null && (g.kind === "single" || g.kind === "identical_duplicate") &&
      lookalikes.length === 0 && blockers.length === 0 && reporter?.status === "resolved" && findings.length === 0 &&
      timing === null && gate?.permits === true;

    const orderIds = [...new Set(g.rows.map((r) => r.order?.orderId).filter((id): id is string => id !== undefined))].sort();
    const clients = new Set(g.rows.map((r) => r.order?.client).filter((c): c is string => c !== undefined));
    return {
      key: g.key,
      orderNumber: g.orderNumber,
      orderIds,
      client: clients.size === 1 ? ([...clients][0] ?? null) : null,
      sourceRows: g.rows.map((r) => r.index),
      identity: { kind: g.kind, conflictingFields: g.conflictingFields, orderIdCollisions: g.orderIdCollisions },
      eligibility,
      reporter,
      tracking,
      execution: { action: decideAction(g.key, reasons, ready), reasons },
    };
  });

  // Every source row must map to exactly one decision.
  const sourceRowMap = decisions.flatMap((d) => d.sourceRows.map((row) => ({ row, decision: d.key }))).sort((a, b) => a.row - b.row);
  const totalRows = inputs.orders.valid.length + inputs.orders.invalid.length;
  if (sourceRowMap.length !== totalRows || sourceRowMap.some((m, i) => m.row !== i)) {
    throw new Error(`internal: ${sourceRowMap.length} of ${totalRows} order rows mapped`);
  }

  const has = (d: OrderDecision, codes: ReasonCode[]): boolean => d.execution.reasons.some((r) => codes.includes(r.code));
  const count = (pred: (d: OrderDecision) => boolean): number => decisions.filter(pred).length;
  const reasonCounts: Record<string, number> = {};
  for (const d of decisions) for (const code of new Set(d.execution.reasons.map((r) => r.code))) reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;

  return {
    referenceTime: now,
    policy: { ...POLICY },
    summary: {
      sourceRows: {
        orders: totalRows,
        complaints: { valid: inputs.complaints.valid.length, invalid: inputs.complaints.invalid.length },
        returns: { valid: inputs.returns.valid.length, invalid: inputs.returns.invalid.length },
      },
      logicalOrders: decisions.length,
      duplicateGroups: decisions.filter((d) => d.sourceRows.length > 1).map((d) => ({ key: d.key, kind: d.identity.kind, sourceRows: d.sourceRows })),
      eligibility: {
        eligible: count((d) => d.eligibility.status === "eligible"),
        ineligible: count((d) => d.eligibility.status === "ineligible"),
        undetermined: count((d) => d.eligibility.status === "undetermined"),
      },
      actions: {
        create: count((d) => d.execution.action === "create"),
        skip: count((d) => d.execution.action === "skip"),
        review: count((d) => d.execution.action === "review"),
      },
      categories: {
        businessIneligible: count((d) => d.eligibility.status === "ineligible"),
        eligibleAwaitingReporter: count((d) => d.eligibility.status === "eligible" && d.reporter?.status !== "resolved"),
        eligibleAwaitingTracking: count((d) => d.eligibility.status === "eligible" && !has(d, ["TRACKING_DELIVERED", "TRACKING_RETURNING", "TRACKING_IN_TRANSIT", "TRACKING_NOT_REQUIRED"])),
        eligibleClearedByTracking: count((d) => d.eligibility.status === "eligible" && has(d, ["TRACKING_DELIVERED", "TRACKING_RETURNING"])),
        blockedByComplaintOrReturn: count((d) => has(d, ["EXISTING_COMPLAINT", "EXISTING_RETURN"])),
        invalidOrAmbiguousData: count((d) => has(d, DATA_QUALITY_CODES)),
      },
      reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    integrityFindings: findings,
    decisions,
    sourceRowMap,
  };
}
