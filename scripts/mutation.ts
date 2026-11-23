// Targeted mutation testing for the safety-critical decision path. No framework: each mutant is one
// exact textual change in a scratch copy of the repository; the full test suite then runs. A mutant
// is KILLED when the suite fails. Mutants judged equivalent are declared up front WITH a reason; the
// run checks that judgement (an "equivalent" mutant that gets killed is reported as misclassified).
//
// Score = killed / (generated − equivalent). Exit 1 if a non-equivalent mutant survives, if an
// expected-equivalent mutant is killed, or if a mutant does not match its source exactly once.
//
// Usage: npm run mutation   (≈ 15 min; not part of the per-push CI job)

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface Mutant { id: string; area: string; file: string; find: string; replace: string; what: string; equivalent?: string }

const MUTANTS: Mutant[] = [
  // Business eligibility (definitions A/B)
  { id: "M01", area: "eligibility", file: "src/rules/eligibility.ts", find: "days.days < def.minDaysInStatus", replace: "days.days <= def.minDaysInStatus", what: "threshold off by one (>= becomes >)" },
  { id: "M02", area: "eligibility", file: "src/rules/eligibility.ts", find: "days.days < def.minDaysInStatus", replace: "days.days < def.minDaysInStatus - 1", what: "threshold one day too lenient" },
  { id: "M03", area: "eligibility", file: "src/rules/eligibility.ts", find: "if (exact !== undefined) {", replace: "if (false) {", what: "excluded shipping methods ignored" },
  { id: "M04", area: "eligibility", file: "src/rules/eligibility.ts", find: "([, def]) => def.status === order.status", replace: "([, def]) => def.status !== order.status", what: "wrong definition selected for a status" },
  { id: "M05", area: "time", file: "src/time/pragueDays.ts", find: "timeZone: PRAGUE_TIME_ZONE,", replace: 'timeZone: "UTC",', what: "calendar days counted in UTC instead of Prague" },
  { id: "M06", area: "time", file: "src/time/pragueDays.ts", find: 'return { field: "shippedAt", value: order.shippedAt };', replace: 'return { field: "shippedAt", value: order.updatedAt };', what: "updatedAt used as state-entry time" },
  // Blockers
  { id: "M07", area: "blockers", file: "src/rules/blockers.ts", find: "if (c.orderNumber === orderNumber && (client === null || c.client === client)) {", replace: 'if (c.status !== "closed" && c.orderNumber === orderNumber && (client === null || c.client === client)) {', what: "closed complaints do not block" },
  { id: "M08", area: "blockers", file: "src/rules/blockers.ts", find: "if (c.orderNumber === orderNumber && (client === null || c.client === client)) {", replace: 'if (c.status !== "draft" && c.orderNumber === orderNumber && (client === null || c.client === client)) {', what: "draft complaints do not block" },
  { id: "M09", area: "blockers", file: "src/rules/blockers.ts", find: "if (r.orderNumber === orderNumber) {", replace: 'if (r.status !== "Připraveno" && r.orderNumber === orderNumber) {', what: "returns in Připraveno do not block" },
  { id: "M10", area: "blockers", file: "src/rules/blockers.ts", find: 'if (typeof raw === "string" && (raw === orderNumber || mayDenote(raw, orderNumber))) {', replace: "if (false) {", what: "malformed complaint/return records ignored" },
  // Reporter
  { id: "M11", area: "reporter", file: "src/rules/reporter.ts", find: 'if (matrix.status === "missing") {', replace: 'if (matrix.status === "missing" && history.status !== "found") {', what: "history used as reporter while the matrix is missing" },
  { id: "M12", area: "reporter", file: "src/decision/decide.ts", find: 'reporter?.status === "resolved" && findings.length === 0 &&', replace: "findings.length === 0 &&", what: "create checklist ignores the reporter",
    equivalent: "double guard: every non-resolved reporter outcome adds a review-effect reason, which decides REVIEW before the checklist is consulted (M13 shows the checklist catching a broken reason)" },
  { id: "M13", area: "reporter", file: "src/domain/types.ts", find: 'REPORTER_MATRIX_UNAVAILABLE: "review",', replace: 'REPORTER_MATRIX_UNAVAILABLE: "info",', what: "missing matrix no longer forces REVIEW" },
  // CREATE authorisation
  { id: "M25", area: "authorisation", file: "src/decision/decide.ts", find: 'if (definition !== "B") {', replace: "if (false) {", what: "definition A: in-transit page no longer contradicts the complaint reason" },
  { id: "M27", area: "authorisation", file: "src/decision/decide.ts", find: 'if (hasEffect(reasons, "skip")) return "skip";', replace: "", what: "skip reasons no longer take precedence" },
  { id: "M28", area: "authorisation", file: "src/domain/types.ts", find: 'TRACKING_DELIVERED: "skip",', replace: 'TRACKING_DELIVERED: "review",', what: "confirmed delivery no longer skips" },
  { id: "M30", area: "authorisation", file: "src/domain/types.ts", find: 'EXISTING_COMPLAINT: "skip",', replace: 'EXISTING_COMPLAINT: "info",', what: "existing complaint no longer blocks" },
  // Malformed HTML
  { id: "M31", area: "html", file: "src/tracking/html.ts", find: "if (!isScalarValue(code)) throw new MalformedHtmlError(", replace: "if (false) throw new MalformedHtmlError(", what: "invalid character references not rejected" },
  { id: "M32", area: "html", file: "src/tracking/classify.ts", find: "if (!(e instanceof MalformedHtmlError)) throw e;", replace: "", what: "any error swallowed as UNKNOWN" },
  // Tracking history
  { id: "M33", area: "parser", file: "src/tracking/carriers/kuryrVltava.ts", find: "if (!/doručena příjemci/i.test(msg)) return unknown(", replace: "if (false) return unknown(", what: "'doručena' without the recipient accepted as DELIVERED" },
  { id: "M34", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: 'if (count(html, "table") !== 1)', replace: "if (false)", what: "tables besides the events table ignored" },
  { id: "M35", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: "const rows = byTag(table, \"tr\");", replace: "const rows = byTag(table, \"tbody\").slice(0, 1).flatMap((b) => byTag(b, \"tr\"));", what: "only the first <tbody> read" },
  { id: "M36", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: "if (unrecognised) {", replace: "if (false) {", what: "unrecognised earlier events ignored" },
  { id: "M37", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: 'if (c.state === "IN_TRANSIT" && events.some((e) => e.cls?.state === "RETURNING")) {', replace: "if (false) {", what: "earlier return to the sender ignored" },
  { id: "M38", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: "DATE_CELL.test(date) && TIME_CELL.test(time) ?", replace: "true ?", what: "date/time cells parsed leniently (first date-like text)" },
  { id: "M39", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: 'return found.size === 1 && byTag(html, "h1").length > 0 ?', replace: 'return found.size >= 1 && byTag(html, "h1").length > 0 ?', what: "conflicting tracking numbers on the page accepted" },
  { id: "M40", area: "parser", file: "src/tracking/carriers/kuryrVltava.ts", find: '...base, eventTime: null, state: "IN_TRANSIT", activity, reason,', replace: '...base, eventTime, state: "IN_TRANSIT", activity, reason,', what: "date in an in-transit sentence used as the last event" },
  { id: "M41", area: "parser", file: "src/tracking/carriers/kuryrVltava.ts", find: "const eventTime = dates === 1 ? czechDateTime(msg) : null;", replace: "const eventTime = czechDateTime(msg);", what: "first of several dates used" },
  { id: "M43", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: "if (!plain) return unknown(", replace: "if (false) return unknown(", what: "any in-transit history accepted" },
  { id: "M44", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: 'const newestFirst = keys.every((k, i) => i === 0 || k < (keys[i - 1] ?? ""));', replace: 'const newestFirst = keys.every((k, i) => i === 0 || k <= (keys[i - 1] ?? ""));', what: "equal timestamps / duplicated rows accepted" },
  { id: "M45", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: "rest.every((e) => PROCESSED.test(e.text) && SORTING_CENTRE.test(e.place))", replace: "rest.every((e) => PROCESSED.test(e.text))", what: "event place not checked" },
  { id: "M47", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: "/^(?:Zásilka vrácena odesílateli|Úložní doba uplynula, zásilka se vrací odesílateli)\\.?$/", replace: "/vrácena odesílateli|vrací odesílateli/", what: "ParcelNord return matched as a substring" },
  { id: "M48", area: "parser", file: "src/tracking/carriers/kuryrVltava.ts", find: "if (RETURNING.test(msg)) {", replace: "if (/vracíme odesílateli|vrací odesílateli|vrácena odesílateli/i.test(msg)) {", what: "Kurýr Vltava return matched as a substring" },
  { id: "M49", area: "parser", file: "src/tracking/carriers/kuryrVltava.ts", find: "} else if (/odesílatel/i.test(msg)) {", replace: "} else if (false) {", what: "unrecognised sentence naming the sender read as transit" },
  { id: "M50", area: "parser", file: "src/tracking/carriers/expedo.ts", find: "if (/^Zásilka byla předána příjemci\\.$/.test(detail))", replace: "if (/příjemci/i.test(detail))", what: "Expedo: any 'příjemci' read as handover (wrong SKIP)" },
  { id: "M51", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: "sameTime.map((e) => `${e.cls?.state}/${e.cls?.activity}`)", replace: "sameTime.map((e) => `${e.cls?.state}`)", what: "same-time events compared by state only (row order decides activity)" },
  { id: "M52", area: "parser", file: "src/tracking/classify.ts", find: "const r = parser.parse(stripInert(html));", replace: "const r = parser.parse(html);", what: "comments/scripts not rejected before parsing" },
  { id: "M53", area: "parser", file: "src/tracking/carriers/parcelNord.ts", find: 'if (!HEADER.test(table) || residue.trim() !== "")', replace: "if (false)", what: "PN: table layout not allowlisted" },
  // CREATE gate (decisions.md D-30)
  { id: "M70", area: "create", file: "src/decision/decide.ts", find: 'return definition === "A" && noEvidence ? notRequired(', replace: "return false && noEvidence ? notRequired(", what: "definition A requires a tracking page (CREATE-A impossible)" },
  { id: "M71", area: "create", file: "src/decision/decide.ts", find: 'const noEvidence = t.reason === "NO_TRACKING_NUMBER" || t.reason === "NO_TRACKING_PAGE" || t.reason === "UNSUPPORTED_CARRIER";', replace: "const noEvidence = true;", what: "definition A ignores a shared or unusable tracking number" },
  { id: "M72", area: "create", file: "src/decision/decide.ts", find: 'if (c.activity === "ACTIVE") return block(', replace: "if (false) return block(", what: "definition B: active last mile permits CREATE" },
  { id: "M73", area: "create", file: "src/decision/decide.ts", find: 'if (c.evidence.eventTime === null) return block(reason("TRACKING_ACTIVITY_UNDETERMINED"', replace: 'if (false) return block(reason("TRACKING_ACTIVITY_UNDETERMINED"', what: "definition B: undated in-transit page permits CREATE" },
  { id: "M74", area: "create", file: "src/decision/decide.ts", find: 'if (definition === "A" && o.shippedAt !== null) return', replace: "if (false) return", what: "waiting_for_carrier with a shippedAt accepted" },
  { id: "M75", area: "create", file: "src/decision/decide.ts", find: "timing === null && gate?.permits === true;", replace: "timing === null;", what: "create checklist ignores the tracking gate",
    equivalent: "double guard: a non-permitting tracking gate always adds a skip- or review-effect reason, which decides the action before the checklist is consulted (M28/M72 show the reasons doing that work)" },
  // Time-consistent tracking evidence
  { id: "M76", area: "time-consistency", file: "src/decision/decide.ts", find: "if (earliest.local.slice(0, 10) < from)", replace: "if (false)", what: "event before the expedition day accepted" },
  { id: "M77", area: "time-consistency", file: "src/decision/decide.ts", find: "if (earliest.local.slice(0, 10) < from)", replace: "if (earliest.local.slice(0, 10) <= from)", what: "event on the expedition day rejected (boundary)" },
  { id: "M78", area: "time-consistency", file: "src/decision/decide.ts", find: "if (latest.local.slice(0, 10) > to)", replace: "if (false)", what: "event after the decision day accepted" },
  { id: "M79", area: "time-consistency", file: "src/decision/decide.ts", find: "const earliest = c.earliestEventTime ?? latest;", replace: "const earliest = latest;", what: "only the latest event compared with the expedition" },
  { id: "M80", area: "time-consistency", file: "src/decision/decide.ts", find: 'if (latest === null) return "the page shows no valid carrier event date";', replace: "if (latest === null) return null;", what: "delivery or return without a usable date accepted" },
  { id: "M81", area: "time-consistency", file: "src/decision/decide.ts", find: 'if (inconsistent) return block(inconsistent);\n      return c.state === "DELIVERED"', replace: 'return c.state === "DELIVERED"', what: "DELIVERED / RETURNING skip without a date check" },
  // Expedo in-transit card (can support a definition-B CREATE)
  { id: "M82", area: "parser", file: "src/tracking/carriers/expedo.ts", find: "if (!NEUTRAL_TRANSIT.test(detail)) return unknown(", replace: "if (false) return unknown(", what: "Expedo: contradictory card text under 'Na cestě' accepted" },
  { id: "M83", area: "parser", file: "src/tracking/carriers/expedo.ts", find: "if (!UPDATED.test(updated)) return unknown(", replace: "if (false) return unknown(", what: "Expedo: inexact update time accepted" },
  { id: "M84", area: "parser", file: "src/tracking/carriers/expedo.ts", find: "if (!CARD.test(card)) return unknown(", replace: "if (false) return unknown(", what: "Expedo: unrecognised card structure accepted" },
  { id: "M85", area: "parser", file: "src/tracking/carriers/expedo.ts", find: "if (cards.length !== 1 || mentions !== 1)", replace: "if (cards.length !== 1)", what: "Expedo: a second (differently quoted) status card ignored" },
  // Identity and look-alike identifiers
  { id: "M55", area: "identity", file: "src/rules/reporter.ts", find: 's.normalize("NFC").replace(/\\p{White_Space}+/gu, " ").trim()', replace: 's.normalize("NFC").trim()', what: "Unicode whitespace not normalised" },
  { id: "M56", area: "identity", file: "src/domain/reason.ts", find: "\\p{Default_Ignorable_Code_Point}\\p{Z}\\s\\p{P}\\p{S}\\u2800", replace: "\\p{Z}\\s", what: "invisible, punctuation and filler characters not detected" },
  { id: "M57", area: "identity", file: "src/domain/reason.ts", find: "return x.length === y.length && x.every(", replace: "return false && x.every(", what: "look-alikes from other scripts not detected" },
  { id: "M58", area: "reporter", file: "src/rules/reporter.ts", find: "if (nowMs !== null && latest.at > nowMs) {", replace: "if (false) {", what: "complaint dated after the decision time picks the reporter" },
  { id: "M59", area: "reporter", file: "src/rules/reporter.ts", find: "if (near.length > 0) {", replace: "if (false) {", what: "near-identical matrix spelling falls back to history" },
  { id: "M60", area: "reporter", file: "src/rules/reporter.ts", find: "if (variants.size > 0) {", replace: "if (false) {", what: "variant client names in complaint history ignored" },
  { id: "M61", area: "reporter", file: "src/rules/reporter.ts", find: "if (other !== undefined && !invalidClients.has(a))", replace: "if (false)", what: "near-identical matrix rows not detected" },
  { id: "M62", area: "reporter", file: "src/rules/reporter.ts", find: "return c === null || sameClient(c, client) || mayBeClient(c, client);", replace: "return c !== null && (sameClient(c, client) || mayBeClient(c, client));", what: "malformed complaint without a resolvable client ignored" },
  { id: "M63", area: "identity", file: "src/cli.ts", find: "pageTrackingProvider(trackingDir, allOrderRows(inputs.orders))", replace: "pageTrackingProvider(trackingDir, inputs.orders.valid.map((v) => v.record))", what: "malformed order rows not considered for the page mapping" },
  { id: "M64", area: "identity", file: "src/rules/identity.ts", find: "const v = r.order?.orderId ?? (typeof r.raw", replace: "const v = r.order?.orderId ?? (false && typeof r.raw", what: "orderId of malformed rows ignored" },
  { id: "M65", area: "blockers", file: "src/rules/blockers.ts", find: "} else if (mayDenote(r.orderNumber, orderNumber)) {", replace: "} else if (false) {", what: "return with a look-alike order number ignored" },
  { id: "M66", area: "blockers", file: "src/rules/blockers.ts", find: "} else if (mayDenote(c.orderNumber, orderNumber)) {", replace: "} else if (false) {", what: "complaint with a look-alike order number ignored" },
  { id: "M67", area: "identity", file: "src/decision/decide.ts", find: "...(lookalikes.length > 0 ?", replace: "...(false ?", what: "order rows with look-alike order numbers decided independently" },
  // Order timestamps
  { id: "M68", area: "time", file: "src/decision/decide.ts", find: "if (timing !== null) reasons.push(", replace: "if (false) reasons.push(", what: "inconsistent order timestamps ignored before CREATE" },
  { id: "M69", area: "time", file: "src/decision/decide.ts", find: "if (chain.some((t, i) => i > 0 && t < (chain[i - 1] as number)) || updated > nowMs)", replace: "if (updated > nowMs)", what: "order of createdAt/packedAt/shippedAt not checked" },
];

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ws = mkdtempSync(join(tmpdir(), "mailstep-mutation-"));
for (const entry of ["src", "test", "data", "examples", "scripts", "package.json", "tsconfig.json"]) cpSync(join(ROOT, entry), join(ws, entry), { recursive: true });
symlinkSync(join(ROOT, "node_modules"), join(ws, "node_modules"), "dir");

