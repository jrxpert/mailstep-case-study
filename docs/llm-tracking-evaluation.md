# Optional LLM tracking classification: design and evaluation

A pilot evaluation on the 20 supplied pages (6 of them `UNKNOWN`). This is not a statistically
significant measure of production accuracy.

**Evaluation verdict: `LLM_HYBRID_IMPLEMENTED_NO_MEASURABLE_GAIN`.** The integration is an optional experimental
extension, disabled by default; the evaluation has not yet shown any benefit for automated decisions.

## 1. Why an LLM

The deterministic parsers score 16/20 on the supplied pages with 6× `UNKNOWN` (4× Doručto, where the status
is marked only by colour, "zásilku jsme nenašli" (we could not find the shipment) at Expedo, and a handover to a neighbour at Kurýr Vltava). Every
`UNKNOWN` means a manual review. The question was: can a language model cheaply and safely reduce the number of manual
reviews?

## 2. Why the rules remain primary

The parsers are explainable, repeatable, offline and accurate on known structures (14/14 definite
answers). The model receives only pages that the parser evaluated as `UNKNOWN`, and its answer is a
claim that is checked by a deterministic validator. **The LLM can never cause a CREATE on its own.**

## 3. Architecture

```text
page → deterministic parser ──────┬─ definite status ─────────────────────────┐
                                  └─ UNKNOWN (carrier and tracking no. verified)│
                                        → LLM adapter (Together.ai, JSON)      │
                                        → evidence validator ─ OK / rejected   │
                                        → active mode: only DELIVERED/RETURNING│
                                          with an event date, else UNKNOWN     │
                                                                ↓              ↓
                                                     existing decision engine
```

Code: [src/tracking/llm/](../src/tracking/llm/) (`config.ts`, `client.ts`, `minimise.ts`, `validate.ts`, `refine.ts`,
`incidents.ts`), wiring in `src/cli.ts`, evaluation in `scripts/llm-eval.ts`. No new dependency,
no framework, queue or database; HTTP calls via the built-in `fetch`, mocked in tests.

## 4. Configuration

