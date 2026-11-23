# Mailstep – automatic complaint creation (case study)

[![CI](https://github.com/jrxpert/mailstep-case-study/actions/workflows/ci.yml/badge.svg)](https://github.com/jrxpert/mailstep-case-study/actions/workflows/ci.yml)

An offline TypeScript CLI that, for each order in the Mailship and WMS exports, decides whether to
create a complaint (`create`), not create one (`skip`), or hand it to a human (`review`), and states why.
The second part reads stored carrier tracking pages and measures accuracy against `labels.csv`.

By default the application calls no API, fetches no live tracking and uses no LLM (the optional LLM
module is a disabled experiment, § 10). **CREATE is a deterministic
decision of the program, not a write to Mailship.**

| Deliverable (assignment, p. 3) | Where |
|---|---|
| 1. Design (at most 2 pages) | [docs/architecture.md](docs/architecture.md), [docs/architecture.pdf](docs/architecture.pdf) |
| 2. Code with tests and README, run with a single command | `src/`, `test/`, this file |
| 3. Measurement over tracking pages | [docs/tracking-evaluation.md](docs/tracking-evaluation.md), generated `out/tracking-eval.{json,md}` |
| 4. Questions for the complaints department and Mailship development | [docs/questions-complaints.md](docs/questions-complaints.md), [docs/questions-mailship.md](docs/questions-mailship.md) |
| 5. What we did not finish or deliberately omitted | [docs/omissions.md](docs/omissions.md), § 9 below |

## 1. Running

Requirements: Node.js ≥ 24 (TypeScript runs directly, no build step) and npm. Network access is needed only for `npm ci`.

```bash
npm ci && npm run all      # typecheck, all tests, decisions and measurement over data/ → out/
```

| Output | Contents |
|---|---|
| `out/decisions.json` | decision for each logical order: eligibility, action, all reasons with evidence, reporter, tracking |
| `out/tracking-eval.json`, `out/tracking-eval.md` | classifier measurement: confusion matrix, errors by impact |
| console | summary and one line per order |

Other commands: `npm start` (application only), `npm test`, `npm run ci` (same as CI on GitHub),
`npm run example:create` (§ 7), `npm run mutation` (§ 8). CLI flags: `--data`, `--out`,
`--now` (decision instant, default 2 Nov 2026 07:30 Prague) and `--skip-eval`. Outputs are
deterministic: a repeated run produces byte-identical files, even with a different system `TZ`.

## 2. Definitions A and B

Rules are read from [data/rules.yaml](data/rules.yaml).

| | Definition A | Definition B |
|---|---|---|
| Order status | `waiting_for_carrier` | `carrier_picked_up` |
| Time in status | ≥ 2 Prague calendar days since `packedAt` | ≥ 14 Prague calendar days since `shippedAt` |
| Excluded shipping methods | Interní přeprava | Interní přeprava, Parcelo DE, Parcelo International, Parcelo Return DE, Marketplace Delivered |
| Complaint reason | `not_collected_by_carrier` | `loss` |

Days are calendar dates in Prague ("handed over on Monday = 2 days on Wednesday"), independent of the
hour, DST changes and the machine's time zone. `updatedAt` is not used; it changes on every order edit.

## 3. CREATE / SKIP / REVIEW

The decision has two separate layers: **business eligibility** (does the order meet definition A or B?) and
the **action** (may the system act on its own?). Eligibility alone does not yield CREATE.

Each reason code has a fixed effect ([src/domain/types.ts](src/domain/types.ts), `REASON_EFFECT`):
any `skip` → **SKIP**; otherwise any `review` → **REVIEW**; otherwise **CREATE**. CREATE additionally
independently verifies an explicit list of conditions: eligibility, unambiguous identity, no blocker, resolved
reporter, consistent order timestamps, tracking that permits CREATE, and no malformed record
in the batch. A disagreement between the two checks is a program error and throws an exception. The output keeps all
reasons, even when only one of them determined the action.

| Action | When | Example codes |
|---|---|---|
| SKIP | an unambiguous reason not to create | `NOT_A_CANDIDATE_STATUS`, `THRESHOLD_NOT_REACHED`, `EXCLUDED_SHIPPING_METHOD`, `EXISTING_COMPLAINT`, `EXISTING_RETURN`, `TRACKING_DELIVERED`, `TRACKING_RETURNING` |
| REVIEW | conditions cannot be evaluated safely | ambiguous identity or duplicate, malformed or suspicious record, invalid timestamp, missing matrix or reporter, tracking unavailable, `UNKNOWN`, conflicting or temporally inconsistent |
| CREATE | eligible, no blocker and no uncertainty | informational codes only, e.g. `BUSINESS_ELIGIBLE`, `REPORTER_RESOLVED` |

**Blockers per the assignment:** a complaint for the order in any state (including a draft; additionally also closed
and with a different reason) → SKIP. A WMS return in any state, including "Připraveno" (ready) → SKIP. A record
that only *may* relate to the order (number differing in letter case or whitespace, different
client, malformed record) → REVIEW.

## 4. Reporter

- Large client (present in the `reporters.csv` matrix) → reporter from the matrix.
- Others → the most recent reporter from the client's complaint history (by `createdAt`, any state).
- The client name is compared after Unicode NFC and whitespace normalization. A near-identical name (different
  letter case, diacritics, invisible character) yields REVIEW, never a guess.

**`reporters.csv` is missing from the inputs** (the assignment mentions it). Without the matrix it is impossible to tell who is a large
client, and a reporter from history could be wrong for a large client. Therefore all eligible orders
get REVIEW (`REPORTER_MATRIX_UNAVAILABLE`) and the candidate from history is listed only as
supporting information. This is our conservative interpretation, not a requirement of the assignment. The accepted matrix format
(`client,reporter`) is an assumption.

## 5. Tracking

The classifier reads only the status part of a known carrier's page and returns `DELIVERED`, `IN_TRANSIT`
(with activity `ACTIVE` = pickup point, courier out for delivery, failed attempt; otherwise `UNDETERMINED`),
`RETURNING` or `UNKNOWN`. Delivered means explicit receipt by the recipient (neighbour → `UNKNOWN`).
The tracking number and carrier on the page must match the order. `UNKNOWN` is never treated as
`IN_TRANSIT`.

| Carrier | Where the status is read |
|---|---|
| ParcelNord | the whole event table; the latest event by date decides, contradictory history → `UNKNOWN` |
| Expedo | status card (value, "Poslední aktualizace" (last update), card sentence) |
| Kurýr Vltava | the `.shipment-message` sentence; progress indicator only for consistency checks |
| Doručto | status indicated only by colour → always `UNKNOWN` |

| Page state | Definition A | Definition B |
|---|---|---|
| no page, no tracking number, unsupported carrier | no effect | REVIEW |
| shared (including by different letter case) or unusable tracking number, unreadable or foreign page | REVIEW | REVIEW |
| `DELIVERED` / `RETURNING`, temporally consistent | SKIP | SKIP |
| `DELIVERED` / `RETURNING`, undated or inconsistent | REVIEW | REVIEW |
| `IN_TRANSIT` | REVIEW (contradicts "nevyzvednuto" (not collected)) | `ACTIVE` or undated → REVIEW; dated, consistent → **permits CREATE** |
| `UNKNOWN` | REVIEW | REVIEW |

Definition A does not require tracking: the missing carrier pickup is the subject of the complaint. **Temporal
consistency:** pages give times without a time zone, so only Prague calendar dates are compared.
Every dated event must fall between the dispatch day (A `packedAt`, B `shippedAt`) and the decision day.

## 6. Result on the supplied data

| | `create` | `skip` | `review` | total |
|---|---|---|---|---|
| eligible | 0 | 5 | 18 | 23 (A: 6, B: 17) |
| not eligible | 0 | 9 | 0 | 9 |
| total | **0** | **14** | **18** | 32 logical orders from 33 rows |

- All 18 REVIEW have `REPORTER_MATRIX_UNAVAILABLE` (`reporters.csv` missing). For 5 definition A orders
  and for 120114 it is the only reason. The others also have a tracking reason: missing page
  or tracking number (4×), `UNKNOWN` (4×), active delivery (3×), Kurýr Vltava undated (1×).
  The row without `orderNumber` has `INVALID_ORDER_IDENTITY`.
- 5× SKIP despite eligibility: complaint draft 120004, complaint 120109, return "Připraveno" 120108,
  delivered 120105 and 120117.
- 9× SKIP without eligibility: excluded shipping method 4×, threshold not reached 3× (120125 has 13 days by Prague,
  would have 14 by UTC), status outside the definitions 2×. The duplicate row 120101 yields one decision.

## 7. CREATE example

The synthetic example [examples/create/](examples/create/) runs through the same CLI with the same rules:

```bash
npm run example:create     # node src/cli.ts --data examples/create --out out/create --skip-eval
```

| Order | Result | Why |
|---|---|---|
| MS-EX-A-0001 | CREATE `not_collected_by_carrier` | 4 days in status, no complaint or return, large client → reporter from matrix, no tracking page |
| MS-EX-B-0001 | CREATE `loss` | 24 days, no complaint or return, small client → reporter from history, page `IN_TRANSIT` with latest event on 12 Oct |

Negative variants of both definitions are in [test/integration/create-scenarios.test.ts](test/integration/create-scenarios.test.ts).

## 8. Tests

656 tests (`node:test`), offline, without network or database (LLM module with a mocked provider). A verification summary is in
[docs/quality-audit.md](docs/quality-audit.md).

| Command | What it does |
|---|---|
| `npm test` | all tests |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run test:coverage` | tests with coverage gates on `src/` (lines ≥ 95 %, branches ≥ 85 %, functions ≥ 95 %) |
| `npm run verify:baseline` | the real CLI over a clean copy of `data/`, SHA-256 of outputs against [scripts/baseline-outputs.json](scripts/baseline-outputs.json) |
| `npm run ci` | typecheck + coverage + baseline |
| `npm run mutation` | targeted mutation tests of the decision path (~15 min) |

The suites cover A/B rules and Prague days (including DST changes), identity and duplicates, blockers,
the reporter, carrier parsers, tracking temporal consistency, integration runs of the real CLI and
CREATE safety invariants. Tests check reason codes, not just the action.

## 9. Known limitations

- **The reporter matrix is missing**, so no CREATE occurs on the supplied data.
- **The tracking measurement** was done on the same 20 pages the parsers were written against
  (16/20, 0 critical errors, 4 conservative `UNKNOWN` for Doručto). It is not an estimate of production accuracy.
- **Tracking freshness (definition B).** Only the 14-day threshold from `shippedAt` applies. Stagnation since
  the last movement is not measured, and it is not checked that the pickup date on the carrier page matches
  `shippedAt`. A shipment that moved yesterday, or that the carrier picked up only recently, can therefore
  get CREATE `loss`. A last-movement threshold would be a new business rule; for production we
  propose agreeing on it with the complaints department.
- **Calendar days.** Temporal consistency is judged by Prague calendar days, not by the
  hour of the event (pages give no time zone). An event on the dispatch day with an earlier hour or on the
  decision day with a later hour is not detected.
- **Input integrity.** Inputs are treated as trusted exports. A duplicate key in a JSON record
  is silently overwritten by the last value (which can hide a complaint or return), and an implausible but
  formally valid timestamp (e.g. year 0026) is not detected. A production version should reject such records.
- **HTML parsing robustness.** The parsers are written for the structures of the supplied pages and read HTML
  with regular expressions; this is not a general extraction engine. An unknown structure usually yields `UNKNOWN`,
  but a modified page (hidden text, nested elements, a second status value or a different tracking number
  outside the watched locations) may be misread and even lead to a wrong SKIP or CREATE. A carrier layout
  change requires a parser update.
- **This is not a production system.** Writing to Mailship, idempotency, audit log, live tracking and
  locking are future integrations ([docs/omissions.md](docs/omissions.md)).

## 10. Optional experimental extension: LLM classification (disabled)

This is an experiment whose measurement has not yet shown a benefit for automated decisions; it is not used in the default
run. Pages that the parsers classify as `UNKNOWN` can be assessed by a model via Together.ai.
The model receives only the text of the page's `<main>` element (the body if there is none), reduced to an allowlist of tracking vocabulary,
dates and times; names, addresses and any other unknown word are masked before the request. Its answer
is checked by a deterministic validator (verbatim quote, status wording judged in the quote's complete sentence or
event so a partial quote cannot drop a negation or condition, an event date that belongs to the quoted event rather
than a page-update time), and the LLM can never cause CREATE on its own. To enable:

```bash
TRACKING_LLM_ENABLED=true TRACKING_LLM_MODEL=Qwen/Qwen3.5-9B TOGETHER_API_KEY=… npm start   # or in .env (template: .env.example)
npm run llm:eval            # live E1/E2/E3 measurement with a budget → out/llm-eval/
```

The default mode is `shadow` (recording to `out/llm-tracking.json` only). Provider operational errors
(credit, unavailable model, authentication, rate limit…) are written to **`out/llm-incidents.jsonl`**
(or `TRACKING_LLM_INCIDENT_LOG`). Measurement on 6 `UNKNOWN` pages: Qwen3.5-9B 2/6 and MiniMax-M3.1-Flash
4/6 correct, neither changed a decision, and both would have produced a wrong CREATE without the validator; we therefore
do not recommend enabling the LLM for decisions. These are historical results, measured before the input minimisation
and the stricter event-date rule; they have not been rerun.
Details: [docs/llm-tracking-evaluation.md](docs/llm-tracking-evaluation.md).

## 11. Further documents

- [docs/decisions.md](docs/decisions.md): interpretation of the assignment and key decisions.
- [docs/acceptance-criteria.md](docs/acceptance-criteria.md): checklist of assignment requirements.
- [docs/quality-audit.md](docs/quality-audit.md): tests, coverage, mutations, determinism.
- [docs/input-integrity-audit.md](docs/input-integrity-audit.md): protection of source data and malformed inputs.
- [docs/assignments/](docs/assignments/): original assignment and source data (unchanged).

```text
src/
  cli.ts                 load → decide → measure → out/*
  io/                    validating input loading (JSON, YAML, CSV)
  time/pragueDays.ts     Prague calendar days, reference time
  rules/                 A/B eligibility, identity and duplicates, blockers, reporter
  decision/decide.ts     tracking gate, action, reasons, summaries
  tracking/              classifier, carrier parsers, page lookup, measurement
  tracking/llm/          optional, disabled LLM classifier (experiment, § 10)
examples/create/         synthetic CREATE-A/B example
test/                    unit, integration and integrity tests
scripts/                 baseline gate and mutation tests
```
