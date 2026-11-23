// Typed, validating loaders for the fixture files. Read-only: files are never written.
//
// Error model:
//   - Mandatory file missing / unreadable / wrong top-level shape  → throws InputError (fatal).
//   - Individual malformed record                                   → kept in `invalid` with its raw
//     source and every problem found; never silently dropped.
//   - Optional file missing (reporters.csv)                         → explicit { status: "missing" }.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  COMPLAINT_STATUSES,
  ORDER_STATUSES,
  TRACKING_STATES,
  type Complaint,
  type ComplaintDefinition,
  type DefinitionId,
  type Order,
  type ReporterMatrix,
  type Return,
  type Rules,
  type TrackingLabel,
} from "../domain/types.ts";
import { parseIsoInstant } from "../time/pragueDays.ts";
import { parseCsv } from "./csv.ts";

export class InputError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InputError";
    this.path = path;
  }
}

export interface LoadedRecord<T> {
  /** 0-based position in the source array / data rows. */
  index: number;
  record: T;
  /** Untouched source record, including any fields the typed record does not model. */
  raw: unknown;
}

export interface InvalidRecord {
  index: number;
  raw: unknown;
  errors: string[];
}

export interface Collection<T> {
  path: string;
  valid: LoadedRecord<T>[];
  invalid: InvalidRecord[];
  /** File-level observations that do not invalidate a record. */
  warnings: string[];
}

// ---------- file helpers ----------

function readRequiredText(path: string): string {
  if (!existsSync(path)) throw new InputError(path, "required input file not found");
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new InputError(path, `cannot read file: ${(e as Error).message}`);
  }
}