Environment variables or `./.env` (only `TRACKING_LLM_*` and `TOGETHER_*` are read; the environment takes
precedence). Template: [.env.example](../.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `TRACKING_LLM_ENABLED` | `false` | master switch; `false` takes precedence over the mode |
| `TRACKING_LLM_MODE` | `shadow` | `off` / `shadow` (record only) / `active` (see § 7) |
| `TRACKING_LLM_MODEL` | *(empty)* | model ID; **no default value**, empty = LLM disabled with a diagnostic |
| `TOGETHER_API_KEY` | – | key; alternatively `TOGETHER_ENV_FILE` = path to a file with the key |
| `TRACKING_LLM_PRICE_INPUT_PER_M`, `_OUTPUT_PER_M` | verified price list | price in USD / 1M tokens for a model not in the price list in `config.ts` |
| `TRACKING_LLM_TIMEOUT_MS` | 5000 | timeout of a single call |
| `TRACKING_LLM_MAX_CALLS` / `_MAX_COST_USD` | 20 / 0.02 | call and cost limit per run |
| `TRACKING_LLM_MAX_INPUT_CHARS` / `_MAX_OUTPUT_TOKENS` | 6000 / 200 | input and response size |
| `TRACKING_LLM_MAX_RETRY_WAIT_MS` | 2000 | longest `Retry-After` that is waited for (one attempt) |
| `TRACKING_LLM_INCIDENT_LOG` | `<out>/llm-incidents.jsonl` | incident log |

Changing the model requires no code change. Costs are calculated at the price of the model actually used. A model
without a verified price is not run: without a price the USD budget cannot be guaranteed, and the price is never guessed.

Run: `TRACKING_LLM_ENABLED=true TRACKING_LLM_MODEL=Qwen/Qwen3.5-9B TOGETHER_API_KEY=… npm start`
(additional output `out/llm-tracking.json`); evaluation: `… npm run llm:eval` (output `out/llm-eval/`).

## 5. Model selection (Together.ai)

Verified on 2026-11-22 via the Together.ai API `/v1/models` (prices) and trial calls.

- The initially chosen `mistralai/Mistral-Small-24B-Instruct-2501` ($0.10 / $0.30) **is not available
  serverless** (HTTP 400 `model_not_available`, requires a dedicated endpoint). The same applies to 20 other
  cheap models. Of 28 chat models up to $1.20 / 1M tokens, 8 were available serverless.
- **Chosen: `Qwen/Qwen3.5-9B`: $0.17 input / $0.25 output per 1M tokens**, 262k context. The cheapest
  available general instruction model. By default it "thinks" (consumes output tokens and
  does not return JSON), so `chat_template_kwargs.enable_thinking=false` is sent.
- Comparison model **`MiniMaxAI/MiniMax-M3.1-Flash`: $0.15 / $0.60** per 1M tokens (price from `/v1/models`, supplied
  in the run via `TRACKING_LLM_PRICE_*`), used only for a single comparison evaluation in shadow mode.
  `openai/gpt-oss-120b` tried on one page: a reasoning model, 806 output tokens and 6.7 s.
- `zai-org/GLM-5.3-Flash` (cheaper input) rejected: reasoning cannot be disabled, and the response content stayed
  empty. Experimental and 1.5B models were not considered.

## 6. Security and privacy

- The model receives only the text of the page's `<main>` element (the body if there is none), reduced to a closed allowlist
  ([minimise.ts](../src/tracking/llm/minimise.ts)): parcel-tracking words and function words, Czech dates and
  times, SVG step colours (hex values only) and punctuation, plus the carrier name. Every other token is replaced
  by `[…]`, and a run of them by a single `[…]`. The text keeps one line per block (paragraph, list item, table
  row, timeline step) so the validator can recover a quote's sentence or event. That covers names, initials, streets, towns, house and postal
  numbers, signatures, e-mails, phone numbers and any unknown word. The tracking number becomes `[ČÍSLO ZÁSILKY]`.
  The model never receives the order, client, address, complaints or other shipments.
  Example (KV2026100115): `Převzal: soused (Novák), Lipová 12.` is sent as `Převzal: soused ([…]), […].`
  This is fail-closed: a word missing from the list costs evidence, never privacy. Residual risk: a name spelled
  exactly like a list word (e.g. a surname "Kurýr") is not recognised. Input is limited to 6000 characters, output to 200 tokens.
- Only pages for which the parser verified both the carrier and the tracking number are sent; a page with comments,
  scripts or invalid entities is not sent.
- HTML is untrusted; the system prompt says so, but the protection is provided by the validator, not the prompt.
- The key is read only from the variable or from the named file, and is never printed or stored.
  Diagnostics, errors and the log contain no request or response headers or bodies.

## 7. Evidence validation and safety policy

The answer (`status`, `event_date`, `evidence`, `evidence_source`, `confidence`) is accepted only if:
the JSON matches the schema exactly; the quote exists verbatim in the text the model received; the wording of the quote
matches the status (DELIVERED = explicit handover to the recipient, without a neighbour or negation; RETURNING = return
to sender; IN_TRANSIT = shipment with the carrier); the quote contains no masked word `[…]` (it could have been a
negation); the page contains no contradictory wording (also checked locally in the unmasked text); the date is
valid, is not after the decision day, and is stated for the claimed event itself. The quote must hold exactly
one date and no page-update wording ("Aktualizováno", "Poslední aktualizace", …), and the date must directly
accompany the event wording: `… doručena příjemci 30. 10. 2026`, `… příjemci dne 30. 10. 2026`, or
`30. 10. 2026 13:12 Zásilka byla doručena příjemci`. A sentence break or other words in between break the link.

For DELIVERED and RETURNING the quote is not judged on its own: the model may quote a fragment
(`doručena příjemci 30. 10. 2026`) of a sentence that negates it (`Zásilka nemohla […] doručena příjemci 30. 10. 2026`).
The validator locates the quote in the received text as whole words (a quote starting inside `nedoručena` does not
count), requires it to occur exactly once, and widens it to its complete sentence or, without a sentence end, to its
block (for example a table row). That context must contain no masked word, no negated word (structurally: `ne` + a
vocabulary word, plus `není` / `nevíme`), no conditional, future, attempt or question wording, and no neighbour /
third-person qualification. Other sentences and rows are not part of the context, so an earlier failed attempt
does not block a later delivery. If the context cannot be reconstructed (repeated quote, no boundary within
300 characters), the answer is rejected and the page stays `UNKNOWN`. A row that contains a masked place name is
therefore rejected as well.
Rejected example: `Zásilka byla doručena příjemci. Aktualizováno 30. 10. 2026`. The same rule rejects a
table row whose place column sits between the date and the event, which costs a dated answer there and keeps
the page `UNKNOWN`. Finally, `confidence` ≥ 0.5 (never sufficient on its own) and the page was not truncated. A quote that exists does not yet prove the correct interpretation, which is why
the wording rules are strict.

`active` mode: a validated **IN_TRANSIT is never used** (it could lead to CREATE `loss`).
A validated DELIVERED / RETURNING with a date replaces `UNKNOWN`; the decision engine then still verifies temporal
consistency, and only then can a SKIP result. Everything else stays `UNKNOWN` → REVIEW.

## 8. Methodology

E1: deterministic parsers over 20 pages. E2: LLM in shadow mode over 6 `UNKNOWN` pages,
evaluated against `labels.csv` (labels are joined only after classification; model answers are not
treated as ground truth). E3: decision simulation for the supplied data and for the what-if "matrix exists, no large
client" in three variants: baseline, `active` and a **counterfactual `raw`** (the model answer without the
validator and policy; only for measuring risk, never a product mode). Qwen: three repeated runs on
2026-11-22 gave identical answers and tokens (temperature 0). MiniMax: one run. The same prompt, validator
and policy for both models.

