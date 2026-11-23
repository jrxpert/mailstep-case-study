import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decideAll, type DecisionInputs, type OrderDecision } from "../../src/decision/decide.ts";
import type { Order, Return, TrackingVerification } from "../../src/domain/types.ts";
import { loadInputs } from "../../src/io/load.ts";
import { pageTrackingProvider } from "../../src/tracking/lookup.ts";
import { DATA_DIR, MISSING_MATRIX, NOW, RULES, classified, coll, complaint, matrix, order, ret } from "../helpers.ts";

// SYNTHETIC_TEST: client confirmed non-large by a synthetic valid matrix, with history.
// The default order is definition B, shipped 2026-10-10 10:00 Prague; NOW is 2026-11-02 07:30 Prague.
const HISTORY = [complaint({ client: "Client One", reporter: "history@client-one.example" })];
const VALID_MATRIX = matrix([{ client: "Big Client", reporter: "ops@big.example" }]);
const DEF_A = order({ status: "waiting_for_carrier", packedAt: "2026-10-28T08:00:00+01:00", shippedAt: null });

function decideOne(o: Order, tracking: TrackingVerification, extra: { complaints?: ReturnType<typeof complaint>[]; returns?: Return[]; reporterMatrix?: DecisionInputs["reporterMatrix"] } = {}): OrderDecision {
  const r = decideAll({
    orders: coll([o]), complaints: coll(extra.complaints ?? HISTORY), returns: coll(extra.returns ?? []),
    rules: RULES, reporterMatrix: extra.reporterMatrix ?? VALID_MATRIX,
  }, NOW, { tracking: () => tracking });
  return r.decisions[0] as OrderDecision;
}
const codes = (d: OrderDecision) => d.execution.reasons.filter((r) => r.effect !== "info").map((r) => r.code);

describe("tracking gate in the decision layer (eligible order, reporter resolved)", () => {
  const cases: [string, TrackingVerification, string, string[]][] = [
    ["DELIVERED", classified("DELIVERED"), "skip", ["TRACKING_DELIVERED"]],
    ["RETURNING", classified("RETURNING"), "skip", ["TRACKING_RETURNING"]],
    ["UNKNOWN", classified("UNKNOWN"), "review", ["TRACKING_UNKNOWN"]],
    ["IN_TRANSIT/ACTIVE", classified("IN_TRANSIT", { activity: "ACTIVE" }), "review", ["TRACKING_ACTIVE_DELIVERY"]],
    ["IN_TRANSIT/UNDETERMINED without an event date", classified("IN_TRANSIT", { event: null }), "review", ["TRACKING_ACTIVITY_UNDETERMINED"]],
    ["IN_TRANSIT/UNDETERMINED with a consistent date", classified("IN_TRANSIT"), "create", []],
    ["missing page", { status: "unavailable", reason: "NO_TRACKING_PAGE", detail: "no saved page" }, "review", ["TRACKING_UNAVAILABLE"]],
    ["no tracking provider", { status: "not_verified" }, "review", ["TRACKING_NOT_VERIFIED"]],
  ];
  for (const [label, t, action, expected] of cases) {
    it(`B: ${label} → ${action}`, () => {
      const d = decideOne(order(), t);
      assert.equal(d.eligibility.status, "eligible");
      assert.equal(d.reporter?.status, "resolved");
      assert.equal(d.execution.action, action);
      assert.deepEqual(codes(d), expected);
    });
  }

  it("B: only a dated, non-active IN_TRANSIT page permits create", () => {
    const creates = cases.filter(([, t]) => decideOne(order(), t).execution.action === "create").map(([label]) => label);
    assert.deepEqual(creates, ["IN_TRANSIT/UNDETERMINED with a consistent date"]);
    const r = decideOne(order(), classified()).execution.reasons.find((x) => x.code === "TRACKING_IN_TRANSIT");
    assert.equal(r?.effect, "info");
  });

  it("carrier RETURNING is labelled as distinct from the WMS return rule", () => {
    const r = decideOne(order(), classified("RETURNING")).execution.reasons.find((x) => x.code === "TRACKING_RETURNING");
    assert.match(r?.detail ?? "", /not the WMS return rule/);
  });

  const aCases: [string, TrackingVerification, string, string[]][] = [
    ["no tracking provider", { status: "not_verified" }, "create", []],
    ["no tracking number", { status: "unavailable", reason: "NO_TRACKING_NUMBER", detail: "x" }, "create", []],
    ["no saved page", { status: "unavailable", reason: "NO_TRACKING_PAGE", detail: "x" }, "create", []],
    ["unsupported carrier", { status: "unavailable", reason: "UNSUPPORTED_CARRIER", detail: "x" }, "create", []],
    ["tracking number shared by several orders", { status: "unavailable", reason: "AMBIGUOUS_PAGE_MAPPING", detail: "x" }, "review", ["TRACKING_UNAVAILABLE"]],
    ["unusable tracking number", { status: "unavailable", reason: "INVALID_TRACKING_NUMBER", detail: "x" }, "review", ["TRACKING_UNAVAILABLE"]],
    ["unreadable page", { status: "unavailable", reason: "UNREADABLE_PAGE", detail: "x" }, "review", ["TRACKING_UNAVAILABLE"]],
    ["UNKNOWN page", classified("UNKNOWN"), "review", ["TRACKING_UNKNOWN"]],
    ["IN_TRANSIT page", classified("IN_TRANSIT", { event: "2026-10-30" }), "review", ["TRACKING_CONTRADICTS_COMPLAINT_REASON"]],
    ["IN_TRANSIT/ACTIVE page", classified("IN_TRANSIT", { activity: "ACTIVE", event: null }), "review", ["TRACKING_CONTRADICTS_COMPLAINT_REASON"]],
    ["DELIVERED after packing", classified("DELIVERED", { event: "2026-10-30T10:00" }), "skip", ["TRACKING_DELIVERED"]],
  ];
  for (const [label, t, action, expected] of aCases) {
    it(`A: ${label} → ${action}`, () => {
      const d = decideOne(DEF_A, t);
      assert.equal(d.eligibility.definition, "A");
      assert.equal(d.execution.action, action);
      assert.deepEqual(codes(d), expected);
    });
  }

  it("A: contradiction detail names the complaint reason", () => {
    const r = decideOne(DEF_A, classified("IN_TRANSIT")).execution.reasons.find((x) => x.code === "TRACKING_CONTRADICTS_COMPLAINT_REASON");
    assert.match(r?.detail ?? "", /contradicts 'not_collected_by_carrier'/);
  });
});

