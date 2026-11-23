// Evaluation of the tracking classifier against data/tracking/labels.csv.
// This is the ONLY module that reads labels. Pages are classified first, from HTML alone (carrier
// detected from the page, no tracking number or file-name hints); labels are joined afterwards.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRACKING_STATES, type TrackingClassification, type TrackingState } from "../domain/types.ts";
import { InputError, loadTrackingLabels } from "../io/load.ts";
import { classifyTrackingPage } from "./classify.ts";

export type ErrorCategory = "CRITICAL" | "FALSE_CERTAINTY" | "CONSERVATIVE_ABSTENTION" | "OTHER";
type Gate = "skip" | "review" | "create (B) or review";

export interface EvalCase {
  file: string;
  expected: TrackingState;
  note: string;
  classification: TrackingClassification;
}

/**
 * Decision-gate effect of a tracking state (decisions.md D-30): DELIVERED / RETURNING → skip; IN_TRANSIT
 * may permit a definition-B create (dated, no last-mile activity), otherwise review; UNKNOWN → review.
 */
const gateOf = (s: TrackingState): Gate => (s === "DELIVERED" || s === "RETURNING" ? "skip" : s === "IN_TRANSIT" ? "create (B) or review" : "review");
/** A prediction that can satisfy the definition-B create gate (the date is checked against the order later). */
const mayCreate = (c: TrackingClassification): boolean => c.state === "IN_TRANSIT" && c.activity === "UNDETERMINED" && c.evidence.eventTime !== null;
const clears = (s: TrackingState): boolean => s === "DELIVERED" || s === "RETURNING";

/**
 * Error categories, by consequence for complaint automation (first match wins):
 *  CRITICAL                 could allow an unjustified complaint (IN_TRANSIT predicted for a parcel that
 *                           was delivered or is returning) or wrongly suppress one (DELIVERED/RETURNING
 *                           predicted for a parcel in transit or of unknown state).
 *  FALSE_CERTAINTY          a definite state where the reference says the page is ambiguous.
 *  CONSERVATIVE_ABSTENTION  UNKNOWN where the reference knows the state: costs coverage, not safety.
 *  OTHER                    the rest (DELIVERED ↔ RETURNING: same gate, wrong reason).
 */
export function categorize(expected: TrackingState, predicted: TrackingState): ErrorCategory | null {
  if (expected === predicted) return null;
  if ((predicted === "IN_TRANSIT" && clears(expected)) || (clears(predicted) && !clears(expected))) return "CRITICAL";
  if (expected === "UNKNOWN") return "FALSE_CERTAINTY";
  if (predicted === "UNKNOWN") return "CONSERVATIVE_ABSTENTION";
  return "OTHER";
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 10000) / 10000);

