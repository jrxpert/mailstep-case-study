// Entry point: load inputs → decide → write out/decisions.json and print a summary.
// Output is deterministic: no run timestamps or random ids, stable ordering.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decideAll } from "./decision/decide.ts";
import { InputError, inputPaths, loadInputs } from "./io/load.ts";
import type { Order, TrackingVerification } from "./domain/types.ts";
import { REFERENCE_NOW, parseIsoInstant, pragueDate } from "./time/pragueDays.ts";
import { renderMarkdown, runTrackingEvaluation } from "./tracking/evaluate.ts";
import type { FetchLike } from "./tracking/llm/client.ts";
import { loadLlmConfig, readDotEnv } from "./tracking/llm/config.ts";
import { IncidentLog } from "./tracking/llm/incidents.ts";
import { applyLlmResult, collectUnknownPages, refineUnknownPages, type LlmRunReport } from "./tracking/llm/refine.ts";
import { allOrderRows, pageTrackingProvider } from "./tracking/lookup.ts";

const sha256 = (path: string): string | null =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      data: { type: "string", default: "data" },
      now: { type: "string", default: REFERENCE_NOW },
      out: { type: "string", default: "out" },
      "skip-eval": { type: "boolean", default: false },
    },
  });
  if (parseIsoInstant(values.now) === null) {
    console.error(`FATAL --now must be ISO 8601 with offset, got ${JSON.stringify(values.now)}`);
    return 2;
  }

  let inputs;
  try {
    inputs = loadInputs(values.data);
  } catch (e) {
    if (e instanceof InputError) {
      console.error(`FATAL input error — ${e.message}`);
      return 2;
    }
    throw e;
  }

  // Decisions consume classifier output from the saved pages. Labels are never passed in.
  const trackingDir = join(values.data, "tracking");
  let tracking: (order: Order) => TrackingVerification = pageTrackingProvider(trackingDir, allOrderRows(inputs.orders));

  // Optional LLM second opinion on UNKNOWN pages (off by default; docs/llm-tracking-evaluation.md).
  // Settings come from the environment, then from ./.env (TRACKING_LLM_* and TOGETHER_* only).
  const dotEnv = readDotEnv(".env");
  const llm = loadLlmConfig({ ...dotEnv.values, ...process.env });
  for (const d of [...(dotEnv.problem ? [dotEnv.problem] : []), ...llm.diagnostics]) console.error(`LLM: ${d}`);
  let llmReport: LlmRunReport | null = null;
  if (llm.mode !== "off") {
    const pages = collectUnknownPages(inputs.orders.valid.map((v) => v.record), tracking, (page) => readFileSync(join(trackingDir, page), "utf8"));
    const incidents = new IncidentLog(llm.incidentLog ?? join(values.out, "llm-incidents.jsonl"), llm.model);
    try {
      llmReport = await refineUnknownPages(llm, pages, pragueDate(parseIsoInstant(values.now) as number), fetch as unknown as FetchLike, { incidents });
    } finally {
      await incidents.flush();
    }
    if (llmReport.incidents.length > 0) console.error(`LLM: ${llmReport.incidents.length} provider incident(s) recorded in ${incidents.path}`);
    if (llm.mode === "active") {
      const byPage = new Map(llmReport.results.map((r) => [r.page, r]));
      const deterministic = tracking;
      tracking = (order) => {
        const t = deterministic(order);
        return t.status === "classified" ? { ...t, classification: applyLlmResult(t.classification, byPage.get(t.page), llm.model) } : t;
      };
    }
  }
  const report = decideAll(inputs, values.now, { tracking });
  const sources = Object.fromEntries(
    Object.entries(inputPaths(values.data)).map(([name, path]) => [name, { path, sha256: sha256(path) }]),
  );
  const { referenceTime, ...rest } = report;
  const payload = { referenceTime, sources, ...rest };
  const outFile = join(values.out, "decisions.json");
  try {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (e) {
    console.error(`FATAL cannot write output ${outFile}: ${(e as Error).message}`);
    return 2;
  }

  const s = report.summary;
  console.log(`Reference time: ${report.referenceTime} (Europe/Prague calendar days)`);
  console.log(`Source order rows: ${s.sourceRows.orders} → logical orders: ${s.logicalOrders}`);
  for (const g of s.duplicateGroups) console.log(`  duplicate group ${g.key}: ${g.kind}, rows ${g.sourceRows.join(", ")}`);
  console.log(`Inputs: complaints ${s.sourceRows.complaints.valid} valid / ${s.sourceRows.complaints.invalid} invalid; returns ${s.sourceRows.returns.valid} valid / ${s.sourceRows.returns.invalid} invalid`);
  console.log(`Reporter matrix: ${inputs.reporterMatrix.status}${inputs.reporterMatrix.status === "missing" ? " (reporters.csv not supplied — eligible orders go to review)" : ""}`);
  console.log(`Integrity findings: ${report.integrityFindings.length}`);
  console.log(`Business eligibility: ${s.eligibility.eligible} eligible, ${s.eligibility.ineligible} ineligible, ${s.eligibility.undetermined} undetermined`);
  console.log(`Actions: create ${s.actions.create}, skip ${s.actions.skip}, review ${s.actions.review}`);
  console.log(`Categories: ${Object.entries(s.categories).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log("");
  for (const d of report.decisions) {
    const codes = d.execution.reasons.filter((r) => r.effect !== "info").map((r) => r.code);
    const label = (d.orderNumber ?? `<${d.key}>`).padEnd(16);
    const elig = `${d.eligibility.definition ?? "-"} ${d.eligibility.status}`.padEnd(15);
    const detail = d.execution.action === "create" ? `→ ${d.eligibility.complaintReason}` : codes.join(", ");
    console.log(`  ${label} ${d.execution.action.padEnd(6)} ${elig} ${detail}`);
  }
  console.log(`\nWrote ${outFile}`);
  if (llmReport !== null) {
    const llmFile = join(values.out, "llm-tracking.json");
    writeFileSync(llmFile, `${JSON.stringify(llmReport, null, 2)}\n`);
    const t = llmReport.totals;
    console.log(`LLM (${llmReport.mode}, ${llmReport.model}): ${t.calls} call(s), ${t.validated} validated, ${t.usableInActiveMode} usable in active mode, $${t.costUsd} (${t.costSource}) → ${llmFile}`);
  }

  if (values["skip-eval"]) {
    console.log("Tracking evaluation skipped (--skip-eval).");
    return 0;
  }

  // Evaluation: a separate step. It is the only place labels.csv is read.
  let evaluation;
  try {
    evaluation = runTrackingEvaluation(trackingDir);
  } catch (e) {
    if (e instanceof InputError) {
      console.error(`FATAL evaluation input error — ${e.message} (${outFile} was written; run with --skip-eval to skip the evaluation)`);
      return 1;
    }
    throw e;
  }
  try {
    writeFileSync(join(values.out, "tracking-eval.json"), `${JSON.stringify(evaluation, null, 2)}\n`);
    writeFileSync(join(values.out, "tracking-eval.md"), renderMarkdown(evaluation));
  } catch (e) {
    console.error(`FATAL cannot write evaluation output in ${values.out}: ${(e as Error).message}`);
    return 1;
  }
  console.log(`Tracking evaluation: ${evaluation.correct}/${evaluation.total} correct (accuracy ${evaluation.accuracy}), UNKNOWN rate ${evaluation.unknownRate}, errors by category ${JSON.stringify(evaluation.errorsByCategory)}`);
  console.log(`Wrote ${join(values.out, "tracking-eval.json")}, ${join(values.out, "tracking-eval.md")}`);
  return 0;
}

process.exitCode = await main();
