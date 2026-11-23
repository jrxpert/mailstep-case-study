import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../../src/io/csv.ts";
import {
  InputError,
  loadComplaints,
  loadInputs,
  loadOrders,
  loadReporterMatrix,
  loadReturns,
  loadRules,
  loadTrackingLabels,
} from "../../src/io/load.ts";

const DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "mailstep-load-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
function tmpFile(name: string, content: string): string {
  const dir = join(scratch, String(counter++));
  mkdirSync(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const validOrder = {
  orderId: "o-1",
  orderNumber: "MS-1",
  client: "Client",
  carrier: "Carrier",
  shippingMethod: "Method",
  trackingNumber: "T1",
  trackingUrl: null,
  status: "carrier_picked_up",
  createdAt: "2026-10-01T10:00:00+02:00",
  packedAt: "2026-10-02T10:00:00+02:00",
  shippedAt: "2026-10-03T10:00:00+02:00",
  updatedAt: "2026-10-03T10:00:00+02:00",
};

describe("fixtures in data/", () => {
  it("load without invalid records and with the expected counts", () => {
    const inputs = loadInputs(DATA_DIR);
    assert.equal(inputs.orders.valid.length, 33);
    assert.equal(inputs.orders.invalid.length, 0);
    assert.equal(inputs.complaints.valid.length, 9);
    assert.equal(inputs.complaints.invalid.length, 0);
    assert.equal(inputs.returns.valid.length, 3);
    assert.equal(inputs.returns.invalid.length, 0);
    assert.ok(!("trackingLabels" in inputs), "ground-truth labels must not be part of runtime inputs");
    const labels = loadTrackingLabels(join(DATA_DIR, "tracking", "labels.csv"), join(DATA_DIR, "tracking"));
    assert.equal(labels.valid.length, 20);
    assert.equal(labels.invalid.length, 0);
    assert.deepEqual(labels.warnings, []);
  });

  it("rules match rules.yaml", () => {
    const { A, B } = loadRules(join(DATA_DIR, "rules.yaml")).definitions;
    assert.equal(A.status, "waiting_for_carrier");
    assert.equal(A.minDaysInStatus, 2);
    assert.equal(A.complaintReason, "not_collected_by_carrier");
    assert.deepEqual(A.excludedShippingMethods, ["Interní přeprava"]);
    assert.equal(B.status, "carrier_picked_up");
    assert.equal(B.minDaysInStatus, 14);
    assert.equal(B.complaintReason, "loss");
    assert.deepEqual(B.excludedShippingMethods, [
      "Interní přeprava",
      "Parcelo DE",
      "Parcelo International",
      "Parcelo Return DE",
      "Marketplace Delivered",
    ]);
  });

  it("reporters.csv is reported as missing, not as an empty mapping", () => {
    const m = loadInputs(DATA_DIR).reporterMatrix;
    assert.equal(m.status, "missing");
    assert.ok(!("rows" in m));
  });

  it("keeps the null orderNumber record and the duplicate 120101 rows (no silent dedupe)", () => {
    const orders = loadInputs(DATA_DIR).orders.valid;
    assert.equal(orders.filter((o) => o.record.orderNumber === null).length, 1);
    assert.equal(orders.filter((o) => o.record.orderNumber === "MS-2026-120101").length, 2);
  });

  it("labels keep quoted notes containing commas", () => {
    const labels = loadTrackingLabels(join(DATA_DIR, "tracking", "labels.csv"), join(DATA_DIR, "tracking")).valid.map((l) => l.record);
    const pn116 = labels.find((l) => l.trackingNumber === "PN55100116");
    assert.equal(pn116?.note, "čeká na výdejním místě, příjemce ji nevyzvedl");
    assert.equal(pn116?.expectedState, "IN_TRANSIT");
  });

  it("does not modify fixture files", () => {
    const hashAll = (): string => {
      const h = createHash("sha256");
      for (const dir of [DATA_DIR, join(DATA_DIR, "tracking")]) {
        for (const f of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()) {
          h.update(f).update(readFileSync(join(dir, f)));
        }
      }
      return h.digest("hex");
    };
    const before = hashAll();
    loadInputs(DATA_DIR);
    assert.equal(hashAll(), before);
  });
});

describe("JSON collections: malformed records are kept, not dropped", () => {
  it("reports every problem of a bad order with its index and raw source", () => {
    const bad = { ...validOrder, orderId: 42, status: "lost", shippedAt: "2026-10-03 10:00", trackingNumber: "" } as Record<string, unknown>;
    delete bad["client"];
    const path = tmpFile("orders.json", JSON.stringify([validOrder, bad, "oops"]));
    const c = loadOrders(path);
    assert.equal(c.valid.length, 1);
    assert.equal(c.invalid.length, 2);
    const [first, second] = c.invalid;
    assert.equal(first?.index, 1);
    assert.deepEqual(first?.raw, bad);
    const msg = first?.errors.join("\n") ?? "";
    assert.match(msg, /"orderId" must be a string, got number/);
    assert.match(msg, /"client" is missing/);
    assert.match(msg, /"status" has unknown value "lost"/);
    assert.match(msg, /"shippedAt" is not an ISO 8601 timestamp/);
    assert.match(msg, /"trackingNumber" is an empty string \(use null/);
    assert.equal(second?.index, 2);
    assert.match(second?.errors[0] ?? "", /record must be an object, got string/);
  });

  it("distinguishes an absent key from an explicit null", () => {
    const noPacked = { ...validOrder } as Record<string, unknown>;
    delete noPacked["packedAt"];
    const c = loadOrders(tmpFile("orders.json", JSON.stringify([{ ...validOrder, packedAt: null }, noPacked])));
    assert.equal(c.valid.length, 1);
    assert.equal(c.valid[0]?.record.packedAt, null);
    assert.match(c.invalid[0]?.errors[0] ?? "", /"packedAt" is missing/);
  });

  it("preserves unmodelled source fields in raw", () => {
    const c = loadOrders(tmpFile("orders.json", JSON.stringify([{ ...validOrder, extra: "kept" }])));
    assert.equal((c.valid[0]?.raw as Record<string, unknown>)["extra"], "kept");
    assert.ok(!("extra" in (c.valid[0]?.record ?? {})));
  });

  it("validates complaint status and return fields", () => {
    const complaints = loadComplaints(
      tmpFile("c.json", JSON.stringify([{ complaintId: "c", orderNumber: "MS-1", client: "X", status: "pending", reason: "loss", reporter: "r@x", createdAt: "2026-10-01T10:00:00+02:00" }])),
    );
    assert.match(complaints.invalid[0]?.errors[0] ?? "", /"status" has unknown value "pending"; expected one of: draft, open, closed/);
    const returns = loadReturns(tmpFile("r.json", JSON.stringify([{ returnId: "r", orderNumber: null, status: "Připraveno", createdAt: "2026-10-01T10:00:00+02:00" }])));
    assert.match(returns.invalid[0]?.errors[0] ?? "", /"orderNumber" must be a string, got null/);
  });
});

describe("mandatory inputs: fatal, actionable errors", () => {
  it("missing file", () => {
    assert.throws(() => loadOrders(join(scratch, "nope.json")), (e: unknown) => e instanceof InputError && /nope\.json: required input file not found/.test(e.message));
  });

  it("invalid JSON", () => {
    assert.throws(() => loadOrders(tmpFile("orders.json", "[{")), /invalid JSON/);
  });

  it("non-array JSON", () => {
    assert.throws(() => loadComplaints(tmpFile("c.json", '{"a":1}')), /expected a JSON array at top level, got object/);
  });

  it("rules: reports all problems at once", () => {
    const yaml = [
      "definitions:",
      "  A:",
      "    name: a",
      "    status: waiting",
      "    minDaysInStatus: -1",
      "    complaintReason: x",
      "    excludedShippingMethods: Interní přeprava",
      "  C:",
      "    name: c",
    ].join("\n");
    assert.throws(
      () => loadRules(tmpFile("rules.yaml", yaml)),
      (e: unknown) =>
        e instanceof InputError &&
        /unexpected definitions: C/.test(e.message) &&
        /definition A: field "status" has unknown value "waiting"/.test(e.message) &&
        /definition A: field "minDaysInStatus" must be a non-negative integer/.test(e.message) &&
        /definition A: field "excludedShippingMethods" must be a list/.test(e.message) &&
        /definition B is missing/.test(e.message),
    );
  });

  it("rules: two definitions for the same status are rejected", () => {
    const def = (n: string) => [`  ${n}:`, "    name: x", "    status: carrier_picked_up", "    minDaysInStatus: 1", "    complaintReason: loss", "    excludedShippingMethods: []"];
    const yaml = ["definitions:", ...def("A"), ...def("B")].join("\n");
    assert.throws(() => loadRules(tmpFile("rules.yaml", yaml)), /both apply to status "carrier_picked_up"/);
  });

  it("rules: invalid YAML", () => {
    assert.throws(() => loadRules(tmpFile("rules.yaml", "definitions: [unclosed")), /invalid YAML/);
  });
});

describe("tracking labels", () => {
  function labelsFixture(csv: string, pages: string[]): { path: string; dir: string } {
    const path = tmpFile("labels.csv", csv);
    const dir = join(path, "..");
    for (const p of pages) writeFileSync(join(dir, p), "<html></html>");
    return { path, dir };
  }

  it("flags unknown state, missing page, name mismatch, duplicates; warns on unlabeled pages", () => {
    const { path, dir } = labelsFixture(
      [
        "file,carrier,tracking_number,expected_state,note",
        "A1.html,X,A1,DELIVERED,",
        "A2.html,X,A2,LOST,",
        "A3.html,X,A3,IN_TRANSIT,",
        "A4.html,X,WRONG,UNKNOWN,",
        "A1.html,X,A1,DELIVERED,",
      ].join("\n"),
      ["A1.html", "A2.html", "A4.html", "EXTRA.html"],
    );
    const c = loadTrackingLabels(path, dir);
    assert.equal(c.valid.length, 1);
    const errs = c.invalid.map((i) => i.errors.join("; "));
    assert.match(errs[0] ?? "", /line 3: "expected_state" "LOST"/);
    assert.match(errs[1] ?? "", /line 4: tracking page .*A3\.html does not exist/);
    assert.match(errs[2] ?? "", /line 5: file "A4\.html" does not match tracking number "WRONG"/);
    assert.match(errs[3] ?? "", /line 6: duplicate label for "A1\.html"/);
    assert.deepEqual(c.warnings, ["tracking pages without a label: EXTRA.html"]);
  });

  it("rejects an unexpected header", () => {
    const { path, dir } = labelsFixture("file,state\nA.html,DELIVERED\n", []);
    assert.throws(() => loadTrackingLabels(path, dir), /unexpected header/);
  });
});

describe("reporter matrix (optional input)", () => {
  it("missing file → status missing", () => {
    assert.deepEqual(loadReporterMatrix(join(scratch, "reporters.csv")), { status: "missing", path: join(scratch, "reporters.csv") });
  });

  it("present file → raw rows keyed by its own header (no assumed schema)", () => {
    const m = loadReporterMatrix(tmpFile("reporters.csv", "client,reporter\nBig Co,ops@big.example\n"));
    assert.equal(m.status, "available");
    assert.ok(m.status === "available");
    assert.deepEqual(m.columns, ["client", "reporter"]);
    assert.deepEqual(m.rows, [{ client: "Big Co", reporter: "ops@big.example" }]);
  });

  it("present but malformed → fatal", () => {
    assert.throws(() => loadReporterMatrix(tmpFile("reporters.csv", "client,reporter\nonly-one\n")), /line 2: expected 2 columns, got 1/);
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF, BOM and trailing newline", () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  });

  it("keeps empty trailing fields", () => {
    assert.deepEqual(parseCsv("a,b,\n"), [["a", "b", ""]]);
  });

  it("rejects an unterminated quote", () => {
    assert.throws(() => parseCsv('a,"b\n'), /unterminated/);
  });
});
