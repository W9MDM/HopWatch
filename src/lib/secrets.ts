import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

// AES-256-GCM encryption for secrets stored in the DB (SMTP passwords, etc.), so
// operational secrets can be entered in the admin UI. The MASTER KEY stays in env
// (a true secret): HOPWATCH_MASTER_KEY, falling back to HOPWATCH_SESSION_SECRET.
// Encrypted values are self-describing: "enc:v1:<iv>:<tag>:<ciphertext>" (base64).

const PREFIX = "enc:v1:";

function masterKey(): Buffer {
  const s = process.env.HOPWATCH_MASTER_KEY || process.env.HOPWATCH_SESSION_SECRET || "";
  if (!s) {
    throw new Error(
      "No encryption master key set. Set HOPWATCH_MASTER_KEY (or HOPWATCH_SESSION_SECRET) in the environment to store secrets in the UI.",
    );
  }
  return createHash("sha256").update(s).digest(); // 32 bytes
}

export function isEncrypted(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  if (plain === "") return "";
  if (isEncrypted(plain)) return plain; // already encrypted
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

// Undecryptable stored secrets, by the caller-supplied label. Every stored ciphertext fails GCM
// authentication at once when the master key changes: adding HOPWATCH_MASTER_KEY to an install
// that had been running on the HOPWATCH_SESSION_SECRET fallback, rotating either value, or
// restoring a database dump onto a host whose installer generated its own random key.
const failedLabels = new Set<string>();

/** Labels of stored secrets that failed to decrypt in this process. Surfaced by the admin
 * diagnostics bundle so a master-key mismatch is diagnosable instead of merely fatal. */
export function secretDecryptFailures(): string[] {
  return [...failedLabels].sort();
}

/**
 * Decrypt one stored secret. Plaintext (legacy, unencrypted) values pass through unchanged.
 *
 * A secret that cannot be decrypted reads as UNSET ("") rather than throwing. Throwing took the
 * whole process down: getChannelKeys / getRuntimeBrokers / listForwardRules and effectiveConfig's
 * decryptDoc all map this over every row with no try, ingest awaits them bare inside reload(), and
 * `main().catch(process.exit(1))` plus systemd `Restart=always` turned one stale ciphertext into a
 * permanent restart loop that ingested nothing and logged only the raw OpenSSL message. Degrading
 * instead leaves the rest of the config working (a broker with no password, a channel with no PSK),
 * which is visible and repairable in /admin.
 *
 * `label` names WHICH secret failed (never its value) so the cause is identifiable in the log and
 * in the diagnostics bundle.
 */
export function decryptSecret(stored: string | null | undefined, label = "secret"): string {
  if (!stored) return "";
  if (!isEncrypted(stored)) return stored; // plaintext / legacy value
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) return recordFailure(label, "malformed envelope");
  const [ivB, tagB, ctB] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB!, "base64"));
    decipher.setAuthTag(Buffer.from(tagB!, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB!, "base64")), decipher.final()]).toString("utf8");
  } catch (e) {
    return recordFailure(label, (e as Error).message);
  }
}

function recordFailure(label: string, reason: string): string {
  if (!failedLabels.has(label)) {
    failedLabels.add(label);
    console.error(
      `[secrets] cannot decrypt ${label}: ${reason}. The master key (HOPWATCH_MASTER_KEY, or HOPWATCH_SESSION_SECRET) does not match the one that encrypted it; re-enter this value in /admin/settings. Treating it as unset.`,
    );
  }
  return "";
}

/**
 * Whether a stored value can be decrypted with the CURRENT master key, without producing its
 * plaintext or recording a failure. Lets the admin diagnostics probe name mismatched secrets on
 * every request (the failure set above is once-per-process, so it would keep reporting a secret an
 * operator has since re-entered).
 */
export function canDecryptSecret(stored: string | null | undefined): boolean {
  if (!stored || !isEncrypted(stored)) return true; // unset or legacy plaintext: nothing to decrypt
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) return false;
  const [ivB, tagB, ctB] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB!, "base64"));
    decipher.setAuthTag(Buffer.from(tagB!, "base64"));
    Buffer.concat([decipher.update(Buffer.from(ctB!, "base64")), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}
