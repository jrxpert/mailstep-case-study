// Safety invariants of CREATE. Starting point: the synthetic example (examples/create), in which
// MS-EX-A-0001 (definition A) and MS-EX-B-0001 (definition B) reach CREATE through the real pipeline.
// Each invariant degrades one input on a temporary copy and runs loaders → classifier → decision engine.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXAMPLE_DIR, decideExample, editJson, type Mutation } from "../helpers.ts";

const A = "MS-EX-A-0001";
const B = "MS-EX-B-0001";
const action = (key: string, m: Mutation = () => {}) => decideExample(m).decisions.find((d) => d.key === key)?.execution.action ?? "missing";
const PAGE = (dir: string) => join(dir, "tracking", "PNEXB0001.html");
const HTML = readFileSync(join(EXAMPLE_DIR, "tracking", "PNEXB0001.html"), "utf8");
const idx = (key: string) => (key === A ? 0 : 1);

/** A monotone sweep: once an outcome leaves "create", it must never return to "create". */
function assertNeverReturnsToCreate(outcomes: string[], label: string) {
  assert.equal(outcomes[0], "create", `${label}: sweep must start from CREATE: ${outcomes.join(",")}`);
  const left = outcomes.findIndex((o) => o !== "create");
  assert.ok(left !== -1, `${label}: sweep never leaves CREATE, so it proves nothing: ${outcomes.join(",")}`);
  assert.ok(outcomes.slice(left).every((o) => o !== "create"), `${label}: ${outcomes.join(",")}`);
}

describe("safety invariants of CREATE (real pipeline on copies of the synthetic example)", () => {
  it("baseline: both unmodified example orders are CREATE", () => {
    assert.equal(action(A), "create");
    assert.equal(action(B), "create");
  });

  const cases: [string, (key: string) => Mutation][] = [
    ["1. adding a complaint (draft)", (k) => editJson("complaints.json", (c) => c.push({ ...c[0], complaintId: "x1", orderNumber: k, status: "draft" }))],
    ["1. adding a complaint (closed, other reason)", (k) => editJson("complaints.json", (c) => c.push({ ...c[0], complaintId: "x2", orderNumber: k, status: "closed", reason: "damaged" }))],
    ["2. adding a WMS return (Připraveno)", (k) => (d) => writeFileSync(join(d, "returns.json"), JSON.stringify([{ returnId: "r1", orderNumber: k, status: "Připraveno", createdAt: "2026-10-31T10:00:00+01:00" }]))],
    ["2. adding a WMS return (Zpracováno)", (k) => (d) => writeFileSync(join(d, "returns.json"), JSON.stringify([{ returnId: "r2", orderNumber: k, status: "Zpracováno", createdAt: "2026-10-31T10:00:00+01:00" }]))],
    ["3. removing the reporter matrix", () => (d) => rmSync(join(d, "reporters.csv"))],
    ["3. invalid reporter value", (k) => k === A
      ? (d) => writeFileSync(join(d, "reporters.csv"), "client,reporter\nVelký Klient s.r.o.,not an address\n")
      : editJson("complaints.json", (c) => { c[0].reporter = "not an address"; })],
    ["4. removing the order number", (k) => editJson("orders.json", (o) => { o[idx(k)].orderNumber = null; })],
    ["4. duplicating the order with a different client", (k) => editJson("orders.json", (o) => o.push({ ...o[idx(k)], orderId: "dup", client: "Jiný Klient" }))],
    ["4. a malformed return without an order number (batch gate)", () => (d) => writeFileSync(join(d, "returns.json"), JSON.stringify([{ returnId: "r?" }]))],
    ["5. updatedAt after the decision time", (k) => editJson("orders.json", (o) => { o[idx(k)].updatedAt = "2026-11-02T08:00:00+01:00"; })],
  ];
  for (const [label, mutate] of cases) {
    for (const key of [A, B]) {
      it(`${label} cannot enable CREATE (${key})`, () => assert.notEqual(action(key, mutate(key)), "create"));
    }
  }

  it("6. invalid tracking HTML cannot enable CREATE (definition B)", () => {
    assert.equal(action(B, (d) => writeFileSync(PAGE(d), HTML.replace("Zásilka zpracována</td></tr>", "Zásilka zpracována &#1114112;</td></tr>"))), "review");
  });

  it("7. definition A with a page showing carrier acceptance is not CREATE", () => {
    const toA = editJson("orders.json", (o) => Object.assign(o[1], { status: "waiting_for_carrier", packedAt: "2026-10-09T10:00:00+02:00", shippedAt: null }));
    assert.equal(action(B, toA), "review");
  });

  it("8. moving the last carrier event later never re-enables CREATE (12. 10. … 5. 11.)", () => {
    const days = ["12. 10.", "20. 10.", "31. 10.", "1. 11.", "2. 11.", "3. 11.", "4. 11.", "5. 11."];
    const outcomes = days.map((day) => action(B, (d) => writeFileSync(PAGE(d), HTML.replace("<td>12. 10. 2026</td>", `<td>${day} 2026</td>`))));
    assertNeverReturnsToCreate(outcomes, "last event");
    assert.deepEqual(outcomes, ["create", "create", "create", "create", "create", "review", "review", "review"]);
  });

  it("9. moving shippedAt later never re-enables CREATE (events before shipment, then window not reached)", () => {
    const days = Array.from({ length: 16 }, (_, i) => 9 + i); // 9. 10. … 24. 10.
    const outcomes = days.map((day) => action(B, editJson("orders.json", (o) => { o[1].shippedAt = `2026-10-${String(day).padStart(2, "0")}T15:20:00+02:00`; o[1].updatedAt = o[1].shippedAt; })));
    assertNeverReturnsToCreate(outcomes, "shippedAt");
  });

  it("10. moving packedAt later never re-enables CREATE (2-day window)", () => {
    const stamps = ["2026-10-29T10:00:00+01:00", "2026-10-30T23:59:00+01:00", "2026-10-31T00:00:00+01:00", "2026-11-01T10:00:00+01:00", "2026-11-02T07:00:00+01:00"];
    const outcomes = stamps.map((t) => action(A, editJson("orders.json", (o) => { o[0].packedAt = t; o[0].updatedAt = t; })));
    assert.deepEqual(outcomes, ["create", "create", "create", "skip", "skip"]);
  });

  it("11. the process time zone does not change any decision", () => {
    const original = process.env.TZ;
    const outputs = new Set<string>();
    try {
      for (const tz of ["UTC", "Europe/Prague", "America/Los_Angeles", "Asia/Kathmandu", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        outputs.add(JSON.stringify(decideExample()));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.equal(outputs.size, 1);
  });
});
