# Synthetic example: CREATE for definition A and B

**All data in this folder is synthetic.** It is not source data from Mailstep. The folder shows that
the regular CLI with the same rules (`rules.yaml` is a copy of `data/rules.yaml`) returns CREATE when the
inputs are complete and consistent. No special mode or flag.

```bash
node src/cli.ts --data examples/create --out out/create --skip-eval
```

| Order | Definition | Why CREATE | Complaint reason |
|---|---|---|---|
| MS-EX-A-0001 | A | `waiting_for_carrier` since 29 Oct 2026 (4 Prague days), Kurýr Vltava Standard, no complaint or return; large client → reporter from matrix; no tracking page needed | `not_collected_by_carrier` |
| MS-EX-B-0001 | B | `carrier_picked_up` since 9 Oct 2026 (24 days), ParcelNord Home, no complaint or return; client not in matrix → most recent reporter from history; page shows the shipment in transit, latest event on 12 Oct 2026 (between dispatch and decision), no delivery activity | `loss` |

| File | Contents |
|---|---|
| `orders.json` | the two orders above |
| `complaints.json` | closed complaint for another order of client "Malý Klient s.r.o." (reporter source) |
| `returns.json` | no returns |
| `reporters.csv` | matrix with a single large client "Velký Klient s.r.o." |
| `tracking/PNEXB0001.html` | copy of `data/tracking/PN55100114.html` with a changed tracking number |

Negative variants (complaint, draft, return, missing reporter or matrix, conflicting identity,
shared tracking number, invalid and future timestamps, delivery, return to sender, UNKNOWN, foreign page, temporally
impossible events) are in `test/integration/create-scenarios.test.ts`. Tests modify a copy of this folder,
never the folder itself.
