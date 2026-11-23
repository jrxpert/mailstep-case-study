import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAll, type DecisionInputs, type OrderDecision } from "../../src/decision/decide.ts";
import type { Complaint, Order, Return, TrackingVerification } from "../../src/domain/types.ts";
import { loadInputs } from "../../src/io/load.ts";
import { DATA_DIR, MISSING_MATRIX, NOW, RULES, classified, coll, complaint, matrix, order, ret } from "../helpers.ts";

// Synthetic world in which a create is *possible*: the client is confirmed non-large by a
// (synthetic) valid matrix and has history. Tracking is injected only where a test says so.
const HISTORY = [complaint({ client: "Client One", reporter: "history@client-one.example" })];
const VALID_MATRIX = matrix([{ client: "Big Client", reporter: "ops@big.example" }]);
/** Tracking that permits definition B: in transit, no last-mile activity, dated after the shipment. */
const PERMIT = (): TrackingVerification => classified();

function run(
  orders: Order[],
  { complaints = HISTORY, returns = [] as Return[], badComplaints = [] as { raw: unknown }[], badReturns = [] as { raw: unknown }[],
    badOrders = [] as { raw: unknown }[], reporterMatrix = VALID_MATRIX, tracking = undefined as undefined | (() => TrackingVerification) } = {},
) {
  const inputs: DecisionInputs = {
    orders: coll(orders, badOrders, "orders.json"),
    complaints: coll<Complaint>(complaints, badComplaints, "complaints.json"),
    returns: coll(returns, badReturns, "returns.json"),
    rules: RULES,
    reporterMatrix,
  };
  return decideAll(inputs, NOW, tracking ? { tracking } : {});
}
const codes = (d: OrderDecision | undefined) => d?.execution.reasons.map((r) => r.code) ?? [];
const only = (r: ReturnType<typeof run>) => {
  assert.equal(r.decisions.length, 1);
  return r.decisions[0] as OrderDecision;
};

describe("execution decisions", () => {
  it("create only when every gate passes (dated in-transit tracking)", () => {
    const d = only(run([order()], { tracking: PERMIT }));
    assert.equal(d.execution.action, "create");
    assert.deepEqual(codes(d), ["BUSINESS_ELIGIBLE", "REPORTER_RESOLVED", "TRACKING_IN_TRANSIT"]);
  });

  it("no automatic create without tracking verification (default)", () => {
    const d = only(run([order()]));
    assert.equal(d.eligibility.status, "eligible");
    assert.equal(d.execution.action, "review");
    assert.deepEqual(codes(d), ["BUSINESS_ELIGIBLE", "REPORTER_RESOLVED", "TRACKING_NOT_VERIFIED"]);
  });

  it("eligible but reporter matrix missing → review, eligibility unaffected", () => {
    const d = only(run([order()], { reporterMatrix: MISSING_MATRIX, tracking: PERMIT }));
    assert.equal(d.eligibility.status, "eligible");
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("REPORTER_MATRIX_UNAVAILABLE"));
    assert.equal(d.reporter?.status, "needs_missing_data");
  });

  it("eligible but reporter not found → review REPORTER_NOT_FOUND (not business-ineligible)", () => {
    const d = only(run([order()], { complaints: [], tracking: PERMIT }));
    assert.equal(d.eligibility.status, "eligible");
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("REPORTER_NOT_FOUND"));
  });

  it("invalid reporter data → review REPORTER_DATA_INVALID", () => {
    const d = only(run([order()], { complaints: [complaint({ reporter: "???" })], tracking: PERMIT }));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("REPORTER_DATA_INVALID"));
  });

  it("business-ineligible → skip; reporter and tracking are not evaluated", () => {
    const d = only(run([order({ shippedAt: "2026-10-25T10:00:00+01:00" })], { tracking: PERMIT }));
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["THRESHOLD_NOT_REACHED"]);
    assert.equal(d.reporter, null);
    assert.equal(d.tracking, null);
  });

  it("existing complaint (closed, different reason) → skip even though everything else passes", () => {
    const d = only(run([order()], { complaints: [...HISTORY, complaint({ orderNumber: "MS-T-1", status: "closed", reason: "damaged" })], tracking: PERMIT }));
    assert.equal(d.execution.action, "skip");
    assert.ok(codes(d).includes("EXISTING_COMPLAINT"));
  });

  it("existing return (Připraveno) → skip with evidence", () => {
    const d = only(run([order()], { returns: [ret()], tracking: PERMIT }));
    assert.equal(d.execution.action, "skip");
    const r = d.execution.reasons.find((x) => x.code === "EXISTING_RETURN");
    assert.deepEqual(r?.evidence, ["returns.json#0 (r-1)"]);
  });

  it("multiple simultaneous reasons are all preserved", () => {
    const d = only(run([order({ shippingMethod: "Parcelo DE", shippedAt: "2026-10-25T10:00:00+01:00" })],
      { complaints: [...HISTORY, complaint({ orderNumber: "MS-T-1" })], returns: [ret()] }));
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["EXCLUDED_SHIPPING_METHOD", "THRESHOLD_NOT_REACHED", "EXISTING_COMPLAINT", "EXISTING_RETURN"]);
  });

  it("definitive blocker + uncertainty → skip, uncertainty stays visible", () => {
    const d = only(run([order()], { complaints: [...HISTORY, complaint({ orderNumber: "MS-T-1" })], badReturns: [{ raw: { orderNumber: "MS-T-1" } }] }));
    assert.equal(d.execution.action, "skip");
    assert.ok(codes(d).includes("EXISTING_COMPLAINT"));
    assert.ok(codes(d).includes("POTENTIAL_BLOCKING_RECORD"));
    assert.ok(codes(d).includes("TRACKING_NOT_VERIFIED"));
  });
});

