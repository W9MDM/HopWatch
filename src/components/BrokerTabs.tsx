"use client";

import { useState } from "react";
import Link from "next/link";
import { fmtAge, fmtNum, ageTone, fmtNode } from "../lib/format.ts";
import { formatNodeId } from "../meshtastic/types.ts";
import { cn } from "../lib/cn.ts";
import type { BrokerPresence, MqttClientRow } from "../db/queries.ts";

export interface BrokerGateway {
  gateway_id: number; long_name: string | null; short_name: string | null;
  last_seen_at: string | null; direct_nodes: number; broker_id: string | null;
}

function kindTone(kind: string | null): string {
  if (!kind) return "text-ink-mute";
  if (kind === "hopwatch") return "text-accent";
  if (kind.startsWith("app")) return "text-ok";
  if (kind === "node") return "text-ink";
  return "text-ink-faint";
}

function fmtUptime(s: number | null): string {
  if (s == null) return "-";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums text-ink", tone)}>{value}</div>
    </div>
  );
}

/** Tabbed per-broker presence: one tab per configured broker, each showing its live $SYS client
 *  counts and the roster of gateways observed publishing through it. Client-side so switching tabs
 *  is instant and does not reload the page (auto-refresh still re-renders the server data). */
export function BrokerTabs({ brokers, rosters, clients, isAdmin }: {
  brokers: BrokerPresence[];
  rosters: Record<string, BrokerGateway[]>;
  clients?: Record<string, MqttClientRow[]>;
  isAdmin?: boolean;
}) {
  const [active, setActive] = useState<string>(brokers[0]?.broker_id ?? "");
  if (brokers.length === 0) return <div className="card text-ink-faint">No brokers configured.</div>;

  const b = brokers.find((x) => x.broker_id === active) ?? brokers[0]!;
  const roster = (rosters[b.broker_id] ?? []).slice().sort((a, c) => (c.last_seen_at ?? "").localeCompare(a.last_seen_at ?? ""));
  const clientList = clients?.[b.broker_id] ?? [];
  const sysStale = b.sys_updated_at != null && ageTone(b.sys_updated_at) === "off";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist">
        {brokers.map((x) => {
          const on = x.broker_id === b.broker_id;
          return (
            <button
              key={x.broker_id}
              role="tab"
              aria-selected={on}
              onClick={() => setActive(x.broker_id)}
              className={cn(
                "flex items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-[13px]",
                on ? "border-line bg-raised text-ink" : "border-transparent text-ink-mute hover:text-ink",
              )}
            >
              <span className={cn("inline-block h-2 w-2 rounded-full", x.ingest_connected ? "bg-ok" : "bg-ink-faint")} />
              {x.broker_id}
              {x.clients_connected != null && <span className="mono text-[11px] text-ink-faint">{fmtNum(x.clients_connected)}</span>}
            </button>
          );
        })}
      </div>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-semibold text-ink">{b.broker_id}</h2>
          <span className={cn("pill", b.ingest_connected ? "pill-on" : "pill-off")}>
            {b.ingest_connected ? "ingest connected" : "ingest down"}
          </span>
          {b.version && <span className="mono text-[11px] text-ink-faint">{b.version}</span>}
          {b.sys_updated_at == null && <span className="text-[11px] text-ink-faint">($SYS not exposed by this broker)</span>}
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Clients connected" value={b.clients_connected != null ? fmtNum(b.clients_connected) : "n/a"} />
          <Stat label="Clients active" value={b.clients_active != null ? fmtNum(b.clients_active) : "n/a"} />
          <Stat label="Broker uptime" value={fmtUptime(b.uptime_s)} />
          <Stat label="Gateways" value={fmtNum(b.gateways_total)} />
          <Stat label="Gateways active 15m" value={fmtNum(b.gateways_active_15m)} />
          <Stat label="Last gateway seen" value={fmtAge(b.last_gateway_seen)} tone={ageTone(b.last_gateway_seen) === "on" ? "text-ok" : ""} />
        </div>
        {sysStale && (
          <p className="text-[11px] text-ink-faint">$SYS reading is stale (last update {fmtAge(b.sys_updated_at)} ago); the broker or our subscription may be down.</p>
        )}

        {clientList.length > 0 && (
          <div className="space-y-1.5">
            <div className="stat-label">Connected clients ({clientList.length}) <span className="text-ink-faint">- live sessions on the broker, from its log</span></div>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Client ID</th>
                    <th>Kind</th>
                    <th>Node</th>
                    {isAdmin && <th>User</th>}
                    <th className="text-right">Keepalive</th>
                    <th>Connected</th>
                  </tr>
                </thead>
                <tbody>
                  {clientList.map((c) => (
                    <tr key={c.client_id}>
                      <td className="mono text-[12px] text-ink-mute" title={c.client_id}>
                        {c.client_id.length > 42 ? c.client_id.slice(0, 42) + "..." : c.client_id}
                      </td>
                      <td className={kindTone(c.kind)}>{c.kind ?? "-"}</td>
                      <td>
                        {c.node_id != null
                          ? <Link className="callsign" href={`/nodes/${c.node_id}`}>{fmtNode(c.node_id, c.long_name, c.short_name)}</Link>
                          : <span className="text-ink-faint">-</span>}
                      </td>
                      {isAdmin && <td className="text-ink-faint">{c.username ?? "-"}</td>}
                      <td className="text-right tabular-nums text-ink-faint">{c.keepalive_s != null ? `${c.keepalive_s}s` : "-"}</td>
                      <td data-sort={c.connected_at ? new Date(c.connected_at.replace(" ", "T") + "Z").getTime() : 0}>
                        <span className="pill pill-on">{fmtAge(c.connected_at)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!isAdmin && <p className="text-[11px] text-ink-faint">Sign in as an admin to see usernames.</p>}
          </div>
        )}

        <div className="overflow-x-auto">
          <div className="stat-label mb-1.5">Gateway roster <span className="text-ink-faint">- Meshtastic gateways seen publishing here</span></div>
          <table className="data">
            <thead>
              <tr>
                <th>Gateway</th>
                <th>Short</th>
                <th className="text-right">Nodes heard direct</th>
                <th>Last seen</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roster.length === 0 && (
                <tr><td colSpan={5} className="text-ink-faint">No gateways observed publishing through this broker yet.</td></tr>
              )}
              {roster.map((g) => (
                <tr key={g.gateway_id}>
                  <td>
                    <Link className="callsign" href={`/gateways/${g.gateway_id}`}>
                      {fmtNode(g.gateway_id, g.long_name, g.short_name)}
                    </Link>
                    <span className="ml-2 mono text-[11px] text-ink-faint">{formatNodeId(g.gateway_id)}</span>
                  </td>
                  <td className="mono text-ink-mute">{g.short_name ?? "-"}</td>
                  <td className="text-right tabular-nums">{fmtNum(g.direct_nodes)}</td>
                  <td data-sort={g.last_seen_at ? new Date(g.last_seen_at.replace(" ", "T") + "Z").getTime() : 0}>
                    <span className={cn("pill", ageTone(g.last_seen_at) === "on" ? "pill-on" : "pill-off")}>{fmtAge(g.last_seen_at)}</span>
                  </td>
                  <td className="text-right">
                    <Link className="btn btn-outline h-7 px-2 text-[12px]" href={`/gateways/${g.gateway_id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
