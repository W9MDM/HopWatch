// Discord webhook posting. A Discord channel webhook honors a per-message `username` and `avatar_url`
// override, which is how a post can appear as a branded identity (e.g. "HopWatch" with a logo) rather
// than a personal account or a generic bot name. Outbound only: this posts to Discord, it never
// receives (the bot's inbound slash commands are served separately over HTTP interactions).

// Discord's documented field caps: embed title 256, description 4096, webhook username 80.
const TITLE_MAX = 256;
const DESC_MAX = 4096;
const NAME_MAX = 80;
const HTTP_TIMEOUT_MS = 8_000;
const DEFAULT_COLOR = 0x11b3a6; // teal, close to the TARA accent

export interface DiscordIdentity { username: string; avatar_url: string }
export interface DiscordMessage { title: string; body: string; username?: string; color?: number; url?: string }

/** Build the JSON body Discord expects. `msg.username` (a per-message persona) wins over the
 * configured default identity, so one webhook can post as "HopWatch Weather", "HopWatch Alerts", etc. */
export function buildDiscordPayload(msg: DiscordMessage, id: DiscordIdentity): Record<string, unknown> {
  const embed: Record<string, unknown> = {
    title: (msg.title || "").slice(0, TITLE_MAX),
    description: (msg.body || "").slice(0, DESC_MAX),
    color: msg.color ?? DEFAULT_COLOR,
    timestamp: new Date().toISOString(),
  };
  if (msg.url) embed.url = msg.url;
  const username = (msg.username || id.username || "HopWatch").slice(0, NAME_MAX);
  const payload: Record<string, unknown> = { username, embeds: [embed] };
  if (id.avatar_url) payload.avatar_url = id.avatar_url;
  return payload;
}

/** Host only, so a failure message never echoes the secret token embedded in the webhook URL. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "discord"; }
}

/** Post one message to every configured Discord webhook. Every target is attempted; failures are
 * collected and thrown together so one bad webhook never hides the rest. */
export async function sendDiscordWebhooks(webhooks: string[], msg: DiscordMessage, id: DiscordIdentity): Promise<void> {
  const urls = (webhooks ?? []).filter((u) => typeof u === "string" && u);
  if (urls.length === 0) return;
  const body = JSON.stringify(buildDiscordPayload(msg, id));
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`discord ${hostOf(url)} returned HTTP ${res.status} ${res.statusText}`);
    }),
  );
  const errs = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (errs.length > 0) {
    throw new Error(`${errs.length}/${results.length} discord webhook(s) failed: ${errs.map((e) => (e.reason as Error).message).join("; ")}`);
  }
}