describe("time consistency: DELIVERED / RETURNING skip only with a time-consistent carrier event", () => {
  // Expedition: B shippedAt 2026-10-10 10:00, A packedAt 2026-10-28 08:00. Decision day 2026-11-02.
  const cases: [string, Order, TrackingVerification, string, string[]][] = [
    ["B delivered before the shipment day", order(), classified("DELIVERED", { event: "2026-10-09T23:59" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B returned before the shipment day", order(), classified("RETURNING", { event: "2026-10-01" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B delivered after the decision day", order(), classified("DELIVERED", { event: "2026-11-03T00:00" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B returned after the decision day (date only)", order(), classified("RETURNING", { event: "2026-11-03" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B delivered without any event date", order(), classified("DELIVERED", { event: null }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B returned without any event date", order(), classified("RETURNING", { event: null }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B delivered on the shipment day (earlier hour; no zone on the page)", order(), classified("DELIVERED", { event: "2026-10-10T08:00" }), "skip", ["TRACKING_DELIVERED"]],
    ["B delivered on the shipment day (date only)", order(), classified("DELIVERED", { event: "2026-10-10" }), "skip", ["TRACKING_DELIVERED"]],
    ["B delivered on the decision day", order(), classified("DELIVERED", { event: "2026-11-02T06:00" }), "skip", ["TRACKING_DELIVERED"]],
    ["B in transit, last event before the shipment day", order(), classified("IN_TRANSIT", { event: "2026-10-09T10:00" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B in transit, last event after the decision day", order(), classified("IN_TRANSIT", { event: "2026-11-05" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["B in transit, event on the shipment day", order(), classified("IN_TRANSIT", { event: "2026-10-10" }), "create", []],
    ["A delivered before the packing day", DEF_A, classified("DELIVERED", { event: "2026-10-27T12:00" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["A returned after the decision day", DEF_A, classified("RETURNING", { event: "2026-11-04T12:00" }), "review", ["TRACKING_TIME_INCONSISTENT"]],
    ["A returned on the packing day", DEF_A, classified("RETURNING", { event: "2026-10-28" }), "skip", ["TRACKING_RETURNING"]],
  ];
  for (const [label, o, t, action, expected] of cases) {
    it(`${label} → ${action}`, () => {
      const d = decideOne(o, t);
      assert.equal(d.execution.action, action);
      assert.deepEqual(codes(d), expected);
    });
  }

  it("the inconsistency detail names the event and the boundary day", () => {
    const r = decideOne(order(), classified("DELIVERED", { event: "2026-10-09T23:59" })).execution.reasons.find((x) => x.code === "TRACKING_TIME_INCONSISTENT");
    assert.match(r?.detail ?? "", /DELIVERED: carrier event 2026-10-09T23:59 is before the expedition day 2026-10-10/);
  });

  it("an unusable expedition timestamp never lets tracking decide", () => {
    const d = decideOne(order({ shippedAt: null }), classified("DELIVERED", { event: "2026-10-20" }));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_TIME_INCONSISTENT"));
    assert.ok(codes(d).includes("MISSING_TIMESTAMP"));
  });
});

describe("tracking combined with other rules", () => {
  it("business-ineligible + DELIVERED → skip on the business rule; tracking not consulted", () => {
    const d = decideOne(order({ shippedAt: "2026-10-25T10:00:00+01:00" }), classified("DELIVERED"));
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["THRESHOLD_NOT_REACHED"]);
    assert.equal(d.tracking, null);
  });

  it("existing complaint + tracking uncertainty → skip, uncertainty visible", () => {
    const d = decideOne(order(), classified("UNKNOWN"), { complaints: [...HISTORY, complaint({ orderNumber: "MS-T-1" })] });
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["EXISTING_COMPLAINT", "TRACKING_UNKNOWN"]);
  });

  it("existing WMS return + tracking uncertainty → skip, uncertainty visible", () => {
    const d = decideOne(order(), classified("IN_TRANSIT", { event: null }), { returns: [ret()] });
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["EXISTING_RETURN", "TRACKING_ACTIVITY_UNDETERMINED"]);
  });

  it("missing reporter matrix + permitting tracking → review (matrix still visible)", () => {
    const d = decideOne(order(), classified(), { reporterMatrix: MISSING_MATRIX });
    assert.equal(d.execution.action, "review");
    assert.deepEqual(codes(d), ["REPORTER_MATRIX_UNAVAILABLE"]);
  });

  it("missing reporter matrix + DELIVERED → skip; matrix gap still reported", () => {
    const d = decideOne(order(), classified("DELIVERED"), { reporterMatrix: MISSING_MATRIX });
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["REPORTER_MATRIX_UNAVAILABLE", "TRACKING_DELIVERED"]);
  });

  it("valid synthetic matrix + tracking result: only the tracking reason remains", () => {
    const d = decideOne(order({ client: "Big Client" }), classified("IN_TRANSIT", { activity: "ACTIVE" }));
    assert.equal(d.reporter?.status === "resolved" && d.reporter.source, "matrix");
    assert.deepEqual(codes(d), ["TRACKING_ACTIVE_DELIVERY"]);
  });

  it("multiple simultaneous reasons are all preserved", () => {
    const d = decideOne(order(), classified("DELIVERED"), { complaints: [...HISTORY, complaint({ orderNumber: "MS-T-1" })], returns: [ret()], reporterMatrix: MISSING_MATRIX });
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["EXISTING_COMPLAINT", "EXISTING_RETURN", "REPORTER_MATRIX_UNAVAILABLE", "TRACKING_DELIVERED"]);
  });
});

describe("provided fixtures with the page classifier", () => {
  const inputs = loadInputs(DATA_DIR);
  const tracking = pageTrackingProvider(join(DATA_DIR, "tracking"), inputs.orders.valid.map((v) => v.record));
  const withTracking = decideAll(inputs, NOW, { tracking });
  const withoutTracking = decideAll(inputs, NOW);
  const byKey = (k: string) => withTracking.decisions.find((d) => d.key === k) as OrderDecision;
  const trackingCode = (d: OrderDecision) => d.execution.reasons.find((r) => r.code.startsWith("TRACKING_"))?.code ?? null;

  it("all rows and logical orders accounted for; counts", () => {
    assert.equal(withTracking.sourceRowMap.length, 33);
    assert.equal(withTracking.decisions.length, 32);
    assert.deepEqual(withTracking.summary.eligibility, { eligible: 23, ineligible: 9, undetermined: 0 });
    assert.deepEqual(withTracking.summary.actions, { create: 0, skip: 14, review: 18 });
  });

  it("business eligibility is unchanged by tracking", () => {
    assert.deepEqual(withTracking.decisions.map((d) => d.eligibility), withoutTracking.decisions.map((d) => d.eligibility));
  });

  it("explicit tracking outcome per order", () => {
    const expected: Record<string, [string, string | null]> = {
      "MS-2026-120101": ["review", "TRACKING_ACTIVITY_UNDETERMINED"],
      "MS-2026-120105": ["skip", "TRACKING_DELIVERED"],
      "MS-2026-120112": ["review", "TRACKING_UNKNOWN"], // Doručto: colour only
      "MS-2026-120113": ["review", "TRACKING_UNKNOWN"], // carrier has no record
      "MS-2026-120114": ["review", "TRACKING_IN_TRANSIT"], // last scan 12 Oct; review only for the missing matrix
      "MS-2026-120115": ["review", "TRACKING_UNKNOWN"], // neighbour
      "MS-2026-120116": ["review", "TRACKING_ACTIVE_DELIVERY"], // pickup box
      "MS-2026-120117": ["skip", "TRACKING_DELIVERED"],
      "MS-2026-120118": ["review", "TRACKING_ACTIVE_DELIVERY"], // failed attempt
      "MS-2026-120123": ["review", "TRACKING_ACTIVE_DELIVERY"], // out for delivery
      "MS-2026-120124": ["review", "TRACKING_UNKNOWN"], // Doručto: delivery shown only by colour
    };
    for (const [k, [action, code]] of Object.entries(expected)) {
      assert.deepEqual([byKey(k).execution.action, trackingCode(byKey(k))], [action, code], k);
    }
  });

  it("120116, 120118, 120123 are not created", () => {
    for (const k of ["MS-2026-120116", "MS-2026-120118", "MS-2026-120123"]) assert.equal(byKey(k).execution.action, "review", k);
  });

  it("orders without a usable page keep their tracking-free action; definition A does not need a page", () => {
    const unavailable = withTracking.decisions.filter((d) => d.tracking?.status === "unavailable");
    assert.equal(unavailable.length, 12);
    for (const d of unavailable) {
      const before = withoutTracking.decisions.find((x) => x.key === d.key);
      assert.equal(d.execution.action, before?.execution.action, d.key);
      const code = d.eligibility.definition === "A" ? "TRACKING_NOT_REQUIRED" : "TRACKING_UNAVAILABLE";
      assert.ok(d.execution.reasons.some((r) => r.code === code), d.key);
    }
    assert.equal(unavailable.filter((d) => d.eligibility.definition === "A").length, 6);
    const parcelo = byKey("MS-2026-120008").tracking;
    assert.equal(parcelo?.status === "unavailable" ? parcelo.reason : null, "UNSUPPORTED_CARRIER");
    const noNumber = byKey("MS-2026-120111").tracking;
    assert.equal(noNumber?.status === "unavailable" ? noNumber.reason : null, "NO_TRACKING_NUMBER");
  });

  it("the only tracking-permitted order (120114) is REVIEW solely because the reporter matrix is missing", () => {
    const d = byKey("MS-2026-120114");
    assert.deepEqual(codes(d), ["REPORTER_MATRIX_UNAVAILABLE"]);
    assert.equal(d.execution.action, "review");
  });

  it("only 120105 and 120117 changed action versus the decision without tracking", () => {
    const changed = withTracking.decisions.filter((d, i) => d.execution.action !== withoutTracking.decisions[i]?.execution.action).map((d) => d.key);
    assert.deepEqual(changed, ["MS-2026-120105", "MS-2026-120117"]);
  });

  it("deterministic", () => {
    assert.equal(JSON.stringify(decideAll(inputs, NOW, { tracking })), JSON.stringify(withTracking));
  });
});
