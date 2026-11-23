// Live, budget-limited evaluation of the optional LLM tracking classifier (never run in CI).
//   E1  deterministic parsers on data/tracking (same as `npm start`)
//   E2  LLM shadow run on the pages E1 classifies UNKNOWN, scored against labels.csv
//   E3  decision simulation: baseline vs. active policy vs. an unvalidated counterfactual
// Labels are joined only after classification, as in src/tracking/evaluate.ts.
//
// Usage: TRACKING_LLM_ENABLED=true TRACKING_LLM_MODEL=<model> TOGETHER_API_KEY=… npm run llm:eval
//        (settings may also come from ./.env; the key from TOGETHER_ENV_FILE=<dotenv file>)

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideAll, type DecisionReport } from "../src/decision/decide.ts";
import type { Order, TrackingClassification, TrackingState, TrackingVerification } from "../src/domain/types.ts";
import { loadInputs } from "../src/io/load.ts";
import { REFERENCE_NOW } from "../src/time/pragueDays.ts";
import { classifyTrackingPage } from "../src/tracking/classify.ts";
import { runTrackingEvaluation } from "../src/tracking/evaluate.ts";
import type { FetchLike } from "../src/tracking/llm/client.ts";
import { loadLlmConfig, readDotEnv } from "../src/tracking/llm/config.ts";
import { IncidentLog } from "../src/tracking/llm/incidents.ts";
import { applyLlmResult, refineUnknownPages, type LlmPageResult } from "../src/tracking/llm/refine.ts";
import { allOrderRows, pageTrackingProvider } from "../src/tracking/lookup.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DATA = join(ROOT, "data");
const TRACKING = join(DATA, "tracking");
const OUT = join(ROOT, "out", "llm-eval");

const cfg = loadLlmConfig({ ...readDotEnv(join(ROOT, ".env")).values, ...process.env, TRACKING_LLM_MODE: "shadow" });
if (cfg.mode === "off") {
  console.error(`LLM evaluation needs TRACKING_LLM_ENABLED=true, TRACKING_LLM_MODEL and a Together.ai key. ${cfg.diagnostics.join("; ")}`);
  process.exit(2);
}

// ---- E1 ----
const e1 = runTrackingEvaluation(TRACKING);
const labelOf = new Map(e1.cases.map((c) => [c.file, c.expected]));

// ---- E2 ----
const unknownPages = e1.cases.filter((c) => c.predicted === "UNKNOWN").map((c) => {
  const html = readFileSync(join(TRACKING, c.file), "utf8");
  return { page: c.file, html, trackingNumber: c.file.replace(/\.html$/, ""), classification: classifyTrackingPage(html) };
});
const incidents = new IncidentLog(cfg.incidentLog ?? join(OUT, "llm-incidents.jsonl"), cfg.model);
const run = await refineUnknownPages(cfg, unknownPages, "2026-11-02", fetch as unknown as FetchLike, { incidents });
await incidents.flush();
const scored = run.results.map((r) => {
  const label = labelOf.get(r.page) as TrackingState;
  return {
    page: r.page, label, llm: r.answer?.status ?? null, correct: r.answer?.status === label,
    validated: r.validation?.accepted ?? false, rejected: r.validation?.reasons ?? [], activeState: r.activeState,
    activeCorrect: r.activeState === label, error: r.error, errorDetail: r.errorDetail,
    evidence: r.answer?.evidence ?? null, eventDate: r.answer?.event_date ?? null, confidence: r.answer?.confidence ?? null,
    tokens: r.usage, costUsd: r.costUsd, latencyMs: r.latencyMs,
  };
});
const e2 = {
  pagesUnknownInE1: unknownPages.length,
  ...run.totals,
  stoppedBy: run.stoppedBy,
  incidents: run.incidents,
  validJson: scored.filter((s) => s.llm !== null).length,
  llmCorrect: scored.filter((s) => s.correct).length,
  llmIncorrect: scored.filter((s) => s.llm !== null && !s.correct).length,
  validatedCorrect: scored.filter((s) => s.validated && s.correct).length,
  validatedIncorrect: scored.filter((s) => s.validated && !s.correct).length,
  /** UNKNOWN pages whose known state the LLM read correctly AND the validator accepted. */
  resolvedUnknown: scored.filter((s) => s.validated && s.correct && s.label !== "UNKNOWN" && s.llm !== "UNKNOWN").length,
  costPerResolvedUnknownUsd: null as number | null,
  pages: scored,
};
e2.costPerResolvedUnknownUsd = e2.resolvedUnknown > 0 ? Number((run.totals.costUsd / e2.resolvedUnknown).toFixed(6)) : null;

