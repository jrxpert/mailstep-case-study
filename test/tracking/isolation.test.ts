// labels.csv is evaluation ground truth. It must never reach the classifier or a decision.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decideAll } from "../../src/decision/decide.ts";
import { loadInputs } from "../../src/io/load.ts";
import { runTrackingEvaluation } from "../../src/tracking/evaluate.ts";
import { pageTrackingProvider } from "../../src/tracking/lookup.ts";
import { DATA_DIR, NOW } from "../helpers.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/**
 * Files reachable through relative RUNTIME imports, with the names each file imports.
 * `import type` is skipped: it is erased at runtime and cannot carry data.
 */
function importGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, "utf8");
    const names: string[] = [];
    seen.set(file, names);
    for (const m of src.matchAll(/import\s+(?!type\s)(?:\{([^}]*)\}|[\w*\s,]+)\s+from\s+"(\.[^"]+)"/g)) {
      names.push(...(m[1] ?? "").split(",").map((n) => n.replace(/^\s*type\s+/, "").trim()).filter(Boolean));
      visit(resolve(dirname(file), m[2] ?? ""));
    }
  };
  visit(entry);
  return seen;
}

describe("runtime isolation from labels.csv", () => {
  for (const entry of ["tracking/classify.ts", "tracking/lookup.ts", "decision/decide.ts"]) {
    it(`${entry}: no import path reaches the evaluator or the label loader`, () => {
      const graph = importGraph(join(SRC, entry));
      for (const [file, names] of graph) {
        assert.ok(!file.endsWith(join("tracking", "evaluate.ts")), `${entry} reaches evaluate.ts via ${file}`);
        assert.ok(!names.includes("loadTrackingLabels"), `${file} imports loadTrackingLabels`);
        assert.ok(!names.includes("TrackingLabel"), `${file} imports TrackingLabel`);
        // String literals only (comments may legitimately say "never reads labels.csv").
        assert.ok(!/["'`][^"'`\n]*labels\.csv/.test(readFileSync(file, "utf8")), `${file} references labels.csv in code`);
      }
    });
  }

  describe("behavioural check: decisions are identical without labels and with corrupted labels", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mailstep-isolation-"));
    after(() => rmSync(tmp, { recursive: true, force: true }));
    const src = join(DATA_DIR, "tracking");
    for (const f of readdirSync(src).filter((f) => f.endsWith(".html"))) copyFileSync(join(src, f), join(tmp, f));

    const inputs = loadInputs(DATA_DIR);
    const orders = inputs.orders.valid.map((v) => v.record);
    const decide = (dir: string) => JSON.stringify(decideAll(inputs, NOW, { tracking: pageTrackingProvider(dir, orders) }));

    it("no labels.csv present → same decisions as with the real labels", () => {
      assert.equal(decide(tmp), decide(src));
    });

    it("every label flipped → same decisions; only the evaluation changes", () => {
      const flipped = readFileSync(join(src, "labels.csv"), "utf8")
        .split("\n")
        .map((line, i) => (i === 0 || line === "" ? line : line.replace(/,(DELIVERED|IN_TRANSIT|RETURNING|UNKNOWN),/, (_m, s: string) => `,${s === "UNKNOWN" ? "DELIVERED" : "UNKNOWN"},`)))
        .join("\n");
      writeFileSync(join(tmp, "labels.csv"), flipped);
      assert.equal(decide(tmp), decide(src));
      const real = runTrackingEvaluation(src);
      const fake = runTrackingEvaluation(tmp);
      assert.deepEqual(fake.cases.map((c) => c.predicted), real.cases.map((c) => c.predicted)); // predictions unchanged
      assert.notEqual(fake.correct, real.correct); // only the scoring moved
    });
  });
});
