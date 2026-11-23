// Regression tests for correctness gaps found by adversarial review: ParcelNord event history,
// Kurýr Vltava event time, reporter identity, delivery wording, order identity and time consistency,
// and the same failure class in the other carriers (Expedo).
//
// Every case runs BOTH the parser/resolver AND the real pipeline (loaders → classifier → decision
// engine) on a temporary copy of examples/create, where MS-EX-B-0001 (definition B) is CREATE. All
// pages and names here are SYNTHETIC_TEST data; nothing under data/ or examples/ is modified.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OrderDecision } from "../../src/decision/decide.ts";
import { parseExpedo } from "../../src/tracking/carriers/expedo.ts";
import { parseKuryrVltava } from "../../src/tracking/carriers/kuryrVltava.ts";
import { parseParcelNord } from "../../src/tracking/carriers/parcelNord.ts";
import { classifyTrackingPage } from "../../src/tracking/classify.ts";
import { DATA_DIR, EXAMPLE_DIR, decideExample, editJson, type Mutation } from "../helpers.ts";

const KEY = "MS-EX-B-0001";
const CLIENT = "Malý Klient s.r.o.";
const PAGE_FILE = "PNEXB0001.html";
const PN = readFileSync(join(EXAMPLE_DIR, "tracking", PAGE_FILE), "utf8");
const KV = readFileSync(join(DATA_DIR, "tracking", "KV2026100101.html"), "utf8").replaceAll("KV2026100101", "PNEXB0001");
const EX = readFileSync(join(DATA_DIR, "tracking", "EX7710194.html"), "utf8").replaceAll("EX7710194", "PNEXB0001");

function decide(...mutations: Mutation[]): OrderDecision {
  const d = decideExample(...mutations).decisions.find((x) => x.key === KEY);
  assert.ok(d, "example order missing");
  return d;
}
const codes = (d: OrderDecision) => d.execution.reasons.map((r) => r.code);
const setPage = (html: string): Mutation => (dir) => writeFileSync(join(dir, "tracking", PAGE_FILE), html);
const shipWith = (carrier: string, method: string): Mutation => editJson("orders.json", (o) => { o[1].carrier = carrier; o[1].shippingMethod = method; });
const setMatrix = (csv: string): Mutation => (dir) => writeFileSync(join(dir, "reporters.csv"), csv);
const setClient = (client: string): Mutation => (dir) => {
  editJson("orders.json", (o) => { o[1].client = client; })(dir);
  editJson("complaints.json", (c) => { c[0].client = client; })(dir);
};

const row = (date: string, time: string, place: string, text: string) => `<tr><td>${date}</td><td>${time}</td><td>${place}</td><td>${text}</td></tr>`;
const DELIVERED_ROW = row("30. 10. 2026", "11:00", "Brno", "Doručeno příjemci, podepsal: J. Novák");
const kvMessage = (msg: string, width = 66) =>
  KV.replace(/<div class="shipment-message">[\s\S]*?<\/div>/, `<div class="shipment-message"><p>${msg}</p></div>`).replace("width:66%", `width:${width}%`);
const exCard = (small: string, paragraphs = "<p>Zásilka opustila třídicí centrum Ostrava.</p>", value = "Na cestě") =>
  EX.replace(/<div class="status-card">[\s\S]*?<\/div>/, `<div class="status-card"><span class="label">Aktuální stav</span><strong class="value">${value}</strong><small>${small}</small>${paragraphs}</div>`);

describe("control: the unmodified example order is a legitimate CREATE", () => {
  it("CREATE with TRACKING_IN_TRANSIT and the history reporter", () => {
    const d = decide();
    assert.equal(d.execution.action, "create");
    assert.ok(codes(d).includes("TRACKING_IN_TRANSIT"));
    assert.deepEqual(d.reporter && d.reporter.status === "resolved" ? [d.reporter.reporter, d.reporter.source] : null, ["reklamace@maly-klient.example", "history"]);
  });
});

