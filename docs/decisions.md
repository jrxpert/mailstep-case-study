# Decisions and interpretation of the assignment

The assignment ([docs/assignments/case-study.pdf](assignments/case-study.pdf)) explicitly asks for a
reasonable interpretation of ambiguities to be chosen and stated. This document summarises the final
decisions. Decision numbers (D-n) are stable; code comments reference them.

## Foundations

**D-1 Runtime and dependencies.** Node.js 24 runs TypeScript directly, with no build step. The only
runtime dependency is `yaml` (for `rules.yaml`). The default run uses no network, database or LLM;
the optional LLM module is disabled and measured separately ([llm-tracking-evaluation.md](llm-tracking-evaluation.md)).

**D-2 Rules instead of a language model.** Eligibility, blocking and reporter selection are structured
rules. Only the text of tracking pages is unstructured, and those pages have a few known structures.
A per-carrier parser is explainable, cheap and repeatable. A model would make sense for unknown
carrier formats, with output restricted to four states and a source citation (architecture § 5).

**D-3 Prague calendar days.** Time in state = the difference between the Prague calendar dates of
entering the state and of the decision instant (`order-states.md`: „pondělí → středa = 2 dny bez ohledu na hodinu“
— "Monday → Wednesday = 2 days regardless of the hour"). It is computed via `Intl` with the
`Europe/Prague` zone, so the result depends neither on the machine's time zone nor on DST changes.
Thresholds are inclusive (≥ 2, ≥ 14). The decision instant is 2 Nov 2026 07:30 Prague (`--now`).

**D-4 Timestamps.** Only ISO 8601 with an offset is accepted. A missing, invalid or future timestamp
is not a number but a reason for REVIEW. For an eligible order, the ordering `createdAt ≤ packedAt ≤ shippedAt ≤
decision instant`, `updatedAt ≤ decision instant`, and the absence of `shippedAt` on `waiting_for_carrier` are also checked.

**D-6 Entering the state.** A counts from `packedAt`, B from `shippedAt`. `updatedAt` is not used
because it changes on every edit of the order.

## Decision layer

**D-12 Eligibility is not authorisation to act.** Business eligibility (`eligible` / `ineligible` / `undetermined`)
covers only the definition, state, duration and exclusions. The action (`create` / `skip` / `review`) adds
identity, blocking, reporter and tracking. Every reason code has a fixed effect; precedence is SKIP >
REVIEW > CREATE. CREATE additionally checks an explicit list of conditions, and a disagreement between
the two checks throws an exception. The cost of an error sets the direction: an unjustified complaint
costs more than a manual check, so uncertainty leads to REVIEW.

**D-13 Identity and duplicates.** Order identity is `orderNumber`, the only field through which
complaints and returns are matched. Identical duplicate rows (120101) yield one decision. Differing
duplicates, a missing or unusable number, a shared `orderId`, and numbers that differ only in notation
(letter case, whitespace, punctuation, look-alike characters from another script) → REVIEW. Every source
row is traceable in the output.

**D-14 Reporter and matrix (assumption).** Large client → reporter from the matrix; others → the most
recent reporter from the client's complaint history (latest `createdAt`, any status and reason).
- `reporters.csv` is missing from the provided data. Without the matrix a large client cannot be
  distinguished, hence **REVIEW** (`REPORTER_MATRIX_UNAVAILABLE`), with the history candidate only as
  supporting information. The alternative "missing matrix = no large clients" could pick the wrong
  reporter for a large client.
- The matrix schema is a guess: exactly the columns `client,reporter`; any other shape → the whole
  matrix is invalid. A reporter must have the form of an e-mail address (like all of them in
  `complaints.json`). Conflicting rows for a client → REVIEW for that client only.
- History: a tie between the two most recent complaints with different reporters, a complaint dated
  after the decision instant, or a defective record that may belong to the client → REVIEW.
- A client is the same only after NFC and whitespace normalisation. A nearly identical name → REVIEW, never a guess.

**D-15 Blocking.** A complaint for the order in any status → SKIP. The assignment explicitly mentions
drafts; we also block on a closed complaint and on a complaint with a different reason (a conservative
choice, an open question for the complaints department). A WMS return in any status, including
„Připraveno“ ("Ready") → SKIP. A record that only may relate to the order (different client, number
differing in notation) → REVIEW.

