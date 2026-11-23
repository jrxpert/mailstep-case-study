// Reporter resolution (FR-10). Assignment [PDF p.1]: large clients → contact matrix; others → last
// reporter from the client's complaint history. "Large" is defined only by the matrix.
//
// The matrix (data/reporters.csv) was NOT supplied and its schema is unspecified. ASSUMPTION
// (documented in docs/decisions.md D-14): a usable matrix has exactly the columns `client,reporter`.
// Any other layout is rejected as invalid (fail-closed) rather than interpreted.

import { looseKey, mayDenote } from "../domain/reason.ts";
import type { Complaint, ReporterMatrix, ReporterResolution } from "../domain/types.ts";
import type { Collection } from "../io/load.ts";
import { parseIsoInstant } from "../time/pragueDays.ts";

export type ParsedMatrix =
  | { status: "missing" }
  | { status: "invalid"; problems: string[] }
  | {
      status: "valid";
      /** client → reporter, for clients the matrix identifies as large. */
      reporters: Map<string, { reporter: string; evidence: string }>;
      /** Large clients whose matrix entry cannot be trusted. */
      invalidClients: Map<string, string>;
    };

const EXPECTED_COLUMNS = ["client", "reporter"];
/** Reporter values in the provided complaints are e-mail addresses; anything else is not trusted. */
const REPORTER_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Client identity. Two names are the SAME client when they are equal after Unicode NFC
 * and after every run of Unicode White_Space (NBSP, thin space, tab, …; not invisible format
 * characters such as U+FEFF) is collapsed to one space and trimmed. Case and diacritics stay
 * significant. A different name that `mayDenote` the same client is never a match: the reporter is
 * unresolvable (REVIEW) instead of letting history or another matrix row decide.
 */
export const clientKey = (s: string): string => s.normalize("NFC").replace(/\p{White_Space}+/gu, " ").trim();
const sameClient = (a: string, b: string) => clientKey(a) === clientKey(b);
const mayBeClient = (a: string, b: string) => mayDenote(clientKey(a), clientKey(b));

export function parseReporterMatrix(matrix: ReporterMatrix): ParsedMatrix {
  if (matrix.status === "missing") return { status: "missing" };
  const cols = [...matrix.columns].map((c) => c.trim()).sort();
  if (cols.join(",") !== EXPECTED_COLUMNS.join(",")) {
    return { status: "invalid", problems: [`unsupported columns [${matrix.columns.join(", ")}]; expected exactly [${EXPECTED_COLUMNS.join(", ")}]`] };
  }
  const reporters = new Map<string, { reporter: string; evidence: string }>();
  const invalidClients = new Map<string, string>();
  const problems: string[] = [];
  matrix.rows.forEach((row, i) => {
    const line = i + 2;
    const client = clientKey(row["client"] ?? "");
    const reporter = (row["reporter"] ?? "").trim();
    if (looseKey(client) === "") {
      // A row we cannot attribute could belong to any client → nobody can be classified safely.
      problems.push(`line ${line}: empty client`);
      return;
    }
    if (!REPORTER_SHAPE.test(reporter)) {
      invalidClients.set(client, `line ${line}: invalid reporter ${JSON.stringify(reporter)}`);
      return;
    }
    const existing = reporters.get(client);
    if (existing && existing.reporter !== reporter) {
      invalidClients.set(client, `conflicting reporters ${existing.reporter} / ${reporter} (line ${line})`);
    } else if (!existing) {
      reporters.set(client, { reporter, evidence: `${matrix.path.split(/[\\/]/).pop()} line ${line}` });
    }
  });
  if (problems.length > 0) return { status: "invalid", problems };

  // Rows that may denote the same client under different spellings: neither can be trusted.
  const names = [...reporters.keys(), ...invalidClients.keys()];
  for (const a of names) {
    const other = names.find((b) => mayBeClient(a, b));
    if (other !== undefined && !invalidClients.has(a)) invalidClients.set(a, `matrix also lists the near-identical client name ${JSON.stringify(other)}`);
  }
  for (const c of invalidClients.keys()) reporters.delete(c);
  return { status: "valid", reporters, invalidClients };
}

type HistoryResult =
  | { status: "found"; reporter: string; evidence: string }
  | { status: "none" }
  | { status: "invalid"; detail: string };

/**
 * Latest complaint (by createdAt instant, any status, any reason) of the client. With `now`, a
 * complaint dated after the decision time makes the history invalid (it cannot be the latest known).
 */
