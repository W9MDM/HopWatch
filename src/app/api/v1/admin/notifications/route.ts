import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "../../../../../auth/guard.ts";
import { effectiveConfig, saveOverrides } from "../../../../../db/appsettings.ts";
import { sendDiscordWebhooks } from "../../../../../lib/discord.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Notification settings: SMTP (password AES-encrypted at rest), delivery targets,
// alert rules, and the daily digest. The SMTP password is never returned.
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const cfg = await effectiveConfig();
  const smtp = cfg.alerts.delivery.smtp;
  return NextResponse.json({
    smtp: { host: smtp.host, port: smtp.port, user: smtp.user, from: smtp.from, starttls: smtp.starttls, has_password: !!smtp.password },
    // Counts only. A webhook/ntfy URL embeds its own bearer token, so returning the list handed a
    // live credential back to the browser (and into any page cache or shared screen), which is the
    // reason the forwarding targets next door are already reported as a count. Rule 6.
    webhook_count: cfg.alerts.delivery.webhook.length,
    ntfy_count: cfg.alerts.delivery.ntfy.length,
    // username + avatar are branding, not secret, so they round-trip; the webhook URLs embed a token
    // and are reported as a count only (Rule 6), same as the plain webhook list above.
    discord: {
      username: cfg.alerts.delivery.discord.username,
      avatar_url: cfg.alerts.delivery.discord.avatar_url,
      webhook_count: cfg.alerts.delivery.discord.webhooks.length,
    },
    rules: cfg.alerts.rules,
    digest: cfg.digest,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard instanceof NextResponse) return guard;
  const b = (await req.json().catch(() => null)) as any;
  if (!b || typeof b !== "object") return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const smtp: Record<string, unknown> = {
    host: String(b.smtp?.host ?? ""),
    port: Number(b.smtp?.port ?? 587),
    user: String(b.smtp?.user ?? ""),
    from: String(b.smtp?.from ?? ""),
    starttls: !!b.smtp?.starttls,
  };
  // Only set the password when a new one is provided; blank keeps the stored (encrypted) one.
  if (typeof b.smtp?.password === "string" && b.smtp.password !== "") smtp.password = b.smtp.password;

  // Targets follow the same rule as the SMTP password: a blank box keeps what is stored (the client
  // never had the values to send back), a non-empty one replaces the list, and an explicit
  // clear_<channel> flag empties it. Without this, saving any unrelated notification setting would
  // have wiped every target, since the form could no longer echo them.
  const targets = (key: "webhook" | "ntfy" | "discord_webhooks", clearKey: string): string[] | undefined => {
    if (b[clearKey]) return [];
    const list = Array.isArray(b[key]) ? b[key].filter((x: unknown) => typeof x === "string" && x) : [];
    return list.length > 0 ? list : undefined;
  };
  const delivery: Record<string, unknown> = { smtp };
  const webhook = targets("webhook", "clear_webhook");
  const ntfy = targets("ntfy", "clear_ntfy");
  if (webhook !== undefined) delivery.webhook = webhook;
  if (ntfy !== undefined) delivery.ntfy = ntfy;

  // Discord: username + avatar (branding) are always written; the webhook list keeps/replaces/clears
  // like the others (a blank box keeps what is stored, since the client never had the URLs to echo).
  const discord: Record<string, unknown> = {
    username: (String(b.discord?.username ?? "").trim()) || "HopWatch",
    avatar_url: String(b.discord?.avatar_url ?? "").trim(),
  };
  const discordHooks = targets("discord_webhooks", "clear_discord");
  if (discordHooks !== undefined) discord.webhooks = discordHooks;
  delivery.discord = discord;

  const patch = {
    alerts: {
      delivery,
      rules: Array.isArray(b.rules) ? b.rules : [],
    },
    digest: b.digest && typeof b.digest === "object" ? b.digest : {},
  };

  try {
    await saveOverrides(patch);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Optional test post so the admin can confirm "send as" works before wiring it to any rule. Uses the
  // freshly-saved (decrypted) config, so it also validates that the stored webhook is still good.
  let test: string | undefined;
  if (b.test_discord) {
    const fresh = await effectiveConfig();
    const d = fresh.alerts.delivery.discord;
    if (d.webhooks.length === 0) test = "no discord webhooks configured";
    else {
      try {
        await sendDiscordWebhooks(
          d.webhooks,
          { title: "HopWatch test", body: `This is a test post from HopWatch, sent as **${d.username || "HopWatch"}**. If you can read this, alerts and the daily digest can post here.` },
          { username: d.username, avatar_url: d.avatar_url },
        );
        test = "sent";
      } catch (e) {
        test = `error: ${(e as Error).message}`;
      }
    }
  }
  return NextResponse.json({ ok: true, ...(test ? { test } : {}) });
}
