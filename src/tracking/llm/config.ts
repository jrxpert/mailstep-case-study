// Configuration of the optional LLM tracking classifier (docs/llm-tracking-evaluation.md).
// Off unless TRACKING_LLM_ENABLED=true. The model is always configured (TRACKING_LLM_MODEL); there is
// no built-in default. Any configuration problem turns the integration off (deterministic fallback)
// with a diagnostic that never contains the API key.

import { readFileSync } from "node:fs";

export type LlmMode = "off" | "shadow" | "active";

export interface LlmConfig {
  /** Effective mode: "off" whenever the integration is disabled or misconfigured. */
  mode: LlmMode;
  apiKey: string | null;
  /** Configured model ID; empty when not configured. */
  model: string;
  timeoutMs: number;
  maxCalls: number;
  maxCostUsd: number;
  /** Upper bound on the page text sent to the model. */
  maxInputChars: number;
  maxOutputTokens: number;
  /** Longest Retry-After the run waits for (one retry), in milliseconds. */
  maxRetryWaitMs: number;
  /** USD per 1M tokens; negative when unknown (the integration is then off). */
  price: { input: number; output: number };
  /** Model-specific request parameters (e.g. disabling a reasoning mode). */
  extraBody: Record<string, unknown>;
  /** JSON Lines incident log; null = next to the other outputs (<out>/llm-incidents.jsonl). */
  incidentLog: string | null;
  /** Safe, secret-free notes about the configuration. */
  diagnostics: string[];
}

/**
 * Verified prices (USD per 1M tokens, Together.ai /v1/models, 2026-11-22) and the request parameters a
 * model needs. This is a price list, not a default: the model is chosen with TRACKING_LLM_MODEL, and a
 * model not listed here needs TRACKING_LLM_PRICE_INPUT_PER_M / _OUTPUT_PER_M from the provider.
 * Qwen3.5 "thinks" by default, which costs output tokens and breaks JSON output.
 */
export const VERIFIED_PRICES: Record<string, { input: number; output: number; extraBody: Record<string, unknown> }> = {
  "Qwen/Qwen3.5-9B": { input: 0.17, output: 0.25, extraBody: { chat_template_kwargs: { enable_thinking: false } } },
};

/** Variable names under which a Together.ai key is accepted (values are never logged). */
export const KEY_NAMES = ["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY", "TOGETHERAI_API_KEY"] as const;

type Env = Record<string, string | undefined>;

/** Reads only the known key names from a dotenv-style file. Returns null when none is present. */
export function readKeyFile(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string | null {
  const text = read(path);
  for (const name of KEY_NAMES) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?([^"'\\s#]+)`, "m").exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * The TRACKING_LLM_* and TOGETHER_* entries of a dotenv file (other names are ignored). A missing file
 * gives {}; a file that exists but cannot be read is reported, never its content.
 */
export function readDotEnv(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): { values: Env; problem: string | null } {
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    return { values: {}, problem: (e as NodeJS.ErrnoException).code === "ENOENT" ? null : `${path} could not be read` };
  }
  const values: Env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?((?:TRACKING_LLM|TOGETHER)_[A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1]) values[m[1]] = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2").replace(/\s+#.*$/, "");
  }
  return { values, problem: null };
}

function number(env: Env, name: string, fallback: number, min: number, max: number, diagnostics: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    diagnostics.push(`${name} must be a number in [${min}, ${max}]; using ${fallback}`);
    return fallback;
  }
  return v;
}

export function loadLlmConfig(env: Env, read?: (p: string) => string): LlmConfig {
  const diagnostics: string[] = [];
  const enabled = ["true", "1"].includes((env["TRACKING_LLM_ENABLED"] ?? "").trim().toLowerCase());
  const requested = (env["TRACKING_LLM_MODE"] ?? "shadow").trim().toLowerCase();
  let mode: LlmMode = requested === "off" || requested === "active" ? requested : "shadow";
  if (!["off", "shadow", "active"].includes(requested)) diagnostics.push("unknown TRACKING_LLM_MODE; using shadow");

  const model = (env["TRACKING_LLM_MODEL"] ?? "").trim();
  const verified = VERIFIED_PRICES[model];
  const price = {
    input: number(env, "TRACKING_LLM_PRICE_INPUT_PER_M", verified?.input ?? -1, 0, 100, diagnostics),
    output: number(env, "TRACKING_LLM_PRICE_OUTPUT_PER_M", verified?.output ?? -1, 0, 100, diagnostics),
  };
  const config: LlmConfig = {
    mode,
    apiKey: null,
    model,
    timeoutMs: number(env, "TRACKING_LLM_TIMEOUT_MS", 5000, 100, 60000, diagnostics),
    maxCalls: number(env, "TRACKING_LLM_MAX_CALLS", 20, 0, 1000, diagnostics),
    maxCostUsd: number(env, "TRACKING_LLM_MAX_COST_USD", 0.02, 0, 10, diagnostics),
    maxInputChars: number(env, "TRACKING_LLM_MAX_INPUT_CHARS", 6000, 200, 50000, diagnostics),
    maxOutputTokens: number(env, "TRACKING_LLM_MAX_OUTPUT_TOKENS", 200, 50, 2000, diagnostics),
    maxRetryWaitMs: number(env, "TRACKING_LLM_MAX_RETRY_WAIT_MS", 2000, 0, 30000, diagnostics),
    price,
    extraBody: verified?.extraBody ?? {},
    incidentLog: env["TRACKING_LLM_INCIDENT_LOG"]?.trim() || null,
    diagnostics,
  };
  if (!enabled) return { ...config, mode: "off", diagnostics: [] };
  if (mode === "off") return config;

  let key = KEY_NAMES.map((n) => env[n]?.trim()).find((v) => v) ?? null;
  const keyFile = env["TOGETHER_ENV_FILE"]?.trim();
  if (!key && keyFile) {
    try {
      key = readKeyFile(keyFile, read);
    } catch {
      diagnostics.push("TOGETHER_ENV_FILE could not be read");
    }
  }
  if (model === "") {
    diagnostics.push("TRACKING_LLM_ENABLED=true but TRACKING_LLM_MODEL is empty; deterministic classification only");
    mode = "off";
  } else if (!key) {
    diagnostics.push("TRACKING_LLM_ENABLED=true but no Together.ai API key is configured; deterministic classification only");
    mode = "off";
  } else if (price.input < 0 || price.output < 0) {
    diagnostics.push(`no verified price for model ${model}; set TRACKING_LLM_PRICE_INPUT_PER_M and _OUTPUT_PER_M so the USD budget can be enforced; deterministic classification only`);
    mode = "off";
  }
  return { ...config, mode, apiKey: mode === "off" ? null : key };
}
