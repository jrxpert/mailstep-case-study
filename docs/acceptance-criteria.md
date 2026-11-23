# Assignment requirements checklist

Requirements from [case-study.pdf](assignments/case-study.pdf) and [order-states.md](assignments/order-states.md).

**Statuses:** `PASS` met and evidenced · `PASS_WITH_LIMITATION` met with a stated limitation ·
`BLOCKED_BY_INPUT` cannot be verified without missing source data · `NOT_IMPLEMENTED` deliberately out of scope.

## Deliverables (PDF p. 3)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Design from part 1, at most 2 pages | PASS | [architecture.md](architecture.md), [architecture.pdf](architecture.pdf) (2 A4 pages): rules vs. LLM, source of truth for delivery, error and verification unavailability, deployment and metrics |
| 2 | Code with tests and README with a single-command run | PASS | `npm ci && npm run all`, [README](../README.md) |
| 3 | Result of the measurement over tracking pages (count, errors, direction) | PASS | [tracking-evaluation.md](tracking-evaluation.md), generated `out/tracking-eval.{json,md}` |
| 4 | Questions for the complaints department and Mailship development | PASS | [questions-complaints.md](questions-complaints.md), [questions-mailship.md](questions-mailship.md) |
| 5 | What was not finished or was deliberately omitted | PASS | [omissions.md](omissions.md), README § 9 |
| – | Interpretation of ambiguities stated in the README | PASS | README §§ 4, 5, 9; in detail [decisions.md](decisions.md) |
| – | LLM: model and price, or justification | PASS | the default run does not use an LLM (justification [architecture.md](architecture.md) § 5, [decisions.md](decisions.md) D-2); optional module: model `Qwen/Qwen3.5-9B`, $0.17 / $0.25 per 1M tokens, measured $0.000531 for 6 pages ([llm-tracking-evaluation.md](llm-tracking-evaluation.md)) |

## Decision logic (part 2)

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| FR-1 | Definition A: `waiting_for_carrier`, ≥ 2 days, `not_collected_by_carrier` | PASS | `test/rules/eligibility.test.ts`; 120001 and 120007 are eligible, 120002 is not |
| FR-2 | Definition B: `carrier_picked_up`, ≥ 14 days, `loss` | PASS | same; 120101 and 120105 are eligible, 120102 and 120125 are not |
| FR-3 | Excluded shipping methods per definition | PASS | the lists are separate (120008 `Parcelo DE` is eligible under A); all 5 exclusions under B tested |
| FR-4 | Windows and exclusions from `rules.yaml`, nothing hard-coded | PASS | test: changing `minDaysInStatus` changes the result |
| FR-5 | Status entry from `packedAt` / `shippedAt`, never `updatedAt` | PASS | tests 120004, 120006, 120105, 120118 |
| FR-6 | Prague calendar days, safe across DST changes | PASS | `test/time/pragueDays.test.ts`: 120125 has 13 days; independent of system `TZ` |
| FR-7 | Run instant 2 Nov 2026 07:30 Prague | PASS | `REFERENCE_NOW`, flag `--now` |
| FR-8 | A complaint is not created twice, even when only a draft exists | PASS | `draft`, `open`, `closed` and a different reason → SKIP (`test/rules/blockers.test.ts`) |
| FR-9 | A WMS return blocks even in state `Připraveno` (ready) | PASS | any state; fixture 120108 |
| FR-10 | Every complaint has a reporter (matrix / history) | BLOCKED_BY_INPUT | both paths tested with synthetic matrices; `reporters.csv` was not supplied, so eligible orders end in REVIEW |
| FR-11 | For each order: create / do not create and why | PASS | `out/decisions.json`; table of all 32 orders in `test/decision/decide.test.ts` |
| FR-12 | Verification that the shipment was not delivered | PASS_WITH_LIMITATION | from stored pages; delivery / return → SKIP only with a temporally consistent event; page freshness cannot be verified, stagnation is not measured (README § 9) |
| FR-13 | Page reading: delivered / in transit / returning / unknown | PASS_WITH_LIMITATION | 4 carriers, 20/20 pages processed, Doručto always `UNKNOWN`; parsers are bound to known page structures |
| FR-14 | Delivered = received by the recipient, waiting at a pickup point = in transit | PASS | KV2026100115 (neighbour) → `UNKNOWN`, PN55100116 → `IN_TRANSIT`, PN55100191 → `DELIVERED` |
| FR-15 | Measurement honest, broken down by error type, repeatable | PASS_WITH_LIMITATION | 16/20, 0 critical errors, deterministic; no held-out set |
| FR-16 | Orders without a tracking page | PASS | B → REVIEW; A does not require tracking (`TRACKING_NOT_REQUIRED`) |
| FR-17 | Only a monitored status is a candidate | PASS | 120106 and 120107 → `NOT_A_CANDIDATE_STATUS` |
| – | CREATE for both definition A and B | PASS | `npm run example:create`: MS-EX-A-0001 → `not_collected_by_carrier`, MS-EX-B-0001 → `loss`; negative variants in `test/integration/create-scenarios.test.ts` |
| – | Complaint creation via API | NOT_IMPLEMENTED | outside the assignment scope; the output is decisions |

## Quality and safety

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| NFR-1 | TypeScript on Node.js | PASS | Node ≥ 24, `npm run typecheck` (strict) |
| NFR-2 | Testable without network and database, edge cases | PASS | 656 offline tests, CLI integration tests, mutation tests ([quality-audit.md](quality-audit.md)) |
| NFR-5 | Cost of error and design safeguards | PASS | measurement errors by impact; uncertainty → REVIEW; CREATE with a double check |
| NFR-8 | Explainability | PASS | every decision has reason codes, detail and a reference to the source record |
| NFR-9 | Determinism, no duplicate complaint from duplicates | PASS | byte-identical runs (including a different `TZ`); duplicates yield one decision |
| NFR-10 | Missing or malformed data does not lead to CREATE | PASS_WITH_LIMITATION | holds for the tested degradations; corrupted exports (duplicate key in JSON, implausible year) and modified HTML are not caught (README § 9) |
| INT | Source data is not modified, labels do not feed into decisions | PASS | `test/integrity.test.ts` (SHA-256), `test/tracking/isolation.test.ts` |

## Results on the supplied data

33 rows, 32 logical orders, eligibility 23 / 9, action CREATE 0 / SKIP 14 / REVIEW 18,
tracking 16 / 20. Outputs are pinned by SHA-256 in [scripts/baseline-outputs.json](../scripts/baseline-outputs.json)
and verified by `npm run verify:baseline`.
