// Domain contracts. Types only — no behaviour lives here (except the static reason→effect table).
// Shapes mirror the fixture files in data/ (Mailship export, WMS returns, rules.yaml).

// ---------- Input records ----------

export const ORDER_STATUSES = ["waiting_for_carrier", "carrier_picked_up", "delivered", "returning"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** One row of the Mailship order export (data/orders.json). Nullable = observed as null in the provided fixtures. */
export interface Order {
  orderId: string;
  orderNumber: string | null;
  client: string;
  carrier: string | null;
  shippingMethod: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: OrderStatus;
  createdAt: string;
  /** Entry into `waiting_for_carrier` (docs/assignments/order-states.md). */
  packedAt: string | null;
  /** Entry into `carrier_picked_up`. */
  shippedAt: string | null;
  /** Changes on ANY edit (note, address). Never use for time-in-status. */
  updatedAt: string;
}

export const COMPLAINT_STATUSES = ["draft", "open", "closed"] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export interface Complaint {
  complaintId: string;
  orderNumber: string;
  client: string;
  status: ComplaintStatus;
  reason: string;
  reporter: string;
  createdAt: string;
}

/** WMS return. Any status (incl. "Připraveno") blocks a complaint, so status stays a free string. */
export interface Return {
  returnId: string;
  orderNumber: string;
  status: string;
  createdAt: string;
}

// ---------- Business rules (data/rules.yaml) ----------

export type DefinitionId = "A" | "B";

export interface ComplaintDefinition {
  name: string;
  status: OrderStatus;
  minDaysInStatus: number;
  complaintReason: string;
  excludedShippingMethods: string[];
}

export interface Rules {
  definitions: Record<DefinitionId, ComplaintDefinition>;
}

// ---------- Reporter ----------

/**
 * data/reporters.csv is referenced by the assignment but absent. Its column layout is unknown,
 * so the loader exposes a present file as raw rows; src/rules/reporter.ts validates it.
 */
export type ReporterMatrix =
  | { status: "missing"; path: string }
  | { status: "available"; path: string; columns: string[]; rows: Record<string, string>[] };

/**
 * Assignment [PDF p.1]: large clients → contact matrix; all other clients → last reporter in the
 * client's complaint history. "Large" is defined only by the matrix, so:
 *  - resolved            an authorized source produced a reporter. `history` is only possible when
 *                        a valid matrix is available and the client is not in it.
 *  - needs_missing_data  the matrix is absent, so the client cannot be classified. `historyCandidate`
 *                        is EVIDENCE for a reviewer, never a resolved reporter.
 *  - not_found           all required data available, but no reporter exists.
 *  - invalid             source data exists but cannot be trusted.
 * Only `resolved` may ever lead to an automatic complaint.
 */
export type ReporterResolution =
  | { status: "resolved"; reporter: string; source: "matrix" | "history"; evidence: string }
  | { status: "needs_missing_data"; missing: "REPORTER_MATRIX"; historyCandidate: { reporter: string; evidence: string } | null }
  | { status: "not_found"; detail: string }
  | { status: "invalid"; detail: string };

// ---------- Tracking ----------

export const TRACKING_STATES = ["DELIVERED", "IN_TRANSIT", "RETURNING", "UNKNOWN"] as const;
export type TrackingState = (typeof TRACKING_STATES)[number];

export interface TrackingLabel {
  file: string;
  carrier: string;
  trackingNumber: string;
  expectedState: TrackingState;
  note: string;
}

/**
 * Secondary signal for IN_TRANSIT pages (null for other states):
 *   ACTIVE        the page itself shows the last mile in progress: ready for pickup, failed delivery
 *                 attempt with redelivery, out for delivery.
 *   UNDETERMINED  the page cannot establish whether delivery is progressing or stalled.
 * There is deliberately no STAGNANT value: no stagnation threshold was agreed, so none is measured.
 * Definition B accepts a dated UNDETERMINED in-transit page as loss evidence (decisions.md D-30).
 */
export type DeliveryActivity = "ACTIVE" | "UNDETERMINED";

/** Result of reading one carrier page. Produced from page content only (never from labels). */
export interface TrackingClassification {
  state: TrackingState;
  activity: DeliveryActivity | null;
  /** True when the state comes from the carrier's status section without contradictions. */
  reliable: boolean;
  reason: string;
  evidence: {
    /** Carrier recognised from the page itself. */
    carrier: string | null;
    pageTrackingNumber: string | null;
    /** Where on the page the status was read, e.g. ".status-card .value". */
    source: string | null;
    statusText: string | null;
    eventText: string | null;
    /** Carrier event time exactly as printed, plus a local ISO form. The page states no timezone. */
    eventTime: { text: string; local: string } | null;
  };
  /** Earliest dated event of a page with an event history (ParcelNord); checked against the expedition day. */
  earliestEventTime?: { text: string; local: string };
  /** Page retrieval time is not known for the fixtures, so freshness is never asserted. */
  freshness: { retrievedAt: string | null; established: boolean };
  warnings: string[];
}

export type TrackingUnavailableReason =
  | "NO_TRACKING_NUMBER"
  | "INVALID_TRACKING_NUMBER"
  | "UNSUPPORTED_CARRIER"
  | "NO_TRACKING_PAGE"
  | "UNREADABLE_PAGE"
  | "AMBIGUOUS_PAGE_MAPPING";

/**
 * Tracking input for one order (src/tracking/lookup.ts).
 *   not_verified  no tracking provider configured (unit tests that do not exercise tracking)
 *   unavailable   no usable page for the order
 *   classified    a page was read; the decision layer maps the classification to reasons
 */
export type TrackingVerification =
  | { status: "not_verified" }
  | { status: "unavailable"; reason: TrackingUnavailableReason; detail: string }
  | { status: "classified"; page: string; classification: TrackingClassification };

// ---------- Reasons ----------

export type Action = "create" | "skip" | "review";

/**
 * Every reason has a fixed effect:
 *   skip   — a definitive business rule prevents the complaint
 *   review — the order may be eligible, but information is missing, invalid or ambiguous
 *   info   — explanatory only
 * Action precedence: any skip → skip; else any review → review; else create (if all gates pass).
 */
export const REASON_EFFECT = {
  // business eligibility
  BUSINESS_ELIGIBLE: "info",
  NOT_A_CANDIDATE_STATUS: "skip",
  EXCLUDED_SHIPPING_METHOD: "skip",
  THRESHOLD_NOT_REACHED: "skip",
  AMBIGUOUS_SHIPPING_METHOD: "review",
  MISSING_TIMESTAMP: "review",
  INVALID_TIMESTAMP: "review",
  FUTURE_TIMESTAMP: "review",
  // blocking records
  EXISTING_COMPLAINT: "skip",
  EXISTING_RETURN: "skip",
  POTENTIAL_BLOCKING_RECORD: "review",
  // identity / data integrity
  IDENTICAL_DUPLICATE_GROUPED: "info",
  CONFLICTING_DUPLICATE: "review",
  INVALID_ORDER_IDENTITY: "review",
  INVALID_RECORD: "review",
  BATCH_INTEGRITY_GATE: "review",
  // reporter
  REPORTER_RESOLVED: "info",
  REPORTER_MATRIX_UNAVAILABLE: "review",
  REPORTER_NOT_FOUND: "review",
  REPORTER_DATA_INVALID: "review",
  // tracking
  TRACKING_NOT_REQUIRED: "info",
  TRACKING_IN_TRANSIT: "info",
  TRACKING_NOT_VERIFIED: "review",
  TRACKING_UNAVAILABLE: "review",
  TRACKING_DELIVERED: "skip",
  TRACKING_RETURNING: "skip",
  TRACKING_UNKNOWN: "review",
  TRACKING_ACTIVE_DELIVERY: "review",
  TRACKING_ACTIVITY_UNDETERMINED: "review",
  TRACKING_TIME_INCONSISTENT: "review",
  TRACKING_CONTRADICTS_COMPLAINT_REASON: "review",
} as const satisfies Record<string, "skip" | "review" | "info">;

export type ReasonCode = keyof typeof REASON_EFFECT;
export type ReasonEffect = (typeof REASON_EFFECT)[ReasonCode];

export interface Reason {
  code: ReasonCode;
  effect: ReasonEffect;
  detail?: string;
  /** References into source data, e.g. "complaints.json#0 (d5df662d-…)". */
  evidence?: string[];
}

// ---------- Eligibility vs execution ----------

/**
 * Business eligibility: does the order meet definition A or B (status, window, exclusions)?
 * Independent of complaints, returns, reporter and tracking. `undetermined` = cannot be decided
 * from the data (e.g. missing timestamp) and no definitive rule fails.
 */
export interface BusinessEligibility {
  status: "eligible" | "ineligible" | "undetermined";
  definition: DefinitionId | null;
  complaintReason: string | null;
  stateEntry: { field: "packedAt" | "shippedAt"; value: string | null } | null;
  daysInStatus: number | null;
  minDaysInStatus: number | null;
  reasons: Reason[];
}

/** Execution decision: may the system proceed automatically? */
export interface ExecutionDecision {
  action: Action;
  reasons: Reason[];
}
