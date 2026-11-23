# What is done, what is missing, and why

## Implemented and tested

- **Validating input loading.** A defective record is not discarded; it gets a `review` decision. A missing required file ends the run with an error (exit code 2).
- **Prague calendar day counting** from `packedAt` or `shippedAt`, safe across DST changes. Tests also run under other system `TZ` values.
- **Business eligibility** for definitions A and B according to `rules.yaml`, including excluded shipping methods per definition.
- **Blocking:**
  - an existing complaint in any status and with any reason;
  - a WMS return in any status;
  - suspicious and defective complaint and return records yield REVIEW, or stop creation for the whole batch.
- **Identity and duplicates:** identical duplicates yield one decision. Differing duplicates, a missing `orderNumber` and defective rows yield REVIEW. Every source row is traceable.
- **Reporter resolution:** from the matrix, or from history for a client not in the matrix. The states `resolved`, `needs_missing_data`, `not_found` and `invalid` are distinguished. Verified with synthetic matrices in tests.
- **Classifier for saved tracking pages** of four carriers, with evidence, an activity signal and contradiction checks.
- **Tracking wired into decisions:** `DELIVERED` and `RETURNING` yield SKIP only with a time-consistent event, otherwise REVIEW. Definition A does not require tracking; an "in transit" page contradicts it (REVIEW). Definition B gets CREATE only with a dated "in transit" page without delivery activity.
- **Classifier measurement** with errors broken down by impact.
- **CREATE for both definition A and B** given complete and consistent inputs, demonstrated on the synthetic example `examples/create/` with negative variants.
- **Error isolation:** a damaged tracking page yields `UNKNOWN` only for its own order; the batch continues.
- **CLI integration tests** on temporary copies of the inputs (including CREATE-A/B and negative variants) and tests of CREATE safety invariants.
- **Deterministic output** and a single command to run.
- **Tests:** unit, integration and integrity. The assignment and input data are not modified; a checksum test enforces this.

## Deliberately omitted

- **Creating complaints via the Mailship API** and any write. The assignment provides no access; the output is proposed decisions.
- **Live tracking retrieval, retrack and browser automation.** The solution works with saved pages.
- **LLM in decision-making.** Page structures are known and rules suffice (see [architecture.md](architecture.md) § 5). An optional LLM module exists, is disabled and measured; in `active` mode it must not cause CREATE on its own ([llm-tracking-evaluation.md](llm-tracking-evaluation.md)).
- **Reading Doručto status from SVG colour.** Colour is not reliable evidence, so Doručto pages yield `UNKNOWN`. Cost: 4 pages.
- **A "stagnating" state and pickup date check.** The provided pages lack both a download time and an agreed threshold. Definition B therefore does not measure stagnation since the last movement and does not check that the pickup date on the page matches `shippedAt`; a dated "in transit" page without delivery activity is sufficient ([decisions.md](decisions.md) D-30, README § 9).
- **Verifying tracking page provenance** (download records, fingerprints, freshness). The assignment's input files are treated as trusted (D-30).
- **General validation of corrupted exports.** Duplicate keys in JSON and implausible but formally valid timestamps (e.g. year 0026) are not caught. A production loader should reject them.
- **A general HTML parser.** Pages are read with regular expressions based on the known structures of the provided carriers; an edited or changed page may be read incorrectly.
- **CREATE-B for Kurýr Vltava and Doručto.** The Kurýr Vltava „na cestě“ page has no structured time, and Doručto shows the status only by colour; both yield REVIEW.
- **Matching client names that differ in letter case or diacritics.** Only a name identical after NFC and whitespace normalisation is a match. Nearly identical names (letter case, diacritics, invisible characters) yield REVIEW instead of a guess.
- **Look-alike identifiers.** Order numbers or names that differ only in letter case, punctuation, an invisible character or a letter from another script yield REVIEW. Distinct ASCII identifiers (e.g. `MS-DEM0` with a zero, `MS-DEMO-1`, the legal suffix „s.r.o.“) are not considered identical.
- **JSON with a leading BOM.** Rejected as invalid JSON with a clear message (fail-safe). BOM tolerance is deferred.
- **Scheduler, monitoring, alerting, storage of run history.**
- **Output localisation.** `decisions.json` uses English reason codes.

## Blocked by missing inputs

| What | Missing |
|---|---|
| Verification of the reporter matrix on real data | `reporters.csv` was not provided. The schema is a guess (`client,reporter`). |
| CREATE for orders from the provided data that meet eligibility | the reporter matrix (the logic for both definitions is complete and tested on a synthetic example) |
| Verification of tracking freshness | page download time, time zones of carrier events |
| Independent validation of the classifier | additional tracking pages outside the development set |

## Needed for production

1. Approved policies from the complaints department (see [questions-complaints.md](questions-complaints.md)), especially stagnation, freshness and receipt by a neighbour.
2. The reporter matrix as a managed source with schema validation.
3. An idempotent complaint write and a check for an existing complaint and return immediately before the write. Protection against race conditions.
4. Live tracking (retrack or carrier API) with retrieval time and a maximum age, from a **verified retrieval service**. It needs signed or otherwise authenticated download records, protected policy configuration and independently auditable metadata. SHA-256 and an allowlist of sources only attest byte identity and configuration.
5. An audit record of every decision, shadow mode and metrics (agreement with the claims clerk, REVIEW share, errors by carrier).
6. Monitoring of carrier page layout changes (an increase in `UNKNOWN`). The parsers are tested only on known structures; even an identical SHA-256 does not guarantee correct interpretation of a new structure.