const runSuite = () => spawnSync(process.execPath, ["--test", "test/**/*.test.ts"], { cwd: ws, encoding: "utf8", timeout: 300_000 });
const baseline = runSuite();
if (baseline.status !== 0) {
  console.error("unmutated suite fails; mutation testing aborted");
  rmSync(ws, { recursive: true, force: true });
  process.exit(1);
}

type Row = Mutant & { status: "killed" | "survived" | "invalid"; failed: string };
const rows: Row[] = [];
for (const m of MUTANTS) {
  const path = join(ws, m.file);
  const original = readFileSync(path, "utf8");
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    rows.push({ ...m, status: "invalid", failed: `pattern matched ${count} times` });
    continue;
  }
  writeFileSync(path, original.replace(m.find, m.replace));
  const r = runSuite();
  writeFileSync(path, original);
  const failed = /ℹ fail (\d+)/.exec(r.stdout)?.[1] ?? (r.status === 0 ? "0" : "?");
  rows.push({ ...m, status: r.status === 0 ? "survived" : "killed", failed });
  process.stderr.write(`${m.id} ${r.status === 0 ? "survived" : "killed"}\n`);
}
rmSync(ws, { recursive: true, force: true });

const equivalent = rows.filter((r) => r.equivalent);
const meaningful = rows.filter((r) => !r.equivalent);
const killed = meaningful.filter((r) => r.status === "killed").length;
const survivors = meaningful.filter((r) => r.status === "survived");
const misclassified = equivalent.filter((r) => r.status !== "survived");
const invalid = rows.filter((r) => r.status === "invalid");

console.log("| Mutant | Area | Change | Result | Failing tests |\n|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.id} | ${r.area} | ${r.what} | ${r.equivalent ? `${r.status} (declared equivalent)` : r.status} | ${r.failed} |`);
console.log(`\ngenerated ${rows.length}; declared equivalent ${equivalent.length}; killed ${killed}/${meaningful.length}; survived ${survivors.length}; invalid ${invalid.length}`);
console.log(`mutation score (excluding equivalent): ${meaningful.length ? ((killed / meaningful.length) * 100).toFixed(1) : "n/a"} %`);
for (const r of equivalent) console.log(`equivalent ${r.id}: ${r.equivalent}`);

if (survivors.length || misclassified.length || invalid.length) {
  console.error(`FAIL: survivors [${survivors.map((r) => r.id).join(", ")}], misclassified equivalents [${misclassified.map((r) => r.id).join(", ")}], invalid [${invalid.map((r) => r.id).join(", ")}]`);
  process.exit(1);
}