export function evaluate(cases: EvalCase[]) {
  const sorted = [...cases].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const confusion = Object.fromEntries(TRACKING_STATES.map((e) => [e, Object.fromEntries(TRACKING_STATES.map((p) => [p, 0]))])) as Record<TrackingState, Record<TrackingState, number>>;
  for (const c of sorted) confusion[c.expected][c.classification.state] += 1;

  const total = sorted.length;
  const correct = sorted.filter((c) => c.expected === c.classification.state).length;
  const predictedUnknown = sorted.filter((c) => c.classification.state === "UNKNOWN").length;
  const definite = total - predictedUnknown;
  const definiteCorrect = sorted.filter((c) => c.classification.state !== "UNKNOWN" && c.expected === c.classification.state).length;

  const perClass = Object.fromEntries(TRACKING_STATES.map((s) => {
    const tp = confusion[s][s];
    const predicted = TRACKING_STATES.reduce((n, e) => n + confusion[e][s], 0);
    const support = TRACKING_STATES.reduce((n, p) => n + confusion[s][p], 0);
    return [s, { support, predicted, truePositives: tp, precision: ratio(tp, predicted), recall: ratio(tp, support) }];
  }));

  const errors = sorted
    .filter((c) => c.expected !== c.classification.state)
    .map((c) => ({
      file: c.file,
      expected: c.expected,
      predicted: c.classification.state,
      category: categorize(c.expected, c.classification.state) as ErrorCategory,
      decisionImpact: `${gateOf(c.expected)} → ${gateOf(c.classification.state)}`,
      reason: c.classification.reason,
      warnings: c.classification.warnings,
      labelNote: c.note,
    }));
  const byCategory = Object.fromEntries((["CRITICAL", "FALSE_CERTAINTY", "CONSERVATIVE_ABSTENTION", "OTHER"] as const).map((k) => [k, errors.filter((e) => e.category === k).length]));

  return {
    total,
    correct,
    incorrect: total - correct,
    accuracy: ratio(correct, total),
    unknownRate: ratio(predictedUnknown, total),
    coverage: ratio(definite, total),
    accuracyOnDefinitePredictions: ratio(definiteCorrect, definite),
    perClass,
    confusion,
    errorsByCategory: byCategory,
    decisionImpact: {
      skipInsteadOfReview: errors.filter((e) => e.decisionImpact === "review → skip").length,
      reviewInsteadOfSkip: errors.filter((e) => e.decisionImpact === "skip → review").length,
      wrongCreatePossible: sorted.filter((c) => c.expected !== "IN_TRANSIT" && mayCreate(c.classification)).length,
      note: "A dated IN_TRANSIT prediction without last-mile activity can permit a definition-B (loss) create, so IN_TRANSIT predicted for a delivered or returning parcel is CRITICAL. 'skip instead of review' would suppress human review of a possibly justified complaint; 'review instead of skip' only adds manual work.",
    },
    errors,
    cases: sorted.map((c) => ({
      file: c.file,
      expected: c.expected,
      predicted: c.classification.state,
      activity: c.classification.activity,
      correct: c.expected === c.classification.state,
      reason: c.classification.reason,
      evidence: c.classification.evidence,
      warnings: c.classification.warnings,
    })),
  };
}

export type EvalReport = ReturnType<typeof evaluate>;

/** Classifies every *.html page in trackingDir, then joins labels.csv. Deterministic (sorted). */
export function runTrackingEvaluation(trackingDir: string) {
  // Missing evaluation inputs are input errors with a path, not crashes.
  if (!existsSync(trackingDir)) throw new InputError(trackingDir, "tracking directory not found (required by the evaluation step)");
  const labelsPath = join(trackingDir, "labels.csv");
  if (!existsSync(labelsPath)) throw new InputError(labelsPath, "reference labels not found (required by the evaluation step)");
  const pages = readdirSync(trackingDir).filter((f) => f.endsWith(".html")).sort();
  const hash = createHash("sha256");
  const predictions = new Map<string, TrackingClassification>();
  for (const file of pages) {
    let html: string;
    try {
      html = readFileSync(join(trackingDir, file), "utf8");
    } catch (e) {
      throw new InputError(join(trackingDir, file), `cannot read tracking page: ${(e as Error).message}`);
    }
    hash.update(file).update(html);
    predictions.set(file, classifyTrackingPage(html)); // page content only
  }
  // Labels are read only after every prediction exists.
  hash.update(readFileSync(labelsPath));
  const labels = loadTrackingLabels(labelsPath, trackingDir);
  if (labels.invalid.length > 0) {
    throw new InputError(labelsPath, `${labels.invalid.length} invalid label row(s); first: ${labels.invalid[0]?.errors.join("; ")}`);
  }

  const cases: EvalCase[] = labels.valid.map(({ record }) => {
    const classification = predictions.get(record.file);
    if (!classification) throw new Error(`label for ${record.file} has no page`);
    return { file: record.file, expected: record.expectedState, note: record.note, classification };
  });
  const unlabeled = pages.filter((p) => !labels.valid.some((l) => l.record.file === p));
  return {
    method: "deterministic carrier-specific parsers (no LLM); carrier detected from page <title>; labels joined after classification",
    datasetSha256: hash.digest("hex"),
    pagesFound: pages.length,
    unlabeledPages: unlabeled,
    limitations: [
      "20 pages only; the parsers were written while looking at these same pages, so there is no held-out set. Accuracy here shows fit, not generalisation.",
      "Doručto pages convey the current step only by SVG colour; by policy they are classified UNKNOWN (conservative abstention).",
      "Page retrieval times are unknown, so evidence freshness and stagnation cannot be established.",
      "Execution time and token cost are not recorded (no LLM; timings would make the output non-deterministic).",
    ],
    ...evaluate(cases),
  };
}

