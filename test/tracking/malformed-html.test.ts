// Malformed tracking HTML must make only the affected page UNKNOWN, never abort the batch.
// All fixtures are temporary copies; data/ is never modified.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decideAll } from "../../src/decision/decide.ts";
import { loadInputs } from "../../src/io/load.ts";
import { classifyTrackingPage } from "../../src/tracking/classify.ts";
import { MalformedHtmlError, decodeEntities } from "../../src/tracking/html.ts";
import { pageTrackingProvider } from "../../src/tracking/lookup.ts";
import { DATA_DIR, NOW, decideExample } from "../helpers.ts";

const PN114 = readFileSync(join(DATA_DIR, "tracking", "PN55100114.html"), "utf8");
const inject = (html: string, text: string) => html.replace("Zásilka zpracována</td></tr>", `Zásilka zpracována ${text}</td></tr>`);

describe("decodeEntities", () => {
  it("decodes valid named, decimal and hex references", () => {
    assert.equal(decodeEntities("a &amp; b &#65;&#x42; &nbsp;"), "a & b AB  ");
  });
  for (const bad of ["&#1114112;", "&#x110000;", "&#xD800;", "&#57343;", "&#99999999999999999999;"]) {
    it(`throws MalformedHtmlError for ${bad}`, () => assert.throws(() => decodeEntities(bad), MalformedHtmlError));
  }
});

describe("classifier boundary", () => {
  it("1. invalid numeric entity → UNKNOWN with a diagnostic reason", () => {
    const c = classifyTrackingPage(inject(PN114, "&#1114112;"));
    assert.equal(c.state, "UNKNOWN");
    assert.equal(c.reliable, false);
    assert.match(c.reason, /malformed tracking page: invalid numeric character reference &#1114112;/);
  });

  it("2. multiple invalid entities → UNKNOWN", () => {
    assert.equal(classifyTrackingPage(inject(PN114, "&#xD800; &#1114112; &#x110000;")).state, "UNKNOWN");
  });

  it("only MalformedHtmlError is absorbed: a programming error (non-string input) still propagates", () => {
    assert.throws(() => classifyTrackingPage(null as unknown as string), TypeError);
  });

  it("3. invalid entity mixed with valid ones → UNKNOWN; the same page with only valid ones is classified normally", () => {
    assert.equal(classifyTrackingPage(inject(PN114, "&amp; &#x41; &#1114112;")).state, "UNKNOWN");
    // Valid entities decode normally (the event text must still be a known sentence exactly).
    const valid = PN114.replace("<td>Zásilka zpracována</td></tr>", "<td>&#x5A;ásilka zpracov&#225;na</td></tr>");
    assert.notEqual(valid, PN114);
    assert.equal(classifyTrackingPage(valid).state, "IN_TRANSIT");
    // Extra text after a known in-transit sentence is no longer that sentence → UNKNOWN (fail closed).
    assert.equal(classifyTrackingPage(inject(PN114, "&amp; &#x41;")).state, "UNKNOWN");
  });
});

describe("batch isolation", () => {
  it("4. one malformed page among valid pages: only that order changes, all others are unaffected", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailstep-q04-"));
    try {
      cpSync(DATA_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "tracking", "PN55100114.html"), inject(PN114, "&#1114112;"));
      const run = (d: string) => {
        const inputs = loadInputs(d);
        return decideAll(inputs, NOW, { tracking: pageTrackingProvider(join(d, "tracking"), inputs.orders.valid.map((v) => v.record)) });
      };
      const base = run(DATA_DIR);
      const broken = run(dir);
      assert.equal(broken.decisions.length, 32);
      const changed = broken.decisions.filter((d, i) => JSON.stringify(d) !== JSON.stringify(base.decisions[i])).map((d) => d.key);
      assert.deepEqual(changed, ["MS-2026-120114"]);
      const d = broken.decisions.find((x) => x.key === "MS-2026-120114");
      assert.equal(d?.execution.action, "review");
      const r = d?.execution.reasons.find((x) => x.code === "TRACKING_UNKNOWN");
      assert.match(r?.detail ?? "", /malformed tracking page/);
      assert.deepEqual(broken.summary.actions, { create: 0, skip: 14, review: 18 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("6. a malformed page cannot lead to CREATE (definition B)", () => {
    const r = decideExample((dir) => {
      const page = join(dir, "tracking", "PNEXB0001.html");
      writeFileSync(page, inject(readFileSync(page, "utf8"), "&#1114112;"));
    });
    const d = r.decisions.find((x) => x.key === "MS-EX-B-0001");
    assert.equal(d?.execution.action, "review");
    assert.ok(d?.execution.reasons.some((x) => x.code === "TRACKING_UNKNOWN" && /malformed/.test(x.detail ?? "")));
    assert.equal(r.summary.actions.create, 1); // only the unaffected definition-A order
  });
});
