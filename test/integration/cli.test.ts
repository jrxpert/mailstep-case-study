// Process-level integration tests: the real CLI (`node src/cli.ts`) on temporary copies of real files.
// The supplied fixtures and the synthetic example are never modified.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "src", "cli.ts");
/** Pinned default-run outputs; single source of truth shared with `npm run verify:baseline`. */
const BASELINE_SHA256: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "scripts", "baseline-outputs.json"), "utf8")).sha256;

const scratch = mkdtempSync(join(tmpdir(), "mailstep-cli-it-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
/** Fresh working directory holding a copy of `data/` (as ./data) and of examples/create (as ./example). */
function workspace(): string {
  const ws = join(scratch, String(n++));
  cpSync(join(ROOT, "data"), join(ws, "data"), { recursive: true });
  cpSync(join(ROOT, "examples", "create"), join(ws, "example"), { recursive: true });
  return ws;
}
const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const byKey = (d: any, k: string) => d.decisions.find((x: any) => x.key === k);
const codes = (x: any) => x.execution.reasons.map((r: any) => r.code);
const EXAMPLE_ARGS = ["--data", "example", "--out", "out-example", "--skip-eval"];

describe("A. default pipeline (real CLI, copy of the supplied fixtures)", () => {
  const ws = workspace();
  const r = cli(ws);
  const out = join(ws, "out");

  it("exits 0 and writes the three outputs", () => {
    assert.equal(r.status, 0, r.stderr);
    for (const f of Object.keys(BASELINE_SHA256)) assert.ok(existsSync(join(out, f)), f);
  });

  it("decision and evaluation figures", () => {
    const d = json(join(out, "decisions.json"));
    assert.equal(d.summary.sourceRows.orders, 33);
    assert.equal(d.summary.logicalOrders, 32);
    assert.deepEqual(d.summary.eligibility, { eligible: 23, ineligible: 9, undetermined: 0 });
    assert.deepEqual(d.summary.actions, { create: 0, skip: 14, review: 18 });
    const e = json(join(out, "tracking-eval.json"));
    assert.deepEqual([e.total, e.correct, e.errorsByCategory.CRITICAL], [20, 16, 0]);
  });

  it("outputs are byte-identical to the pinned baseline", () => {
    for (const [f, expected] of Object.entries(BASELINE_SHA256)) assert.equal(sha(join(out, f)), expected, f);
  });
});

describe("B. synthetic CREATE example (real CLI, no special flags)", () => {
  const ws = workspace();
  const r = cli(ws, ...EXAMPLE_ARGS);
  const d = r.status === 0 ? json(join(ws, "out-example", "decisions.json")) : null;

  it("exits 0; the example has no labels.csv, so decisions cannot depend on it", () => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(ws, "example", "tracking", "labels.csv")), false);
  });

  it("2 CREATE: definition A (not_collected_by_carrier) and definition B (loss)", () => {
    assert.deepEqual(d.summary.actions, { create: 2, skip: 0, review: 0 });
    assert.deepEqual([byKey(d, "MS-EX-A-0001").eligibility.complaintReason, codes(byKey(d, "MS-EX-A-0001"))], ["not_collected_by_carrier", ["BUSINESS_ELIGIBLE", "REPORTER_RESOLVED", "TRACKING_NOT_REQUIRED"]]);
    assert.deepEqual([byKey(d, "MS-EX-B-0001").eligibility.complaintReason, codes(byKey(d, "MS-EX-B-0001"))], ["loss", ["BUSINESS_ELIGIBLE", "REPORTER_RESOLVED", "TRACKING_IN_TRANSIT"]]);
    assert.match(r.stdout, /MS-EX-A-0001\s+create A eligible\s+→ not_collected_by_carrier/);
    assert.match(r.stdout, /MS-EX-B-0001\s+create B eligible\s+→ loss/);
  });
});

describe("C. malformed tracking page (real CLI)", () => {
  const ws = workspace();
  const page = join(ws, "data", "tracking", "PN55100114.html");
  writeFileSync(page, readFileSync(page, "utf8").replace("Zásilka zpracována</td></tr>", "Zásilka zpracována &#1114112; &#xD800;</td></tr>"));
  const r = cli(ws);
  const cleanWs = workspace();
  const clean = cli(cleanWs);

  it("the process completes and writes all outputs", () => {
    assert.equal(r.status, 0, r.stderr);
    for (const f of Object.keys(BASELINE_SHA256)) assert.ok(existsSync(join(ws, "out", f)), f);
  });

  it("only the affected order changes; it fails closed with a diagnostic", () => {
    const d = json(join(ws, "out", "decisions.json"));
    assert.equal(clean.status, 0, clean.stderr);
    const base = json(join(cleanWs, "out", "decisions.json"));
    const changed = d.decisions.filter((x: any, i: number) => JSON.stringify(x) !== JSON.stringify(base.decisions[i])).map((x: any) => x.key);
    assert.deepEqual(changed, ["MS-2026-120114"]);
    const x = byKey(d, "MS-2026-120114");
    assert.equal(x.execution.action, "review");
    assert.match(x.execution.reasons.find((q: any) => q.code === "TRACKING_UNKNOWN").detail, /malformed tracking page/);
    assert.deepEqual(d.summary.actions, { create: 0, skip: 14, review: 18 });
  });

  it("the evaluation records the page as a conservative abstention, not a crash", () => {
    const e = json(join(ws, "out", "tracking-eval.json"));
    assert.deepEqual([e.total, e.correct, e.errorsByCategory.CRITICAL, e.errorsByCategory.CONSERVATIVE_ABSTENTION], [20, 15, 0, 5]);
  });
});

