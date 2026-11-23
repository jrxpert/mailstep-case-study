# Quality verification

A summary of verifiable results. All commands run offline against the repository; the same checks
(except mutation tests) run in CI on GitHub ([.github/workflows/ci.yml](../.github/workflows/ci.yml)).

## Results

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | `tsc --noEmit` (strict) with no errors |
| Tests | `npm test` | 656 / 656 (of which 128 for the optional LLM module, offline with a mock) |
| Coverage of `src/` | `npm run test:coverage` | lines 99.5 %, branches 93.9–94.2 % (varies slightly between runs), functions 99.1 % (gates 95 / 85 / 95 %) |
| Baseline | `npm run verify:baseline` | the real CLI on a clean copy of `data/`; 3 outputs byte-identical to the pinned SHA-256 |
| Mutation tests | `npm run mutation` | 69 targeted mutants, 2 equivalent (justified in the script), 67 / 67 killed |
| Positive CREATE | `npm run example:create` | MS-EX-A-0001 CREATE `not_collected_by_carrier`, MS-EX-B-0001 CREATE `loss` |
| Dependencies | `npm audit --omit=dev` (in CI) | 0 vulnerabilities; the only runtime dependency is `yaml` |

Pinned outputs ([scripts/baseline-outputs.json](../scripts/baseline-outputs.json)):

| File | SHA-256 |
|---|---|
| `decisions.json` | `db6aee07fd5dd6f180ba904a81efb78b2b5a26b8368a91a48421b94cf78bee11` |
| `tracking-eval.json` | `60139bf2fa15407b74934f75995fb3b0f797dd3c5d98ba1e8ec43b4317f1700d` |
| `tracking-eval.md` | `33c8274b18f48026e7bdacc401c38cdc3ad949e654d649ed3c9f7d86fcdf0a20` |

Baseline counts: 33 rows, 32 logical orders, eligibility 23 / 9, actions 0 / 14 / 18,
tracking 16 / 20 with no critical error.

## Determinism

The output contains no run time or random identifiers and has stable ordering. Repeated runs, runs
under different system `TZ` values (UTC, Europe/Prague, America/Los_Angeles, Asia/Kolkata, Pacific/Kiritimati)
and a run from a clean clone (`npm ci && npm run all`) produced byte-identical outputs.

## What the tests cover

- Rules A/B, day thresholds, UTC versus Prague offset (120125: 13 days, not 14), DST changes.
- Identity and duplicates, blocking (draft, open and closed complaint, WMS return in any status),
  suspicious and defective records.
- Reporter: matrix, history, missing matrix, conflicts, Unicode variants of client names.
- Carrier parsers on provided and modified pages, damaged HTML, contradictory history.
- Tracking time consistency (events before dispatch, after the decision, without a date).
- Integration runs of the real CLI, including CREATE-A/B and their negative variants, CLI error states.
- Optional LLM module: configuration, classification of provider errors (402, 404, 400, 401, 403, 429, 5xx,
  timeout), circuit breaker, incident log (deduplication, concurrent writes, write failure), evidence
  validator, prompt injection, no new CREATE and no network call in the default run; data minimisation
  (the full mocked provider request contains no name, address, house number, signature or contact detail)
  event-date attribution (page-update timestamps, unrelated or multiple dates are rejected) and evidence
  context (partial quotes that omit a negation, condition or masked word in their sentence or event are rejected).
- Input protection: the assignment and `data/` are pinned by SHA-256, and decision-making must not read `labels.csv`.

Tests check reason codes, not just the resulting action. Mutation tests verify that the suite catches
the weakening of specific gates (thresholds, blocking, reporter, tracking gate, time consistency, parsers).

## Independent adversarial audit

Before submission, an independent audit ran its own synthetic scenarios through the regular CLI. The
assignment's rules (thresholds, exclusions, complaints, returns, reporter) held in all edge cases.
It did, however, find reproducible cases where **corrupted or edited input** leads to CREATE or SKIP
instead of REVIEW: a duplicate key in JSON, an implausible year, edited tracking page HTML, a variant of
the carrier name. The description is in README § 9; the implementation was not changed before submission.

Separate independent reviews of the optional LLM module found three defects, all fixed with regression
tests: the model input contained personal data (a neighbour's surname and street address on
`KV2026100115.html`); the validator accepted a page-update timestamp as the date of a delivery event; and it
accepted a partial quote (`doručena příjemci 30. 10. 2026`) that left out the negation of its sentence
(`Zásilka nemohla být doručena …`). Details in [llm-tracking-evaluation.md](llm-tracking-evaluation.md) §§ 6–7.

## Limits of verification

- High coverage and mutation scores do not imply correctness for arbitrary input; the tests cover the
  enumerated degradations, not corrupted exports in general.
- Tracking measurement uses the same 20 pages on which the parsers were developed; there is no held-out set.
- Mutation tests are targeted (69 mutants), not exhaustive, and do not cover the optional LLM module. Its
  safeguards were checked by 29 hand-applied mutants outside the suite (each removed safeguard fails a test,
  except the hex-only step-colour filter, which is redundant with the allowlist).
