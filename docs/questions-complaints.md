# Questions for the claims department

Ordered by impact on correctness and safety. The "Current assumption" column describes what the implementation does today. It is an assumption, not an answer.

## Before production (changes decisions)

| # | Question | Why it matters | Current assumption |
|---|---|---|---|
| 1 | Which clients are "large", and what does the contact matrix look like? Does the reporter apply per client, or per client and complaint type? | Without the matrix the reporter cannot be determined. No complaint is created automatically. | Without the matrix, REVIEW. The reporter from history is only supporting information. |
| 2 | After how long without a new carrier event is a shipment "lost"? How fresh must tracking be at the moment of decision? | Without this, a "loss" complaint may be created for a shipment that moved recently. | Stagnation is not measured. Definition B gets CREATE with a dated `IN_TRANSIT` page without delivery activity; the carrier pickup date is not compared with `shippedAt`. |
| 3 | Should a "loss" complaint be created when, after 14 days, the carrier shows delivery in progress (shipment waiting in a parcel locker, failed attempt, courier out for delivery)? | Otherwise the 14-day rule would lead to clearly unjustified complaints (120116, 120118, 120123). | REVIEW (`TRACKING_ACTIVE_DELIVERY`) |
| 4 | Does a **closed** complaint on the same order also block a new complaint? | The brief explicitly mentions only a draft. | It blocks, SKIP. |
| 5 | Does a complaint with a **different reason** (e.g. `damaged` versus `loss`) also block a new complaint? | It may suppress a justified complaint. | It blocks, SKIP. |
| 6 | Is the carrier status "returning to sender" enough not to create a complaint, even if there is no WMS return yet? | The rule in the brief only mentions a WMS return. | SKIP (`TRACKING_RETURNING`), conservatively |
| 7 | Is a handover to a neighbour or another third party a delivery? | Decides between SKIP and a complaint. | No. `UNKNOWN`, i.e. REVIEW. |
| 8 | Without verification with the carrier (missing page or tracking number, unsupported carrier), should the complaint always be handed to a human? | Today a claims clerk checks tracking "usually", i.e. not always. | Definition A: tracking is not required (the missing pickup is the subject of the complaint). Definition B: REVIEW. |
| 9 | Who approves complaints while the matrix is not available? Who handles the REVIEW queue? | Without a queue owner, automation saves nothing. | not addressed |
| 10 | What should happen when a client has no complaint history, or the last reporter is ambiguous (two complaints at the same moment)? | A complaint must have a reporter. | REVIEW (`REPORTER_NOT_FOUND`, `REPORTER_DATA_INVALID`) |
| 11 | Should automatic creation have a human approval step in the first weeks? Based on what do we turn it off? | Risk management during rollout | Proposal: shadow mode, then approval (see [architecture.md](architecture.md) § 7) |

## Clarifications (less critical)

| # | Question | Current assumption |
|---|---|---|
| 12 | "Last reporter from history": does it also count drafts and complaints with a different reason? | The latest `createdAt` decides, in any state and with any reason. |
| 13 | "Minimum period of 2 days": does it mean ≥ 2 calendar days (Monday → Wednesday)? | Yes, ≥, Prague calendar dates |
| 14 | Is the loss of automation acceptable for carriers whose page does not express the status in text (Doručto)? Or should the graphical indicator also be read? | It is not read, `UNKNOWN`. |
| 15 | Under definition A (not picked up by the carrier), should the system stop the complaint when tracking shows that the carrier has the shipment? | Yes, REVIEW with an explanation of the conflict. |
