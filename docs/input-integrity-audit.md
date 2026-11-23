# Input integrity

How the solution handles the provided inputs and defective records. Tests: [test/integrity.test.ts](../test/integrity.test.ts),
[test/io/load.test.ts](../test/io/load.test.ts), [test/tracking/isolation.test.ts](../test/tracking/isolation.test.ts).

## Inputs are unmodified

| Item | Status |
|---|---|
| Assignment (`docs/assignments/`) and input data (`data/`) | from Mailstep, unmodified; every file is pinned by SHA-256 in `test/integrity.test.ts` |
| `data/reporters.csv` | **missing** (the assignment mentions it). Nothing is invented; a test fails if it appears in `data/` |
| List of large clients | not in any input; determined only by the missing matrix |
| Tracking page download time | unknown; evidence freshness cannot be verified |
| `labels.csv` | for measurement only; decision-making never reads it (`test/tracking/isolation.test.ts`). The file intentionally has CRLF line endings |
| Synthetic data | only in tests (temporary directories) and in `examples/create/`, marked as synthetic |

## Defective and ambiguous inputs

| Input | Behaviour |
|---|---|
| Missing or unreadable required file | clear error, exit code 2, no stack trace |
| Defective order record | not discarded; REVIEW decision (`INVALID_RECORD`) |
| Missing or unusable `orderNumber`, differing duplicates, shared `orderId` | REVIEW |
| Defective complaint or return record with a usable order number | REVIEW for that order (`POTENTIAL_BLOCKING_RECORD`) |
| Defective complaint or return record without an order number | stops CREATE for the whole batch (`BATCH_INTEGRITY_GATE`) |
| Missing, invalid or future timestamp | REVIEW |
| Missing reporter matrix | REVIEW (`REPORTER_MATRIX_UNAVAILABLE`); history only as supporting information |
| Matrix in an unexpected shape | whole matrix invalid, REVIEW |
| Damaged tracking page | `UNKNOWN` only for its own order; the batch continues |
| JSON with a BOM | rejected as invalid (exit code 2) |

## What validation does not catch

Inputs are treated as trusted exports. A duplicate key in a JSON record is overwritten by the last
value, and an implausible but formally valid timestamp (e.g. year 0026) is not detected. A defective
reporter matrix row (e.g. unclosed quotes) ends the whole run with an error instead of REVIEW. More detail in README § 9.
