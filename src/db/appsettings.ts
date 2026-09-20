import { query } from "./client.ts";
import { toMysqlUtc } from "../lib/time.ts";
import { loadConfig } from "../config/load.ts";
import { encryptSecret, decryptSecret, isEncrypted, canDecryptSecret } from "../lib/secrets.ts";
import { bumpRev } from "./settings.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// UI-editable config overrides, deep-merged over the file config at runtime. Secret
// fields (dotted paths below) are AES-encrypted at rest; the master key stays in env.
const OVERRIDES_KEY = "config_overrides";
// Dotted paths whose value is a secret and is AES-encrypted at rest. A path may hold a string or an
// ARRAY of strings: alert webhook and ntfy targets embed bearer tokens in the URL itself
// (`https://discord.com/api/webhooks/<id>/<token>`), exactly like the forwarding targets this
// project already encrypts and redacts. They were stored verbatim, so any DB dump, backup, or
// read-only credential yielded live webhook tokens.
const SECRET_PATHS = [
  "alerts.delivery.smtp.password",
  "alerts.delivery.webhook",
  "alerts.delivery.ntfy",
  "alerts.delivery.discord.webhooks",
  "server.auth.discord.client_secret",
  "server.ui.analytics.api_secret",
  "discord_bot.bot_token",
];

type Doc = Record<string, unknown>;

export async function getOverridesRaw(): Promise<Doc> {
  const rows = await query<{ sval: string | null }>(`SELECT sval FROM app_setting WHERE skey=?`, [OVERRIDES_KEY]);
  if (!rows[0]?.sval) return {};
  try {
    return JSON.parse(rows[0].sval) as Doc;
  } catch {
    return {};
  }
}

/** File config deep-merged with (decrypted) DB overrides. Used wherever settings are consumed. */
export async function effectiveConfig(): Promise<HopWatchConfig> {
  const base = loadConfig() as unknown as Doc;
  const overrides = decryptDoc(await getOverridesRaw());
  return deepMerge(structuredClone(base), overrides) as unknown as HopWatchConfig;
}

/** Merge a partial patch into the stored overrides, encrypting any secret fields. */
export async function saveOverrides(patch: Doc): Promise<void> {
  const merged = deepMerge(await getOverridesRaw(), patch);
  for (const p of SECRET_PATHS) {
    const v = getPath(merged, p);
    if (typeof v === "string" && v !== "" && !isEncrypted(v)) setPath(merged, p, encryptSecret(v));
    else if (Array.isArray(v)) {
      setPath(merged, p, v.map((x) => (typeof x === "string" && x !== "" && !isEncrypted(x) ? encryptSecret(x) : x)));
    }
  }
  await query(
    `INSERT INTO app_setting (skey, sval, updated_at) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE sval=VALUES(sval), updated_at=VALUES(updated_at)`,
    [OVERRIDES_KEY, JSON.stringify(merged), toMysqlUtc(new Date())],
  );
  await bumpRev();
}

/** Whether a secret path currently has a value set (without revealing it). */
export async function secretIsSet(path: string): Promise<boolean> {
  const raw = await getOverridesRaw();
  const v = getPath(raw, path);
  if (typeof v === "string" && v !== "") return true;
  // Fall back to the file config value.
  const base = getPath(loadConfig() as unknown as Doc, path);
  return typeof base === "string" && base !== "";
}

/**
 * Every stored secret that the current master key cannot decrypt, named (never valued).
 *
 * A master-key change (adding HOPWATCH_MASTER_KEY over an install that ran on the
 * HOPWATCH_SESSION_SECRET fallback, rotating either value, or restoring a dump onto a host whose
 * installer generated its own key) invalidates ALL of them at once. decryptSecret degrades each to
 * "unset" rather than throwing, so the install keeps running: this probe is what makes the silent
 * degradation visible, by reporting exactly which values need re-entering in /admin.
 */
export async function undecryptableSecrets(): Promise<string[]> {
  const bad: string[] = [];
  const raw = await getOverridesRaw();
  for (const p of SECRET_PATHS) {
    const v = getPath(raw, p);
    if (typeof v === "string" && v !== "" && !canDecryptSecret(v)) bad.push(`setting ${p}`);
    else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (typeof x === "string" && x !== "" && !canDecryptSecret(x)) bad.push(`setting ${p}[${i}]`);
      });
    }
  }
  for (const r of await query<{ name: string; key_b64: string | null }>(`SELECT name, key_b64 FROM channel_key`)) {
    if (!canDecryptSecret(r.key_b64)) bad.push(`channel key "${r.name}"`);
  }
  for (const r of await query<{ id: string; password: string | null }>(`SELECT id, password FROM mqtt_broker`)) {
    if (!canDecryptSecret(r.password)) bad.push(`broker "${r.id}" password`);
  }
  for (const r of await query<{ id: string; targets: string | null }>(`SELECT id, targets FROM forward_rule`)) {
    let targets: unknown[] = [];
    try { targets = JSON.parse(r.targets ?? "[]") as unknown[]; } catch { targets = []; }
    targets.forEach((t, i) => {
      if (typeof t === "string" && !canDecryptSecret(t)) bad.push(`forward rule "${r.id}" target ${i + 1}`);
    });
  }
  return bad;
}

function decryptDoc(doc: Doc): Doc {
  const d = structuredClone(doc);
  for (const p of SECRET_PATHS) {
    const v = getPath(d, p);
    if (typeof v === "string" && v !== "") setPath(d, p, decryptSecret(v, `setting ${p}`));
    else if (Array.isArray(v)) {
      // An entry that fails to decrypt reads as "" and is dropped, so a delivery channel silently
      // pointing at an empty URL is not left in the list for the dispatcher to try.
      setPath(d, p, v
        .map((x, i) => (typeof x === "string" && x !== "" ? decryptSecret(x, `setting ${p}[${i}]`) : x))
        .filter((x) => x !== ""));
    }
  }
  return d;
}

// Deep-merge: plain objects merge recursively; arrays and scalars from `over` replace.
function deepMerge(base: Doc, over: Doc): Doc {
  const out: Doc = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as Doc, v as Doc);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Doc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getPath(obj: Doc, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = (cur as Doc)[key];
  }
  return cur;
}

function setPath(obj: Doc, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: Doc = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Doc;
  }
  cur[keys[keys.length - 1]!] = value;
}
