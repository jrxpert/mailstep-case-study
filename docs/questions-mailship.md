# Questions for the Mailship development team

Ordered by impact on data correctness and safe integration.

## Data and its meaning

| # | Question | Why | Current assumption |
|---|---|---|---|
| 1 | What is the authoritative source of the order status and the carrier status? How quickly does the normalised carrier status propagate? Can retrack return both the event time and the time the status was obtained from the carrier? | A candidate arises from a stuck status. The carrier holds the truth about delivery, and without the fetch time freshness cannot be verified. | The order status is only a trigger; the stored page is what gets verified. |
| 2 | Can `packedAt` or `shippedAt` be overwritten (repacking, repeated handover)? Is there a status history? | The time spent in a status is calculated from these fields. | Reliable times of entering the status. `updatedAt` is not used. |
| 3 | Are all times ISO 8601 with an offset? Which time zone are carrier times in? Does Prague also apply to the warehouse in Italy? | Day boundaries (120125: 13 or 14 days?) | A time without an offset is rejected. Days are counted by the Prague calendar. |
| 4 | Is `orderNumber` unique and always filled in? What is the real key, `orderNumber` or `orderId`? | Complaints and returns are matched via `orderNumber`. | A missing or conflicting order number gives REVIEW. |
| 5 | Can the export contain duplicate rows (120101 appears twice in the export)? Can duplicates differ? | Risk of a double complaint | Identical rows give one decision, differing rows give REVIEW. |
| 6 | Is `shippingMethod` a stable string, or is there a code? Do the names change? | Exclusions are compared by name. | Exact match after normalisation; a difference only in letter case gives REVIEW. |
| 7 | Where does the reporter matrix originate and what is its schema (columns, key, validity)? | `reporters.csv` was not supplied. | Only `client,reporter` is accepted. |
| 8 | How are carrier, shipping method and tracking URL mapped? Is `carrier: null` on 120110 a known data defect? | Parser selection, page identity check | The carrier is verified against the page `<title>`. |

## Integration and writes

| # | Question | Why |
|---|---|---|
| 9 | Is there an API for creating a complaint? Does it support an idempotency key or uniqueness per order and reason? | A repeated run must not create a second complaint. |
| 10 | How can the existence of a complaint, including drafts, be reliably checked right before the write? | Concurrency with a claims clerk or another run (race condition) |
| 11 | How quickly are WMS returns synchronised into Mailship? Can a return exist in the WMS but still be missing from the export? | A return blocks a complaint in any state. |
| 12 | What errors and limits does the API return (rate limit, 409, timeouts)? How should retries work? | Safe retries without duplicates |
| 13 | Can several automation instances run at the same time? Is there a per-order lock? | Concurrent runs |
| 14 | Can retrack be called in bulk, and what is its limit? Does Mailship have live tracking for all carriers, including Doručto? | Fresh verification before every CREATE |
| 15 | Where should the decision audit record (reasons, evidence, rule version) be stored? Is there a field on the complaint for it? | Traceability, evaluation of shadow mode |
| 16 | Is a test or sandbox environment with realistic data available? | Shadow mode and integration tests |
