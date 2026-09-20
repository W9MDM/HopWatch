import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import {
  listNodes, countNodes, nodeStats, distinctBrokers, distinctNodeRoles, distinctNodeHardware,
  type NodeFilter,
} from "../../db/queries.ts";
import { distinctChannels } from "../../db/settings.ts";
import { fmtAge, fmtNode, fmtNum } from "../../lib/format.ts";
import { roleColor } from "../../lib/rx.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { cn } from "../../lib/cn.ts";
import { ageTone } from "../../lib/format.ts";
import { DbError } from "../../components/DbError.tsx";
import { AutoRefresh } from "../../components/AutoRefresh.tsx";
import { currentUserPrefs, resolveFormDefault } from "../../auth/prefs.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Nodes" };

type SP = Record<string, string | string[] | undefined>;

const PAGE_SIZES = [50, 100, 250, 500];
const inputCls =
  "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export default async function NodesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const __denied = await moduleDenied("nodes"); if (__denied) return __denied;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const q = one("q") || undefined;
  // Seed broker/channel from the user's saved defaults on a bare visit; an explicit blank wins.
  const prefs = await currentUserPrefs();
  const broker = resolveFormDefault(one("broker"), prefs.default_broker);
  const channel = resolveFormDefault(one("channel"), prefs.default_channel);

  const role = one("role") || undefined;
  const kind = (["gateway", "relay", "node"].includes(one("kind") ?? "") ? one("kind") : undefined) as
    NodeFilter["kind"];
  const hw = one("hw") || undefined;
  const posSel = one("pos") ?? ""; // "", "yes", "no"
  const hasPosition = posSel === "yes" ? true : posSel === "no" ? false : undefined;
  const keySel = one("key") ?? "";
  const hasKey = keySel === "yes" ? true : keySel === "no" ? false : undefined;
  const spoof = one("spoof") === "1" ? true : undefined;
  const seenWithin = (["1h", "24h", "7d", "30d"].includes(one("seen") ?? "") ? one("seen") : undefined) as
    NodeFilter["seenWithin"];
  const sort = (["last_seen", "first_seen", "packets", "receptions", "name", "hops"].includes(one("sort") ?? "")
    ? one("sort")
    : "last_seen") as NodeFilter["sort"];

  const pageSize = PAGE_SIZES.includes(Number(one("limit"))) ? Number(one("limit")) : 100;
  const page = Math.max(1, Number(one("page")) || 1);
  const offset = (page - 1) * pageSize;

  const filter: NodeFilter = {
    q, broker, channelId: channel, role, kind, hw, hasPosition, hasKey, spoof, seenWithin, sort,
  };

  let rows, total: number, stats, brokers: string[], channels: string[], roles: string[], hws: string[];
  try {
    [rows, total, stats, brokers, channels, roles, hws] = await Promise.all([
      listNodes({ ...filter, limit: pageSize, offset }),
      countNodes(filter),
      nodeStats({ broker, channelId: channel }),
      distinctBrokers(),
      distinctChannels(),
      distinctNodeRoles(),
      distinctNodeHardware(),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);

  // Build a querystring for a page link that preserves every active filter (page is 1-based).
  const pageHref = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (broker) u.set("broker", broker); else if (one("broker") === "") u.set("broker", "");
    if (channel) u.set("channel", channel); else if (one("channel") === "") u.set("channel", "");
    if (role) u.set("role", role);
    if (kind) u.set("kind", kind);
    if (hw) u.set("hw", hw);
    if (posSel) u.set("pos", posSel);
    if (keySel) u.set("key", keySel);
    if (spoof) u.set("spoof", "1");
    if (seenWithin) u.set("seen", seenWithin);
    if (sort && sort !== "last_seen") u.set("sort", sort);
    if (pageSize !== 100) u.set("limit", String(pageSize));
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return s ? `/nodes?${s}` : "/nodes";
  };

  const StatCard = ({ label, value }: { label: string; value: number }) => (
    <div className="card px-4 py-3">
      <div className="stat-label">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{fmtNum(value)}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="eyebrow">
          <span className="eyebrow-bar" />
          Nodes
        </h1>
        <AutoRefresh />
      </div>

      {(broker || channel) && (
        <p className="text-[12px] text-ink-faint">
          Totals below are scoped to{broker ? <> broker <b className="text-ink-mute">{broker}</b></> : null}
          {broker && channel ? " /" : null}
          {channel ? <> channel <b className="text-ink-mute">{channel}</b></> : null}.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <StatCard label="Total nodes" value={stats.total} />
        <StatCard label="Active 1h" value={stats.active1h} />
        <StatCard label="Active 12h" value={stats.active12h} />
        <StatCard label="Active 24h" value={stats.active24h} />
        <StatCard label="Active 7d" value={stats.active7d} />
        <StatCard label="Active 30d" value={stats.active30d} />
        <StatCard label="With position" value={stats.withPosition} />
        <StatCard label="Gateways" value={stats.gateways} />
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <label className="space-y-1.5">
          <span className="block stat-label">Search</span>
          <input name="q" defaultValue={q ?? ""} placeholder="name or id (partial ok)" className={`${inputCls} w-56`} />
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Broker</span>
          <select name="broker" defaultValue={broker ?? ""} className={`${inputCls} w-36 appearance-none`}>
            <option value="">any</option>
            {brokers.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Channel</span>
          <select name="channel" defaultValue={channel ?? ""} className={`${inputCls} w-36 appearance-none`}>
            <option value="">any</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Role</span>
          <select name="role" defaultValue={role ?? ""} className={`${inputCls} w-36 appearance-none`}>
            <option value="">any</option>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Kind</span>
          <select name="kind" defaultValue={kind ?? ""} className={`${inputCls} w-32 appearance-none`}>
            <option value="">any</option>
            <option value="gateway">gateway</option>
            <option value="relay">relay</option>
            <option value="node">plain node</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Hardware</span>
          <select name="hw" defaultValue={hw ?? ""} className={`${inputCls} w-40 appearance-none`}>
            <option value="">any</option>
            {hws.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Seen within</span>
          <select name="seen" defaultValue={seenWithin ?? ""} className={`${inputCls} w-32 appearance-none`}>
            <option value="">any time</option>
            <option value="1h">1 hour</option>
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Position</span>
          <select name="pos" defaultValue={posSel} className={`${inputCls} w-32 appearance-none`}>
            <option value="">any</option>
            <option value="yes">has GPS</option>
            <option value="no">no GPS</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">PKI key</span>
          <select name="key" defaultValue={keySel} className={`${inputCls} w-32 appearance-none`}>
            <option value="">any</option>
            <option value="yes">has key</option>
            <option value="no">no key</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Sort</span>
          <select name="sort" defaultValue={sort ?? "last_seen"} className={`${inputCls} w-40 appearance-none`}>
            <option value="last_seen">last seen</option>
            <option value="first_seen">first seen</option>
            <option value="packets">packets</option>
            <option value="receptions">receptions</option>
            <option value="name">name</option>
            <option value="hops">hops away</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="block stat-label">Per page</span>
          <select name="limit" defaultValue={String(pageSize)} className={`${inputCls} w-24 appearance-none`}>
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-[13px] text-ink-mute">
          <input type="checkbox" name="spoof" value="1" defaultChecked={!!spoof} /> spoof-flagged only
        </label>
        <div className="ml-auto flex items-end gap-2 pb-0.5">
          <button className="btn btn-primary h-9 px-4 text-[13px]" type="submit">Apply</button>
          <Link className="btn btn-outline h-9 px-4 text-[13px]" href="/nodes">Reset</Link>
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="data" data-no-paginate>
          <thead>
            <tr>
              <th>Node</th>
              <th>Short</th>
              <th>Role</th>
              <th>Hardware</th>
              <th>Kind</th>
              <th>Last seen</th>
              <th className="text-right" title="Fewest hops any gateway used to hear this node in the last 24h (direct = heard over the air, 0 relays)">Hops</th>
              <th className="text-right">Packets</th>
              <th className="text-right">Receptions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="text-ink-faint">No nodes match.</td>
              </tr>
            )}
            {rows.map((n) => (
              <tr key={n.node_id}>
                <td>
                  <Link className="callsign" href={`/nodes/${n.node_id}`}>
                    {fmtNode(n.node_id, n.long_name, n.short_name)}
                  </Link>
                  <span className="ml-2 mono text-[11px] text-ink-faint">{formatNodeId(n.node_id)}</span>
                </td>
                <td className="mono text-ink-mute">{n.short_name ?? "-"}</td>
                <td className={roleColor(n.role)}>{n.role ?? "-"}</td>
                <td className="text-ink-mute">{n.hw_model ?? "-"}</td>
                <td className="text-ink-faint">
                  {n.is_gateway ? "gateway " : ""}
                  {n.is_relay ? "relay" : ""}
                  {!n.is_gateway && !n.is_relay ? "node" : ""}
                  {n.spoof_flag_count > 0 ? <span className="ml-1 text-accent-strong">spoof</span> : null}
                </td>
                <td data-sort={n.last_seen_at ? new Date(n.last_seen_at.replace(" ", "T") + "Z").getTime() : 0}>
                  <span className={cn("pill", ageTone(n.last_seen_at) === "on" ? "pill-on" : "pill-off")}>
                    {fmtAge(n.last_seen_at)}
                  </span>
                </td>
                <td className="text-right tabular-nums" data-sort={n.hops ?? 9999}>
                  {n.hops == null
                    ? <span className="text-ink-faint">-</span>
                    : n.hops === 0
                      ? <span className="pill pill-on">direct</span>
                      : <span className="text-ink-mute">{n.hops}</span>}
                </td>
                <td className="text-right tabular-nums">{fmtNum(n.total_packet_count)}</td>
                <td className="text-right tabular-nums">{fmtNum(n.total_reception_count)}</td>
                <td className="text-right">
                  <Link className="btn btn-outline h-7 px-2 text-[12px]" href={`/nodes/${n.node_id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-mute">
        <span>
          {total === 0 ? "No matching nodes" : <>Showing <b className="text-ink">{fmtNum(from)}</b>-<b className="text-ink">{fmtNum(to)}</b> of <b className="text-ink">{fmtNum(total)}</b></>}
        </span>
        <div className="flex items-center gap-2">
          {page > 1
            ? <Link className="btn btn-outline h-8 px-3 text-[12px]" href={pageHref(page - 1)}>Prev</Link>
            : <span className="btn btn-outline h-8 px-3 text-[12px] opacity-40 pointer-events-none">Prev</span>}
          <span className="tabular-nums">Page {page} / {lastPage}</span>
          {page < lastPage
            ? <Link className="btn btn-outline h-8 px-3 text-[12px]" href={pageHref(page + 1)}>Next</Link>
            : <span className="btn btn-outline h-8 px-3 text-[12px] opacity-40 pointer-events-none">Next</span>}
        </div>
      </div>
    </div>
  );
}
