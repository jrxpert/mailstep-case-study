import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateEligibility } from "../../src/rules/eligibility.ts";
import { NOW, RULES, order } from "../helpers.ts";

const codes = (o: Parameters<typeof evaluateEligibility>[0], now = NOW) =>
  evaluateEligibility(o, RULES, now).reasons.map((r) => r.code);

describe("definition A — not collected (waiting_for_carrier, ≥ 2 days since packedAt)", () => {
  const a = (packedAt: string, over = {}) => order({ status: "waiting_for_carrier", packedAt, shippedAt: null, ...over });

  it("exact threshold: 2 calendar days → eligible, reason not_collected_by_carrier", () => {
    const e = evaluateEligibility(a("2026-10-31T23:59:59+01:00"), RULES, NOW);
    assert.equal(e.status, "eligible");
    assert.equal(e.definition, "A");
    assert.equal(e.complaintReason, "not_collected_by_carrier");
    assert.equal(e.daysInStatus, 2);
    assert.deepEqual(e.stateEntry, { field: "packedAt", value: "2026-10-31T23:59:59+01:00" });
  });

  it("threshold minus one day: 1 calendar day → ineligible", () => {
    const e = evaluateEligibility(a("2026-11-01T00:00:00+01:00"), RULES, NOW);
    assert.equal(e.status, "ineligible");
    assert.deepEqual(e.reasons.map((r) => r.code), ["THRESHOLD_NOT_REACHED"]);
  });

  it("excludes Interní přeprava", () => {
    assert.deepEqual(codes(a("2026-10-20T10:00:00+02:00", { shippingMethod: "Interní přeprava" })), ["EXCLUDED_SHIPPING_METHOD"]);
  });

  it("does NOT apply definition B exclusions (Parcelo DE is eligible under A)", () => {
    assert.equal(evaluateEligibility(a("2026-10-30T07:50:00+01:00", { shippingMethod: "Parcelo DE" }), RULES, NOW).status, "eligible");
  });

  it("DST: 24 Oct 23:30 CEST → 26 Oct 00:30 CET is 2 calendar days (≈26 h) → eligible", () => {
    assert.equal(evaluateEligibility(a("2026-10-24T23:30:00+02:00"), RULES, "2026-10-26T00:30:00+01:00").status, "eligible");
  });
});

describe("definition B — loss (carrier_picked_up, ≥ 14 days since shippedAt)", () => {
  const b = (shippedAt: string | null, over = {}) => order({ shippedAt, ...over });

  it("exact threshold: 14 calendar days → eligible, reason loss", () => {
    const e = evaluateEligibility(b("2026-10-19T23:59:59+02:00"), RULES, NOW);
    assert.equal(e.status, "eligible");
    assert.equal(e.definition, "B");
    assert.equal(e.complaintReason, "loss");
    assert.equal(e.daysInStatus, 14);
  });

  it("threshold minus one day: 13 → ineligible", () => {
    assert.deepEqual(codes(b("2026-10-20T00:00:00+02:00")), ["THRESHOLD_NOT_REACHED"]);
  });

  it("Prague timezone: 120125-style 00:30 CEST is 13 days whatever offset the instant is written in", () => {
    assert.equal(evaluateEligibility(b("2026-10-20T00:30:00+02:00"), RULES, NOW).daysInStatus, 13);
    assert.equal(evaluateEligibility(b("2026-10-19T22:30:00Z"), RULES, NOW).daysInStatus, 13);
    assert.equal(evaluateEligibility(b("2026-10-19T22:30:00Z"), RULES, NOW).status, "ineligible");
  });

  for (const m of ["Interní přeprava", "Parcelo DE", "Parcelo International", "Parcelo Return DE", "Marketplace Delivered"]) {
    it(`excludes ${m}`, () => assert.deepEqual(codes(b("2026-10-01T10:00:00+02:00", { shippingMethod: m })), ["EXCLUDED_SHIPPING_METHOD"]));
  }

  it("exclusion matches a Unicode-NFD spelling of the same method", () => {
    assert.deepEqual(codes(b("2026-10-01T10:00:00+02:00", { shippingMethod: "Interní přeprava".normalize("NFD") })), ["EXCLUDED_SHIPPING_METHOD"]);
  });

  it("a case-only variant of an excluded method is ambiguous → undetermined, never silently eligible", () => {
    const e = evaluateEligibility(b("2026-10-01T10:00:00+02:00", { shippingMethod: "parcelo de" }), RULES, NOW);
    assert.equal(e.status, "undetermined");
    assert.deepEqual(e.reasons.map((r) => r.code), ["AMBIGUOUS_SHIPPING_METHOD"]);
  });

  it("ignores updatedAt (recent updatedAt, old shippedAt → eligible)", () => {
    assert.equal(evaluateEligibility(b("2026-10-15T09:40:00+02:00", { updatedAt: "2026-11-01T18:22:00+01:00" }), RULES, NOW).daysInStatus, 18);
  });
});

describe("unsupported statuses and unusable timestamps", () => {
  for (const status of ["delivered", "returning"] as const) {
    it(`${status} → ineligible, NOT_A_CANDIDATE_STATUS`, () => {
      const e = evaluateEligibility(order({ status }), RULES, NOW);
      assert.equal(e.status, "ineligible");
      assert.equal(e.definition, null);
      assert.deepEqual(e.reasons.map((r) => r.code), ["NOT_A_CANDIDATE_STATUS"]);
    });
  }

  it("missing state timestamp → undetermined (review), not ineligible", () => {
    const e = evaluateEligibility(order({ shippedAt: null }), RULES, NOW);
    assert.equal(e.status, "undetermined");
    assert.deepEqual(e.reasons.map((r) => r.code), ["MISSING_TIMESTAMP"]);
  });

  it("invalid and future timestamps → undetermined", () => {
    assert.deepEqual(codes(order({ shippedAt: "garbage" })), ["INVALID_TIMESTAMP"]);
    assert.deepEqual(codes(order({ shippedAt: "2026-11-03T10:00:00+01:00" })), ["FUTURE_TIMESTAMP"]);
  });

  it("a definitive rule wins over uncertainty, but both stay visible", () => {
    const e = evaluateEligibility(order({ shippedAt: null, shippingMethod: "Parcelo DE" }), RULES, NOW);
    assert.equal(e.status, "ineligible");
    assert.deepEqual(e.reasons.map((r) => r.code), ["EXCLUDED_SHIPPING_METHOD", "MISSING_TIMESTAMP"]);
  });
});

describe("rules come from configuration", () => {
  it("changing minDaysInStatus in the rules object changes the outcome", () => {
    const strict = structuredClone(RULES);
    strict.definitions.B.minDaysInStatus = 30;
    assert.equal(evaluateEligibility(order(), strict, NOW).status, "ineligible");
    assert.equal(evaluateEligibility(order(), RULES, NOW).status, "eligible");
  });
});
