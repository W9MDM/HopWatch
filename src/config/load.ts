import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { configSchema, type HopWatchConfig } from "./schema.ts";

/**
 * Load, override, and validate config. Order of precedence (highest last):
 *   1. YAML file (HOPWATCH_CONFIG or ./config/hopwatch.yaml)
 *   2. ${VAR} placeholder resolution from process.env (inside string values)
 *   3. HOPWATCH_<DOTTED_PATH> environment overrides
 *
 * Throws a ConfigError with an actionable, multi-line message on any failure.
 */
export class ConfigError extends Error {}

let cached: HopWatchConfig | null = null;
let envLoaded = false;

// Load .env into process.env once, so standalone processes (ingest, worker, migrate)
// pick up secrets and overrides without a separate dotenv dependency. Next.js also
// loads .env on its own; re-loading the same file here is harmless.
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
  } catch {
    /* no .env present */
  }
}

export function loadConfig(opts: { path?: string; force?: boolean } = {}): HopWatchConfig {
  if (cached && !opts.force) return cached;
  ensureEnvLoaded();

  const path = opts.path ?? process.env.HOPWATCH_CONFIG ?? "./config/hopwatch.yaml";

  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(
      `Could not read config file at "${path}".\n` +
        `  Set HOPWATCH_CONFIG to point at your YAML file, or copy config/hopwatch.example.yaml to config/hopwatch.yaml.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (e) {
    throw new ConfigError(`Config file "${path}" is not valid YAML:\n  ${(e as Error).message}`);
  }

  const resolved = resolveEnvPlaceholders(parsed);
  const overridden = applyEnvOverrides(resolved as Record<string, unknown>);

  const result = configSchema.safeParse(overridden);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error, path));
  }

  validateAlertRules(result.data);

  cached = result.data;
  return cached;
}

/** Replace ${VAR} inside string values with process.env.VAR (empty string if unset). */
function resolveEnvPlaceholders(node: unknown): unknown {
  if (typeof node === "string") {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(node)) return node.map(resolveEnvPlaceholders);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveEnvPlaceholders(v);
    return out;
  }
  return node;
}

/**
 * Apply HOPWATCH_A_B_C=value overrides. The dotted path is derived by lowercasing
 * and splitting on "_", walking into the object. Arrays are addressed by index
 * (HOPWATCH_INGEST_BROKERS_0_HOST). Values are coerced to JSON when possible.
 */
function applyEnvOverrides(base: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (!envKey.startsWith("HOPWATCH_") || envVal === undefined) continue;
    if (["HOPWATCH_CONFIG", "HOPWATCH_GIT_COMMIT"].includes(envKey)) continue;
    const segments = envKey.slice("HOPWATCH_".length).toLowerCase().split("_");
    setDeep(out, segments, coerce(envVal));
  }
  return out;
}

function setDeep(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]!] = value;
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function formatZodError(err: z.ZodError, path: string): string {
  const lines = err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `Config validation failed for "${path}":\n${lines.join("\n")}`;
}

/** Rule-type-specific required fields. Keeps alert rules fully config-driven but validated. */
function validateAlertRules(cfg: HopWatchConfig): void {
  const required: Record<string, string[]> = {
    node_offline: ["threshold_minutes"],
    battery_threshold: ["threshold_volts"],
    gateway_silent: ["threshold_minutes"],
    channel_util: ["threshold_pct"],
    battery_forecast: ["days_ahead"],
    spoof_flag: [],
    new_node: [],
  };
  const errs: string[] = [];
  for (const rule of cfg.alerts.rules) {
    const need = required[rule.type] ?? [];
    for (const field of need) {
      if ((rule as Record<string, unknown>)[field] === undefined) {
        errs.push(`  - alerts.rules[${rule.id}] of type "${rule.type}" requires "${field}"`);
      }
    }
    for (const ch of rule.channels) {
      if (ch === "smtp" && !cfg.alerts.delivery.smtp.host) {
        errs.push(`  - alerts.rules[${rule.id}] uses smtp but alerts.delivery.smtp.host is empty`);
      }
    }
  }
  if (errs.length) throw new ConfigError(`Alert rule validation failed:\n${errs.join("\n")}`);
}