describe("identity in the decision layer", () => {
  it("identical duplicate → one decision referencing every row", () => {
    const r = run([order(), order()], { tracking: PERMIT });
    const d = only(r);
    assert.deepEqual(d.sourceRows, [0, 1]);
    assert.equal(d.execution.action, "create");
    assert.ok(codes(d).includes("IDENTICAL_DUPLICATE_GROUPED"));
    assert.deepEqual(r.sourceRowMap, [{ row: 0, decision: "MS-T-1" }, { row: 1, decision: "MS-T-1" }]);
  });

  it("conflicting duplicate → review, eligibility undetermined (no arbitrary pick)", () => {
    const d = only(run([order(), order({ shippingMethod: "Parcelo DE" })], { tracking: PERMIT }));
    assert.equal(d.execution.action, "review");
    assert.equal(d.eligibility.status, "undetermined");
    assert.deepEqual(codes(d), ["CONFLICTING_DUPLICATE"]);
  });

  it("conflicting duplicate with an existing complaint → skip (blocker depends only on orderNumber)", () => {
    const d = only(run([order(), order({ shippingMethod: "Parcelo DE" })], { complaints: [complaint({ orderNumber: "MS-T-1" })] }));
    assert.equal(d.execution.action, "skip");
    assert.deepEqual(codes(d), ["CONFLICTING_DUPLICATE", "EXISTING_COMPLAINT"]);
  });

  it("missing order number → review INVALID_ORDER_IDENTITY; eligibility still reported", () => {
    const d = only(run([order({ orderNumber: null })], { tracking: PERMIT }));
    assert.equal(d.key, "row:0");
    assert.equal(d.execution.action, "review");
    assert.equal(d.eligibility.status, "eligible");
    assert.ok(codes(d).includes("INVALID_ORDER_IDENTITY"));
  });

  it("malformed order record → review INVALID_RECORD, row mapped (no silent loss)", () => {
    const r = run([order()], { badOrders: [{ raw: { orderNumber: "MS-T-9", status: "lost" } }], tracking: PERMIT });
    assert.deepEqual(r.sourceRowMap, [{ row: 0, decision: "MS-T-1" }, { row: 1, decision: "MS-T-9" }]);
    const bad = r.decisions.find((d) => d.key === "MS-T-9");
    assert.equal(bad?.execution.action, "review");
    assert.deepEqual(codes(bad), ["INVALID_RECORD"]);
  });
});

