// Structured, de-duplicated log of LLM provider incidents (JSON Lines). One line per distinct
// incident and flush, carrying its occurrence count in the run. Records hold only categories, codes
// and counts: never keys, headers, request/response bodies, page content or order data.
// No notification is sent: notification_status "PENDING" only marks a candidate for a future alert.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { FATAL_ERRORS, type ProviderError } from "./client.ts";

export type Severity = "critical" | "warning";
export type FallbackAction = "deterministic_parser_llm_disabled_for_run" | "deterministic_parser_for_page";

export interface Incident {
  timestamp: string;
  last_seen: string;
  component: "tracking-llm";
  provider: "together.ai";
  model: string;
  severity: Severity;
  category: ProviderError;
  http_status: number | null;
  provider_error_code: string | null;
  fallback_action: FallbackAction;
  occurrences: number;
  /** PENDING = candidate for a future operator notification; NOT_REQUIRED otherwise. Nothing is sent. */
  notification_status: "PENDING" | "NOT_REQUIRED";
}

export interface IncidentInput {
  category: ProviderError;
  httpStatus: number | null;
  providerCode: string | null;
  fallback: FallbackAction;
}

export class IncidentLog {
  private readonly incidents = new Map<string, Incident>();
  private readonly flushed = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  readonly path: string;
  private readonly model: string;
  private readonly now: () => Date;
  private readonly append: (path: string, data: string) => Promise<void>;
  private readonly warn: (message: string) => void;

  constructor(
    path: string,
    model: string,
    now: () => Date = () => new Date(),
    append: (path: string, data: string) => Promise<void> = async (p, d) => {
      await mkdir(dirname(p), { recursive: true });
      await appendFile(p, d, "utf8");
    },
    warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
  ) {
    this.path = path;
    this.model = model;
    this.now = now;
    this.append = append;
    this.warn = warn;
  }

  /** Records one occurrence (synchronous, so concurrent callers cannot interleave). */
  record(i: IncidentInput): Incident {
    const key = [i.category, i.httpStatus ?? "", i.providerCode ?? "", i.fallback].join("|");
    const at = this.now().toISOString();
    const existing = this.incidents.get(key);
    if (existing) {
      existing.occurrences++;
      existing.last_seen = at;
      return existing;
    }
    const critical = FATAL_ERRORS.includes(i.category);
    const incident: Incident = {
      timestamp: at, last_seen: at, component: "tracking-llm", provider: "together.ai", model: this.model,
      severity: critical ? "critical" : "warning", category: i.category, http_status: i.httpStatus,
      provider_error_code: i.providerCode, fallback_action: i.fallback, occurrences: 1,
      notification_status: critical || i.category === "RATE_LIMITED" ? "PENDING" : "NOT_REQUIRED",
    };
    this.incidents.set(key, incident);
    return incident;
  }

  all(): Incident[] {
    return [...this.incidents.values()];
  }

  /**
   * Appends every incident that is new or has new occurrences since the last flush. Flushes are
   * serialised, so concurrent calls never interleave lines. A write failure is reported on stderr
   * (error code only) and does not stop the run; returns false in that case.
   */
  flush(): Promise<boolean> {
    const run = this.queue.then(async () => {
      const lines = [...this.incidents.entries()].filter(([k, v]) => this.flushed.get(k) !== v.occurrences);
      if (lines.length === 0) return true;
      try {
        await this.append(this.path, lines.map(([, v]) => `${JSON.stringify(v)}\n`).join(""));
        for (const [k, v] of lines) this.flushed.set(k, v.occurrences);
        return true;
      } catch (e) {
        this.warn(`LLM incident log could not be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
        return false;
      }
    });
    this.queue = run.then(() => undefined);
    return run;
  }
}
