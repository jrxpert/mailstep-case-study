import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Complaint } from "../../src/domain/types.ts";
import { loadComplaints } from "../../src/io/load.ts";
import { parseReporterMatrix, resolveReporter } from "../../src/rules/reporter.ts";
import { DATA_DIR, MISSING_MATRIX, coll, complaint, matrix } from "../helpers.ts";

// All matrices below are SYNTHETIC_TEST data; no real client is classified as large anywhere.
const history = coll([
  complaint({ complaintId: "old", reporter: "old@client-one.example", createdAt: "2026-10-30T00:30:00+01:00" }),
  // 23:45Z on 29 Oct = 00:45 CET on 30 Oct → later than "old" despite the earlier-looking date.
  complaint({ complaintId: "new", reporter: "new@client-one.example", createdAt: "2026-10-29T23:45:00Z" }),
  complaint({ complaintId: "x", client: "Other", reporter: "x@other.example", createdAt: "2026-11-01T10:00:00+01:00" }),
], [], "complaints.json");
const resolve = (client: string, m = MISSING_MATRIX, h = history) => resolveReporter(client, parseReporterMatrix(m), h);

describe("valid matrix available (assignment precedence)", () => {
  const valid = matrix([{ client: "Big Client", reporter: "ops@big.example" }]);

  it("large client in matrix → resolved from matrix", () => {
    assert.deepEqual(resolve("Big Client", valid), { status: "resolved", reporter: "ops@big.example", source: "matrix", evidence: "reporters.csv line 2" });
  });

  it("matrix wins over history for a listed client", () => {
    const h = coll([complaint({ client: "Big Client", reporter: "someone@big.example" })]);
    assert.deepEqual(resolve("Big Client", valid, h), { status: "resolved", reporter: "ops@big.example", source: "matrix", evidence: "reporters.csv line 2" });
  });

  it("client absent from a valid matrix (confirmed non-large) → latest history reporter by instant", () => {
    assert.deepEqual(resolve("Client One", valid), {
      status: "resolved", reporter: "new@client-one.example", source: "history",
      evidence: "complaints.json#1 (new, 2026-10-29T23:45:00Z)",
    });
  });

  it("non-large client without history → not_found", () => {
    assert.equal(resolve("Nobody", valid).status, "not_found");
  });

  it("latest complaints tie with different reporters → invalid", () => {
    const h = coll([complaint({ reporter: "a@c.example" }), complaint({ reporter: "b@c.example" })]);
    assert.equal(resolve("Client One", valid, h).status, "invalid");
  });

  it("invalid reporter value in history → invalid", () => {
    assert.equal(resolve("Client One", valid, coll([complaint({ reporter: "Jana Svobodová" })])).status, "invalid");
  });

  it("malformed complaint record of the client → history untrustworthy → invalid", () => {
    const h = coll<Complaint>([complaint()], [{ raw: { client: "Client One", status: "??" } }]);
    assert.equal(resolve("Client One", valid, h).status, "invalid");
  });
});

describe("invalid matrix", () => {
  it("unexpected columns → whole matrix invalid (schema is not guessed)", () => {
    const m = matrix([{ klient: "Big", email: "a@b.example" }], ["klient", "email"]);
    assert.equal(resolve("Client One", m).status, "invalid");
  });

  it("row without client → whole matrix invalid (it could be any client)", () => {
    assert.equal(resolve("Client One", matrix([{ client: " ", reporter: "a@b.example" }])).status, "invalid");
  });

  it("invalid reporter value → that client invalid; other clients still resolve", () => {
    const m = matrix([{ client: "Big", reporter: "not-an-email" }, { client: "Huge", reporter: "ops@huge.example" }]);
    assert.equal(resolve("Big", m).status, "invalid");
    assert.equal(resolve("Huge", m).status, "resolved");
    assert.equal(resolve("Client One", m).status, "resolved");
  });

  it("conflicting duplicate rows for a client → invalid for that client", () => {
    const m = matrix([{ client: "Big", reporter: "a@big.example" }, { client: "Big", reporter: "b@big.example" }]);
    assert.equal(resolve("Big", m).status, "invalid");
  });
});

