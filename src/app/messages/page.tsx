import { moduleDenied } from "../../components/ModuleGate.tsx";
import { pageAccess } from "../../auth/rbac.ts";
import Link from "next/link";
import { listTextMessages, channelStats, type ChannelStat } from "../../db/queries.ts";
import { distinctChannels, getChannelKeys } from "../../db/settings.ts";
import { txThreadMessages } from "../../db/tx.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { MessageCompose } from "../../components/MessageCompose.tsx";
import { fmtLocal } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";
import { DbError } from "../../components/DbError.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Messages" };

async function tz(): Promise<string> {
  try {
    return (await effectiveConfig()).server.local_timezone;
  } catch {
    return "UTC";
  }
}

const ms = (s: string) => new Date(s.replace(" ", "T") + "Z").getTime();
const STATE_TONE: Record<string, string> = {
  queued: "text-ink-mute", held: "text-accent-strong", dry_run: "text-ink-faint", sent: "text-accent",
  heard: "text-ok", acked: "text-ok", failed: "text-accent-strong", cancelled: "text-ink-faint",
};

interface ThreadItem {
  key: string; timeMs: number; time: string; origin: "rx" | "tx";
  fromNodeId: number | null; fromName: string; channel: string | null; body: string;
  toNode?: number | null; state?: string; broker?: string | null; topic?: string | null;
}

type SP = Record<string, string | string[] | undefined>;

export default async function MessagesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("messages"); if (__denied) return __denied;
  // Compose renders only for viewers whose role can transmit (Rule 2: anonymous read-only
  // can never send). The TX API rejects them server-side regardless; this keeps the UI honest.
  const canTx = (await pageAccess()).canTx;
  const sp = await searchParams;
  const channel = Array.isArray(sp.channel) ? sp.channel[0] : sp.channel;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() || undefined;
  const dirSel = (Array.isArray(sp.dir) ? sp.dir[0] : sp.dir) ?? ""; // "", "rx", "tx", "dm"

  let rx, tx, channels: string[], txCfg = { enabled: false, dryRun: true }, keyedChannels: string[] = [], chanStats: ChannelStat[] = [], canned: string[] = [];
  try {
    const cfg = await effectiveConfig();
    txCfg = { enabled: cfg.tx.enabled, dryRun: cfg.tx.dry_run };
    canned = cfg.tx.canned_messages ?? [];
    [rx, tx, channels, keyedChannels, chanStats] = await Promise.all([
      listTextMessages(200, channel || undefined, q),
      txThreadMessages(200, channel || undefined, q),
      distinctChannels(),
      txCfg.enabled && canTx ? getChannelKeys().then((ks) => ks.map((k) => k.name)) : Promise.resolve([] as string[]),
      channelStats(24),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }
  const zone = await tz();

  // Merge observed (RX) and our own (TX) messages into one timeline, newest first.
  const items: ThreadItem[] = [
    ...rx.map((m) => ({
      key: `rx${m.id}`, timeMs: ms(m.observed_at), time: m.observed_at, origin: "rx" as const,
      fromNodeId: m.from_node_id, fromName: m.from_name ?? formatNodeId(m.from_node_id), channel: m.channel_id, body: m.body, toNode: m.to_node_id, broker: m.source_broker_id, topic: m.source_topic,
    })),
    ...tx.map((t) => ({
      key: `tx${t.id}`, timeMs: ms(t.sent_at ?? t.created_at), time: t.sent_at ?? t.created_at, origin: "tx" as const,
      fromNodeId: null, fromName: "HopWatch", channel: t.channel_id, body: t.payload_text ?? "", toNode: t.to_node, state: t.state,
    })),
  ]
    // Direction filter (additive; default shows everything): received / our TX / directed-only.
    .filter((m) =>
      dirSel === "rx" ? m.origin === "rx"
      : dirSel === "tx" ? m.origin === "tx"
      : dirSel === "dm" ? m.toNode != null
      : true)
    .sort((a, b) => b.timeMs - a.timeMs).slice(0, 300);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="eyebrow">
            <span className="eyebrow-bar" />
            Messages
          </h1>
          <p className="mt-1 text-[13px] text-ink-faint">
            Observed text messages, merged with messages HopWatch has sent (tagged). Sending is off unless TX is enabled and armed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link className="btn btn-outline h-8 px-3 text-[13px]" href="/messages/chat">Open chat</Link>
          <AutoRefresh />
        </div>
      </div>

      {chanStats.length > 0 && (
        <div className="card overflow-x-auto">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Channel activity (24h)</h2>
          <table className="data">
            <thead><tr><th>Channel</th><th className="text-right">Packets</th><th className="text-right">Transmitters</th><th className="text-right">Messages</th></tr></thead>
            <tbody>
              {chanStats.map((c) => (
                <tr key={c.channel}>
                  <td className="mono">
                    <Link className="callsign" href={`/messages?channel=${encodeURIComponent(c.channel)}`}>{c.channel}</Link>
                  </td>
                  <td className="text-right tabular-nums">{c.packets.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{c.nodes.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{c.messages.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="card flex flex-wrap items-end gap-3" method="get">
        <label className="space-y-1.5">
          <span className="block stat-label">Search text</span>
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="word or phrase in message body"
            className="h-9 w-64 rounded-md border border-line bg-raised px-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Channel</span>
          <select
            name="channel"
            defaultValue={channel ?? ""}
            className="h-9 w-40 appearance-none rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="">any</option>
            {channels.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Direction</span>
          <select
            name="dir"
            defaultValue={dirSel}
            className="h-9 w-44 appearance-none rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="">all</option>
            <option value="rx">received (RX)</option>
            <option value="tx">sent by HopWatch</option>
            <option value="dm">directed / DM only</option>
          </select>
        </label>
        <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">Apply</button>
      </form>
      {txCfg.enabled && canTx && keyedChannels.length > 0 && <MessageCompose channels={keyedChannels} dryRun={txCfg.dryRun} canned={canned} />}
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Time ({zone})</th>
              <th>From</th>
              <th>Channel</th>
              <th>Source</th>
              <th>Topic</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="text-ink-faint">
                  No messages yet.
                </td>
              </tr>
            )}
            {items.map((m) => (
              <tr key={m.key}>
                <td className="whitespace-nowrap text-ink-mute" data-sort={m.timeMs}>{fmtLocal(m.time, zone)}</td>
                <td>
                  {m.origin === "tx" ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="rounded bg-accent/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-accent-strong">hopwatch</span>
                      {m.toNode != null ? <span className="mono text-ink-faint">to {formatNodeId(m.toNode)}</span> : <span className="text-ink-faint">broadcast</span>}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Link className="callsign" href={`/nodes/${m.fromNodeId}`}>{m.fromName}</Link>
                      {/* Overheard directed message: label it so it does not read as channel traffic. */}
                      {m.toNode != null && <span className="mono text-ink-faint">DM to {formatNodeId(m.toNode)}</span>}
                    </span>
                  )}
                </td>
                <td className="text-ink-faint">{m.channel ?? "-"}</td>
                <td className="mono text-[11px] text-ink-faint">{m.origin === "tx" ? "-" : (m.broker ?? "unknown")}</td>
                <td className="mono max-w-[220px] truncate text-[11px] text-ink-faint" title={m.topic ?? ""}>{m.origin === "tx" ? "-" : (m.topic ?? "-")}</td>
                <td className="text-ink">
                  {m.body}
                  {m.origin === "tx" && m.state && <span className={cn("ml-2 text-[11px]", STATE_TONE[m.state] ?? "text-ink-faint")}>[{m.state}]</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
