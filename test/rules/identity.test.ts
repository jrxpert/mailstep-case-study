import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupOrders } from "../../src/rules/identity.ts";
import { coll, order } from "../helpers.ts";

const summary = (gs: ReturnType<typeof groupOrders>) => gs.map((g) => [g.key, g.kind, g.rows.map((r) => r.index)]);

describe("groupOrders", () => {
  it("single and identical duplicate: one group, every row referenced", () => {
    const o = order();
    const gs = groupOrders(coll([o, order({ orderNumber: "MS-T-2", orderId: "id-2" }), { ...o }]));
    assert.deepEqual(summary(gs), [["MS-T-1", "identical_duplicate", [0, 2]], ["MS-T-2", "single", [1]]]);
    assert.equal(gs[0]?.order?.orderNumber, "MS-T-1");
  });

  it("conflicting duplicate: no row is picked, differing fields are named", () => {
    const gs = groupOrders(coll([order(), order({ status: "delivered", updatedAt: "2026-11-01T10:00:00+01:00" })]));
    assert.equal(gs[0]?.kind, "conflicting_duplicate");
    assert.equal(gs[0]?.order, null);
    assert.deepEqual(gs[0]?.conflictingFields, ["status", "updatedAt"]);
  });

  it("missing or unusable orderNumber → one invalid_identity group per row (never merged)", () => {
    const gs = groupOrders(coll([order({ orderNumber: null }), order({ orderNumber: null, orderId: "id-2" }), order({ orderNumber: " MS-T-1", orderId: "id-3" })]));
    assert.deepEqual(summary(gs), [["row:0", "invalid_identity", [0]], ["row:1", "invalid_identity", [1]], ["row:2", "invalid_identity", [2]]]);
  });

  it("malformed row with a usable orderNumber joins its group as invalid_record", () => {
    const gs = groupOrders(coll([order()], [{ raw: { orderNumber: "MS-T-1", status: "lost" } }]));
    assert.deepEqual(summary(gs), [["MS-T-1", "invalid_record", [0, 1]]]);
    assert.equal(gs[0]?.order, null);
  });

  it("malformed row without orderNumber gets its own group", () => {
    const gs = groupOrders(coll([order()], [{ raw: "not an object" }]));
    assert.deepEqual(summary(gs), [["MS-T-1", "single", [0]], ["row:1", "invalid_identity", [1]]]);
    assert.equal(gs[1]?.rows[0]?.order, null);
  });

  it("orderId shared by two different orderNumbers is flagged on both", () => {
    const gs = groupOrders(coll([order(), order({ orderNumber: "MS-T-2" })]));
    assert.deepEqual(gs.map((g) => g.orderIdCollisions), [["MS-T-2"], ["MS-T-1"]]);
  });

  it("no row is lost and order is deterministic regardless of input order", () => {
    const rows = [order({ orderNumber: "B", orderId: "b" }), order({ orderNumber: null, orderId: "n" }), order({ orderNumber: "A", orderId: "a" })];
    const gs = groupOrders(coll(rows));
    assert.deepEqual(gs.flatMap((g) => g.rows.map((r) => r.index)).sort(), [0, 1, 2]);
    assert.deepEqual(gs.map((g) => g.key), ["A", "B", "row:1"]);
  });
});
