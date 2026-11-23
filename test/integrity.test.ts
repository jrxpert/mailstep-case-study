// Input-integrity guards (docs/input-integrity-audit.md).
// These tests protect provenance, not behaviour: they fail if provided fixtures change or if
// any file is added to data/ — including a fabricated reporters.csv.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadComplaints, loadReturns } from "../src/io/load.ts";

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

/** SHA-256 of every file supplied by Mailstep, unchanged (PROVIDED). */
const PROVIDED_MANIFEST: Record<string, string> = {
  "complaints.json": "d678bd443e5ff99bc0a9ebb70251a7509a55d488a19a6e954a2578116454ec80",
  "orders.json": "856a9ae670a100c4d3bfcc2e6df162d3ade826444acbad287507a52929a596f2",
  "returns.json": "84ef9457d607ed90cc069192a5b5639973a0e623ae7b8776e2f6e05ba324b3f9",
  "rules.yaml": "58b7b2baa21b37b107d1d731c6ea739f41a6243784aef7b894908cbf10fd6835",
  "tracking/DT9100112.html": "987f8b3906c9b19d74f5a9420fb9f7a1c62d7106e803b9bb5b06a0dfaa428d68",
  "tracking/DT9100124.html": "02b61d3b210a7368ef1dc80e02e08340c3032f820a4cd4ac46c16bb2716c4bf4",
  "tracking/DT9100197.html": "dfcd72a2598a84513e61bd48752d879f3a023b6b39d83120f5b90f4b5196ba55",
  "tracking/DT9100198.html": "3c03fc582ebfb6e6e5954ffcde5fe803f5a0554181b7c03aa8f3751fc1cd7c66",
  "tracking/EX7710113.html": "efa5aedf6d5a926028bac75a8704cf0e39bf2d35a4c189e476914adb3c8d27c8",
  "tracking/EX7710117.html": "25117d4369d94f5cfd3711df03bf09669b3f5335117955276cb04e1385483c50",
  "tracking/EX7710194.html": "50d48c14345dfbee299b4cdaeee835d944850a348fca634c0e5afa7165fccd0c",
  "tracking/EX7710195.html": "77259ac315b5479dc50c278dc9fb10ba2c88541cf9a9eba9f9bf8e414a2341e5",
  "tracking/EX7710196.html": "f4c300057e8e84579370c559038ee47d26cf6d42f87681996ff31ca392f5f829",
  "tracking/KV2026100101.html": "5546a2cb7d7876f2ef01e5398b2bd8a9ecd9710a6721f41d8f895fa43244c6f7",
  "tracking/KV2026100105.html": "e02b67737957fc101b6b7d3e6a1d68be767c93cea981eb78a3ee831976ab7ab8",
  "tracking/KV2026100115.html": "d2e6c83e16aa875cea54c698ef924b3d34979b03ce9fdc1f5c842a597aa36dc5",
  "tracking/KV2026100118.html": "eec9318a087cc27639bc484df067c51fc7249e6e58d31e82495da4f443e65d23",
  "tracking/KV2026100123.html": "4589178b73a2437bc889587b83f30c0eae29ec5c4df92bbd1ddfb7566ab777db",
  "tracking/KV2026100190.html": "451e08464feacec7aca8d6dd5dcc5dfa21eada38c1291d0df2da84184ca04e90",
  "tracking/PN55100114.html": "cf5f6dea91d24ba36389bc8da3d4439c7eb064a9f49eaa939623fd2152d3a9f5",
  "tracking/PN55100116.html": "b492b99416cd7a524067299c1ee8946481b431e72524658b393760de89ccdbaa",
  "tracking/PN55100191.html": "42e3b375af3c3c8e953618aa606c8659ca64bd122277001d80d5486f3efff274",
  "tracking/PN55100192.html": "a11dd02ad2efa302fc49e4f2aace372f554b07612efc9438444ff910785a9317",
  "tracking/PN55100193.html": "c3d7fce1a8f9f2c0e5e7641f6e3a329feeb46a7df44abdfe310ec82369cea232",
  "tracking/labels.csv": "4455b7679507d4b51c7f1692b12cfb241efb8c9693a9cf968bf17c53b81cb630",
};

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(DATA_DIR, join(e.parentPath, e.name)).split("\\").join("/"))
    .sort();
}

describe("provided fixtures", () => {
  it("data/ contains exactly the provided files — nothing added, nothing removed", () => {
    assert.deepEqual(listFiles(DATA_DIR), Object.keys(PROVIDED_MANIFEST).sort());
  });

  it("every provided file is byte-identical to the committed original", () => {
    for (const [file, sha] of Object.entries(PROVIDED_MANIFEST)) {
      const actual = createHash("sha256").update(readFileSync(join(DATA_DIR, file))).digest("hex");
      assert.equal(actual, sha, `${file} was modified`);
    }
  });

  it("reporters.csv is MISSING (referenced by the assignment, not supplied) and has not been generated", () => {
    assert.equal(existsSync(join(DATA_DIR, "reporters.csv")), false);
  });
});

describe("hazard: invalid records must stay visible to the future decision engine", () => {
  const scratch = mkdtempSync(join(tmpdir(), "mailstep-integrity-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  // SYNTHETIC_TEST: an existing complaint with an unknown status. If the engine only consulted
  // `valid`, it would see no complaint for MS-X and could create a duplicate.
  it("an invalid complaint keeps its orderNumber in raw, so the order can be blocked fail-safe", () => {
    const path = join(scratch, "complaints.json");
    writeFileSync(path, JSON.stringify([{ complaintId: "c", orderNumber: "MS-X", client: "X", status: "cancelled", reason: "loss", reporter: "r@x.example", createdAt: "2026-10-01T10:00:00+02:00" }]));
    const c = loadComplaints(path);
    assert.equal(c.valid.length, 0);
    assert.equal(c.invalid.length, 1);
    assert.equal((c.invalid[0]?.raw as { orderNumber?: unknown }).orderNumber, "MS-X");
  });

  it("an invalid return keeps its orderNumber in raw", () => {
    const path = join(scratch, "returns.json");
    writeFileSync(path, JSON.stringify([{ returnId: "r", orderNumber: "MS-Y", status: "Připraveno", createdAt: "31. 10. 2026" }]));
    const r = loadReturns(path);
    assert.equal(r.valid.length, 0);
    assert.equal((r.invalid[0]?.raw as { orderNumber?: unknown }).orderNumber, "MS-Y");
  });
});
