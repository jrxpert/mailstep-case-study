import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  REFERENCE_NOW,
  calendarDaysInPrague,
  parseIsoInstant,
  pragueDate,
  stateEntryTimestamp,
} from "../../src/time/pragueDays.ts";

/** Days or throws — keeps the expected-value assertions short. */
function days(entry: string, now: string = REFERENCE_NOW): number {
  const r = calendarDaysInPrague(entry, now);
  if (!r.ok) throw new Error(`unexpected ${r.error}: ${r.detail}`);
  return r.days;
}

describe("parseIsoInstant", () => {
  it("parses offsets and Z to the same instant", () => {
    assert.equal(parseIsoInstant("2026-11-02T07:30:00+01:00"), Date.UTC(2026, 10, 2, 6, 30));
    assert.equal(parseIsoInstant("2026-11-02T06:30:00Z"), Date.UTC(2026, 10, 2, 6, 30));
    assert.equal(parseIsoInstant("2026-10-20T00:30:00+02:00"), Date.UTC(2026, 9, 19, 22, 30));
    assert.equal(parseIsoInstant("2026-10-20T00:30+02:00"), Date.UTC(2026, 9, 19, 22, 30));
    assert.equal(parseIsoInstant("2026-10-20T00:30:00.250+02:00"), Date.UTC(2026, 9, 19, 22, 30, 0, 250));
  });

  for (const bad of [
    "2026-02-29T10:00:00+01:00", // 2026 is not a leap year
    "2026-10-32T10:00:00+01:00",
    "2026-13-01T10:00:00+01:00",
    "2026-10-20T24:00:00+02:00",
    "2026-10-20T10:60:00+02:00",
    "2026-10-20T10:00:00", // no offset → ambiguous
    "2026-10-20 10:00:00+02:00",
    "2026-10-20",
    "not a date",
    "",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(parseIsoInstant(bad), null));
  }
});

