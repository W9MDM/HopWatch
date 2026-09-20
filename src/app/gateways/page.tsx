import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { listGateways, distinctBrokers } from "../../db/queries.ts";
import { distinctChannels } from "../../db/settings.ts";
import { fmtAge, fmtNum } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { ageTone } from "../../lib/format.ts";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";
import { currentUserPrefs, resolveFormDefault } from "../../auth/prefs.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Gateways" };

type SP = Record<string, string | string[] | undefined>;

export default async function GatewaysPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("gateways"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  // Seed from the user's saved defaults on a bare visit; an explicit blank selection wins.
  const prefs = await currentUserPrefs();
  const broker = resolveFormDefault(one("broker"), prefs.default_broker);
  const channel = resolveFormDefault(one("channel"), prefs.default_channel);

  let rows, brokers: string[], channels: string[];
  try {
    [rows, brokers, channels] = await Promise.all([
      listGateways({ broker: broker || undefined, channelId: channel || undefined }),
      distinctBrokers(),
      distinctChannels(),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Gateways
        </h1>
        <AutoRefresh />
      </div>
      <form className="card flex flex-wrap items-end gap-3" method="get">
        <label className="space-y-1.5">
          <span className="block stat-label">Broker</span>
          <select
            name="broker"
            defaultValue={broker ?? ""}
            className="h-9 w-40 appearance-none rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none"
          >
            <option value="">any</option>
            {brokers.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
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
        <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">Apply</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Gateway</th>
              <th>Short</th>
              <th>Broker</th>
              <th className="text-right">Nodes heard direct</th>
              <th>Last seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-ink-faint">
                  No gateways have reported yet.
                </td>
              </tr>
            )}
            {rows.map((g) => {
              const tone = ageTone(g.last_seen_at);
              return (
                <tr key={g.gateway_id}>
                  <td>
                    <Link className="callsign" href={`/nodes/${g.gateway_id}`}>{g.long_name ?? g.short_name ?? formatNodeId(g.gateway_id)}</Link>
                    <div className="mono text-[11px] text-ink-faint">{formatNodeId(g.gateway_id)}</div>
                  </td>
                  <td className="mono text-ink-mute">{g.short_name ?? "-"}</td>
                  <td className="text-ink-faint">{g.broker_id ?? "-"}</td>
                  <td className="text-right tabular-nums">{fmtNum(g.direct_nodes)}</td>
                  <td data-sort={g.last_seen_at ? new Date(g.last_seen_at.replace(" ", "T") + "Z").getTime() : 0}>
                    <span className={cn("pill", tone === "on" ? "pill-on" : "pill-off")}>{fmtAge(g.last_seen_at)}</span>
                  </td>
                  <td className="text-right">
                    <Link className="btn btn-outline h-7 px-2 text-[12px]" href={`/gateways/${g.gateway_id}`}>
                      Heard direct
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