describe("matrix missing (reporters.csv not supplied)", () => {
  it("→ needs_missing_data; history is evidence only, even when it exists", () => {
    assert.deepEqual(resolve("Client One"), {
      status: "needs_missing_data", missing: "REPORTER_MATRIX",
      historyCandidate: { reporter: "new@client-one.example", evidence: "complaints.json#1 (new, 2026-10-29T23:45:00Z)" },
    });
  });

  it("→ needs_missing_data with no candidate when there is no history", () => {
    assert.deepEqual(resolve("Nobody"), { status: "needs_missing_data", missing: "REPORTER_MATRIX", historyCandidate: null });
  });

  it("fixtures: candidates are the latest history reporters (evidence only)", () => {
    const fixtures = loadComplaints(join(DATA_DIR, "complaints.json"));
    const cand = (client: string) => {
      const r = resolveReporter(client, parseReporterMatrix(MISSING_MATRIX), fixtures);
      return r.status === "needs_missing_data" ? r.historyCandidate?.reporter ?? null : r.status;
    };
    assert.equal(cand("Hračky Epsilon"), "tomas.velky@hracky-epsilon.example");
    assert.equal(cand("Kosmetika Delta"), "claims@kosmetika-delta.example");
    assert.equal(cand("Sportovna Alfa"), "jana.svobodova@sportovna-alfa.example");
    assert.equal(cand("Nový klient Zeta"), null);
  });
});