// ---- E3 ----
const byPage = new Map<string, LlmPageResult>(run.results.map((r) => [r.page, r]));
/** Counterfactual only: the raw model answer applied without validator or safety policy. */
const rawApply = (c: TrackingClassification, r: LlmPageResult | undefined): TrackingClassification => {
  if (!r?.answer || c.state !== "UNKNOWN") return c;
  const date = r.answer.event_date;
  return {
    ...c, state: r.answer.status, activity: r.answer.status === "IN_TRANSIT" ? "UNDETERMINED" : null, reason: "raw LLM answer (unvalidated counterfactual)",
    evidence: { ...c.evidence, eventTime: date ? { text: date, local: date } : null },
  };
};
type Variant = "baseline" | "active" | "raw";
function simulate(dataDir: string, variant: Variant) {
  const inputs = loadInputs(dataDir);
  const base = pageTrackingProvider(join(dataDir, "tracking"), allOrderRows(inputs.orders));
  const tracking = (o: Order): TrackingVerification => {
    const t = base(o);
    if (t.status !== "classified" || variant === "baseline") return t;
    const r = byPage.get(t.page);
    return { ...t, classification: variant === "active" ? applyLlmResult(t.classification, r, cfg.model) : rawApply(t.classification, r) };
  };
  const report: DecisionReport = decideAll(inputs, REFERENCE_NOW, { tracking });
  const pageOf = (d: DecisionReport["decisions"][number]) => (d.tracking?.status === "classified" ? d.tracking.page : null);
  const label = (d: DecisionReport["decisions"][number]) => { const p = pageOf(d); return p ? labelOf.get(p) ?? null : null; };
  const codes = (d: DecisionReport["decisions"][number]) => d.execution.reasons.map((r) => r.code);
  return {
    actions: report.summary.actions,
    falseCreate: report.decisions.filter((d) => d.execution.action === "create" && (label(d) === "DELIVERED" || label(d) === "RETURNING")).map((d) => d.key),
    falseTrackingSkip: report.decisions.filter((d) => d.execution.action === "skip" && codes(d).some((c) => c === "TRACKING_DELIVERED" || c === "TRACKING_RETURNING")
      && (label(d) === "IN_TRANSIT" || label(d) === "UNKNOWN")).map((d) => d.key),
    actionByOrder: Object.fromEntries(report.decisions.map((d) => [d.key, d.execution.action])),
  };
}
const ws = mkdtempSync(join(tmpdir(), "mailstep-llm-eval-"));
let e3;
try {
  // What-if: a reporter matrix exists but lists no large client, so reporters come from history.
  const whatIf = join(ws, "data");
  cpSync(DATA, whatIf, { recursive: true });
  writeFileSync(join(whatIf, "reporters.csv"), "client,reporter\n");
  const variants: Variant[] = ["baseline", "active", "raw"];
  e3 = {
    suppliedData: Object.fromEntries(variants.map((v) => [v, simulate(DATA, v)])),
    whatIfMatrixWithoutLargeClients: Object.fromEntries(variants.map((v) => [v, simulate(whatIf, v)])),
  };
} finally {
  rmSync(ws, { recursive: true, force: true });
}
const changed = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} → ${b[k]}`);

const report = {
  date: new Date().toISOString().slice(0, 10),
  model: cfg.model, price: cfg.price, limits: { maxCalls: cfg.maxCalls, maxCostUsd: cfg.maxCostUsd, timeoutMs: cfg.timeoutMs, maxInputChars: cfg.maxInputChars, maxOutputTokens: cfg.maxOutputTokens },
  e1: { total: e1.total, correct: e1.correct, unknown: e1.cases.filter((c) => c.predicted === "UNKNOWN").length, critical: e1.errorsByCategory.CRITICAL },
  e2,
  e3: {
    ...e3,
    changesSupplied: { active: changed(e3.suppliedData["baseline"]!.actionByOrder, e3.suppliedData["active"]!.actionByOrder), raw: changed(e3.suppliedData["baseline"]!.actionByOrder, e3.suppliedData["raw"]!.actionByOrder) },
    changesWhatIf: { active: changed(e3.whatIfMatrixWithoutLargeClients["baseline"]!.actionByOrder, e3.whatIfMatrixWithoutLargeClients["active"]!.actionByOrder), raw: changed(e3.whatIfMatrixWithoutLargeClients["baseline"]!.actionByOrder, e3.whatIfMatrixWithoutLargeClients["raw"]!.actionByOrder) },
  },
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "llm-eval.json"), `${JSON.stringify(report, null, 2)}\n`);

const s = (v: Variant, which: "suppliedData" | "whatIfMatrixWithoutLargeClients") => {
  const x = e3[which][v]!;
  return `| ${v} | ${x.actions.create} | ${x.actions.skip} | ${x.actions.review} | ${x.falseCreate.length} | ${x.falseTrackingSkip.length} |`;
};
const md = [
  `# LLM tracking evaluation (${report.date})`, "",
  `Model \`${cfg.model}\` (Together.ai), $${cfg.price.input} / $${cfg.price.output} per 1M input / output tokens. Limits: ${cfg.maxCalls} calls, $${cfg.maxCostUsd}, ${cfg.timeoutMs} ms, ${cfg.maxOutputTokens} output tokens.`, "",
  `**E1 deterministic:** ${e1.correct}/${e1.total} correct, ${report.e1.unknown} UNKNOWN, ${report.e1.critical} critical.`, "",
  `**E2 LLM shadow on the ${unknownPages.length} UNKNOWN pages:** ${e2.calls} calls (${e2.succeeded} ok, ${e2.failed} failed), valid JSON ${e2.validJson}, LLM correct ${e2.llmCorrect}, incorrect ${e2.llmIncorrect}, validated ${e2.validated} (correct ${e2.validatedCorrect}, incorrect ${e2.validatedIncorrect}), resolved UNKNOWN ${e2.resolvedUnknown}, usable in active mode ${e2.usableInActiveMode}.`,
  `Tokens ${e2.inputTokens} in / ${e2.outputTokens} out, cost $${e2.costUsd} (${e2.costSource}), latency P50 ${e2.latencyP50Ms} ms / P95 ${e2.latencyP95Ms} ms, cost per resolved UNKNOWN ${e2.costPerResolvedUnknownUsd === null ? "n/a" : `$${e2.costPerResolvedUnknownUsd}`}.`, "",
  "| Page | Label | LLM | Correct | Validated | Active state | Rejected because | Evidence |", "|---|---|---|---|---|---|---|---|",
  ...scored.map((x) => `| ${x.page} | ${x.label} | ${x.llm ?? `error: ${x.error} ${x.errorDetail ?? ""}`} | ${x.correct ? "yes" : "no"} | ${x.validated ? "yes" : "no"} | ${x.activeState} | ${x.rejected.join("; ")} | ${(x.evidence ?? "").replace(/\|/g, "\\|")} |`),
  "", "**E3 decision simulation** (raw = unvalidated counterfactual, never a product mode):", "",
  "Supplied data (no reporter matrix):", "", "| Variant | CREATE | SKIP | REVIEW | false CREATE | false tracking SKIP |", "|---|---|---|---|---|---|",
  s("baseline", "suppliedData"), s("active", "suppliedData"), s("raw", "suppliedData"), "",
  "What-if: matrix present, no large clients:", "", "| Variant | CREATE | SKIP | REVIEW | false CREATE | false tracking SKIP |", "|---|---|---|---|---|---|",
  s("baseline", "whatIfMatrixWithoutLargeClients"), s("active", "whatIfMatrixWithoutLargeClients"), s("raw", "whatIfMatrixWithoutLargeClients"), "",
  `Changed actions vs. baseline: supplied active ${JSON.stringify(report.e3.changesSupplied.active)}, raw ${JSON.stringify(report.e3.changesSupplied.raw)}; what-if active ${JSON.stringify(report.e3.changesWhatIf.active)}, raw ${JSON.stringify(report.e3.changesWhatIf.raw)}.`, "",
];
writeFileSync(join(OUT, "llm-eval.md"), `${md.join("\n")}\n`);
console.log(md.join("\n"));