describe("ParcelNord: every row of the event history is read", () => {
  const secondTbody = PN.replace("</tbody></table>", `</tbody><tbody>${DELIVERED_ROW}</tbody></table>`);

  it("parser: delivery in a later <tbody> → DELIVERED (original code read only the first <tbody> → IN_TRANSIT)", () => {
    const r = parseParcelNord(secondTbody);
    assert.equal(r.state, "DELIVERED");
    assert.equal(r.eventTime?.local, "2026-10-30T11:00");
  });

  it("end-to-end: delivery in a later <tbody> → SKIP (TRACKING_DELIVERED), never CREATE", () => {
    const d = decide(setPage(secondTbody));
    assert.equal(d.execution.action, "skip");
    assert.ok(codes(d).includes("TRACKING_DELIVERED"));
    assert.ok(!codes(d).includes("TRACKING_IN_TRANSIT"));
  });

  it("reversed table order (delivery tbody first) and delivery in <tfoot> → SKIP", () => {
    for (const html of [PN.replace("<tbody>", `<tbody>${DELIVERED_ROW}</tbody><tbody>`), PN.replace("</tbody></table>", `</tbody><tfoot>${DELIVERED_ROW}</tfoot></table>`)]) {
      assert.equal(parseParcelNord(html).state, "DELIVERED");
      assert.equal(decide(setPage(html)).execution.action, "skip");
    }
  });

  it("an OLDER delivery hidden in a later <tbody> (latest row is 'zpracována') → UNKNOWN → REVIEW", () => {
    const html = PN.replace("</tbody></table>", `</tbody><tbody>${row("11. 10. 2026", "11:00", "Brno", "Doručeno příjemci")}</tbody></table>`);
    assert.match(parseParcelNord(html).reason, /earlier event reports delivery/);
    const d = decide(setPage(html));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_UNKNOWN"));
  });

  const unknownPages: [string, string, RegExp][] = [
    ["a second table elsewhere on the page", PN.replace("</table>", `</table><table><tbody>${DELIVERED_ROW}</tbody></table>`), /tables besides the events table/],
    ["a nested table inside a cell", PN.replace("<td>Zásilka zpracována</td>", "<td>Zásilka zpracována<table><tr><td>x</td></tr></table></td>"), /tables besides|malformed rows/],
    ["an unrecognised delivery wording in the history", PN.replace("<tbody>", `<tbody>${row("11. 10. 2026", "11:00", "Brno", "Zásilka doručena sousedovi")}`), /earlier event is not recognised/],
    ["an earlier return to the sender, later sorting scan", PN.replace("<tbody>", `<tbody>${row("11. 10. 2026", "23:00", "Brno", "Zásilka vrácena odesílateli")}`), /earlier event reports a return/],
    ["a date cell holding two dates", PN.replace("<td>12. 10. 2026</td>", "<td>12. 10. 2026 (30. 10. 2026)</td>"), /no readable date\/time/],
    ["a row without a time", PN.replace("<td>04:37</td>", "<td></td>"), /no readable date\/time/],
    ["a row with five cells", PN.replace("<td>Zásilka zpracována</td></tr>", "<td>Zásilka zpracována</td><td>Doručeno příjemci</td></tr>"), /exactly four cells/],
    ["an unclosed row", PN.replace("<tr><td>10. 10. 2026</td>", "<tr><tr><td>10. 10. 2026</td>"), /malformed rows/],
  ];
  for (const [label, html, reason] of unknownPages) {
    it(`${label} → UNKNOWN → REVIEW (TRACKING_UNKNOWN)`, () => {
      const r = parseParcelNord(html);
      assert.equal(r.state, "UNKNOWN");
      assert.match(r.reason, reason);
      const d = decide(setPage(html));
      assert.equal(d.execution.action, "review");
      assert.ok(codes(d).includes("TRACKING_UNKNOWN"));
    });
  }

  it("two different tracking numbers on the page → identity not established → REVIEW", () => {
    const html = PN.replace("</table>", "</table><h1>Zásilka PNOTHER0001</h1>");
    assert.equal(parseParcelNord(html).pageTrackingNumber, null);
    const d = decide(setPage(html));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_UNKNOWN"));
  });

  it("source order must be unambiguous — strictly oldest-first creates, shuffled or duplicated rows do not", () => {
    const tbody = /<tbody>([\s\S]*)<\/tbody>/.exec(PN)?.[1] ?? "";
    const rows = tbody.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
    assert.equal(rows.length, 3);
    assert.equal(decide(setPage(PN.replace(tbody, [...rows].reverse().join("")))).execution.action, "create");
    for (const order of [[rows[2], rows[0], rows[1]], [rows[0], rows[0], rows[1], rows[2]]]) {
      const d = decide(setPage(PN.replace(tbody, order.join(""))));
      assert.equal(d.execution.action, "review");
      assert.ok(codes(d).includes("TRACKING_UNKNOWN"));
    }
    // Rows split across two <tbody> elements are still read as one history.
    assert.equal(decide(setPage(PN.replace(rows[1] ?? "", `${rows[1]}</tbody><tbody>`))).execution.action, "create");
  });

  it("a newer event hidden in a later <tbody> is read as the latest event; out of source order → REVIEW", () => {
    const html = PN.replace("</tbody></table>", `</tbody><tbody>${row("1. 11. 2026", "21:40", "Třídicí centrum Brno", "Zásilka zpracována")}</tbody></table>`);
    assert.equal(parseParcelNord(html).eventTime?.local, "2026-11-01T21:40");
    const d = decide(setPage(html));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_UNKNOWN"));
  });

  it("a newer event at the top of the history dated after the decision day → REVIEW (TRACKING_TIME_INCONSISTENT)", () => {
    const d = decide(setPage(PN.replace("<tbody>", `<tbody>${row("3. 11. 2026", "04:37", "Třídicí centrum Praha", "Zásilka zpracována")}`)));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_TIME_INCONSISTENT"));
  });
});