function readJsonArray(path: string): unknown[] {
  const text = readRequiredText(path);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new InputError(path, `invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new InputError(path, `expected a JSON array at top level, got ${describe(data)}`);
  return data;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return typeof value;
}

// ---------- field validation ----------

/** Collects every problem in a record instead of stopping at the first one. */
function fieldReader(raw: Record<string, unknown>, errors: string[]) {
  const present = (key: string): boolean => {
    if (!(key in raw)) {
      errors.push(`field "${key}" is missing`);
      return false;
    }
    return true;
  };
  const str = (key: string, nullable: boolean): string | null => {
    if (!present(key)) return null;
    const v = raw[key];
    if (v === null && nullable) return null;
    if (typeof v !== "string") {
      errors.push(`field "${key}" must be ${nullable ? "a string or null" : "a string"}, got ${describe(v)}`);
      return null;
    }
    if (v.trim() === "") {
      errors.push(`field "${key}" is an empty string${nullable ? " (use null for absent values)" : ""}`);
      return null;
    }
    return v;
  };
  const ts = (key: string, nullable: boolean): string | null => {
    const v = str(key, nullable);
    if (v !== null && parseIsoInstant(v) === null) {
      errors.push(`field "${key}" is not an ISO 8601 timestamp with offset: ${JSON.stringify(v)}`);
    }
    return v;
  };
  return {
    string: (key: string): string => str(key, false) ?? "",
    nullableString: (key: string): string | null => str(key, true),
    timestamp: (key: string): string => ts(key, false) ?? "",
    nullableTimestamp: (key: string): string | null => ts(key, true),
    oneOf: <T extends string>(key: string, allowed: readonly T[]): T => {
      const v = str(key, false);
      if (v !== null && !(allowed as readonly string[]).includes(v)) {
        errors.push(`field "${key}" has unknown value ${JSON.stringify(v)}; expected one of: ${allowed.join(", ")}`);
      }
      return v as T;
    },
  };
}

function loadJsonCollection<T>(path: string, build: (f: ReturnType<typeof fieldReader>) => T): Collection<T> {
  const items = readJsonArray(path);
  const result: Collection<T> = { path, valid: [], invalid: [], warnings: [] };
  items.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      result.invalid.push({ index, raw, errors: [`record must be an object, got ${describe(raw)}`] });
      return;
    }
    const errors: string[] = [];
    const record = build(fieldReader(raw as Record<string, unknown>, errors));
    if (errors.length > 0) result.invalid.push({ index, raw, errors });
    else result.valid.push({ index, record, raw });
  });
  return result;
}

// ---------- loaders ----------

export function loadOrders(path: string): Collection<Order> {
  return loadJsonCollection<Order>(path, (f) => ({
    orderId: f.string("orderId"),
    orderNumber: f.nullableString("orderNumber"),
    client: f.string("client"),
    carrier: f.nullableString("carrier"),
    shippingMethod: f.string("shippingMethod"),
    trackingNumber: f.nullableString("trackingNumber"),
    trackingUrl: f.nullableString("trackingUrl"),
    status: f.oneOf("status", ORDER_STATUSES),
    createdAt: f.timestamp("createdAt"),
    packedAt: f.nullableTimestamp("packedAt"),
    shippedAt: f.nullableTimestamp("shippedAt"),
    updatedAt: f.timestamp("updatedAt"),
  }));
}

export function loadComplaints(path: string): Collection<Complaint> {
  return loadJsonCollection<Complaint>(path, (f) => ({
    complaintId: f.string("complaintId"),
    orderNumber: f.string("orderNumber"),
    client: f.string("client"),
    status: f.oneOf("status", COMPLAINT_STATUSES),
    reason: f.string("reason"),
    reporter: f.string("reporter"),
    createdAt: f.timestamp("createdAt"),
  }));
}

export function loadReturns(path: string): Collection<Return> {
  return loadJsonCollection<Return>(path, (f) => ({
    returnId: f.string("returnId"),
    orderNumber: f.string("orderNumber"),
    status: f.string("status"),
    createdAt: f.timestamp("createdAt"),
  }));
}

const DEFINITION_IDS: readonly DefinitionId[] = ["A", "B"];

/** Rules are mandatory configuration: any problem is fatal, all problems are reported at once. */
export function loadRules(path: string): Rules {
  let doc: unknown;
  try {
    doc = parseYaml(readRequiredText(path));
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError(path, `invalid YAML: ${(e as Error).message}`);
  }
  const defs = (doc as { definitions?: unknown } | null)?.definitions;
  if (typeof defs !== "object" || defs === null || Array.isArray(defs)) {
    throw new InputError(path, 'expected a top-level "definitions" mapping');
  }

  const problems: string[] = [];
  const unexpected = Object.keys(defs).filter((k) => !(DEFINITION_IDS as readonly string[]).includes(k));
  if (unexpected.length > 0) problems.push(`unexpected definitions: ${unexpected.join(", ")} (expected A and B)`);

  const definitions = {} as Record<DefinitionId, ComplaintDefinition>;
  for (const id of DEFINITION_IDS) {
    const raw = (defs as Record<string, unknown>)[id];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`definition ${id} is missing or not a mapping`);
      continue;
    }
    const errors: string[] = [];
    const f = fieldReader(raw as Record<string, unknown>, errors);
    const r = raw as Record<string, unknown>;
    const def: ComplaintDefinition = {
      name: f.string("name"),
      status: f.oneOf("status", ORDER_STATUSES),
      minDaysInStatus: r["minDaysInStatus"] as number,
      complaintReason: f.string("complaintReason"),
      excludedShippingMethods: r["excludedShippingMethods"] as string[],
    };
    if (!Number.isInteger(def.minDaysInStatus) || def.minDaysInStatus < 0) {
      errors.push(`field "minDaysInStatus" must be a non-negative integer, got ${describe(r["minDaysInStatus"])}`);
    }
    const excl = r["excludedShippingMethods"];
    if (!Array.isArray(excl) || excl.some((m) => typeof m !== "string" || m.trim() === "")) {
      errors.push('field "excludedShippingMethods" must be a list of non-empty strings');
    }
    problems.push(...errors.map((e) => `definition ${id}: ${e}`));
    definitions[id] = def;
  }
  if (definitions.A && definitions.B && definitions.A.status === definitions.B.status) {
    problems.push(`definitions A and B both apply to status "${definitions.A.status}"; each status must map to one definition`);
  }
  if (problems.length > 0) throw new InputError(path, `invalid rules:\n  - ${problems.join("\n  - ")}`);
  return { definitions };
}

const LABEL_HEADER = ["file", "carrier", "tracking_number", "expected_state", "note"];

/**
 * Ground-truth labels for the tracking pages. Each row must point to an existing HTML file whose
 * name equals the tracking number (original-readme.md: "název souboru = číslo zásilky").
 */
export function loadTrackingLabels(path: string, trackingDir: string): Collection<TrackingLabel> {
  const rows = parseCsvFile(path);
  const header = rows[0];
  if (!header || header.join(",") !== LABEL_HEADER.join(",")) {
    throw new InputError(path, `unexpected header ${JSON.stringify(header)}; expected ${LABEL_HEADER.join(",")}`);
  }
  const result: Collection<TrackingLabel> = { path, valid: [], invalid: [], warnings: [] };
  const seenFiles = new Set<string>();

  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const raw = Object.fromEntries(LABEL_HEADER.map((h, i) => [h, cells[i]]));
    const errors: string[] = [];
    if (cells.length !== LABEL_HEADER.length) {
      errors.push(`line ${line}: expected ${LABEL_HEADER.length} columns, got ${cells.length}`);
    }
    const [file = "", carrier = "", trackingNumber = "", expectedState = "", note = ""] = cells;
    if (file === "") errors.push(`line ${line}: "file" is empty`);
    if (carrier === "") errors.push(`line ${line}: "carrier" is empty`);
    if (trackingNumber === "") errors.push(`line ${line}: "tracking_number" is empty`);
    if (!(TRACKING_STATES as readonly string[]).includes(expectedState)) {
      errors.push(`line ${line}: "expected_state" ${JSON.stringify(expectedState)} is not one of ${TRACKING_STATES.join(", ")}`);
    }
    if (file !== "" && file !== `${trackingNumber}.html`) {
      errors.push(`line ${line}: file "${file}" does not match tracking number "${trackingNumber}"`);
    }
    if (file !== "" && basename(file) !== file) errors.push(`line ${line}: "file" must be a plain file name, got "${file}"`);
    else if (file !== "" && !existsSync(join(trackingDir, file))) {
      errors.push(`line ${line}: tracking page ${join(trackingDir, file)} does not exist`);
    }
    if (seenFiles.has(file)) errors.push(`line ${line}: duplicate label for "${file}"`);
    seenFiles.add(file);

    if (errors.length > 0) result.invalid.push({ index, raw, errors });
    else {
      const record: TrackingLabel = {
        file,
        carrier,
        trackingNumber,
        expectedState: expectedState as TrackingLabel["expectedState"],
        note,
      };
      result.valid.push({ index, record, raw });
    }
  });

  const unlabeled = readdirSync(trackingDir).filter((f) => f.endsWith(".html") && !seenFiles.has(f));
  if (unlabeled.length > 0) result.warnings.push(`tracking pages without a label: ${unlabeled.sort().join(", ")}`);
  return result;
}

/**
 * Optional input. Missing → { status: "missing" } (no fallback is implied here).
 * The assignment does not specify the file's columns, so a present file is exposed as raw rows.
 */
export function loadReporterMatrix(path: string): ReporterMatrix {
  if (!existsSync(path)) return { status: "missing", path };
  const rows = parseCsvFile(path);
  const columns = rows[0];
  if (!columns || columns.length === 0 || columns.some((c) => c.trim() === "")) {
    throw new InputError(path, "reporter matrix has no usable header row");
  }
  const bad = rows.slice(1).findIndex((r) => r.length !== columns.length);
  if (bad !== -1) {
    throw new InputError(path, `line ${bad + 2}: expected ${columns.length} columns, got ${rows[bad + 1]?.length}`);
  }
  return {
    status: "available",
    path,
    columns,
    rows: rows.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""]))),
  };
}

function parseCsvFile(path: string): string[][] {
  const text = readRequiredText(path);
  try {
    return parseCsv(text);
  } catch (e) {
    throw new InputError(path, `invalid CSV: ${(e as Error).message}`);
  }
}

// ---------- all inputs ----------

/**
 * Runtime inputs for the decision engine. Tracking labels (ground truth) are deliberately NOT
 * part of this: they are evaluation data and must never reach a decision.
 * Use loadTrackingLabels() separately for evaluation.
 */
export interface Inputs {
  orders: Collection<Order>;
  complaints: Collection<Complaint>;
  returns: Collection<Return>;
  rules: Rules;
  reporterMatrix: ReporterMatrix;
}

export const inputPaths = (dataDir: string) => ({
  orders: join(dataDir, "orders.json"),
  complaints: join(dataDir, "complaints.json"),
  returns: join(dataDir, "returns.json"),
  rules: join(dataDir, "rules.yaml"),
  reporterMatrix: join(dataDir, "reporters.csv"),
});

export function loadInputs(dataDir: string): Inputs {
  const p = inputPaths(dataDir);
  return {
    orders: loadOrders(p.orders),
    complaints: loadComplaints(p.complaints),
    returns: loadReturns(p.returns),
    rules: loadRules(p.rules),
    reporterMatrix: loadReporterMatrix(p.reporterMatrix),
  };
}
