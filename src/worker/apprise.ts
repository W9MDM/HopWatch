import { spawnSync } from "node:child_process";

// Apprise-style notification dispatch. If the `apprise` CLI is installed it is used
// (full service coverage). Otherwise a native fallback handles the common schemes:
// Discord, ntfy, and generic webhooks. Outbound only.
export interface Msg { title: string; body: string }

let cliChecked = false;
let cliAvailable = false;

function hasCli(): boolean {
  if (cliChecked) return cliAvailable;
  cliChecked = true;
  try {
    const r = spawnSync("apprise", ["--version"], { encoding: "utf8" });
    cliAvailable = r.status === 0;
  } catch {
    cliAvailable = false;
  }
  return cliAvailable;
}

export async function notify(urls: string[], msg: Msg): Promise<void> {
  if (urls.length === 0) return;
  if (hasCli()) {
    const r = spawnSync("apprise", ["-t", msg.title, "-b", msg.body, ...urls], { encoding: "utf8" });
    if (r.status === 0) return;
    console.error(`[forward] apprise CLI failed (${r.status}); trying native senders`);
  }
  await Promise.all(
    urls.map((u) =>
      sendNative(u, msg).catch((e) => console.error(`[forward] ${scheme(u)} target failed: ${(e as Error).message}`)),
    ),
  );
}

function scheme(u: string): string {
  return u.split("://")[0] ?? "?";
}

async function sendNative(url: string, msg: Msg): Promise<void> {
  const content = `**${msg.title}**\n${msg.body}`.slice(0, 1900);

  if (url.startsWith("discord://")) {
    // discord://webhook_id/webhook_token
    const parts = url.slice("discord://".length).split("/").filter(Boolean);
    const [id, token] = parts;
    if (id && token) {
      await post(`https://discord.com/api/webhooks/${id}/${token}`, { content });
    }
    return;
  }
  if (/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url)) {
    await post(url, { content });
    return;
  }
  if (url.startsWith("ntfy://") || url.startsWith("ntfys://")) {
    const rest = url.replace(/^ntfys?:\/\//, "");
    const target = rest.includes("/") ? `https://${rest}` : `https://ntfy.sh/${rest}`;
    await fetch(target, { method: "POST", headers: { Title: msg.title }, body: msg.body });
    return;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // Generic webhook: send a Discord-compatible "content" plus title/body.
    await post(url, { content, title: msg.title, body: msg.body });
    return;
  }
  console.error(`[forward] unsupported scheme "${scheme(url)}"; install the apprise CLI for full support`);
}

async function post(url: string, payload: unknown): Promise<void> {
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}