describe("Kurýr Vltava: no event time from descriptive text", () => {
  const twoDates = kvMessage("Zásilka je na cestě k vám. Přijata 10. 10. 2026 v 08:00, poslední sken 1. 11. 2026 v 21:40.");
  const kv = shipWith("Kurýr Vltava", "Kurýr Vltava Standard");

  it("parser: two dates in the message → no event time (original code took the first, 10. 10.)", () => {
    const r = parseKuryrVltava(twoDates);
    assert.equal(r.state, "IN_TRANSIT");
    assert.equal(r.eventTime, null);
    assert.ok(r.warnings.some((w) => /contains 2 dates/.test(w)));
  });

  it("end-to-end: two dates → REVIEW (TRACKING_ACTIVITY_UNDETERMINED), never CREATE", () => {
    const d = decide(kv, setPage(twoDates));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_ACTIVITY_UNDETERMINED"));
  });

  it("a single (old) date in an in-transit message is not the last carrier event → REVIEW", () => {
    const html = kvMessage("Zásilka je na cestě k vám. Odeslána 10. 10. 2026 v 08:00.");
    const r = parseKuryrVltava(html);
    assert.equal(r.eventTime, null);
    assert.ok(r.warnings.some((w) => /not used as the last carrier event/.test(w)));
    const d = decide(kv, setPage(html));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_ACTIVITY_UNDETERMINED"));
  });

  it("dates spread over several paragraphs of the message, or a date outside it → REVIEW", () => {
    for (const html of [
      kvMessage("Zásilka je na cestě k vám. 10. 10. 2026 v 08:00</p><p>1. 11. 2026 v 21:40"),
      kvMessage("Zásilka je na cestě k vám.").replace('<section class="change-delivery">', "<p>Poslední událost 10. 10. 2026 v 08:00</p><section class=\"change-delivery\">"),
    ]) {
      assert.equal(parseKuryrVltava(html).eventTime, null);
      assert.equal(decide(kv, setPage(html)).execution.action, "review");
    }
  });

  it("a delivery sentence keeps its single date as evidence; with two dates it has none", () => {
    assert.equal(parseKuryrVltava(kvMessage("Zásilka byla doručena příjemci 30. 10. 2026 v 13:12.", 100)).eventTime?.local, "2026-10-30T13:12");
    assert.equal(parseKuryrVltava(kvMessage("Zásilka z 10. 10. 2026 byla doručena příjemci 30. 10. 2026 v 13:12.", 100)).eventTime, null);
  });

  it("delivery with its single date → SKIP; the same sentence without a usable date → REVIEW", () => {
    assert.equal(decide(kv, setPage(kvMessage("Zásilka byla doručena příjemci 30. 10. 2026 v 13:12.", 100))).execution.action, "skip");
    const d = decide(kv, setPage(kvMessage("Zásilka byla doručena příjemci 31. 9. 2026 v 13:12.", 100)));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_TIME_INCONSISTENT"));
  });
});

describe("Kurýr Vltava: 'doručena' without 'příjemci' is recognised as delivery wording", () => {
  // Guards against a mutant that would drop the recipient check
  //   if (!/doručena příjemci/i.test(msg)) return unknown("marked delivered without naming the recipient", …)
  // removed or weakened to /doručena/i. A sentence saying only "doručena" (no recipient, no third
  // party, full progress bar) then became DELIVERED instead of UNKNOWN.
  const dated = kvMessage("Zásilka byla doručena 30. 10. 2026 v 13:12.", 100);
  const mixed = kvMessage("Zásilka byla doručena na výdejní místo, kurýr je na cestě zpět na depo.");

  it("parser: dated 'doručena' without the recipient → UNKNOWN with the 'without naming the recipient' reason", () => {
    const r = parseKuryrVltava(dated);
    assert.equal(r.state, "UNKNOWN");
    assert.match(r.reason, /marked delivered without naming the recipient/);
    assert.equal(r.eventTime?.local, "2026-10-30T13:12");
  });

  it("parser: 'doručena' together with 'na cestě' is delivery wording, not IN_TRANSIT", () => {
    const r = parseKuryrVltava(mixed);
    assert.equal(r.state, "UNKNOWN");
    assert.match(r.reason, /marked delivered without naming the recipient/);
  });

  it("end-to-end: REVIEW with TRACKING_UNKNOWN (the mutant turns this into SKIP / TRACKING_DELIVERED)", () => {
    for (const html of [dated, mixed]) {
      const d = decide(shipWith("Kurýr Vltava", "Kurýr Vltava Standard"), setPage(html));
      assert.equal(d.execution.action, "review");
      assert.ok(codes(d).includes("TRACKING_UNKNOWN"));
      assert.ok(!codes(d).includes("TRACKING_DELIVERED"));
    }
  });
});

describe("Expedo: in transit only from a recognised, dated status card", () => {
  const ex = shipWith("Expedo", "Expedo Standard");

  it("neutral in-transit card with an exact update time → CREATE (definition B)", () => {
    const d = decide(ex, setPage(exCard("Poslední aktualizace: 10. 10. 2026 08:00")));
    assert.equal(d.execution.action, "create");
    assert.ok(codes(d).includes("TRACKING_IN_TRANSIT"));
  });

  const cards: [string, string][] = [
    ["waiting at a pickup point", "<p>Zásilka čeká na výdejním místě Expedo Point Praha 4.</p>"],
    ["storage expired, travelling back to the sender", "<p>Uplynula úložní doba, zásilka je na cestě k odesílateli.</p>"],
    ["recipient absent, held at the depot", "<p>Kurýr vás nezastihl, zásilka čeká na depu Praha.</p>"],
  ];
  for (const [label, p] of cards) {
    it(`${label} under 'Na cestě' → UNKNOWN → REVIEW, never CREATE`, () => {
      const d = decide(ex, setPage(exCard("Poslední aktualizace: 10. 10. 2026 08:00", p)));
      assert.equal(d.execution.action, "review");
      assert.ok(codes(d).includes("TRACKING_UNKNOWN"));
    });
  }

  it("unambiguous delivery and return still SKIP; anything else is not DELIVERED/RETURNING", () => {
    assert.equal(decide(ex, setPage(exCard("Poslední aktualizace: 21. 10. 2026 16:03", "<p>Zásilka byla předána příjemci.</p>", "Doručeno"))).execution.action, "skip");
    assert.equal(decide(ex, setPage(exCard("Poslední aktualizace: 30. 10. 2026 09:15", "<p>Příjemce zásilku odmítl převzít.</p>", "Vrací se odesílateli"))).execution.action, "skip");
    assert.equal(parseExpedo(exCard("", "<p>Zásilka byla doručena na Expedo Point, příjemci ji vydáme po zadání PIN.</p>", "Doručeno")).state, "UNKNOWN");
  });
});

