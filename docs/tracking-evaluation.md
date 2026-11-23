# Tracking classifier evaluation

The evaluation is produced by `npm start` into `out/tracking-eval.json` and `out/tracking-eval.md`. The numbers below come from a run over the supplied pages (dataset SHA-256 `b3ac5c6c7ef5edd220871bd055eb79a56a82211fa615ff9e2fbd2489eb0fb20f`). The output is deterministic, so a repeated run gives the same result.

**Procedure:**

1. Each page is classified from its own HTML only. The carrier is identified from `<title>`, with no hint from the file name or the tracking number.
2. Only then is `labels.csv` joined.

The accuracy denominator includes all pages, including `UNKNOWN` answers.

## Summary

| Metric | Value |
|---|---|
| Pages | 20 |
| Correct / incorrect | 16 / 4 |
| Accuracy | 80.0 % |
| `UNKNOWN` share (abstention) | 30.0 % (6 pages) |
| Coverage by definite answers | 70.0 % (14 pages) |
| Accuracy of definite answers | 100 % (14/14) |

## Confusion matrix (rows = actual, columns = predicted)

| actual \ predicted | DELIVERED | IN_TRANSIT | RETURNING | UNKNOWN |
|---|---|---|---|---|
| DELIVERED | 4 | 0 | 0 | 1 |
| IN_TRANSIT | 0 | 7 | 0 | 2 |
| RETURNING | 0 | 0 | 3 | 1 |
| UNKNOWN | 0 | 0 | 0 | 2 |

| Status | Occurrences | Predicted | Precision | Recall |
|---|---|---|---|---|
| DELIVERED | 5 | 4 | 100 % | 80.0 % |
| IN_TRANSIT | 9 | 7 | 100 % | 77.8 % |
| RETURNING | 4 | 3 | 100 % | 75.0 % |
| UNKNOWN | 2 | 6 | 33.3 % | 100 % |

## Errors by impact on complaints

| Category | Count | Meaning |
|---|---|---|
| Critical | 0 | "in transit" for a delivered or returning shipment (risk of an unjustified complaint), or "delivered/returning" for a shipment that is in transit or unclear (suppression of a justified complaint) |
| False certainty | 0 | a definite status where the page is ambiguous |
| Abstention | 4 | `UNKNOWN` even though the status is known. This costs automation, not safety. |
| Other | 0 | a confusion with the same impact on the action |

**All four errors are abstentions on Doručto pages.** On these pages the current step is marked only by SVG colour, and we do not treat colour as reliable evidence.

| Page | Actual | Predicted | Impact on action |
|---|---|---|---|
| DT9100112 | IN_TRANSIT | UNKNOWN | review → review (no change) |
| DT9100124 | DELIVERED | UNKNOWN | skip → review (unnecessary manual review, order 120124) |
| DT9100197 | IN_TRANSIT | UNKNOWN | review → review |
| DT9100198 | RETURNING | UNKNOWN | skip → review |

No error leads to SKIP instead of REVIEW and none to a possible unjustified CREATE. A dated `IN_TRANSIT` prediction without delivery activity can allow CREATE under definition B (D-30), which is why `IN_TRANSIT` for a delivered or returning shipment is a critical error; there is no such case on the supplied pages (`wrongCreatePossible` = 0).

## Difficult cases recognised correctly

- **Expedo EX7710117:** "Doručeno" (delivered) in the cookie bar and in an advertisement is ignored. The status is read from the status card: "Doručeno" and "předána příjemci" (handed over to the recipient) give DELIVERED.
- **Kurýr Vltava KV2026100115:** "doručena … Převzal: soused" (delivered … received by: neighbour) gives UNKNOWN, because it is not a handover to the recipient.
- **Kurýr Vltava KV2026100105 and Expedo EX7710117:** delivery is confirmed even though Mailship keeps orders 120105 and 120117 in status `carrier_picked_up`.
- **ParcelNord PN55100116, Kurýr Vltava KV2026100118 and KV2026100123** (parcel locker, failed attempt, courier out for delivery) give IN_TRANSIT/ACTIVE. Loss is not inferred.
- **ParcelNord PN55100114** (last scan 12. 10.) gives IN_TRANSIT/UNDETERMINED with a date; for order 120114 tracking would allow CREATE, only the reporter matrix is missing. Stagnation is not measured (both the fetch time and a threshold are missing).

## Limitations

- 20 pages and no held-out set: the parsers were built on the same pages. The result shows agreement with this data, not general accuracy.
- The parsers are tied to the current page structure and read HTML with regular expressions. An unknown or ambiguous structure mostly leads to `UNKNOWN` (verified by tests with corrupted and modified HTML), but some HTML changes can cause misclassification and therefore a wrong SKIP or CREATE. Production requires more robust verification of page identity and structure (README § 9).
- A page with an invalid character entity (e.g. `&#1114112;`) gives `UNKNOWN` with a diagnostic and does not stop the evaluation or the decisions for other orders (`test/tracking/malformed-html.test.ts`, `test/integration/cli.test.ts`).
- The fetch time of the pages is unknown, so the freshness of the evidence cannot be verified.
- The evaluation does not include run times or costs. Classification is local and deterministic, without an LLM, with zero model cost. The evaluation of the optional LLM module on `UNKNOWN` pages is in [llm-tracking-evaluation.md](llm-tracking-evaluation.md).
