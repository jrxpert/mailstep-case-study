import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyTrackingPage } from "../../src/tracking/classify.ts";
import { DATA_DIR } from "../helpers.ts";

const page = (file: string) => readFileSync(join(DATA_DIR, "tracking", file), "utf8");
const classify = (file: string, ctx = {}) => classifyTrackingPage(page(file), ctx);

describe("fixture pages: expected results established by reading the HTML (not labels.csv)", () => {
  // [file, state, activity, carrier detected from the page]
  const table: [string, string, string | null, string][] = [
    ["DT9100112.html", "UNKNOWN", null, "Doručto"], // colour-only step indicator
    ["DT9100124.html", "UNKNOWN", null, "Doručto"],
    ["DT9100197.html", "UNKNOWN", null, "Doručto"],
    ["DT9100198.html", "UNKNOWN", null, "Doručto"],
    ["EX7710113.html", "UNKNOWN", null, "Expedo"], // "Zásilku jsme nenašli"
    ["EX7710117.html", "DELIVERED", null, "Expedo"], // "Doručeno" + "předána příjemci"
    ["EX7710194.html", "IN_TRANSIT", "UNDETERMINED", "Expedo"], // "Na cestě"
    ["EX7710195.html", "RETURNING", null, "Expedo"], // "Vrací se odesílateli"
    ["EX7710196.html", "IN_TRANSIT", "UNDETERMINED", "Expedo"], // "Převzato dopravcem"
    ["KV2026100101.html", "IN_TRANSIT", "UNDETERMINED", "Kurýr Vltava"], // "na cestě k vám", no date
    ["KV2026100105.html", "DELIVERED", null, "Kurýr Vltava"], // "doručena příjemci"
    ["KV2026100115.html", "UNKNOWN", null, "Kurýr Vltava"], // neighbour
    ["KV2026100118.html", "IN_TRANSIT", "ACTIVE", "Kurýr Vltava"], // failed attempt, depot
    ["KV2026100123.html", "IN_TRANSIT", "ACTIVE", "Kurýr Vltava"], // out for delivery
    ["KV2026100190.html", "RETURNING", null, "Kurýr Vltava"],
    ["PN55100114.html", "IN_TRANSIT", "UNDETERMINED", "ParcelNord"], // last scan 12 Oct
    ["PN55100116.html", "IN_TRANSIT", "ACTIVE", "ParcelNord"], // waiting in pickup box
    ["PN55100191.html", "DELIVERED", null, "ParcelNord"], // collected by recipient
    ["PN55100192.html", "RETURNING", null, "ParcelNord"],
    ["PN55100193.html", "DELIVERED", null, "ParcelNord"], // delivered to recipient, signed
  ];
  for (const [file, state, activity, carrier] of table) {
    it(`${file} → ${state}${activity ? `/${activity}` : ""}`, () => {
      const c = classify(file);
      assert.equal(c.state, state);
      assert.equal(c.activity, activity);
      assert.equal(c.evidence.carrier, carrier);
      assert.ok(c.reason.length > 0, "every prediction carries a reason");
      assert.equal(c.reliable, state !== "UNKNOWN");
    });
  }
});

describe("mandatory safeguards", () => {
  it("Expedo: state comes from the status card, not the cookie banner or ads", () => {
    const c = classify("EX7710117.html");
    assert.equal(c.evidence.source, ".status-card .value");
    assert.equal(c.evidence.statusText, "Doručeno");
    // Banner, hero ad and FAQ still say "Doručeno…", but the card says in transit → IN_TRANSIT.
    const moved = page("EX7710117.html").replace('<strong class="value">Doručeno</strong>', '<strong class="value">Na cestě</strong>');
    assert.equal(classifyTrackingPage(moved.replace("Zásilka byla předána příjemci.", "Zásilka opustila třídicí centrum Brno.")).state, "IN_TRANSIT");
    // 'Na cestě' with a card text saying it was handed to the recipient is contradictory → UNKNOWN.
    assert.match(classifyTrackingPage(moved).reason, /not a recognised transit message/);
    // Without a status card, banner text alone never yields DELIVERED.
    const noCard = page("EX7710117.html").replace(/<div class="status-card">[\s\S]*?<\/div>/, "");
    assert.equal(classifyTrackingPage(noCard).state, "UNKNOWN");
  });

  it("Expedo: 'Doručeno' without recipient confirmation is UNKNOWN", () => {
    const html = page("EX7710117.html").replace("Zásilka byla předána příjemci.", "Zásilka byla uložena.");
    assert.equal(classifyTrackingPage(html).state, "UNKNOWN");
  });

  it("Doručto: never classified from colour; changing the colours changes nothing", () => {
    const c = classify("DT9100124.html");
    assert.equal(c.state, "UNKNOWN");
    assert.match(c.reason, /SVG fill colour/);
    assert.ok(c.warnings.some((w) => w.includes('visually highlighted step: "Doručeno"') && w.includes("not used")));
    const recoloured = page("DT9100124.html").replaceAll("#00a86b", "#d0d4d9").replace('cx="40" cy="30" r="14" fill="#d0d4d9"', 'cx="40" cy="30" r="14" fill="#00a86b"');
    assert.equal(classifyTrackingPage(recoloured).state, "UNKNOWN");
  });

  it("neighbour handover is UNKNOWN, with the evidence preserved", () => {
    const c = classify("KV2026100115.html");
    assert.equal(c.state, "UNKNOWN");
    assert.match(c.reason, /soused \(Novák\)/);
    assert.match(c.evidence.statusText ?? "", /Převzal: soused/);
    assert.equal(c.evidence.eventTime?.local, "2026-10-28T10:41");
    assert.ok(c.warnings.some((w) => /third party/.test(w)));
  });

  it("delivery evidence is read from the page, independent of any Mailship status", () => {
    // 120105 and 120117 are carrier_picked_up in orders.json; the classifier has no status input at all.
    assert.equal(classify("KV2026100105.html").state, "DELIVERED");
    assert.equal(classify("EX7710117.html").state, "DELIVERED");
    assert.equal(classify("KV2026100105.html").evidence.eventTime?.local, "2026-10-30T13:12");
  });

  it("active delivery signals: pickup box, failed attempt, out for delivery", () => {
    assert.match(classify("PN55100116.html").reason, /pickup point/);
    assert.match(classify("KV2026100118.html").reason, /failed delivery attempt/);
    assert.match(classify("KV2026100123.html").reason, /out for delivery/);
  });

  it("stale last scan is IN_TRANSIT/UNDETERMINED, never STAGNANT (no retrieval time)", () => {
    const c = classify("PN55100114.html");
    assert.equal(c.activity, "UNDETERMINED");
    assert.equal(c.evidence.eventTime?.local, "2026-10-12T04:37");
    assert.deepEqual(c.freshness, { retrievedAt: null, established: false });
  });
});