describe("malformed complaint / return records", () => {
  it("malformed complaint linked to the order → review POTENTIAL_BLOCKING_RECORD, no batch gate", () => {
    // MS-T-2 belongs to another client: the malformed complaint (linked to MS-T-1, hence to Client One)
    // cannot be its latest complaint, so it does not affect MS-T-2 (no batch-wide effect).
    const two = { ...HISTORY[0]!, complaintId: "c-2", client: "Client Two", reporter: "history@client-two.example" };
    const r = run([order(), order({ orderNumber: "MS-T-2", orderId: "id-2", client: "Client Two" })], { complaints: [...HISTORY, two], badComplaints: [{ raw: { orderNumber: "MS-T-1" } }], tracking: PERMIT });
    assert.deepEqual(r.integrityFindings, []);
    assert.deepEqual(r.decisions.map((d) => [d.key, d.execution.action]), [["MS-T-1", "review"], ["MS-T-2", "create"]]);
    assert.ok(codes(r.decisions[0]).includes("POTENTIAL_BLOCKING_RECORD"));
  });

  it("malformed return linked to the order → review", () => {
    const d = only(run([order()], { badReturns: [{ raw: { orderNumber: "MS-T-1", status: 5 } }], tracking: PERMIT }));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("POTENTIAL_BLOCKING_RECORD"));
  });

  it("unlinked malformed record → dataset finding + batch creation gate; skips stay skips", () => {
    const r = run([order(), order({ orderNumber: "MS-T-2", orderId: "id-2", status: "delivered" })], { badReturns: [{ raw: { returnId: "r?" } }], tracking: PERMIT });
    assert.equal(r.integrityFindings.length, 1);
    assert.equal(r.integrityFindings[0]?.code, "UNLINKED_INVALID_RECORD");
    const [first, second] = r.decisions;
    assert.equal(first?.execution.action, "review");
    assert.equal(first?.eligibility.status, "eligible");
    assert.ok(codes(first).includes("BATCH_INTEGRITY_GATE"));
    assert.equal(second?.execution.action, "skip");
    assert.ok(!codes(second).includes("BATCH_INTEGRITY_GATE"));
  });
});

describe("guards", () => {
  it("rejects an invalid reference time", () => {
    assert.throws(() => decideAll({ orders: coll([]), complaints: coll([]), returns: coll([]), rules: RULES, reporterMatrix: MISSING_MATRIX }, "2026-11-02 07:30"), /reference time/);
  });
});