**D-16 Defective complaint and return records.** A defective record with a usable `orderNumber` → REVIEW for
that order. A defective record without an order number could block any order, so it stops CREATE for
the whole batch (`BATCH_INTEGRITY_GATE`).

**D-18 Excluded shipping methods.** Exact match after NFC and whitespace trimming; each definition uses
only its own list. A variant differing only in notation → REVIEW, never a silent "not excluded".

**D-19 Output.** `out/decisions.json` contains the reference time, sources with SHA-256, a summary,
integrity findings, decisions with reasons and evidence, and a map of source rows. With no run time or
random identifiers and with stable ordering, the output is byte-for-byte deterministic.

## Tracking

**D-20 Page classification.** One parser per carrier, reading only the status part of the page
(Expedo status card, Kurýr Vltava `.shipment-message`, ParcelNord event table). The carrier is
identified from `<title>`, never from the file name or the labels. Keyword search across the whole page
would fail: Expedo has „Doručeno“ ("Delivered") in its cookie banner and in an advertisement, and Doručto
shows the captions of all steps on every page.
- DELIVERED requires explicit receipt by the recipient; a neighbour or third party → `UNKNOWN`.
- A contradiction (progress indicator versus message, an earlier delivery or return before a later
  in-transit event, conflicting events at the same time), an unknown sentence, damaged HTML, a different
  shipment number or a different carrier than the order's → `UNKNOWN`.
- **Doručto** marks the current step only by SVG colour, with no text and no semantic attribute. We do
  not use colour as evidence, so all Doručto pages are `UNKNOWN` (4 abstentions). Reading the
  highlighted step would match the labels on the provided pages, but for delivery there would still be
  no confirmation of receipt by the recipient.
- A shipment number shared by multiple orders (even when differing only in letter case or whitespace)
  means an ambiguous page assignment → REVIEW.

**D-22 Labels for measurement only.** `labels.csv` is read only by the offline measurement (`src/tracking/evaluate.ts`);
decision-making never sees it. A test enforces this.

**D-23 Impact-based measurement.** Accuracy alone is not enough. Errors are classified by what they cause: critical
(a false "in transit" can lead to an unjustified complaint, a false "delivered" suppresses a justified one),
false certainty, abstention (`UNKNOWN`, costs only manual work).

**D-30 Tracking in the decision and CREATE for both A and B.**
- **Definition A** (`not_collected_by_carrier`) requires neither carrier pickup nor a tracking page:
  their absence is the subject of the complaint. A page showing the shipment with the carrier refutes
  the complaint → REVIEW. An unreadable, foreign or shared page → REVIEW.
- **Definition B** (`loss`) needs an `IN_TRANSIT` page without delivery activity (pickup point,
  courier out for delivery, failed attempt → REVIEW) with a dated last event. A page without a date (Kurýr
  Vltava „na cestě“ — "on the way"), `UNKNOWN` or a missing page → REVIEW. Expedo „na cestě“ is accepted only
  from the known card structure with an exact update time.
- **Time consistency:** `DELIVERED` / `RETURNING` yields SKIP, and `IN_TRANSIT` allows CREATE, only
  when all dated events fall between the Prague day of dispatch (A `packedAt`, B
  `shippedAt`) and the decision day. Pages do not state a time zone, so only the calendar day is compared
  and no time is inferred. A missing or invalid date → REVIEW.
- **No stagnation threshold:** the assignment does not define one and the saved pages lack a download time. Definition B
  therefore applies as the department described it (14 days since pickup). The limitation is in README § 9.
- Input files are treated as trusted; the concern is the correct interpretation of their content, not data provenance.
  Verifying page provenance (download records, fingerprints) was out of the assignment's scope and is not part of the solution.

## Solution boundaries

CREATE is a decision of an offline program, not a write to Mailship. For production, the following are
missing: the reporter matrix, live tracking with a download time, an idempotent write with a check for an
existing complaint immediately beforehand, an audit record, and approved policies (stagnation, receipt by
a neighbour). The deployment approach is in [architecture.md](architecture.md) § 7, missing parts in [omissions.md](omissions.md).