describe("client identity normalisation", () => {
  // SYNTHETIC_TEST names. Same client = equal after NFC + Unicode-whitespace collapsing + trim.
  // Case, diacritic and invisible-character differences are never matched; they make the result
  // unresolvable (invalid → REVIEW) instead of silently falling back to history.
  const big = matrix([{ client: "Demo Klient", reporter: "matrix@demo.example" }]);
  const demoHistory = coll([complaint({ client: "Demo Klient", reporter: "history@demo.example" })], [], "complaints.json");
  const viaMatrix = { status: "resolved", reporter: "matrix@demo.example", source: "matrix", evidence: "reporters.csv line 2" };

  it("NBSP in the order's client name still finds the matrix entry (was: history fallback)", () => {
    assert.deepEqual(resolve("Demo Klient", big, demoHistory), viaMatrix);
  });

  it("whitespace variants in the matrix or the order (NBSP, thin/narrow NBSP, tab, newline, repeated, edges)", () => {
    for (const name of ["Demo Klient", "Demo Klient", "Demo\tKlient", "Demo\nKlient", "Demo    Klient", " Demo Klient 　"]) {
      assert.deepEqual(resolve(name, big, demoHistory), viaMatrix, JSON.stringify(name));
      assert.deepEqual(resolve("Demo Klient", matrix([{ client: name, reporter: "matrix@demo.example" }]), demoHistory), viaMatrix, JSON.stringify(name));
    }
  });

  it("Unicode normalisation: NFD and NFC spellings of a Czech name are the same client", () => {
    const czech = matrix([{ client: "Hračky Čeňková", reporter: "matrix@demo.example" }]);
    assert.equal(resolve("Hračky Čeňková", czech).status, "resolved");
  });

  it("case differences are not matched: REVIEW, never the history reporter", () => {
    for (const name of ["Demo klient", "DEMO KLIENT", "demo klient"]) {
      const r = resolve(name, big, coll([complaint({ client: name, reporter: "history@demo.example" })]));
      assert.equal(r.status, "invalid", name);
      assert.match(r.status === "invalid" ? r.detail : "", /matrix applicability unresolved/);
    }
  });

  it("diacritics are significant but a diacritic-only difference is not silently ignored → REVIEW", () => {
    assert.equal(resolve("Démo Klient", big).status, "invalid");
    assert.equal(resolve("Demo Klient", matrix([{ client: "Démo Klient", reporter: "matrix@demo.example" }]), demoHistory).status, "invalid");
  });

  it("invisible format characters (U+200B, U+00AD) → REVIEW, not a match and not history", () => {
    assert.equal(resolve("Demo​Klient", big, demoHistory).status, "invalid");
    assert.equal(resolve("Demo Kli­ent", big, demoHistory).status, "invalid");
  });

  it("matrix precedence holds after normalisation: matrix wins over a history spelled with NBSP", () => {
    const h = coll([complaint({ client: "Demo Klient", reporter: "history@demo.example", createdAt: "2026-11-01T10:00:00+01:00" })]);
    assert.deepEqual(resolve("Demo Klient", big, h), viaMatrix);
  });

  it("history selection treats whitespace variants as the same client (latest wins)", () => {
    const h = coll([
      complaint({ complaintId: "a", client: "Demo Klient", reporter: "older@demo.example", createdAt: "2026-09-01T10:00:00+02:00" }),
      complaint({ complaintId: "b", client: "Demo Klient", reporter: "newer@demo.example", createdAt: "2026-10-01T10:00:00+02:00" }),
    ]);
    const r = resolve("Demo Klient", matrix([{ client: "Other Big", reporter: "o@big.example" }]), h);
    assert.equal(r.status === "resolved" ? r.reporter : r.status, "newer@demo.example");
  });

  it("history containing a case variant of the client → invalid (ambiguous attribution)", () => {
    const h = coll([
      complaint({ complaintId: "a", client: "Demo Klient", reporter: "older@demo.example", createdAt: "2026-09-01T10:00:00+02:00" }),
      complaint({ complaintId: "b", client: "demo klient", reporter: "newer@demo.example", createdAt: "2026-10-01T10:00:00+02:00" }),
    ]);
    assert.equal(resolve("Demo Klient", matrix([{ client: "Other Big", reporter: "o@big.example" }]), h).status, "invalid");
  });

  it("malformed history record for a case variant of the client → invalid", () => {
    const h = coll<Complaint>([complaint({ client: "Demo Klient" })], [{ raw: { client: "DEMO KLIENT", status: "??" } }]);
    assert.equal(resolve("Demo Klient", matrix([{ client: "Other Big", reporter: "o@big.example" }]), h).status, "invalid");
  });

  it("duplicate rows that normalise to the same client: same reporter → resolved; conflicting reporters → invalid", () => {
    assert.equal(resolve("Demo Klient", matrix([{ client: "Demo Klient", reporter: "a@demo.example" }, { client: "Demo Klient", reporter: "a@demo.example" }])).status, "resolved");
    assert.equal(resolve("Demo Klient", matrix([{ client: "Demo Klient", reporter: "a@demo.example" }, { client: "Demo Klient", reporter: "b@demo.example" }])).status, "invalid");
  });

  it("near-identical matrix spellings (case only) → every spelling invalid, even with the same reporter", () => {
    const m = matrix([{ client: "Demo Klient", reporter: "a@demo.example" }, { client: "Demo klient", reporter: "a@demo.example" }]);
    for (const name of ["Demo Klient", "Demo klient", "DEMO KLIENT"]) assert.equal(resolve(name, m, demoHistory).status, "invalid", name);
    const parsed = parseReporterMatrix(m);
    assert.equal(parsed.status === "valid" ? parsed.reporters.size : -1, 0);
  });

  it("an unrelated client is unaffected by a near-identical pair elsewhere in the matrix", () => {
    const m = matrix([{ client: "Demo Klient", reporter: "a@demo.example" }, { client: "Demo klient", reporter: "b@demo.example" }, { client: "Big", reporter: "ops@big.example" }]);
    assert.equal(resolve("Big", m).status, "resolved");
    assert.equal(resolve("Client One", m).status, "resolved");
  });

  it("a matrix row whose client is only whitespace or invisible characters → whole matrix invalid", () => {
    assert.equal(resolve("Client One", matrix([{ client: "  ", reporter: "a@b.example" }])).status, "invalid");
    assert.equal(resolve("Client One", matrix([{ client: "​", reporter: "a@b.example" }])).status, "invalid");
  });

  it("missing matrix: a whitespace variant still yields only an evidence candidate (no CREATE path)", () => {
    const r = resolve("Demo Klient", MISSING_MATRIX, demoHistory);
    assert.equal(r.status, "needs_missing_data");
    assert.equal(r.status === "needs_missing_data" ? r.historyCandidate?.reporter : null, "history@demo.example");
  });
});