## 9. Results

The live runs below used the earlier model input (whole `<main>` text with only the tracking number, e-mails and
phone numbers masked; the pages are fictional) and the earlier validator (the date only had to occur in the quote,
and the quote was judged without its sentence). They have not been repeated with the allowlist input, the stricter
date rule and the context check, so model answers on the new input are unmeasured. Under the earlier, looser rules no decision changed.

Six `UNKNOWN` pages: **two are correctly undeterminable** according to the labels as well (EX7710113 "nenašli" (not found),
KV2026100115 handover to a neighbour); **four are Doručto**, where the current step is marked only by SVG colour.
Two of them (DT9100197, DT9100198) **are not linked to any order**, so they cannot affect
decisions. Six cases cannot be generalised statistically.

| Metric | Qwen3.5-9B | MiniMax-M3.1-Flash |
|---|---:|---:|
| Correct classifications | 2/6 | 4/6 |
| Accepted by validator | 1/6 | 4/6 |
| Change in business decisions (`active`) | 0 | 0 |
| Potential wrong CREATE without validator | 1 (120124) | 1 (120124) |
| Potential wrong SKIP without validator | 1 (120115) | 0 |
| Cost of six classifications (provider-reported usage) | $0.00053 | $0.00078 |
| Tokens input / output | 2364 / 516 | 3363 / 466 |
| Latency P50 / P95 | 1.0–1.3 s / 1.1–1.5 s (3 runs) | 0.7 s / 1.0 s (1 run) |

| Page | Label | Qwen | MiniMax | Note |
|---|---|---|---|---|
| DT9100112 | IN_TRANSIT | IN_TRANSIT (rejected) | IN_TRANSIT (accepted, not used) | by policy IN_TRANSIT is never used |
| DT9100124 | DELIVERED | IN_TRANSIT | IN_TRANSIT | both wrong; without validator → wrong CREATE `loss` |
| DT9100197 | IN_TRANSIT | **DELIVERED** | IN_TRANSIT (accepted, not used) | no order |
| DT9100198 | RETURNING | **DELIVERED** | **DELIVERED** | no order; validator rejected |
| EX7710113 | UNKNOWN | UNKNOWN | UNKNOWN | correctly undeterminable |
| KV2026100115 | UNKNOWN | **DELIVERED** (neighbour) | UNKNOWN | Qwen without validator → wrong SKIP |

E3 (CREATE / SKIP / REVIEW, wrong CREATE, wrong SKIP from tracking):

| | Supplied data | What-if: matrix without large clients |
|---|---|---|
| baseline | 0 / 14 / 18, 0, 0 | 5 / 14 / 13, 0, 0 |
| `active` (both models) | 0 / 14 / 18, 0, 0 | 5 / 14 / 13, 0, 0 |
| raw Qwen (without validator) | 0 / 15 / 17, 0, **1** | 7 / 15 / 10, **1**, **1** |
| raw MiniMax (without validator) | 0 / 14 / 18, 0, 0 | 6 / 14 / 12, **1**, 0 |

### What the results mean

- **Classification is not evidence validation.** Classification is the model's claim about the status; validation verifies that
  the page contains a quote that literally supports the status. A correct classification without a verifiable quote
  (e.g. a step colour) does not propagate into the decision.
- **A better model did not reduce the number of REVIEWs.** MiniMax read better (4/6, did not take the neighbour as delivery), but the only
  correct "new" statuses were `IN_TRANSIT`, which the policy does not use (they could lead to CREATE `loss`).
  For DELIVERED / RETURNING, Doručto contains neither a handover to the recipient nor an event date, so even a
  perfect classification would not provide sufficient evidence for an automated action.
- **Confidence is not enough.** Both models reported 0.95–0.99 even for wrong answers (DT9100124, DT9100198,
  the neighbour for Qwen). Confidence is only an additional filter, never a reason for acceptance.
