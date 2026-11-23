// Minimal Together.ai chat-completions client: one attempt, a hard timeout, typed error categories.
// Errors are reduced to a category, the HTTP status and a sanitised provider error code; request
// headers and bodies, and response bodies, are never logged or returned.

export const TOGETHER_URL = "https://api.together.xyz/v1/chat/completions";

export interface ChatRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** JSON Schema the response must follow (provider-side structured output; re-checked locally). */
  schema: Record<string, unknown>;
  /** Model-specific request parameters. */
  extraBody?: Record<string, unknown>;
}

export const PROVIDER_ERRORS = [
  "INSUFFICIENT_CREDIT", "MODEL_UNAVAILABLE", "AUTHENTICATION_FAILED", "PERMISSION_DENIED", "INVALID_REQUEST",
  "RATE_LIMITED", "PROVIDER_UNAVAILABLE", "TIMEOUT", "INVALID_RESPONSE", "UNKNOWN_PROVIDER_ERROR",
] as const;
export type ProviderError = (typeof PROVIDER_ERRORS)[number];

/** Errors after which no further call in the same run can succeed. */
export const FATAL_ERRORS: readonly ProviderError[] = ["INSUFFICIENT_CREDIT", "MODEL_UNAVAILABLE", "AUTHENTICATION_FAILED", "PERMISSION_DENIED"];

export type ChatResult =
  | { ok: true; content: string; usage: { inputTokens: number; outputTokens: number } | null; latencyMs: number }
  | { ok: false; error: ProviderError; httpStatus: number | null; providerCode: string | null; retryAfterMs: number | null; latencyMs: number };

/** The subset of `fetch` the client uses; injectable so tests never touch the network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json: () => Promise<unknown> }>;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** A provider error code only if it is a short identifier (never free text, which may echo input). */
export function providerCode(body: unknown): string | null {
  const e = (body as { error?: unknown } | null)?.error;
  const candidates = typeof e === "object" && e !== null ? [(e as Record<string, unknown>)["code"], (e as Record<string, unknown>)["type"]] : [];
  const code = candidates.find((c) => typeof c === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(c));
  return typeof code === "string" ? code.toLowerCase() : null;
}

/**
 * HTTP status first; the provider code refines only the ambiguous 400. Together.ai answers a
 * serverless request for a dedicated-only model with HTTP 400 and code "model_not_available"
 * (observed 2026-11-22); other codes are matched by meaning, not by an assumed exact list.
 */
export function classifyHttpError(status: number, code: string | null): ProviderError {
  if (status === 402) return "INSUFFICIENT_CREDIT";
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500 && status <= 599) return "PROVIDER_UNAVAILABLE";
  if (status === 400 || status === 422) {
    if (code && /model.*(not.?(available|found|supported)|unavailable)|unsupported.?model|no.?such.?model/.test(code)) return "MODEL_UNAVAILABLE";
    if (code && /insufficient|credit|quota|billing|balance|payment/.test(code)) return "INSUFFICIENT_CREDIT";
    return "INVALID_REQUEST";
  }
  return "UNKNOWN_PROVIDER_ERROR";
}

/** Retry-After in milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export async function chat(req: ChatRequest, fetchImpl: FetchLike, clock: () => number = () => performance.now()): Promise<ChatResult> {
  const started = clock();
  const elapsed = () => Math.round(clock() - started);
  const fail = (error: ProviderError, httpStatus: number | null = null, code: string | null = null, retry: number | null = null): ChatResult =>
    ({ ok: false, error, httpStatus, providerCode: code, retryAfterMs: retry, latencyMs: elapsed() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetchImpl(TOGETHER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify({
        model: req.model,
        temperature: 0,
        max_tokens: req.maxOutputTokens,
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        response_format: { type: "json_schema", json_schema: { name: "tracking_status", schema: req.schema } },
        ...req.extraBody,
      }),
      signal: controller.signal,
    });
    let body: unknown = null;
    let parsed = true;
    try {
      body = await res.json();
    } catch {
      parsed = false;
    }
    if (!res.ok) {
      const code = parsed ? providerCode(body) : null;
      return fail(classifyHttpError(res.status, code), res.status, code, retryAfterMs(res.headers?.get("retry-after")));
    }
    if (!parsed) return fail("INVALID_RESPONSE", res.status);
    const b = (body ?? {}) as { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> };
    const content = b.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") return fail("INVALID_RESPONSE", res.status);
    const inputTokens = count(b.usage?.["prompt_tokens"]);
    const outputTokens = count(b.usage?.["completion_tokens"]);
    const usage = inputTokens !== null && outputTokens !== null ? { inputTokens, outputTokens } : null;
    return { ok: true, content, usage, latencyMs: elapsed() };
  } catch {
    return fail(controller.signal.aborted ? "TIMEOUT" : "UNKNOWN_PROVIDER_ERROR");
  } finally {
    clearTimeout(timer);
  }
}