describe("pragueDate", () => {
  it("uses the Prague calendar date, not the UTC date", () => {
    // 22:30 UTC on 19 Oct is 00:30 CEST on 20 Oct.
    assert.equal(pragueDate(Date.UTC(2026, 9, 19, 22, 30)), "2026-10-20");
    // 23:30 UTC on 31 Oct is 00:30 CET on 1 Nov (after DST end).
    assert.equal(pragueDate(Date.UTC(2026, 9, 31, 23, 30)), "2026-11-01");
    assert.equal(pragueDate(Date.UTC(2026, 9, 31, 22, 59)), "2026-10-31");
  });

  it("reference run instant is 2 Nov 2026 in Prague", () => {
    assert.equal(pragueDate(parseIsoInstant(REFERENCE_NOW) ?? NaN), "2026-11-02");
  });

  it("does not depend on the process timezone", () => {
    const original = process.env.TZ;
    const sample = Date.UTC(2026, 9, 19, 22, 30);
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata"]) {
        process.env.TZ = tz;
        assert.equal(pragueDate(sample), "2026-10-20", `TZ=${tz}`);
        assert.equal(days("2026-10-20T00:30:00+02:00"), 13, `TZ=${tz}`);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("calendarDaysInPrague — calendar days, not 24 h intervals", () => {
  it("Monday → Wednesday is 2 days regardless of hour (order-states.md example)", () => {
    // 26 Oct 2026 is a Monday, 28 Oct a Wednesday.
    assert.equal(days("2026-10-26T00:01:00+01:00", "2026-10-28T23:59:00+01:00"), 2);
    assert.equal(days("2026-10-26T23:59:00+01:00", "2026-10-28T00:01:00+01:00"), 2); // ~24 h elapsed
  });

  it("same Prague date is 0 days; one minute after midnight is 1", () => {
    assert.equal(days("2026-11-02T00:00:00+01:00"), 0);
    assert.equal(days("2026-11-01T23:59:00+01:00", "2026-11-02T00:01:00+01:00"), 1);
  });

  it("same instant is 0 days, whatever offset it is written with", () => {
    assert.equal(days("2026-11-02T06:30:00Z"), 0);
    assert.equal(days(REFERENCE_NOW), 0);
  });

  it("entry written in UTC is converted to the Prague date", () => {
    // 23:30Z on 31 Oct is already 1 Nov in Prague → 1 day, not 2.
    assert.equal(days("2026-10-31T23:30:00Z"), 1);
    assert.equal(days("2026-10-31T22:30:00Z"), 2);
  });
});

describe("calendarDaysInPrague — October 2026 DST transition (25 Oct, 03:00 CEST → 02:00 CET)", () => {
  it("counts days across the transition by date", () => {
    // 49 elapsed hours, 2 calendar days.
    assert.equal(days("2026-10-24T12:00:00+02:00", "2026-10-26T12:00:00+01:00"), 2);
    // 25 Oct has 25 hours: 00:30 CEST → 23:30 CET is 24 h elapsed but the same date.
    assert.equal(days("2026-10-25T00:30:00+02:00", "2026-10-25T23:30:00+01:00"), 0);
  });

  it("both occurrences of the repeated 02:30 hour fall on 25 Oct", () => {
    assert.equal(pragueDate(parseIsoInstant("2026-10-25T02:30:00+02:00") ?? NaN), "2026-10-25");
    assert.equal(pragueDate(parseIsoInstant("2026-10-25T02:30:00+01:00") ?? NaN), "2026-10-25");
  });

  it("a CEST entry counted against the CET reference", () => {
    assert.equal(days("2026-10-19T00:00:00+02:00"), 14);
    assert.equal(days("2026-10-19T23:59:59+02:00"), 14);
    assert.equal(days("2026-10-20T00:00:00+02:00"), 13);
  });

  it("March 2026 DST start (29 Mar) is also counted by date", () => {
    assert.equal(days("2026-03-28T23:30:00+01:00", "2026-03-30T00:30:00+02:00"), 2);
  });
});

describe("thresholds from rules.yaml (date math only; eligibility comes later)", () => {
  it("Definition A boundary: 2 calendar days", () => {
    assert.equal(days("2026-10-31T23:59:59+01:00"), 2); // packed late Saturday → eligible by date
    assert.equal(days("2026-11-01T00:00:00+01:00"), 1); // packed at Sunday midnight → not yet
    assert.ok(days("2026-10-31T23:59:59+01:00") >= 2);
    assert.ok(days("2026-11-01T00:00:00+01:00") < 2);
  });

  it("Definition B boundary: 14 calendar days", () => {
    assert.equal(days("2026-10-19T23:59:59+02:00"), 14);
    assert.equal(days("2026-10-20T00:00:00+02:00"), 13);
  });
});

describe("calendarDaysInPrague — invalid inputs", () => {
  it("missing timestamp", () => {
    for (const v of [null, undefined]) {
      const r = calendarDaysInPrague(v, REFERENCE_NOW);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error, "MISSING_TIMESTAMP");
    }
  });

  it("invalid timestamp", () => {
    for (const v of ["", "2026-10-20T10:00:00", "2026-02-30T10:00:00+01:00", "yesterday"]) {
      const r = calendarDaysInPrague(v, REFERENCE_NOW);
      assert.equal(!r.ok && r.error, "INVALID_TIMESTAMP", v);
    }
  });

  it("future timestamp is an error, never a negative count", () => {
    const r = calendarDaysInPrague("2026-11-02T07:30:01+01:00", REFERENCE_NOW);
    assert.equal(!r.ok && r.error, "FUTURE_TIMESTAMP");
    const r2 = calendarDaysInPrague("2026-11-05T10:00:00+01:00", REFERENCE_NOW);
    assert.equal(!r2.ok && r2.error, "FUTURE_TIMESTAMP");
  });

  it("invalid reference timestamp", () => {
    const r = calendarDaysInPrague("2026-10-20T10:00:00+02:00", "2026-11-02 07:30");
    assert.equal(!r.ok && r.error, "INVALID_REFERENCE_TIMESTAMP");
  });
});

describe("stateEntryTimestamp", () => {
  const base = { packedAt: "2026-10-28T08:15:00+01:00", shippedAt: "2026-10-29T09:00:00+01:00" };

  it("waiting_for_carrier uses packedAt", () => {
    assert.deepEqual(stateEntryTimestamp({ ...base, status: "waiting_for_carrier" }), { field: "packedAt", value: base.packedAt });
  });

  it("carrier_picked_up uses shippedAt", () => {
    assert.deepEqual(stateEntryTimestamp({ ...base, status: "carrier_picked_up" }), { field: "shippedAt", value: base.shippedAt });
  });

  it("other statuses have no entry timestamp", () => {
    assert.equal(stateEntryTimestamp({ ...base, status: "delivered" }), null);
    assert.equal(stateEntryTimestamp({ ...base, status: "returning" }), null);
  });

  it("passes a null entry through (→ MISSING_TIMESTAMP downstream)", () => {
    assert.deepEqual(stateEntryTimestamp({ status: "carrier_picked_up", packedAt: base.packedAt, shippedAt: null }), { field: "shippedAt", value: null });
  });
});

describe("fixture orders (data/orders.json)", () => {
  interface RawOrder {
    orderNumber: string | null;
    status: "waiting_for_carrier" | "carrier_picked_up" | "delivered" | "returning";
    packedAt: string | null;
    shippedAt: string | null;
    updatedAt: string;
  }
  const orders = JSON.parse(readFileSync(new URL("../../data/orders.json", import.meta.url), "utf8")) as RawOrder[];

  const daysFor = (o: RawOrder): number | null => {
    const entry = stateEntryTimestamp(o);
    return entry === null ? null : days(entry.value ?? "missing");
  };
  const find = (num: string): RawOrder => {
    const o = orders.find((x) => x.orderNumber === num);
    assert.ok(o, `fixture ${num} not found`);
    return o;
  };

  it("120125: shipped 00:30 CEST on 20 Oct = 13 days in Prague (would be 14 by UTC date)", () => {
    const o = find("MS-2026-120125");
    assert.equal(o.shippedAt, "2026-10-20T00:30:00+02:00");
    assert.equal(new Date(parseIsoInstant(o.shippedAt) ?? NaN).toISOString().slice(0, 10), "2026-10-19"); // the UTC trap
    assert.equal(daysFor(o), 13);
  });

  it("120007: packed 23:40 on 31 Oct = 2 days although only ~32 h elapsed", () => {
    assert.equal(daysFor(find("MS-2026-120007")), 2);
  });

  it("120101: 14 days although only 13 d 22 h elapsed", () => {
    assert.equal(daysFor(find("MS-2026-120101")), 14);
  });

  it("updatedAt is ignored (120004, 120006, 120105, 120118 have recent updatedAt)", () => {
    assert.equal(daysFor(find("MS-2026-120004")), 5);
    assert.equal(daysFor(find("MS-2026-120006")), 3);
    assert.equal(daysFor(find("MS-2026-120105")), 14);
    assert.equal(daysFor(find("MS-2026-120118")), 18);
  });

  it("all fixture records match the derived day table", () => {
    // Provenance (DERIVED): table produced by a throwaway script using the same
    // Intl/Europe/Prague approach, so it is NOT independent of the implementation. Independent
    // checks are the explicit boundary tests above (120125, 120007, 120101, DST) and manual
    // date arithmetic of daytime entries (e.g. 1 Oct → 2 Nov = 32). null = not a watched status.
    const expected: Array<[string | null, number | null]> = [
      ["MS-2026-120001", 2], ["MS-2026-120002", 1], ["MS-2026-120003", 13], ["MS-2026-120004", 5],
      ["MS-2026-120005", 4], ["MS-2026-120006", 3], ["MS-2026-120007", 2], ["MS-2026-120008", 3],
      ["MS-2026-120101", 14], ["MS-2026-120102", 13], ["MS-2026-120103", 32], ["MS-2026-120104", 28],
      ["MS-2026-120105", 14], ["MS-2026-120106", null], ["MS-2026-120107", null], ["MS-2026-120108", 21],
      ["MS-2026-120109", 19], ["MS-2026-120110", 20], ["MS-2026-120111", 18], ["MS-2026-120112", 17],
      ["MS-2026-120101", 14], ["MS-2026-120113", 22], ["MS-2026-120114", 24], ["MS-2026-120115", 20],
      ["MS-2026-120116", 16], ["MS-2026-120117", 27], ["MS-2026-120118", 18], ["MS-2026-120120", 30],
      [null, 23], ["MS-2026-120122", 30], ["MS-2026-120123", 16], ["MS-2026-120124", 15],
      ["MS-2026-120125", 13],
    ];
    assert.equal(orders.length, expected.length);
    orders.forEach((o, i) => {
      const [num, d] = expected[i] ?? [];
      assert.equal(o.orderNumber, num, `record ${i}`);
      assert.equal(daysFor(o), d, `record ${i} (${num})`);
    });
  });
});
