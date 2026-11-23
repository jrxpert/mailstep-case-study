// Baseline regression gate: runs the real CLI on a fresh copy of data/ and compares every output with
// the pinned full SHA-256 (scripts/baseline-outputs.json). Never reads an existing out/ and never
// writes to data/. Exit 0 = identical; exit 1 = any difference (with a summary of what changed).
//
// Usage: npm run verify:baseline

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const pinned = JSON.parse(readFileSync(join(ROOT, "scripts", "baseline-outputs.json"), "utf8"));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const treeHash = (dir: string) => {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(dir, p)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
};

const failures: string[] = [];
const fixturesBefore = treeHash(join(ROOT, "data"));
const ws = mkdtempSync(join(tmpdir(), "mailstep-verify-baseline-"));
try {
  cpSync(join(ROOT, "data"), join(ws, "data"), { recursive: true });
  // cwd = workspace and the default relative paths, so recorded source paths equal the pinned run.
  const run = spawnSync(process.execPath, [join(ROOT, "src", "cli.ts")], { cwd: ws, encoding: "utf8" });
  if (run.status !== 0) failures.push(`CLI exit code ${run.status} (expected 0)\n${run.stderr}`);

  for (const [file, expected] of Object.entries<string>(pinned.sha256)) {
    const p = join(ws, "out", file);
    if (!existsSync(p)) { failures.push(`missing output ${file}`); continue; }
    const actual = sha(p);
    if (actual !== expected) failures.push(`${file}: SHA-256 ${actual} ≠ pinned ${expected}`);
  }

  // Meaningful differences, reported even when hashes already failed.
  const dPath = join(ws, "out", "decisions.json");
  const ePath = join(ws, "out", "tracking-eval.json");
  if (existsSync(dPath) && existsSync(ePath)) {
    const d = JSON.parse(readFileSync(dPath, "utf8"));
    const e = JSON.parse(readFileSync(ePath, "utf8"));
    const x = pinned.expected;
    const check = (label: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: ${JSON.stringify(actual)} ≠ expected ${JSON.stringify(expected)}`);
    };
    check("source rows", d.summary.sourceRows.orders, x.sourceRows);
    check("logical orders", d.summary.logicalOrders, x.logicalOrders);
    check("eligibility", d.summary.eligibility, x.eligibility);
    check("actions", d.summary.actions, x.actions);
    check("tracking", { total: e.total, correct: e.correct, critical: e.errorsByCategory.CRITICAL }, x.tracking);
    console.log(`decisions: ${JSON.stringify(d.summary.actions)} | eligibility: ${JSON.stringify(d.summary.eligibility)} | tracking: ${e.correct}/${e.total}, critical ${e.errorsByCategory.CRITICAL}`);
  }
} finally {
  rmSync(ws, { recursive: true, force: true });
}
if (treeHash(join(ROOT, "data")) !== fixturesBefore) failures.push("data/ changed during verification");

if (failures.length > 0) {
  console.error(`BASELINE MISMATCH (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`baseline OK: ${Object.keys(pinned.sha256).length} outputs byte-identical to the pinned SHA-256`);
