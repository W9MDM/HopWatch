// Pure auto-responder logic: pattern matching and reply formatting. DB-free and testable.
// The worker (src/worker/autoresponder.ts) supplies incoming DMs and persists replies.

/** Safe pattern test: compile the admin-supplied regex defensively, matching the trimmed
 *  body case-insensitively. A malformed pattern never matches (and never throws). */
export function matchesPattern(body: string, pattern: string): boolean {
  if (!pattern) return false;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return false;
  }
  return re.test(body.trim());
}

/** Whether a trigger is allowed to fire on the channel a message arrived on. An empty `channels`
 *  list means "any channel" (the historical behaviour); otherwise the incoming channel must be in
 *  the list (case-insensitive). Lets a trigger be scoped to e.g. the Testing channel so it can reply
 *  on-channel there without firing on the main channel. */
export function triggerAllowedOnChannel(channels: string[] | undefined, incoming: string | null | undefined): boolean {
  if (!channels || channels.length === 0) return true;
  if (!incoming) return false;
  const want = incoming.trim().toLowerCase();
  return channels.some((c) => c.trim().toLowerCase() === want);
}

/**
 * Choose which reply template to fill. rssi/snr are properties of the reception, so an MQTT-heard
 * packet has none and its RF template would render {rssi}/{snr} as "?". When a trigger sets a
 * non-empty reply_mqtt, it replaces reply for MQTT-heard messages; otherwise reply is used. RF-heard
 * messages always use reply (they have real link quality to report).
 */
export function pickReplyTemplate(trigger: { reply: string; reply_mqtt?: string }, heardOverRf: boolean): string {
  return !heardOverRf && trigger.reply_mqtt ? trigger.reply_mqtt : trigger.reply;
}

/** Templated reply echoing the observed link quality, the way meshmonitor's auto-ack does. */
export function formatAutoReply(rssi: number | null, snr: number | null, hops: number | null): string {
  const parts: string[] = [];
  if (rssi != null) parts.push(`rssi ${Math.round(rssi)}dBm`);
  if (snr != null) parts.push(`snr ${snr.toFixed(1)}`);
  if (hops != null && hops >= 0) parts.push(`${hops} hop${hops === 1 ? "" : "s"}`);
  return parts.length ? `pong (${parts.join(", ")})` : "pong";
}

export interface ReplyContext {
  name: string | null; short: string | null; id: string;
  rssi: number | null; snr: number | null; hops: number | null;
  via: string; msg: string; count: number; time: string;
}

/** Fill an auto-responder reply template. Unknown values render as "?"; unknown tokens are left
 * as-is. Supported: {name} {short} {id} {rssi} {snr} {hops} {via} {msg} {count} {time}. */
export function fillTemplate(tpl: string, c: ReplyContext): string {
  const map: Record<string, string> = {
    name: c.name ?? c.short ?? c.id,
    short: c.short ?? c.name ?? c.id,
    id: c.id,
    rssi: c.rssi != null ? String(Math.round(c.rssi)) : "?",
    snr: c.snr != null ? c.snr.toFixed(1) : "?",
    hops: c.hops != null && c.hops >= 0 ? String(c.hops) : "?",
    via: c.via,
    msg: c.msg,
    count: String(c.count),
    time: c.time,
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in map ? map[k]! : m)).slice(0, 220);
}