export function latestHistoryReporter(client: string, complaints: Collection<Complaint>, now?: string, clientOf?: (orderNumber: string) => string | null): HistoryResult {
  const key = clientKey(client);
  // A malformed complaint that may belong to this client could be its latest one: never pick an older
  // reporter around it. Without a usable client, the client of the order it refers to is used; if
  // that is unknown too, the record cannot be ruled out.
  const badForClient = complaints.invalid.filter((b) => {
    const raw = (typeof b.raw === "object" && b.raw !== null ? b.raw : {}) as Record<string, unknown>;
    const on = raw["orderNumber"];
    const c = typeof raw["client"] === "string" && looseKey(raw["client"]) !== "" ? raw["client"] : typeof on === "string" ? clientOf?.(on) ?? null : null;
    return c === null || sameClient(c, client) || mayBeClient(c, client);
  });
  if (badForClient.length > 0) {
    return { status: "invalid", detail: `malformed complaint record(s) #${badForClient.map((b) => b.index).join(", #")} may belong to this client and could hide the latest reporter` };
  }
  const variants = new Set(complaints.valid.filter((c) => mayBeClient(c.record.client, client)).map((c) => JSON.stringify(c.record.client)));
  if (variants.size > 0) {
    return { status: "invalid", detail: `complaint history also names client ${[...variants].join(", ")}, which may denote the same client; the latest reporter is ambiguous` };
  }
  const mine = complaints.valid
    .filter((c) => clientKey(c.record.client) === key)
    .map((c) => ({ ...c, at: parseIsoInstant(c.record.createdAt) ?? -Infinity }))
    .sort((a, b) => b.at - a.at);
  const latest = mine[0];
  if (!latest) return { status: "none" };
  const nowMs = now !== undefined ? parseIsoInstant(now) : null;
  if (nowMs !== null && latest.at > nowMs) {
    return { status: "invalid", detail: `latest complaint ${latest.record.complaintId} is dated ${latest.record.createdAt}, after the decision time ${now}` };
  }
  const tied = mine.filter((c) => c.at === latest.at && c.record.reporter !== latest.record.reporter);
  if (tied.length > 0) {
    return { status: "invalid", detail: `latest complaints at ${latest.record.createdAt} name different reporters` };
  }
  if (!REPORTER_SHAPE.test(latest.record.reporter)) {
    return { status: "invalid", detail: `latest reporter ${JSON.stringify(latest.record.reporter)} is not a valid address` };
  }
  return { status: "found", reporter: latest.record.reporter, evidence: `${complaints.path.split(/[\\/]/).pop()}#${latest.index} (${latest.record.complaintId}, ${latest.record.createdAt})` };
}

export function resolveReporter(
  client: string, matrix: ParsedMatrix, complaints: Collection<Complaint>, now?: string, clientOf?: (orderNumber: string) => string | null,
): ReporterResolution {
  const history = latestHistoryReporter(client, complaints, now, clientOf);
  if (matrix.status === "missing") {
    // Conservative policy (not an assignment requirement): without the matrix the client cannot be
    // classified as large or non-large, so history is evidence only.
    return {
      status: "needs_missing_data",
      missing: "REPORTER_MATRIX",
      historyCandidate: history.status === "found" ? { reporter: history.reporter, evidence: history.evidence } : null,
    };
  }
  if (matrix.status === "invalid") return { status: "invalid", detail: `reporter matrix invalid: ${matrix.problems.join("; ")}` };

  const key = clientKey(client);
  const bad = matrix.invalidClients.get(key);
  if (bad !== undefined) return { status: "invalid", detail: `reporter matrix entry for "${client}": ${bad}` };
  const listed = matrix.reporters.get(key);
  if (listed) return { status: "resolved", reporter: listed.reporter, source: "matrix", evidence: listed.evidence };
  // A near-identical matrix spelling means matrix applicability is unresolved: never fall back to
  // history, which could pick a different reporter for a large client.
  const near = [...matrix.reporters.keys(), ...matrix.invalidClients.keys()].filter((m) => mayBeClient(m, client));
  if (near.length > 0) {
    return { status: "invalid", detail: `client "${client}" may denote reporter matrix entry ${near.map((n) => JSON.stringify(n)).join(" / ")}; matrix applicability unresolved` };
  }

  // Not in a valid matrix → non-large client → history rule.
  if (history.status === "found") return { status: "resolved", reporter: history.reporter, source: "history", evidence: history.evidence };
  if (history.status === "invalid") return { status: "invalid", detail: history.detail };
  return { status: "not_found", detail: `client "${client}" is not in the matrix and has no complaint history` };
}