describe("timestamps and freshness", () => {
  it("missing event timestamps are reported as unavailable, not invented", () => {
    for (const f of ["KV2026100101.html", "EX7710113.html", "DT9100112.html"]) {
      const c = classify(f);
      assert.equal(c.evidence.eventTime, null, f);
      assert.ok(c.warnings.some((w) => /no carrier event timestamp|freshness/.test(w)), f);
    }
  });

  it("Doručto 'Aktualizováno' is reported as a page update time, not an event", () => {
    assert.ok(classify("DT9100112.html").warnings.some((w) => /Aktualizováno 20\. 10\. 2026 08:12.*not a dated carrier event/.test(w)));
  });

  it("freshness is never asserted, even when a retrieval time is supplied", () => {
    const c = classify("PN55100114.html", { retrievedAt: "2026-11-02T07:00:00+01:00" });
    assert.deepEqual(c.freshness, { retrievedAt: "2026-11-02T07:00:00+01:00", established: false });
    assert.equal(c.activity, "UNDETERMINED");
  });
});

describe("robustness", () => {
  it("unsupported carrier page → UNKNOWN", () => {
    const c = classifyTrackingPage("<html><head><title>Parcelo – tracking</title></head><body>Delivered</body></html>");
    assert.equal(c.state, "UNKNOWN");
    assert.match(c.reason, /carrier not recognised/);
  });

  it("malformed / empty HTML → UNKNOWN", () => {
    for (const html of ["", "<html><title>Expedo | x", page("PN55100191.html").slice(0, 600), "<<<>>>"]) {
      assert.equal(classifyTrackingPage(html).state, "UNKNOWN", JSON.stringify(html.slice(0, 40)));
    }
  });

  it("contradictory Kurýr Vltava page (delivered message, partial progress) → UNKNOWN", () => {
    const html = page("KV2026100105.html").replace("width:100%", "width:66%");
    const c = classifyTrackingPage(html);
    assert.equal(c.state, "UNKNOWN");
    assert.match(c.reason, /contradictory/);
  });

  it("contradictory ParcelNord history (earlier delivery, later sorting scan) → UNKNOWN", () => {
    const html = page("PN55100193.html").replace(
      "<tbody>",
      "<tbody><tr><td>27. 10. 2026</td><td>08:00</td><td>Třídicí centrum Praha</td><td>Zásilka zpracována</td></tr>",
    );
    assert.equal(classifyTrackingPage(html).state, "UNKNOWN");
  });

  it("ParcelNord latest event is chosen by date, not by row position", () => {
    const html = page("PN55100191.html").replace(/<tbody>([\s\S]*?)<\/tbody>/, (_m, rows: string) => {
      const trs = rows.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
      return `<tbody>${[...trs].reverse().join("")}</tbody>`;
    });
    const c = classifyTrackingPage(html);
    assert.equal(c.state, "DELIVERED");
    assert.ok(c.warnings.some((w) => /not listed newest first/.test(w)));
  });

  it("not keyed to tracking numbers: renaming the parcel does not change the result", () => {
    for (const [file, tn] of [["KV2026100105.html", "KV2026100105"], ["PN55100116.html", "PN55100116"], ["EX7710195.html", "EX7710195"]] as const) {
      const renamed = page(file).replaceAll(tn, "ZZ123456789");
      const a = classifyTrackingPage(page(file));
      const b = classifyTrackingPage(renamed);
      assert.equal(b.state, a.state, file);
      assert.equal(b.evidence.pageTrackingNumber, "ZZ123456789");
    }
  });

  it("cross-checks against the order: wrong carrier or wrong tracking number → UNKNOWN", () => {
    assert.match(classify("KV2026100105.html", { declaredCarrier: "Expedo" }).reason, /ships with Expedo/);
    assert.match(classify("KV2026100105.html", { expectedTrackingNumber: "KV0000000000" }).reason, /expected KV0000000000/);
    const noCarrier = classify("KV2026100105.html", { declaredCarrier: null, expectedTrackingNumber: "KV2026100105" });
    assert.equal(noCarrier.state, "DELIVERED");
    assert.ok(noCarrier.warnings.some((w) => /order has no carrier/.test(w)));
  });

  it("deterministic", () => {
    assert.deepEqual(classify("PN55100116.html"), classify("PN55100116.html"));
  });
});