describe("reporter identity end-to-end", () => {
  const MATRIX_REPORTER = "matrix@maly-klient.example";
  const reporterOf = (d: OrderDecision) => (d.reporter?.status === "resolved" ? `${d.reporter.reporter} (${d.reporter.source})` : d.reporter?.status);

  it("matrix 'Malý Klient s.r.o.', order and history spelled with a no-break space → matrix reporter", () => {
    const d = decide(setMatrix(`client,reporter\n${CLIENT},${MATRIX_REPORTER}\n`), setClient("Malý Klient s.r.o."));
    assert.equal(d.execution.action, "create");
    assert.equal(reporterOf(d), `${MATRIX_REPORTER} (matrix)`);
  });

  it("whitespace variants (NBSP, thin space, tab, repeated spaces) in the matrix → matrix reporter", () => {
    for (const name of ["Malý Klient s.r.o.", "Malý Klient s.r.o.", "Malý\tKlient s.r.o.", "Malý   Klient s.r.o.", " Malý Klient s.r.o. "]) {
      const d = decide(setMatrix(`client,reporter\n"${name}",${MATRIX_REPORTER}\n`));
      assert.equal(reporterOf(d), `${MATRIX_REPORTER} (matrix)`, JSON.stringify(name));
    }
  });

  it("NFD vs NFC spelling of a Czech name → same client, matrix reporter", () => {
    const d = decide(setMatrix(`client,reporter\n${CLIENT.normalize("NFD")},${MATRIX_REPORTER}\n`));
    assert.equal(reporterOf(d), `${MATRIX_REPORTER} (matrix)`);
  });

  for (const name of ["Malý klient s.r.o.", "MALÝ KLIENT S.R.O.", "Maly Klient s.r.o.", "Malý​Klient s.r.o."]) {
    it(`matrix spelling ${JSON.stringify(name)} differs only in case/diacritics/invisible characters → REVIEW (REPORTER_DATA_INVALID), no history fallback`, () => {
      const d = decide(setMatrix(`client,reporter\n${name},${MATRIX_REPORTER}\n`));
      assert.equal(d.execution.action, "review");
      assert.ok(codes(d).includes("REPORTER_DATA_INVALID"));
      assert.equal(d.reporter?.status, "invalid");
    });
  }

  it("complaint history names a case variant of the client → REVIEW, not the older exact-name reporter", () => {
    const d = decide(editJson("complaints.json", (c) => c.push({ ...c[0], complaintId: "h2", client: "malý klient s.r.o.", reporter: "other@maly-klient.example", createdAt: "2026-10-01T10:00:00+02:00" })));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("REPORTER_DATA_INVALID"));
  });

  it("history spelled with NBSP is the same client: its newer reporter is selected", () => {
    const d = decide(editJson("complaints.json", (c) => c.push({ ...c[0], complaintId: "h3", client: "Malý Klient s.r.o.", reporter: "newer@maly-klient.example", createdAt: "2026-10-01T10:00:00+02:00" })));
    assert.equal(d.execution.action, "create");
    assert.equal(reporterOf(d), "newer@maly-klient.example (history)");
  });

  it("missing matrix → REVIEW (REPORTER_MATRIX_UNAVAILABLE) even with a matching history", () => {
    const d = decide((dir) => rmSync(join(dir, "reporters.csv")));
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("REPORTER_MATRIX_UNAVAILABLE"));
  });
});

