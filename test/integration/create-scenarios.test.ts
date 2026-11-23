// CREATE-A / CREATE-B and their negative variants through the real CLI (node src/cli.ts), on a
// temporary copy of examples/create (SYNTHETIC). Same loaders, rules and decision engine as the
// baseline run; no special flag. Each case changes one thing and asserts action + reason codes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLE = join(ROOT, "examples", "create");
const A = "MS-EX-A-0001";
const B = "MS-EX-B-0001";
type Mutation = (dir: string) => void;

function run(...mutations: Mutation[]): Map<string, any> {
  const dir = mkdtempSync(join(tmpdir(), "mailstep-create-"));
  try {
    cpSync(EXAMPLE, dir, { recursive: true });
    for (const m of mutations) m(dir);
    const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.ts"), "--data", dir, "--out", join(dir, "_out"), "--skip-eval"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(join(dir, "_out", "decisions.json"), "utf8"));
    return new Map(report.decisions.map((d: any) => [d.key, d]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const codes = (d: any): string[] => d.execution.reasons.map((r: any) => r.code);
const blocking = (d: any): string[] => d.execution.reasons.filter((r: any) => r.effect !== "info").map((r: any) => r.code);
const editJson = (file: string, fn: (v: any) => void): Mutation => (dir) => {
  const p = join(dir, file);
  const v = JSON.parse(readFileSync(p, "utf8"));
  fn(v);
  writeFileSync(p, JSON.stringify(v));
};
const idx = (key: string) => (key === A ? 0 : 1);
const editOrder = (key: string, fields: Record<string, unknown>) => editJson("orders.json", (o) => Object.assign(o[idx(key)], fields));
const addComplaint = (key: string, status: string) => editJson("complaints.json", (c) => c.push({
  complaintId: `c-${key}`, orderNumber: key, client: key === A ? "Velký Klient s.r.o." : "Malý Klient s.r.o.",
  status, reason: "loss", reporter: "someone@example.test", createdAt: "2026-10-31T10:00:00+01:00",
}));
const addReturn = (key: string, status: string) => editJson("returns.json", (r) => r.push({ returnId: `r-${key}`, orderNumber: key, status, createdAt: "2026-10-31T10:00:00+01:00" }));

const row = (date: string, time: string, place: string, text: string) => `<tr><td>${date}</td><td>${time}</td><td>${place}</td><td>${text}</td></tr>`;
const PICKUP = row("09. 10. 2026", "15:20", "Odesílatel", "Zásilka převzata od odesílatele");
const SORTED = row("12. 10. 2026", "04:37", "Třídicí centrum Brno", "Zásilka zpracována");
/** Replaces the event rows of a ParcelNord page (newest first) and optionally its tracking number. */
const pnPage = (file: string, rows: string[], pageNumber?: string): Mutation => (dir) => {
  const base = readFileSync(join(EXAMPLE, "tracking", "PNEXB0001.html"), "utf8").replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>${rows.join("")}</tbody>`);
  writeFileSync(join(dir, "tracking", `${file}.html`), base.replaceAll("PNEXB0001", pageNumber ?? file));
};
const bPage = (rows: string[], pageNumber?: string) => pnPage("PNEXB0001", rows, pageNumber);

describe("CREATE-A: waiting_for_carrier ≥ 2 Prague days, complete and consistent data", () => {
  const d = run().get(A);
  it("CREATE, definition A, complaint reason not_collected_by_carrier", () => {
    assert.equal(d.execution.action, "create");
    assert.equal(d.eligibility.status, "eligible");
    assert.equal(d.eligibility.definition, "A");
    assert.equal(d.eligibility.complaintReason, "not_collected_by_carrier");
    assert.equal(d.eligibility.daysInStatus, 4);
  });
  it("large client → reporter from the matrix; no blocking reason", () => {
    assert.deepEqual(d.reporter, { status: "resolved", reporter: "reklamace@velky-klient.example", source: "matrix", evidence: "reporters.csv line 2" });
    assert.deepEqual(blocking(d), []);
    assert.deepEqual(codes(d), ["BUSINESS_ELIGIBLE", "REPORTER_RESOLVED", "TRACKING_NOT_REQUIRED"]);
  });
  it("absence of carrier pickup does not block: no shippedAt and no tracking page", () => {
    assert.equal(d.tracking.status, "unavailable");
    assert.equal(d.tracking.reason, "NO_TRACKING_PAGE");
  });
});

describe("CREATE-B: carrier_picked_up ≥ 14 Prague days, dated in-transit tracking", () => {
  const d = run().get(B);
  it("CREATE, definition B, complaint reason loss", () => {
    assert.equal(d.execution.action, "create");
    assert.equal(d.eligibility.definition, "B");
    assert.equal(d.eligibility.complaintReason, "loss");
    assert.equal(d.eligibility.daysInStatus, 24);
  });
  it("non-large client → last reporter from history; tracking IN_TRANSIT with a consistent date", () => {
    assert.equal(d.reporter.status, "resolved");
    assert.equal(d.reporter.source, "history");
    assert.equal(d.reporter.reporter, "reklamace@maly-klient.example");
    assert.equal(d.tracking.classification.state, "IN_TRANSIT");
    assert.equal(d.tracking.classification.activity, "UNDETERMINED");
    assert.deepEqual(codes(d), ["BUSINESS_ELIGIBLE", "REPORTER_RESOLVED", "TRACKING_IN_TRANSIT"]);
  });
});

describe("negative variants for both definitions", () => {
  const cases: [string, (key: string) => Mutation[], "skip" | "review", (key: string) => string][] = [
    ["existing open complaint", (k) => [addComplaint(k, "open")], "skip", () => "EXISTING_COMPLAINT"],
    ["draft complaint", (k) => [addComplaint(k, "draft")], "skip", () => "EXISTING_COMPLAINT"],
    ["existing WMS return", (k) => [addReturn(k, "Přijato")], "skip", () => "EXISTING_RETURN"],
    ["WMS return in status Připraveno", (k) => [addReturn(k, "Připraveno")], "skip", () => "EXISTING_RETURN"],
    ["no reporter (valid matrix without the client, no history)", (k) => [
      (dir) => writeFileSync(join(dir, "reporters.csv"), "client,reporter\nJiný Klient,x@jiny.example\n"),
      editJson("complaints.json", (c) => c.splice(0)),
    ], "review", () => "REPORTER_NOT_FOUND"],
    ["reporter matrix missing", () => [(dir) => unlinkSync(join(dir, "reporters.csv"))], "review", () => "REPORTER_MATRIX_UNAVAILABLE"],
    ["conflicting identity (same orderNumber, different client)", (k) => [
      editJson("orders.json", (o) => o.push({ ...o[idx(k)], orderId: "00000000-0000-4000-8000-0000000000ff", client: "Jiný Klient" })),
    ], "review", () => "CONFLICTING_DUPLICATE"],
    ["tracking number shared with another order", (k) => [
      editJson("orders.json", (o) => o.push({ ...o[idx(k)], orderId: "00000000-0000-4000-8000-0000000000fe", orderNumber: "MS-EX-X-0001" })),
    ], "review", () => "TRACKING_UNAVAILABLE"],
    ["tracking number shared with another order in different letter case", (k) => [
      editJson("orders.json", (o) => o.push({ ...o[idx(k)], orderId: "00000000-0000-4000-8000-0000000000fd", orderNumber: "MS-EX-X-0002", trackingNumber: o[idx(k)].trackingNumber.toLowerCase() })),
    ], "review", () => "TRACKING_UNAVAILABLE"],
    ["tracking number shared with another order with surrounding spaces", (k) => [
      editJson("orders.json", (o) => o.push({ ...o[idx(k)], orderId: "00000000-0000-4000-8000-0000000000fc", orderNumber: "MS-EX-X-0003", trackingNumber: ` ${o[idx(k)].trackingNumber} ` })),
    ], "review", () => "TRACKING_UNAVAILABLE"],
    ["invalid state-entry timestamp", (k) => [editOrder(k, { [k === A ? "packedAt" : "shippedAt"]: "2026-10-32T10:00:00+01:00" })], "review", () => "INVALID_RECORD"],
    ["future state-entry timestamp", (k) => [editOrder(k, { [k === A ? "packedAt" : "shippedAt"]: "2026-11-03T10:00:00+01:00" })], "review", () => "FUTURE_TIMESTAMP"],
    ["updatedAt after the decision time", (k) => [editOrder(k, { updatedAt: "2026-11-02T09:00:00+01:00" })], "review", () => "INVALID_TIMESTAMP"],
    ["missing state-entry timestamp", (k) => [editOrder(k, { [k === A ? "packedAt" : "shippedAt"]: null })], "review", () => "MISSING_TIMESTAMP"],
    ["missing order number", (k) => [editOrder(k, { orderNumber: null })], "review", () => "INVALID_ORDER_IDENTITY"],
  ];
  for (const key of [A, B]) {
    for (const [label, mutations, action, code] of cases) {
      it(`${key === A ? "A" : "B"}: ${label} → ${action.toUpperCase()} (${code(key)})`, () => {
        const ds = run(...mutations(key));
        const d = ds.get(key) ?? [...ds.values()].find((x) => x.orderIds.includes(key === A ? "00000000-0000-4000-8000-0000000000a1" : "00000000-0000-4000-8000-0000000000b1"));
        assert.ok(d, "decision not found");
        assert.equal(d.execution.action, action);
        assert.ok(codes(d).includes(code(key)), `${code(key)} missing in ${codes(d).join(", ")}`);
        assert.notEqual(d.execution.action, "create");
      });
    }
  }
});

describe("definition B: tracking negatives", () => {
  const cases: [string, Mutation[], "skip" | "review", string][] = [
    ["no tracking page", [(dir) => unlinkSync(join(dir, "tracking", "PNEXB0001.html"))], "review", "TRACKING_UNAVAILABLE"],
    ["DELIVERED (dated after shipment)", [bPage([row("30. 10. 2026", "11:00", "Brno", "Doručeno příjemci, podepsal: J. Novák"), SORTED, PICKUP])], "skip", "TRACKING_DELIVERED"],
    ["RETURNING (dated after shipment)", [bPage([row("30. 10. 2026", "11:00", "Brno", "Zásilka vrácena odesílateli."), SORTED, PICKUP])], "skip", "TRACKING_RETURNING"],
    ["UNKNOWN (unrecognised latest event)", [bPage([row("30. 10. 2026", "11:00", "Brno", "Zásilka poškozena"), SORTED, PICKUP])], "review", "TRACKING_UNKNOWN"],
    ["contradictory history (earlier delivery, later sorting scan)", [bPage([row("20. 10. 2026", "11:00", "Třídicí centrum Brno", "Zásilka zpracována"), row("15. 10. 2026", "11:00", "Brno", "Doručeno příjemci"), PICKUP])], "review", "TRACKING_UNKNOWN"],
    ["page of another shipment", [bPage([SORTED, PICKUP], "PNEXB0002")], "review", "TRACKING_UNKNOWN"],
    ["active last mile (waiting at a pickup point)", [bPage([row("13. 10. 2026", "09:00", "Box Brno", "Zásilka je připravena k vyzvednutí."), SORTED, PICKUP])], "review", "TRACKING_ACTIVE_DELIVERY"],
    ["delivery dated before the shipment", [bPage([row("05. 10. 2026", "11:00", "Brno", "Doručeno příjemci"), row("01. 10. 2026", "10:00", "Odesílatel", "Zásilka převzata od odesílatele")])], "review", "TRACKING_TIME_INCONSISTENT"],
    ["return dated before the shipment", [bPage([row("08. 10. 2026", "23:59", "Brno", "Zásilka vrácena odesílateli.")])], "review", "TRACKING_TIME_INCONSISTENT"],
    ["delivery dated after the decision day", [bPage([row("03. 11. 2026", "08:00", "Brno", "Doručeno příjemci"), SORTED, PICKUP])], "review", "TRACKING_TIME_INCONSISTENT"],
    ["in-transit history entirely before the shipment", [bPage([row("05. 10. 2026", "04:37", "Třídicí centrum Brno", "Zásilka zpracována"), row("04. 10. 2026", "15:20", "Odesílatel", "Zásilka převzata od odesílatele")])], "review", "TRACKING_TIME_INCONSISTENT"],
    ["in-transit event after the decision day", [bPage([row("03. 11. 2026", "04:37", "Třídicí centrum Brno", "Zásilka zpracována"), PICKUP])], "review", "TRACKING_TIME_INCONSISTENT"],
  ];
  for (const [label, mutations, action, code] of cases) {
    it(`${label} → ${action.toUpperCase()} (${code})`, () => {
      const d = run(...mutations).get(B);
      assert.equal(d.execution.action, action);
      assert.ok(codes(d).includes(code), `${code} missing in ${codes(d).join(", ")}`);
    });
  }
  it("a delivery on the shipment day itself is consistent → SKIP (calendar-day precision)", () => {
    const d = run(bPage([row("09. 10. 2026", "20:00", "Brno", "Doručeno příjemci"), PICKUP])).get(B);
    assert.equal(d.execution.action, "skip");
    assert.ok(codes(d).includes("TRACKING_DELIVERED"));
  });
});

describe("definition A: tracking is evidence, not a precondition", () => {
  const onParcelNord = editOrder(A, { carrier: "ParcelNord", shippingMethod: "ParcelNord Home", trackingNumber: "PNEXA0001" });
  it("ParcelNord order without a saved page → still CREATE", () => {
    const d = run(onParcelNord).get(A);
    assert.equal(d.execution.action, "create");
    assert.deepEqual(blocking(d), []);
  });
  it("page shows the parcel in the carrier network → REVIEW (contradicts not_collected_by_carrier)", () => {
    const d = run(onParcelNord, pnPage("PNEXA0001", [row("31. 10. 2026", "04:37", "Třídicí centrum Brno", "Zásilka zpracována"), row("30. 10. 2026", "15:20", "Odesílatel", "Zásilka převzata od odesílatele")])).get(A);
    assert.equal(d.execution.action, "review");
    assert.deepEqual(blocking(d), ["TRACKING_CONTRADICTS_COMPLAINT_REASON"]);
  });
  it("delivery dated after packing → SKIP; delivery dated before packing → REVIEW", () => {
    const ok = run(onParcelNord, pnPage("PNEXA0001", [row("31. 10. 2026", "10:00", "Brno", "Doručeno příjemci")])).get(A);
    assert.equal(ok.execution.action, "skip");
    assert.ok(codes(ok).includes("TRACKING_DELIVERED"));
    const early = run(onParcelNord, pnPage("PNEXA0001", [row("28. 10. 2026", "10:00", "Brno", "Doručeno příjemci")])).get(A);
    assert.equal(early.execution.action, "review");
    assert.deepEqual(blocking(early), ["TRACKING_TIME_INCONSISTENT"]);
  });
  it("waiting_for_carrier with a shippedAt is contradictory → REVIEW (INVALID_TIMESTAMP)", () => {
    const d = run(editOrder(A, { shippedAt: "2026-10-30T10:00:00+01:00" })).get(A);
    assert.equal(d.execution.action, "review");
    assert.deepEqual(blocking(d), ["INVALID_TIMESTAMP"]);
  });
  it("an unusable tracking number blocks definition A as well", () => {
    const d = run(editOrder(A, { trackingNumber: "KV EXA/1" })).get(A);
    assert.equal(d.execution.action, "review");
    assert.deepEqual(blocking(d), ["TRACKING_UNAVAILABLE"]);
  });
});

describe("tracking numbers differing only in letter case are one shared parcel, whatever the file system", () => {
  const caseVariant = editJson("orders.json", (o) => o.push({ ...o[1], orderId: "00000000-0000-4000-8000-0000000000fb", orderNumber: "MS-EX-B-0002", trackingNumber: "pnexb0001" }));
  // On a case-sensitive file system only PNEXB0001.html exists for the variant; a second file named
  // pnexb0001.html reproduces what a case-insensitive file system would serve to the variant order.
  const variantPage = (dir: string) => cpSync(join(dir, "tracking", "PNEXB0001.html"), join(dir, "tracking", "pnexb0001.html"));
  for (const [label, mutations] of [["only the exact-case page file", [caseVariant]], ["a page file for each spelling", [caseVariant, variantPage]]] as [string, Mutation[]][]) {
    it(`${label}: both orders → REVIEW (AMBIGUOUS_PAGE_MAPPING), never CREATE`, () => {
      const ds = run(...mutations);
      for (const key of [B, "MS-EX-B-0002"]) {
        const d = ds.get(key);
        assert.equal(d.execution.action, "review", key);
        assert.deepEqual(blocking(d), ["TRACKING_UNAVAILABLE"], key);
        assert.match(d.tracking.reason, /^AMBIGUOUS_PAGE_MAPPING$/, key);
      }
      assert.equal(ds.get(A).execution.action, "create");
    });
  }
});