- **The validator is essential.** Without it, both models would, with high confidence, have created a wrong
  "ztráta" (loss) complaint for the delivered shipment 120124 (the date "Aktualizováno 22. 10. 2026" (updated 22. 10. 2026) would have served as the event
  date). With the validator, no decision changed.
- **The LLM must not authorise CREATE on its own.** A wrong CREATE is the most expensive error (an unjustified complaint);
  on 6 pages, the model produced one with both tested models.
- **Doručto needs a different source, not a stronger model.** Both models assigned the colour marker
  to an adjacent step (MiniMax systematically to the previous one: for DT9100124 it quoted "U kurýra" (with the courier), the green one is
  "Doručeno" (delivered); for DT9100198 "Doručeno", the green one is "Vráceno" (returned)); the text format in which we pass
  the colours to the model may also play a role. More reliable options are deterministic reading of the SVG (the single differently coloured step)
  or the authoritative status from the carrier API / Mailship retrack.

## 10. Tokens and costs

See the table in § 9 (usage reported by the provider). Cost per resolved `UNKNOWN` in a decision: cannot be
determined (0 changed decisions). Total live costs of the whole experiment (evaluation, model availability check,
trial calls) are below $0.01. When usage is missing, the worst-case price is reserved (input =
characters / 2 tokens, output = limit); such costs are marked `estimated` / `unknown`, not as
billed.

## 11. Operations: errors, incidents, fallback

**Error classification** (`client.ts`): by HTTP status, for 400/422 refined by a safely parsed error
code (only a short identifier; the error text is not read). 402 → `INSUFFICIENT_CREDIT`; 404 or 400
with a code such as `model_not_available` (observed at Together.ai) → `MODEL_UNAVAILABLE`; 400 with a code
about credit → `INSUFFICIENT_CREDIT`; other 400 → `INVALID_REQUEST`; 401 → `AUTHENTICATION_FAILED`;
403 → `PERMISSION_DENIED`; 429 → `RATE_LIMITED`; 5xx → `PROVIDER_UNAVAILABLE`; timeout → `TIMEOUT`;
an unparseable or empty response or non-JSON from the model → `INVALID_RESPONSE`; everything else →
`UNKNOWN_PROVIDER_ERROR`. The exact Together.ai error format is not assumed beyond what was observed.

**Fallback:** every error leaves the page with the deterministic parser result (`UNKNOWN` → REVIEW);
no error can lead to CREATE. `INSUFFICIENT_CREDIT`, `MODEL_UNAVAILABLE`, `AUTHENTICATION_FAILED`
and `PERMISSION_DENIED` stop further calls in the run. `RATE_LIMITED`: one further attempt after `Retry-After`,
only if it is ≤ 2 s and the budget suffices; otherwise (or on repetition) calls in the run are stopped. Three
consecutive transient errors (5xx, timeout, …) also stop calls. No infinite retries.

**Incident log** `out/llm-incidents.jsonl` (or `TRACKING_LLM_INCIDENT_LOG`; ignored by Git): one
JSON line per distinct incident and write, with the fields `timestamp`, `last_seen`, `component`, `provider`,
`model`, `severity`, `category`, `http_status`, `provider_error_code`, `fallback_action`,
`occurrences` (occurrences in the run, deduplication) and `notification_status`. Writes are serialised within the
process; a write failure is reported on stderr (error code only) and the run continues. It contains no keys,
headers, requests, responses, HTML or order data.

**Future notifications:** `notification_status: "PENDING"` (critical errors and rate limit) only marks
a candidate for an operator notification. No notification system exists and nothing is sent;
a future sender can read the `PENDING` lines from the log.

**Operational limitations:** configuration problems (missing model, key, price) are only a diagnostic on stderr,
not an incident; deduplication applies within a single run; the log is not rotated.

## 12. Limitations and recommendations

Limitations: 6 evaluated pages (2 correctly undeterminable, 4 Doručto, of which 2 without an order), two models,
one prompt, no held-out set; MiniMax measured in a single run.

**Verdict: `LLM_HYBRID_IMPLEMENTED_NO_MEASURABLE_GAIN`.** On the supplied data the LLM did not reduce the number of manual
reviews, and without the validator it would have produced a wrong CREATE with both models. We therefore do not recommend enabling the LLM in
decision-making; at most it has value in `shadow` mode as a signal for the claims clerk and as a measurement tool when
carrier layouts change. For Doručto, a deterministic SVG rule or the status from the carrier API is more suitable.
A reasonable next step: measure shadow mode on a larger sample of production pages labelled by
claims clerks before `active` mode is considered at all.