describe("D. order identity across malformed rows (real CLI)", () => {
  it("a malformed order row claiming the same tracking number makes the page mapping ambiguous → REVIEW", () => {
    const ws = workspace();
    const file = join(ws, "example", "orders.json");
    const orders = json(file);
    orders.push({ ...orders[1], orderId: "00000000-0000-4000-8000-000000000777", orderNumber: "MS-EX-X-0777", status: "lost_somewhere" });
    writeFileSync(file, JSON.stringify(orders));
    const r = cli(ws, ...EXAMPLE_ARGS);
    assert.equal(r.status, 0, r.stderr);
    const d = byKey(json(join(ws, "out-example", "decisions.json")), "MS-EX-B-0001");
    assert.equal(d.execution.action, "review");
    assert.ok(codes(d).includes("TRACKING_UNAVAILABLE"));
  });

  it("removed verification flags are rejected (no hidden CREATE mode)", () => {
    const ws = workspace();
    for (const flag of ["--verification-policy", "--retrievals"]) {
      const r = cli(ws, ...EXAMPLE_ARGS, flag, "x");
      assert.notEqual(r.status, 0, flag);
      assert.match(r.stderr, /Unknown option/);
    }
  });
});

describe("F. CLI input errors: clear message, correct exit code, no stack trace", () => {
  const noStack = (stderr: string) => assert.ok(!/\n\s+at /.test(stderr), `stack trace leaked:\n${stderr}`);

  it("invalid --now → exit 2", () => {
    const r = cli(workspace(), "--now", "2026-11-02 07:30");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--now must be ISO 8601 with offset/);
    noStack(r.stderr);
  });

  it("missing mandatory input (orders.json) → exit 2, nothing written", () => {
    const ws = workspace();
    rmSync(join(ws, "data", "orders.json"));
    const r = cli(ws);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /orders\.json: required input file not found/);
    assert.equal(existsSync(join(ws, "out", "decisions.json")), false);
    noStack(r.stderr);
  });

  it("malformed mandatory input (orders.json is not JSON) → exit 2", () => {
    const ws = workspace();
    writeFileSync(join(ws, "data", "orders.json"), "[{");
    const r = cli(ws);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid JSON/);
    noStack(r.stderr);
  });

  it("missing labels.csv → decisions.json written, evaluation fails with exit 1 and a clear message", () => {
    const ws = workspace();
    rmSync(join(ws, "data", "tracking", "labels.csv"));
    const r = cli(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reference labels not found/);
    assert.ok(existsSync(join(ws, "out", "decisions.json")));
    assert.equal(sha(join(ws, "out", "decisions.json")), BASELINE_SHA256["decisions.json"]); // decisions do not depend on labels
    noStack(r.stderr);
  });

  it("missing tracking directory → exit 1 with a clear message; all orders still decided", () => {
    const ws = workspace();
    rmSync(join(ws, "data", "tracking"), { recursive: true });
    const r = cli(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /tracking directory not found/);
    assert.equal(json(join(ws, "out", "decisions.json")).summary.logicalOrders, 32);
    noStack(r.stderr);
  });

  it("invalid label row → exit 1 naming the problem", () => {
    const ws = workspace();
    const f = join(ws, "data", "tracking", "labels.csv");
    writeFileSync(f, readFileSync(f, "utf8").replace("KV2026100101.html,Kurýr Vltava,KV2026100101,IN_TRANSIT,", "KV2026100101.html,Kurýr Vltava,KV2026100101,LOST,"));
    const r = cli(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid label row.*"expected_state" "LOST"/);
    noStack(r.stderr);
  });

  it("--out pointing at an existing file → exit 2 with a clear message, no stack trace", () => {
    const ws = workspace();
    writeFileSync(join(ws, "not-a-dir"), "x");
    const r = cli(ws, "--out", "not-a-dir/sub");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /FATAL cannot write output/);
    noStack(r.stderr);
  });

  it("unreadable tracking page (a directory named *.html) → decisions.json written, evaluation exit 1, no stack trace", () => {
    const ws = workspace();
    mkdirSync(join(ws, "data", "tracking", "ZZ0000000.html"));
    const r = cli(ws);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read tracking page/);
    assert.equal(sha(join(ws, "out", "decisions.json")), BASELINE_SHA256["decisions.json"]);
    noStack(r.stderr);
  });

  it("--skip-eval with missing labels → exit 0", () => {
    const ws = workspace();
    rmSync(join(ws, "data", "tracking", "labels.csv"));
    assert.equal(cli(ws, "--skip-eval").status, 0);
  });
});