describe("adversarial counterexamples stay non-CREATE", () => {
  const ex = shipWith("Expedo", "Expedo Standard");
  const exBase = (extra: string, small = "Poslední aktualizace: 10. 10. 2026 08:00") => exCard(small, extra);
  const latest = (text: string) => PN.replace("<tbody>", `<tbody>${row("12. 10. 2026", "05:00", "Brno", text)}`);
  const newest = DELIVERED_ROW.replaceAll("td>", "th>");
  const blockerFor = (file: "complaints.json" | "returns.json", orderNumber: string): Mutation => editJson(file, (v) => v.push(file === "returns.json"
    ? { returnId: "r-x", orderNumber, status: "Připraveno", createdAt: "2026-10-31T10:00:00+01:00" }
    : { ...v[0], complaintId: "c-x", orderNumber, status: "draft" }));
  const historyClient = (client: string, createdAt = "2026-10-30T10:00:00+01:00"): Mutation =>
    editJson("complaints.json", (c) => c.push({ ...c[0], complaintId: "h-x", client, reporter: "newer@maly-klient.example", createdAt }));
  const method = (m: string): Mutation => editJson("orders.json", (o) => { o[1].shippingMethod = m; });

  const cases: [string, Mutation[], string, string][] = [
    // ParcelNord history
    ["PN: newest row made of <th> cells", [setPage(PN.replace("</tbody>", `${newest}</tbody>`))], "review", "TRACKING_UNKNOWN"],
    ["PN: '</table>' inside a comment before a newer delivery row", [setPage(PN.replace("</tbody>", `<!-- legacy </table> -->${DELIVERED_ROW}</tbody>`))], "review", "TRACKING_UNKNOWN"],
    ["PN: '</table>' inside a script before a newer delivery row", [setPage(PN.replace("</tbody>", `<script>/* </table> */</script>${DELIVERED_ROW}</tbody>`))], "review", "TRACKING_UNKNOWN"],
    ["PN: comment-terminator trick '<!-->' before a delivery row", [setPage(PN.replace("</tbody>", `<!-->${DELIVERED_ROW}<!-- end --></tbody>`))], "review", "TRACKING_UNKNOWN"],
    ["PN: second header row of <th> cells with a delivery", [setPage(PN.replace("</tr></thead>", `</tr>${newest}</thead>`))], "review", "TRACKING_UNKNOWN"],
    ["PN: <caption> or loose text inside the table", [setPage(PN.replace('<table class="events">', '<table class="events"><caption>Doručeno příjemci 30. 10. 2026</caption>'))], "review", "TRACKING_UNKNOWN"],
    ["PN: inline markup inside a cell", [setPage(PN.replace("<td>Zásilka zpracována</td></tr>", "<td>Zásilka <b>zpracována</b></td></tr>"))], "review", "TRACKING_UNKNOWN"],
    ["PN: a second (empty) <main>", [setPage(PN.replace("<main>", "<main hidden></main><main>"))], "review", "TRACKING_UNKNOWN"],
    ["PN: soft hyphen inside a word on the page", [setPage(PN.replace("Události se mohou", "Udá­losti se mohou"))], "review", "TRACKING_UNKNOWN"],
    ["PN: unsupported named entity", [setPage(PN.replace("Zásilka zpracována</td></tr>", "Z&aacute;silka zpracována</td></tr>"))], "review", "TRACKING_UNKNOWN"],
    ["PN: 'zpracována k vrácení odesílateli' as the latest event", [setPage(latest("Zásilka zpracována k vrácení odesílateli"))], "review", "TRACKING_UNKNOWN"],
    ["PN: 'zpracována – adresát zásilku odmítl převzít'", [setPage(latest("Zásilka zpracována – adresát zásilku odmítl převzít"))], "review", "TRACKING_UNKNOWN"],
    ["PN: 'zpracována, předána příjemci'", [setPage(latest("Zásilka zpracována, předána příjemci"))], "review", "TRACKING_UNKNOWN"],
    ["PN: same-time sorting scan and pickup-point event (row order must not matter)", [setPage(PN.replace("<tbody>", `<tbody>${row("12. 10. 2026", "04:37", "Brno", "Zásilka je připravena k vyzvednutí.")}`))], "review", "TRACKING_UNKNOWN"],
    ["PN: tracking number glued to a suffix ('PNEXB0001-2')", [setPage(PN.replace("<h1>Zásilka PNEXB0001</h1>", "<h1>Zásilka PNEXB0001-2</h1>"))], "review", "TRACKING_UNKNOWN"],
    ["PN: another 'Zásilka <number>' heading on the page", [setPage(PN.replace("</h1>", "</h1><h2>Zásilka PNEXB0999</h2>"))], "review", "TRACKING_UNKNOWN"],
    ["PN: status wording in the place cell", [setPage(PN.replace("Třídicí centrum Brno", "Doručeno příjemci, podpis: Novák"))], "review", "TRACKING_UNKNOWN"],
    ["PN: English wording in the place cell", [setPage(PN.replace("Třídicí centrum Brno", "Delivered to recipient"))], "review", "TRACKING_UNKNOWN"],
    ["PN: whole history before the order was shipped (stale or recycled page)", [editJson("orders.json", (o) => { o[1].shippedAt = "2026-10-15T10:00:00+02:00"; o[1].packedAt = "2026-10-14T10:00:00+02:00"; })], "review", "TRACKING_TIME_INCONSISTENT"],
    // Expedo card
    ["EX: newer dated activity in the card text", [ex, setPage(exBase("<p>Zásilka 31. 10. 2026 v 18:20 opustila třídicí centrum.</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: 'Zásilku převzal adresát' under 'Na cestě'", [ex, setPage(exBase("<p>Zásilku převzal adresát.</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: 'Zásilka se vrací odesílateli' under 'Na cestě'", [ex, setPage(exBase("<p>Zásilka se vrací odesílateli.</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: delivery text in a <span> instead of <p>", [ex, setPage(exBase("<span class=\"detail\">Zásilka byla předána příjemci.</span>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: nested <div> hides a delivered paragraph", [ex, setPage(exBase("<div class=\"sep\"></div><p>Zásilka byla předána příjemci.</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: second value-like element <b class=\"value\">Doručeno</b>", [ex, setPage(exBase("<b class=\"value\">Doručeno</b>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: second value element with neutral text (<strong class='value'>)", [ex, setPage(exBase("<strong class='value'>Stav neznámý</strong>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: update field is an expected delivery, not an event", [ex, setPage(exBase("", "Předpokládané doručení: 10. 10. 2026 08:00"))], "review", "TRACKING_UNKNOWN"],
    ["EX: newer date without a year in the card", [ex, setPage(exBase("<p>Aktualizováno 1. 11. v 22:40.</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: second card with single quotes before the real one", [ex, setPage(exCard("Poslední aktualizace: 10. 10. 2026 08:00").replace('<div class="status-card">', "<div class='status-card'><strong class=\"value\">Doručeno</strong></div><div class=\"status-card\">"))], "review", "TRACKING_UNKNOWN"],
    ["EX: delivery text in the label span", [ex, setPage(exCard("Poslední aktualizace: 10. 10. 2026 08:00").replace("Aktuální stav", "Doručeno příjemci"))], "review", "TRACKING_UNKNOWN"],
    ["EX: update field carries a zone ('06:30 UTC')", [ex, setPage(exCard("Poslední aktualizace: 10. 10. 2026 06:30 UTC"))], "review", "TRACKING_UNKNOWN"],
    ["EX: update field carries a delivery note", [ex, setPage(exCard("Poslední aktualizace: 10. 10. 2026 08:00 – doručeno příjemci"))], "review", "TRACKING_UNKNOWN"],
    ["EX: synonym 'dodána' in the card text", [ex, setPage(exBase("<p>Zásilka byla dodána.</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: English card text", [ex, setPage(exBase("<p>Delivered to the recipient.</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: synonym 'Obdrženo, podepsal' in the card", [ex, setPage(exBase("<p>Obdrženo, podepsal J. Novák</p>"))], "review", "TRACKING_UNKNOWN"],
    ["EX: tracking number glued to a suffix", [ex, setPage(exCard("Poslední aktualizace: 10. 10. 2026 08:00").replace("Číslo zásilky: PNEXB0001", "Číslo zásilky: PNEXB0001-B"))], "review", "TRACKING_UNKNOWN"],
    ["EX: update dated before the shipment day", [ex, setPage(exCard("Poslední aktualizace: 8. 10. 2026 23:00"))], "review", "TRACKING_TIME_INCONSISTENT"],
    // Blockers and eligibility identifiers
    ["complaint orderNumber with a zero-width space", [blockerFor("complaints.json", "MS-EX-B-0001​")], "review", "POTENTIAL_BLOCKING_RECORD"],
    ["return orderNumber with non-breaking hyphens", [blockerFor("returns.json", "MS‑EX‑B‑0001")], "review", "POTENTIAL_BLOCKING_RECORD"],
    ["return orderNumber with fullwidth digits", [blockerFor("returns.json", "MS-EX-B-０００１")], "review", "POTENTIAL_BLOCKING_RECORD"],
    ["complaint orderNumber with Cyrillic letters and the same digits", [blockerFor("complaints.json", "МС-EX-B-0001")], "review", "POTENTIAL_BLOCKING_RECORD"],
    ["return orderNumber with a Cherokee letter", [blockerFor("returns.json", "ᎷS-EX-B-0001")], "review", "POTENTIAL_BLOCKING_RECORD"],
    ["return orderNumber with Arabic-Indic digits", [blockerFor("returns.json", "MS-EX-B-٠٠٠١")], "review", "POTENTIAL_BLOCKING_RECORD"],
    ["complaint orderNumber with ƀ (non-decomposing Latin letter)", [blockerFor("complaints.json", "MS-EX-ƀ-0001")], "review", "POTENTIAL_BLOCKING_RECORD"],
    ["excluded shipping method written with a no-break space", [method("Parcelo DE")], "review", "AMBIGUOUS_SHIPPING_METHOD"],
    ["excluded shipping method with a zero-width space", [method("Parcelo DE​")], "review", "AMBIGUOUS_SHIPPING_METHOD"],
    ["excluded shipping method with a Lisu letter (no look-alike map entry)", [method("Parcelo Dꓰ")], "review", "AMBIGUOUS_SHIPPING_METHOD"],
    ["excluded shipping method with a dotless ı", [method("Parcelo ınternational")], "review", "AMBIGUOUS_SHIPPING_METHOD"],
    ["second order row whose orderNumber differs only in case (other parcel, delivered)", [editJson("orders.json", (o) => o.push({ ...o[1], orderId: "00000000-0000-4000-8000-0000000000ff", orderNumber: "ms-ex-b-0001", trackingNumber: "PNEXB0099", status: "delivered" }))], "review", "CONFLICTING_DUPLICATE"],
    // Reporter identity
    ["history names the client with a Lisu letter", [historyClient("Malý ꓗlient s.r.o.")], "review", "REPORTER_DATA_INVALID"],
    ["history names the client with a Cyrillic palochka (U+04C0)", [historyClient("Malý KӀient s.r.o.")], "review", "REPORTER_DATA_INVALID"],
    ["history names the client with a braille blank (U+2800)", [historyClient(`${CLIENT}⠀`)], "review", "REPORTER_DATA_INVALID"],
    ["history names the client with a Hangul filler (U+3164)", [historyClient(`${CLIENT}ㅤ`)], "review", "REPORTER_DATA_INVALID"],
    ["history names the client without the final full stop", [historyClient("Malý Klient s.r.o")], "review", "REPORTER_DATA_INVALID"],
    ["history names the client with a Cyrillic К", [historyClient("Malý Кlient s.r.o.")], "review", "REPORTER_DATA_INVALID"],
    ["history names the client with a Roman numeral Ⅿ (U+216F)", [historyClient("Ⅿalý Klient s.r.o.")], "review", "REPORTER_DATA_INVALID"],
    ["large client: order and history spelled with a fullwidth Ｋ", [setMatrix(`client,reporter\n${CLIENT},matrix@maly-klient.example\n`), setClient("Malý Ｋlient s.r.o.")], "review", "REPORTER_DATA_INVALID"],
    ["complaint dated after the decision time decides the reporter", [historyClient(CLIENT, "2027-01-01T10:00:00+01:00")], "review", "REPORTER_DATA_INVALID"],
  ];
  for (const [label, mutations, action, code] of cases) {
    it(`${label} → ${action.toUpperCase()} (${code})`, () => {
      const d = decide(...mutations);
      assert.equal(d.execution.action, action);
      assert.ok(codes(d).includes(code as never), codes(d).join(","));
    });
  }

  it("negated wording is not read as delivery or return", () => {
    assert.equal(parseParcelNord(latest("Zásilka nebyla doručena příjemci")).state, "UNKNOWN");
    assert.equal(parseKuryrVltava(kvMessage("Zásilka nebyla doručena příjemci.", 100)).state, "UNKNOWN");
    assert.equal(parseExpedo(exCard("Poslední aktualizace: 10. 10. 2026 08:00", "<p>Zásilka nebyla předána příjemci.</p>", "Doručeno")).state, "UNKNOWN");
    assert.equal(parseExpedo(exCard("Poslední aktualizace: 10. 10. 2026 08:00", "", "Nevrací se odesílateli")).state, "UNKNOWN");
  });

  it("controls: legitimate CREATE survives harmless variations", () => {
    for (const m of [setPage(PN.replaceAll("</td><td>", "</td>\n<td>")),
      setMatrix("client,reporter\nVelký Klient s.r.o.,reklamace@velky-klient.example\n"), historyClient("Malý  Klient s.r.o.", "2026-09-01T10:00:00+02:00")]) {
      assert.equal(decide(m).execution.action, "create");
    }
  });

  it("comments / scripts in the body → malformed page", () => {
    for (const html of [PN.replace("</tbody>", "<!-- x --></tbody>"), PN.replace("</main>", "<script>1</script></main>")]) {
      assert.match(classifyTrackingPage(html).reason, /malformed tracking page: unsupported markup/);
    }
  });
});

describe("identity and time-consistency counterexamples, end-to-end", () => {
  const rowsOf = (...r: string[]) => PN.replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${r.join("")}</tbody>`);
  const pickedUp = (date: string, time: string) => row(date, time, "Odesílatel", "Zásilka převzata od odesílatele");
  const processed = (date: string, time: string) => row(date, time, "Třídicí centrum Brno", "Zásilka zpracována");
  const order = (fn: (o: any) => void): Mutation => editJson("orders.json", (o) => fn(o[1]));
  const addOrder = (extra: Record<string, unknown>): Mutation => editJson("orders.json", (o) => o.push({ ...o[1], ...extra }));
  const addComplaint = (extra: Record<string, unknown>): Mutation => editJson("complaints.json", (c) => c.push({ ...c[0], complaintId: "x", ...extra }));
  const kv = shipWith("Kurýr Vltava", "Kurýr Vltava Standard");

  const cases: [string, Mutation[], string, string][] = [
    ["pickup point, then processed again", [setPage(rowsOf(processed("12. 10. 2026", "04:37"), row("10. 10. 2026", "22:15", "Box Brno", "Zásilka je připravena k vyzvednutí."), pickedUp("09. 10. 2026", "15:20")))], "review", "TRACKING_UNKNOWN"],
    ["pick-up days before the WMS shipment", [setPage(rowsOf(processed("12. 10. 2026", "04:37"), pickedUp("01. 10. 2026", "08:00")))], "review", "TRACKING_TIME_INCONSISTENT"],
    ["SK-PN1 conditional return as the latest event", [setPage(rowsOf(row("12. 10. 2026", "04:37", "Brno", "Po uplynutí úložní doby bude zásilka vrácena odesílateli."), pickedUp("09. 10. 2026", "15:20")))], "review", "TRACKING_UNKNOWN"],
    ["SK-KV2 'se nevrací odesílateli'", [kv, setPage(kvMessage("Zásilka se nevrací odesílateli, doručení zopakujeme další pracovní den."))], "review", "TRACKING_UNKNOWN"],
    ["SK-KV3 'nevracíme odesílateli'", [kv, setPage(kvMessage("Na žádost příjemce zásilku nevracíme odesílateli, je na cestě k vám."))], "review", "TRACKING_UNKNOWN"],
    ["malformed order row claims the same tracking number", [addOrder({ orderId: "00000000-0000-4000-8000-000000000777", orderNumber: "MS-EX-B-0777", status: "lost_somewhere" })], "review", "TRACKING_UNAVAILABLE"],
    ["malformed order row reuses the orderId", [addOrder({ orderNumber: "MS-EX-B-0778", status: "lost_somewhere", trackingNumber: "PNEXB0778" })], "review", "CONFLICTING_DUPLICATE"],
    ["second row 'MS-EX-B-0001 ' (padded), other parcel", [addOrder({ orderId: "00000000-0000-4000-8000-000000000779", orderNumber: "MS-EX-B-0001 ", trackingNumber: "PNEXB0779", status: "delivered" })], "review", "CONFLICTING_DUPLICATE"],
    ["newer malformed complaint for the client with a Cyrillic а", [editJson("complaints.json", (c) => c.push({ ...c[0], complaintId: "x", client: "Mаlý Klient s.r.o.", status: "bogus", reporter: "attacker@x.example", createdAt: "2026-10-30T10:00:00+01:00" }))], "review", "REPORTER_DATA_INVALID"],
    ["newer malformed complaint without a client, for an order not in the batch", [editJson("complaints.json", (c) => c.push({ complaintId: "x", orderNumber: "MS-ELSEWHERE-1", status: "bogus", reporter: "attacker@x.example", createdAt: "2026-10-30T10:00:00+01:00" }))], "review", "REPORTER_DATA_INVALID"],
    ["newer complaint for the client with a BOM inside", [addComplaint({ client: "Malý﻿Klient s.r.o.", reporter: "bom@x.example", createdAt: "2026-10-30T10:00:00+01:00" })], "review", "REPORTER_DATA_INVALID"],
    ["createdAt after shippedAt", [order((o) => { o.createdAt = "2026-10-10T10:00:00+02:00"; })], "review", "INVALID_TIMESTAMP"],
    ["createdAt after the decision time", [order((o) => { o.createdAt = "2026-12-01T10:00:00+01:00"; })], "review", "INVALID_TIMESTAMP"],
    ["packedAt after shippedAt", [order((o) => { o.packedAt = "2026-10-10T10:00:00+02:00"; })], "review", "INVALID_TIMESTAMP"],
    ["updatedAt after the decision time", [order((o) => { o.updatedAt = "2027-01-01T10:00:00+01:00"; })], "review", "INVALID_TIMESTAMP"],
  ];
  for (const [label, mutations, action, code] of cases) {
    it(`${label} → ${action.toUpperCase()} (${code})`, () => {
      const d = decide(...mutations);
      assert.equal(d.execution.action, action);
      assert.ok(codes(d).includes(code as never), codes(d).join(","));
    });
  }

  it("controls: pick-up on the shipment day (calendar-day precision), unrelated malformed rows → CREATE", () => {
    assert.equal(decide(order((o) => { o.shippedAt = "2026-10-09T15:21:00+02:00"; o.updatedAt = o.shippedAt; })).execution.action, "create");
    assert.equal(decide(order((o) => { o.shippedAt = "2026-10-09T15:20:00+02:00"; })).execution.action, "create");
    assert.equal(decide(addOrder({ orderId: "00000000-0000-4000-8000-000000000780", orderNumber: "MS-EX-B-0780", trackingNumber: "PNEXB0780", status: "lost_somewhere" })).execution.action, "create");
    // A malformed complaint without a client that refers to an order of ANOTHER client does not matter.
    assert.equal(decide(addOrder({ orderId: "00000000-0000-4000-8000-000000000781", orderNumber: "MS-EX-B-0781", client: "Jiný Klient", trackingNumber: "PNEXB0781" }),
      editJson("complaints.json", (c) => c.push({ complaintId: "x", orderNumber: "MS-EX-B-0781", status: "bogus", createdAt: "2026-10-30T10:00:00+01:00" }))).execution.action, "create");
  });

  it("B1–B6: unrelated records with non-ASCII identifiers do not stop CREATE of other orders", () => {
    for (const m of [
      setMatrix("client,reporter\nVelký Klient s.r.o.,reklamace@velky-klient.example\nGroßhandel Müller GmbH,ops@mueller.example\n"),
      setMatrix("client,reporter\nVelký Klient s.r.o.,reklamace@velky-klient.example\nØresund ApS,ops@oresund.example\n"),
      addComplaint({ orderNumber: "PL-1", client: "Łódź Sklep", reporter: "a@lodz.example" }),
      addComplaint({ orderNumber: "US-1", client: "Kelly’s Store", reporter: "a@kelly.example" }),
      (d: string) => writeFileSync(join(d, "returns.json"), JSON.stringify([{ returnId: "r-x", orderNumber: "ÆRØ-77", status: "Připraveno", createdAt: "2026-10-31T10:00:00+01:00" }])),
      addComplaint({ orderNumber: "BESTELLUNG-Straße-9", client: "Großhandel Müller GmbH", reporter: "a@mueller.example" }),
    ]) assert.equal(decide(m).execution.action, "create");
  });

  it("returns and deliveries in their exact known wording are still RETURNING / DELIVERED (SKIP)", () => {
    assert.equal(parseKuryrVltava(kvMessage("Zásilku vracíme odesílateli. Důvod: adresát na uvedené adrese neznámý.")).state, "RETURNING");
    assert.equal(parseKuryrVltava(kvMessage("Zásilka byla vrácena odesílateli.")).state, "RETURNING");
    assert.equal(parseKuryrVltava(kvMessage("Zásilka může být vrácena odesílateli.")).state, "UNKNOWN");
    assert.equal(parseParcelNord(rowsOf(row("29. 10. 2026", "10:05", "Odesílatel", "Zásilka vrácena odesílateli"), pickedUp("19. 10. 2026", "09:00"))).state, "RETURNING");
    assert.equal(decide(setPage(rowsOf(row("29. 10. 2026", "10:05", "Odesílatel", "Zásilka vrácena odesílateli"), pickedUp("19. 10. 2026", "09:00")))).execution.action, "skip");
  });
});
