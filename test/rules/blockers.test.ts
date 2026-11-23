import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Complaint, Return } from "../../src/domain/types.ts";
import { checkBlockers, findUnlinkedRecords } from "../../src/rules/blockers.ts";
import { coll, complaint, ret } from "../helpers.ts";

const none = coll<Return>([]);
const noComplaints = coll<Complaint>([]);
const codes = (rs: ReturnType<typeof checkBlockers>) => rs.map((r) => r.code);

describe("existing complaints block, whatever their status or reason", () => {
  for (const [status, reason] of [["draft", "not_collected_by_carrier"], ["open", "loss"], ["closed", "loss"], ["closed", "damaged"]] as const) {
    it(`${status} complaint with reason ${reason} → EXISTING_COMPLAINT (skip) with evidence`, () => {
      const rs = checkBlockers("MS-T-1", "Client One", coll([complaint({ orderNumber: "MS-T-1", status, reason, complaintId: "c-9" })], [], "complaints.json"), none);
      assert.deepEqual(codes(rs), ["EXISTING_COMPLAINT"]);
      assert.equal(rs[0]?.effect, "skip");
      assert.deepEqual(rs[0]?.evidence, ["complaints.json#0 (c-9)"]);
    });
  }

  it("same orderNumber but another client → ambiguous identity → review", () => {
    const rs = checkBlockers("MS-T-1", "Client One", coll([complaint({ orderNumber: "MS-T-1", client: "Other" })]), none);
    assert.deepEqual(codes(rs), ["POTENTIAL_BLOCKING_RECORD"]);
    assert.equal(rs[0]?.effect, "review");
  });

  it("orderNumber differing only in case/spacing → review, not a confirmed match", () => {
    assert.deepEqual(codes(checkBlockers("MS-T-1", "Client One", coll([complaint({ orderNumber: " ms-t-1" })]), none)), ["POTENTIAL_BLOCKING_RECORD"]);
  });

  it("unrelated complaints do not block", () => {
    assert.deepEqual(checkBlockers("MS-T-1", "Client One", coll([complaint()]), none), []);
  });
});

describe("WMS returns block in any status", () => {
  for (const status of ["Připraveno", "Přijato", "Zpracováno", "Storno"]) {
    it(`return in "${status}" → EXISTING_RETURN (skip)`, () => {
      const rs = checkBlockers("MS-T-1", "Client One", noComplaints, coll([ret({ status, returnId: "r-7" })], [], "returns.json"));
      assert.deepEqual(codes(rs), ["EXISTING_RETURN"]);
      assert.deepEqual(rs[0]?.evidence, ["returns.json#0 (r-7)"]);
    });
  }
});

describe("malformed complaint / return records are never ignored", () => {
  it("malformed complaint linked by orderNumber → POTENTIAL_BLOCKING_RECORD", () => {
    const c = coll<Complaint>([], [{ raw: { orderNumber: "MS-T-1", status: "cancelled" }, errors: ['field "status" has unknown value'] }], "complaints.json");
    const rs = checkBlockers("MS-T-1", "Client One", c, none);
    assert.deepEqual(codes(rs), ["POTENTIAL_BLOCKING_RECORD"]);
    assert.deepEqual(rs[0]?.evidence, ["complaints.json#0"]);
    assert.deepEqual(findUnlinkedRecords(c, none), []);
  });

  it("malformed return linked by orderNumber → POTENTIAL_BLOCKING_RECORD", () => {
    const r = coll<Return>([], [{ raw: { orderNumber: "MS-T-1", createdAt: "31. 10. 2026" } }]);
    assert.deepEqual(codes(checkBlockers("MS-T-1", null, noComplaints, r)), ["POTENTIAL_BLOCKING_RECORD"]);
  });

  it("malformed record for another order does not touch this one", () => {
    const r = coll<Return>([], [{ raw: { orderNumber: "MS-OTHER" } }]);
    assert.deepEqual(checkBlockers("MS-T-1", null, noComplaints, r), []);
  });

  it("malformed record without a usable orderNumber → dataset-level finding (not a per-order match)", () => {
    const c = coll<Complaint>([], [{ raw: { client: "Client One", orderNumber: null } }], "complaints.json");
    const r = coll<Return>([], [{ raw: "garbage" }], "returns.json");
    assert.deepEqual(checkBlockers("MS-T-1", "Client One", c, r), []);
    const f = findUnlinkedRecords(c, r);
    assert.deepEqual(f.map((x) => [x.code, x.source, x.index]), [["UNLINKED_INVALID_RECORD", "complaints.json", 0], ["UNLINKED_INVALID_RECORD", "returns.json", 0]]);
  });
});
