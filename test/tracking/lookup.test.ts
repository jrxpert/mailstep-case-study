import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pageTrackingProvider } from "../../src/tracking/lookup.ts";
import { DATA_DIR, order } from "../helpers.ts";

const TRACKING = join(DATA_DIR, "tracking");

describe("pageTrackingProvider (tracking availability)", () => {
  const provider = pageTrackingProvider(TRACKING, []);
  const status = (o: ReturnType<typeof order>) => {
    const t = provider(o);
    return t.status === "unavailable" ? t.reason : t.status === "classified" ? `classified:${t.classification.state}` : t.status;
  };

  it("no tracking number", () => assert.equal(status(order({ trackingNumber: null })), "NO_TRACKING_NUMBER"));
  it("unsafe tracking number (path traversal) is rejected", () => assert.equal(status(order({ trackingNumber: "../orders" })), "INVALID_TRACKING_NUMBER"));
  it("unsupported carrier", () => assert.equal(status(order({ carrier: "Parcelo", trackingNumber: "PD40080104" })), "UNSUPPORTED_CARRIER"));
  it("no saved page", () => assert.equal(status(order({ trackingNumber: "KV2026100109" })), "NO_TRACKING_PAGE"));

  it("page found and classified from its content (stale Mailship status irrelevant)", () => {
    assert.equal(status(order({ carrier: "Kurýr Vltava", trackingNumber: "KV2026100105", status: "carrier_picked_up" })), "classified:DELIVERED");
  });

  it("order without carrier but with a page: classified, with a warning", () => {
    const t = provider(order({ carrier: null, trackingNumber: "PN55100116" }));
    assert.equal(t.status, "classified");
    assert.ok(t.status === "classified" && t.classification.warnings.some((w) => /no carrier/.test(w)));
  });

  it("tracking number shared by two different orders → ambiguous, not guessed", () => {
    const p = pageTrackingProvider(TRACKING, [order({ orderNumber: "MS-A", trackingNumber: "KV2026100105" }), order({ orderNumber: "MS-B", trackingNumber: "KV2026100105" })]);
    const t = p(order({ orderNumber: "MS-A", trackingNumber: "KV2026100105" }));
    assert.equal(t.status === "unavailable" && t.reason, "AMBIGUOUS_PAGE_MAPPING");
  });

  describe("shared tracking number detection ignores letter case and surrounding spaces", () => {
    const reasonOf = (t: ReturnType<ReturnType<typeof pageTrackingProvider>>) => (t.status === "unavailable" ? t.reason : t.status);
    const variants: [string, string][] = [
      ["exact match", "KV2026100105"],
      ["different letter case", "kv2026100105"],
      ["surrounding spaces", " KV2026100105 "],
      ["letter case and spaces", "\tkV2026100105 "],
    ];
    for (const [label, other] of variants) {
      it(`${label}: the order with the existing page is AMBIGUOUS_PAGE_MAPPING, never classified`, () => {
        const mine = order({ orderNumber: "MS-A", carrier: "Kurýr Vltava", trackingNumber: "KV2026100105" });
        const p = pageTrackingProvider(TRACKING, [mine, order({ orderNumber: "MS-B", carrier: "Kurýr Vltava", trackingNumber: other })]);
        assert.equal(reasonOf(p(mine)), "AMBIGUOUS_PAGE_MAPPING");
      });
    }
    it("the case-variant order is ambiguous too, before any file lookup", () => {
      const p = pageTrackingProvider(TRACKING, [order({ orderNumber: "MS-A", trackingNumber: "KV2026100105" }), order({ orderNumber: "MS-B", trackingNumber: "kv2026100105" })]);
      assert.equal(reasonOf(p(order({ orderNumber: "MS-B", trackingNumber: "kv2026100105" }))), "AMBIGUOUS_PAGE_MAPPING");
    });
    it("different tracking numbers are not ambiguous", () => {
      const mine = order({ orderNumber: "MS-A", carrier: "Kurýr Vltava", trackingNumber: "KV2026100105" });
      const p = pageTrackingProvider(TRACKING, [mine, order({ orderNumber: "MS-B", trackingNumber: "KV2026100106" })]);
      assert.equal(reasonOf(p(mine)), "classified");
    });
  });

  it("identical duplicate rows of one order are not ambiguous", () => {
    const o = order({ orderNumber: "MS-A", carrier: "Kurýr Vltava", trackingNumber: "KV2026100105" });
    assert.equal(pageTrackingProvider(TRACKING, [o, { ...o }])(o).status, "classified");
  });

  describe("unreadable page", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailstep-lookup-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    it("→ UNREADABLE_PAGE", () => {
      mkdirSync(join(dir, "KV1.html")); // a directory where a file is expected
      const t = pageTrackingProvider(dir, [])(order({ trackingNumber: "KV1" }));
      assert.equal(t.status === "unavailable" && t.reason, "UNREADABLE_PAGE");
    });
  });
});