describe("provided fixtures (data/) end-to-end", () => {
  const report = decideAll(loadInputs(DATA_DIR), NOW);
  const M = "REPORTER_MATRIX_UNAVAILABLE";
  // Without a tracking provider, definition B needs tracking (review); definition A does not (info).
  const T = "TRACKING_NOT_VERIFIED";

  it("accounts for all 33 source rows in 32 logical orders", () => {
    assert.equal(report.summary.sourceRows.orders, 33);
    assert.equal(report.summary.logicalOrders, 32);
    assert.equal(report.sourceRowMap.length, 33);
    assert.deepEqual(report.sourceRowMap.map((m) => m.row), [...Array(33).keys()]);
    assert.deepEqual(report.summary.duplicateGroups, [{ key: "MS-2026-120101", kind: "identical_duplicate", sourceRows: [8, 20] }]);
  });

  it("matches the expected decision for every order (explicit table)", () => {
    // [key, action, eligibility, non-info reason codes]
    const expected: [string, string, string, string[]][] = [
      ["MS-2026-120001", "review", "eligible", [M]],
      ["MS-2026-120002", "skip", "ineligible", ["THRESHOLD_NOT_REACHED"]],
      ["MS-2026-120003", "skip", "ineligible", ["EXCLUDED_SHIPPING_METHOD"]],
      ["MS-2026-120004", "skip", "eligible", ["EXISTING_COMPLAINT", M]],
      ["MS-2026-120005", "review", "eligible", [M]],
      ["MS-2026-120006", "review", "eligible", [M]],
      ["MS-2026-120007", "review", "eligible", [M]],
      ["MS-2026-120008", "review", "eligible", [M]],
      ["MS-2026-120101", "review", "eligible", [M, T]],
      ["MS-2026-120102", "skip", "ineligible", ["THRESHOLD_NOT_REACHED"]],
      ["MS-2026-120103", "skip", "ineligible", ["EXCLUDED_SHIPPING_METHOD"]],
      ["MS-2026-120104", "skip", "ineligible", ["EXCLUDED_SHIPPING_METHOD"]],
      ["MS-2026-120105", "review", "eligible", [M, T]],
      ["MS-2026-120106", "skip", "ineligible", ["NOT_A_CANDIDATE_STATUS", "EXISTING_RETURN"]],
      ["MS-2026-120107", "skip", "ineligible", ["NOT_A_CANDIDATE_STATUS"]],
      ["MS-2026-120108", "skip", "eligible", ["EXISTING_RETURN", M, T]],
      ["MS-2026-120109", "skip", "eligible", ["EXISTING_COMPLAINT", M, T]],
      ["MS-2026-120110", "review", "eligible", [M, T]],
      ["MS-2026-120111", "review", "eligible", [M, T]],
      ["MS-2026-120112", "review", "eligible", [M, T]],
      ["MS-2026-120113", "review", "eligible", [M, T]],
      ["MS-2026-120114", "review", "eligible", [M, T]],
      ["MS-2026-120115", "review", "eligible", [M, T]],
      ["MS-2026-120116", "review", "eligible", [M, T]],
      ["MS-2026-120117", "review", "eligible", [M, T]],
      ["MS-2026-120118", "review", "eligible", [M, T]],
      ["MS-2026-120120", "skip", "ineligible", ["EXCLUDED_SHIPPING_METHOD"]],
      ["MS-2026-120122", "review", "eligible", [M, T]],
      ["MS-2026-120123", "review", "eligible", [M, T]],
      ["MS-2026-120124", "review", "eligible", [M, T]],
      ["MS-2026-120125", "skip", "ineligible", ["THRESHOLD_NOT_REACHED"]],
      ["row:28", "review", "eligible", ["INVALID_ORDER_IDENTITY", M, T]],
    ];
    const actual = report.decisions.map((d) => [d.key, d.execution.action, d.eligibility.status, d.execution.reasons.filter((r) => r.effect !== "info").map((r) => r.code)]);
    assert.deepEqual(actual, expected);
  });

  it("summary counts", () => {
    assert.deepEqual(report.summary.eligibility, { eligible: 23, ineligible: 9, undetermined: 0 });
    assert.deepEqual(report.summary.actions, { create: 0, skip: 12, review: 20 });
    assert.deepEqual(report.integrityFindings, []);
  });

  it("120125 stays below 14 Prague days", () => {
    const d = report.decisions.find((x) => x.key === "MS-2026-120125");
    assert.equal(d?.eligibility.daysInStatus, 13);
    assert.equal(d?.execution.action, "skip");
  });

  it("no create; tracking never reported as verified; matrix absence explicit", () => {
    assert.ok(report.decisions.every((d) => d.execution.action !== "create"));
    assert.ok(report.decisions.every((d) => d.tracking === null || d.tracking.status === "not_verified"));
    assert.ok(report.decisions.every((d) => d.reporter === null || d.reporter.status === "needs_missing_data"));
  });

  it("repeated runs are identical", () => {
    assert.equal(JSON.stringify(decideAll(loadInputs(DATA_DIR), NOW)), JSON.stringify(report));
  });
});