const pct = (x: number | null): string => (x === null ? "undefined" : `${(x * 100).toFixed(1)} %`);

export function renderMarkdown(r: ReturnType<typeof runTrackingEvaluation>): string {
  const S = TRACKING_STATES;
  const lines = [
    "# Tracking classifier evaluation",
    "",
    `Method: ${r.method}.`,
    `Dataset SHA-256: \`${r.datasetSha256}\``,
    "",
    "| Metric | Value |", "|---|---|",
    `| Pages evaluated | ${r.total} (found ${r.pagesFound}, unlabeled ${r.unlabeledPages.length}) |`,
    `| Correct / incorrect | ${r.correct} / ${r.incorrect} |`,
    `| Accuracy (all pages, UNKNOWN included in denominator) | ${pct(r.accuracy)} |`,
    `| UNKNOWN (abstention) rate | ${pct(r.unknownRate)} |`,
    `| Coverage (definite predictions) | ${pct(r.coverage)} |`,
    `| Accuracy on definite predictions | ${pct(r.accuracyOnDefinitePredictions)} |`,
    `| Misclassified pages that could permit a definition-B create | ${r.decisionImpact.wrongCreatePossible} |`,
    "",
    "## Confusion matrix (rows = reference label, columns = prediction)", "",
    `| label \\ predicted | ${S.join(" | ")} |`, `|---|${S.map(() => "---").join("|")}|`,
    ...S.map((e) => `| ${e} | ${S.map((p) => r.confusion[e][p]).join(" | ")} |`),
    "",
    "## Per class", "",
    "| State | Support | Predicted | Precision | Recall |", "|---|---|---|---|---|",
    ...S.map((s) => { const c = r.perClass[s]; return `| ${s} | ${c?.support} | ${c?.predicted} | ${pct(c?.precision ?? null)} | ${pct(c?.recall ?? null)} |`; }),
    "",
    "## Errors by consequence", "",
    "| Category | Count | Meaning |", "|---|---|---|",
    `| CRITICAL | ${r.errorsByCategory["CRITICAL"]} | could allow an unjustified complaint or suppress a justified one |`,
    `| FALSE_CERTAINTY | ${r.errorsByCategory["FALSE_CERTAINTY"]} | definite state where the reference says ambiguous |`,
    `| CONSERVATIVE_ABSTENTION | ${r.errorsByCategory["CONSERVATIVE_ABSTENTION"]} | UNKNOWN where the state is known: fewer automated decisions, no harm |`,
    `| OTHER | ${r.errorsByCategory["OTHER"]} | wrong state with the same decision gate |`,
    "",
    `Decision impact: ${r.decisionImpact.skipInsteadOfReview} × skip instead of review, ${r.decisionImpact.reviewInsteadOfSkip} × review instead of skip. ${r.decisionImpact.note}`,
    "",
    "## Every misclassified page", "",
    "| Page | Label | Predicted | Category | Gate (label → predicted) | Classifier reason |", "|---|---|---|---|---|---|",
    ...(r.errors.length ? r.errors.map((e) => `| ${e.file} | ${e.expected} | ${e.predicted} | ${e.category} | ${e.decisionImpact} | ${e.reason} |`) : ["| — | | | | | |"]),
    "",
    "## All pages", "",
    "| Page | Label | Predicted | Activity | Evidence (status text) |", "|---|---|---|---|---|",
    ...r.cases.map((c) => `| ${c.file} | ${c.expected} | ${c.predicted}${c.correct ? "" : " ✗"} | ${c.activity ?? ""} | ${(c.evidence.statusText ?? c.reason).replace(/\|/g, "\\|")} |`),
    "",
    "## Limitations", "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ];
  return lines.join("\n");
}
