import nodemailer from "nodemailer";
import type { HopWatchConfig } from "../config/schema.ts";
import { sendDiscordWebhooks } from "../lib/discord.ts";

export type Channel = "webhook" | "ntfy" | "discord" | "smtp";

export interface Message {
  title: string;
  body: string;
  html?: string;
  attachments?: { filename: string; content: string; contentType: string }[];
  username?: string; // Discord persona override ("send as"); ignored by other channels
  color?: number; // Discord embed color
  url?: string; // Discord embed link
}

// Fan a message out to the requested delivery channels. Outbound only; failures on
// one channel never block the others (each is logged and swallowed).
export async function dispatch(
  channels: Channel[],
  msg: Message,
  delivery: HopWatchConfig["alerts"]["delivery"],
): Promise<Record<string, string>> {
  const status: Record<string, string> = {};
  await Promise.all(
    channels.map(async (ch) => {
      try {
        if (ch === "webhook") await sendWebhooks(delivery.webhook, msg);
        else if (ch === "ntfy") await sendNtfy(delivery.ntfy, msg);
        else if (ch === "discord") await sendDiscord(delivery.discord, msg);
        else if (ch === "smtp") await sendSmtp(delivery.smtp, msg);
        status[ch] = "ok";
      } catch (e) {
        status[ch] = `error: ${(e as Error).message}`;
        console.error(`[worker] delivery ${ch} failed: ${(e as Error).message}`);
      }
    }),
  );
  return status;
}

// Delivery is awaited from the alerts job inside the worker's 60s FAST loop, which also owns the
// hourly rollups, the direct roster and forwarding. With no timeout, a black-holed webhook host
// stalled the tick for undici's 300s default and a black-holed SMTP host for nodemailer's 10-minute
// socket default, and the loop's overlap guard suppressed every tick in between: rollups, roster and
// forwarding simply stopped for that whole period. Every outbound call is now bounded.
const HTTP_TIMEOUT_MS = 8_000;
const SMTP_TIMEOUT_MS = 10_000;

/** Fail on a non-2xx response. Only a thrown network error used to be caught, so a webhook
 * answering 404 or 500 was recorded as status 'ok' and the operator had no idea alerts were being
 * discarded by the far end. */
async function postOrThrow(url: string, init: RequestInit, label: string): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status} ${res.statusText}`);
}

/** Host only, so a failure message never echoes the bearer token embedded in a webhook URL. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "target"; }
}

async function sendWebhooks(urls: string[], msg: Message): Promise<void> {
  const results = await Promise.allSettled(
    urls.map((url) =>
      postOrThrow(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: msg.title, body: msg.body }),
      }, `webhook ${hostOf(url)}`),
    ),
  );
  throwIfAnyRejected(results, "webhook");
}

async function sendDiscord(d: HopWatchConfig["alerts"]["delivery"]["discord"], msg: Message): Promise<void> {
  await sendDiscordWebhooks(
    d.webhooks,
    { title: msg.title, body: msg.body, username: msg.username, color: msg.color, url: msg.url },
    { username: d.username, avatar_url: d.avatar_url },
  );
}

async function sendNtfy(topics: string[], msg: Message): Promise<void> {
  // Each entry may be a full URL or a topic on ntfy.sh.
  const results = await Promise.allSettled(
    topics.map((t) => {
      const url = t.startsWith("http") ? t : `https://ntfy.sh/${t}`;
      return postOrThrow(url, { method: "POST", headers: { Title: msg.title }, body: msg.body }, `ntfy ${hostOf(url)}`);
    }),
  );
  throwIfAnyRejected(results, "ntfy");
}

/** One bad target must not hide the others: every target is attempted, then the failures are
 * reported together. Promise.all would have abandoned the rest on the first rejection. */
function throwIfAnyRejected(results: PromiseSettledResult<unknown>[], channel: string): void {
  const errs = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (errs.length === 0) return;
  throw new Error(`${errs.length}/${results.length} ${channel} target(s) failed: ${errs.map((e) => (e.reason as Error).message).join("; ")}`);
}

async function sendSmtp(smtp: HopWatchConfig["alerts"]["delivery"]["smtp"], msg: Message): Promise<void> {
  if (!smtp.host) return;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.starttls,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    // Bounded: nodemailer's defaults let a black-holed host hold the fast loop for ~10 minutes.
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  await transport.sendMail({
    from: smtp.from || smtp.user,
    to: smtp.from || smtp.user,
    subject: msg.title,
    text: msg.body,
    html: msg.html,
    attachments: msg.attachments,
  });
}
