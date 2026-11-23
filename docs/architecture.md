# Design: automated complaint creation

## 1. Problem and goals

A complaint candidate arises because **the order status in Mailship has stopped moving**. The parcel may be stuck, or a carrier update may simply not have propagated. The truth about delivery lies with the carrier, not with the order status.

Goals in priority order: (1) never create an unjustified complaint, (2) explain every decision, (3) automate only what can be verified.

## 2. Architecture

```text
orders / complaints / returns / rules.yaml
      │  validated loading (malformed records are not discarded)
      ▼
identity and duplicates ─► eligibility A/B ─► blockers (complaint, return)
                                     │
                     reporter ◄──────┤
                                     ▼
tracking HTML ─► classifier ─► state + evidence ─► decision ─► decisions.json
                                                   CREATE / SKIP / REVIEW

tracking HTML + labels.csv ─► offline measurement ─► tracking-eval.{json,md}
```

**The reference labels (`labels.csv`) never enter the decision** (enforced by tests). The core consists of pure TypeScript functions over files and a fixed reference time, without network, database or LLM.

## 3. Business rules (assignment + `rules.yaml`)

| | Definition A – not collected (nevyzvednuto) | Definition B – loss (ztráta) |
|---|---|---|
| Status | `waiting_for_carrier` | `carrier_picked_up` |
| Min. time in status | 2 calendar days from `packedAt` | 14 calendar days from `shippedAt` |
| Excluded shipping | `Interní přeprava` | `Interní přeprava`, `Parcelo DE`, `Parcelo International`, `Parcelo Return DE`, `Marketplace Delivered` |
| Reason | `not_collected_by_carrier` | `loss` |

Days are calendar dates in `Europe/Prague` (not elapsed hours; safe across the DST change), as of `2026-11-02 07:30 Europe/Prague`. `updatedAt` is not used; it changes on every edit. Example: 120125 (`shippedAt` 00:30 CEST) has 14 days in UTC but 13 in Prague, hence SKIP.

**Reporter:** large client (listed in the `reporters.csv` matrix) → from the matrix; others → the last reporter in the client's complaint history. Without the matrix a large client cannot be recognised → REVIEW.

## 4. Decision safety

Two separate layers: **eligibility** (definition A/B) and **action** (may the system act on its own?). Eligibility alone does not give CREATE. Every reason has a fixed effect: any `skip` gives **SKIP**, otherwise any `review` gives **REVIEW**, otherwise **CREATE**. CREATE additionally checks an explicit, independent list of conditions: eligibility, unambiguous identity, no blocker, a resolved reporter, consistent order timestamps and tracking that permits CREATE (§ 6). A disagreement between the two checks is a program error.

| Situation | Action | Origin (policy = our conservative choice) |
|---|---|---|
| A complaint exists (even a draft) | SKIP | assignment; closed or other reason: policy |
| WMS return (even `Připraveno`) | SKIP | assignment |
| Taken over by the recipient / return to sender (time-consistent) | SKIP | practice / policy (≠ WMS return) |
| Disputed identity, duplicate, shared tracking number, malformed record | REVIEW | policy |
| Reporter matrix or reporter missing | REVIEW | reporter mandatory; REVIEW is policy |
| Tracking contradictory, `UNKNOWN`, inconsistent dates; for B also missing | REVIEW | policy |

## 5. Tracking classification (rules, not an LLM)

Each carrier has its own parser that reads **only the status section of the page**: Expedo `.status-card .value`; Kurýr Vltava `.shipment-message` (the progress bar only as a consistency check); ParcelNord the latest event by date. A keyword search over the whole page would fail: Expedo has "Doručeno" in its cookie banner and an ad, Doručto has the labels of all steps on every page.

**Delivered** means an explicit handover to the recipient; a handover to a neighbour, a contradiction, an unknown format, broken HTML or a different tracking number give `UNKNOWN`. Doručto marks the current step only by SVG colour, without text or a semantic attribute; colour is not reliable evidence, hence `UNKNOWN`.

`IN_TRANSIT` carries an activity: `ACTIVE` (pickup box, failed attempt, courier out for delivery), otherwise `UNDETERMINED`. The default run does not infer "stalled": both the retrieval time and a threshold are missing.

**Why not an LLM.** The pages have a few known structures. Rules are explainable, cheap, repeatable and do not hallucinate. A model would make sense for unknown carrier formats (output limited to four states, with a quoted source). For Doručto, however, it would also only read the colour.

## 6. Where the delivery truth comes from, and what if verification fails

**Source of truth:** the carrier status in Mailship after a retrack, otherwise the carrier page or API with its retrieval time. The order status is only the trigger.

**Tracking per definition.** *A (not collected)* requires neither carrier pickup nor a tracking page: their absence is the subject of the complaint. A page showing the parcel with the carrier is a contradiction → REVIEW. *B (loss)* requires a usable page: only a dated, time-consistent `IN_TRANSIT` without last-mile activity permits CREATE. Active delivery, an undated `IN_TRANSIT` and `UNKNOWN` → REVIEW. For both, `DELIVERED` / `RETURNING` gives SKIP only when every dated event lies from the Prague expedition day (A `packedAt`, B `shippedAt`) through the decision day; otherwise REVIEW. Pages state no time zone, so only the calendar day is compared and no time is invented.

**Verification unavailable** (no page or tracking number, unsupported carrier): for A the other conditions decide, B → REVIEW. A foreign, shared or unreadable page → REVIEW for both.

**Verification is wrong.** A false "delivered" suppresses a justified complaint, so an explicit handover to the recipient and time consistency are required. A false "in transit" would lead to an unjustified complaint for B, so `IN_TRANSIT` is accepted only from a known structure with a date (Kurýr Vltava without a date and Doručto are not enough). Uncertainty leads to REVIEW, which costs only the clerk's time.

**Measurement (20 pages):** 16/20 correct, 14/14 definite answers correct, 4 conservative `UNKNOWN` for Doručto, 0 critical errors. This is a development set, not an independent validation.

**Scope boundary:** CREATE is a decision of the offline program, not the creation of a complaint in Mailship. The supplied data give 0 CREATE because `reporters.csv` is missing.

## 7. Rollout and how we know it works

1. **Shadow mode (2–4 weeks):** the system decides every morning, creates nothing, and its results are compared with the clerk's work.
2. **Metrics:** agreement with the clerk on CREATE and SKIP; number of unjustified CREATE proposals (target 0); share of REVIEW; classifier errors per carrier.
3. **Gradual enabling of CREATE:** first one carrier with a textual status page and human approval, then without approval for cases with complete evidence.
4. **Prerequisites for CREATE:** reporter matrix; a stagnation threshold and a maximum tracking age; an idempotent write with a check for an existing complaint immediately before; an audit record with evidence.
