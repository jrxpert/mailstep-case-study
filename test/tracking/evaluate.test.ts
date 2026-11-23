import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TrackingClassification, TrackingState } from "../../src/domain/types.ts";
import { categorize, evaluate, renderMarkdown, runTrackingEvaluation } from "../../src/tracking/evaluate.ts";
import { DATA_DIR, classified } from "../helpers.ts";

const cls = (state: TrackingState): TrackingClassification => ({
  state, activity: null, reliable: state !== "UNKNOWN", reason: "synthetic",
  evidence: { carrier: null, pageTrackingNumber: null, source: null, statusText: null, eventText: null, eventTime: null },
  freshness: { retrievedAt: null, established: false }, warnings: [],
});

describe("error categories (consequence for complaint automation)", () => {
  const table: [TrackingState, TrackingState, string | null][] = [
    ["DELIVERED", "DELIVERED", null],
    ["DELIVERED", "IN_TRANSIT", "CRITICAL"], // could let an unjustified complaint through
    ["RETURNING", "IN_TRANSIT", "CRITICAL"],
    ["IN_TRANSIT", "DELIVERED", "CRITICAL"], // suppresses a possibly justified complaint
    ["UNKNOWN", "DELIVERED", "CRITICAL"], // e.g. neighbour handover read as delivered
    ["UNKNOWN", "IN_TRANSIT", "FALSE_CERTAINTY"],
    ["DELIVERED", "UNKNOWN", "CONSERVATIVE_ABSTENTION"],
    ["IN_TRANSIT", "UNKNOWN", "CONSERVATIVE_ABSTENTION"],
    ["DELIVERED", "RETURNING", "OTHER"],
  ];
  for (const [e, p, cat] of table) it(`${e} → ${p}: ${cat}`, () => assert.equal(categorize(e, p), cat));
});

describe("metrics", () => {
  it("zero denominators are undefined (null), not invented", () => {
    const r = evaluate([{ file: "a", expected: "DELIVERED", note: "", classification: cls("UNKNOWN") }]);
    assert.equal(r.perClass["DELIVERED"]?.precision, null); // nothing predicted DELIVERED
    assert.equal(r.perClass["DELIVERED"]?.recall, 0);
    assert.equal(r.perClass["RETURNING"]?.recall, null); // no RETURNING support
    assert.equal(r.accuracyOnDefinitePredictions, null);
    assert.equal(r.unknownRate, 1);
  });

  it("UNKNOWN predictions stay in the accuracy denominator", () => {
    const r = evaluate([
      { file: "a", expected: "DELIVERED", note: "", classification: cls("DELIVERED") },
      { file: "b", expected: "IN_TRANSIT", note: "", classification: cls("UNKNOWN") },
    ]);
    assert.equal(r.accuracy, 0.5);
    assert.equal(r.accuracyOnDefinitePredictions, 1);
    assert.equal(r.coverage, 0.5);
  });
});

describe("evaluation on the 20 supplied pages", () => {
  const r = runTrackingEvaluation(join(DATA_DIR, "tracking"));

  it("evaluates every page", () => {
    assert.equal(r.pagesFound, 20);
    assert.equal(r.total, 20);
    assert.deepEqual(r.unlabeledPages, []);
  });

  it("headline metrics", () => {
    assert.equal(r.correct, 16);
    assert.equal(r.accuracy, 0.8);
    assert.equal(r.unknownRate, 0.3);
    assert.equal(r.coverage, 0.7);
    assert.equal(r.accuracyOnDefinitePredictions, 1);
  });

  it("confusion matrix", () => {
    assert.deepEqual(r.confusion, {
      DELIVERED: { DELIVERED: 4, IN_TRANSIT: 0, RETURNING: 0, UNKNOWN: 1 },
      IN_TRANSIT: { DELIVERED: 0, IN_TRANSIT: 7, RETURNING: 0, UNKNOWN: 2 },
      RETURNING: { DELIVERED: 0, IN_TRANSIT: 0, RETURNING: 3, UNKNOWN: 1 },
      UNKNOWN: { DELIVERED: 0, IN_TRANSIT: 0, RETURNING: 0, UNKNOWN: 2 },
    });
  });

  it("per-class precision / recall", () => {
    const pr = Object.fromEntries(Object.entries(r.perClass).map(([k, v]) => [k, [v.precision, v.recall]]));
    assert.deepEqual(pr, { DELIVERED: [1, 0.8], IN_TRANSIT: [1, 0.7778], RETURNING: [1, 0.75], UNKNOWN: [0.3333, 1] });
  });

  it("every error is a conservative abstention on a Doručto page; nothing critical", () => {
    assert.deepEqual(r.errorsByCategory, { CRITICAL: 0, FALSE_CERTAINTY: 0, CONSERVATIVE_ABSTENTION: 4, OTHER: 0 });
    assert.deepEqual(r.errors.map((e) => [e.file, e.expected, e.predicted, e.decisionImpact]), [
      ["DT9100112.html", "IN_TRANSIT", "UNKNOWN", "create (B) or review → review"],
      ["DT9100124.html", "DELIVERED", "UNKNOWN", "skip → review"],
      ["DT9100197.html", "IN_TRANSIT", "UNKNOWN", "create (B) or review → review"],
      ["DT9100198.html", "RETURNING", "UNKNOWN", "skip → review"],
    ]);
    assert.equal(r.decisionImpact.skipInsteadOfReview, 0);
    assert.equal(r.decisionImpact.reviewInsteadOfSkip, 2);
    assert.equal(r.decisionImpact.wrongCreatePossible, 0);
  });

  it("a dated IN_TRANSIT prediction for a delivered parcel is CRITICAL and counted as a possible wrong create", () => {
    const transit = (event: string | null) => { const t = classified("IN_TRANSIT", { event }); return t.status === "classified" ? t.classification : assert.fail(); };
    const x = evaluate([
      { file: "a.html", expected: "DELIVERED", note: "", classification: transit("2026-10-20") },
      { file: "b.html", expected: "DELIVERED", note: "", classification: transit(null) },
      { file: "c.html", expected: "IN_TRANSIT", note: "", classification: transit("2026-10-20") },
    ]);
    assert.equal(x.errorsByCategory.CRITICAL, 2);
    assert.equal(x.decisionImpact.wrongCreatePossible, 1);
  });

  it("every prediction has an evidence record", () => {
    for (const c of r.cases) {
      assert.ok(c.reason.length > 0, c.file);
      assert.ok(c.evidence.carrier !== null, c.file);
      assert.ok(c.evidence.statusText !== null || c.warnings.length > 0, c.file);
    }
  });

  it("is deterministic (JSON and markdown)", () => {
    const again = runTrackingEvaluation(join(DATA_DIR, "tracking"));
    assert.equal(JSON.stringify(again), JSON.stringify(r));
    assert.equal(renderMarkdown(again), renderMarkdown(r));
  });
});
