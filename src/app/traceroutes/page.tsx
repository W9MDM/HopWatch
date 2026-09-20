import { moduleDenied } from "../../components/ModuleGate.tsx";
import Link from "next/link";
import { listTraceroutes, tracerouteRttSamples, nodeNamesFor } from "../../db/queries.ts";
import { listSentTraceroutes } from "../../db/tx.ts";
import { getTopology, tracerouteCoverage } from "../../db/topology.ts";
import { fmtLocal, fmtAge, fmtNum } from "../../lib/format.ts";
import { formatNodeId } from "../../meshtastic/types.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../../components/DbError.tsx";
import { TracerouteGraph } from "../../components/TracerouteGraph.tsx";
import { Tabs, type TabDef } from "../../components/Tabs.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tz(): Promise<string> {
  try { return (await effectiveConfig()).server.local_timezone; } catch { return "UTC"; }
}

// 0xffffffff is the broadcast address, not a node; show it as such rather than a dead link.
const BROADCAST = 0xffffffff;
function Hop({ id, names }: { id: number; names?: Map<number, string> }) {
  if (id === BROADCAST) return <span className="whitespace-nowrap text-ink-faint" title="broadcast">broadcast</span>;
  const name = names?.get(id);
  return (
    <Link href={`/nodes/${id}`} className="callsign whitespace-nowrap" title={formatNodeId(id)}>
      {name ?? formatNodeId(id)}
    </Link>
  );
}

export default async function TraceroutesPage() {
  const __denied = await moduleDenied("traceroutes"); if (__denied) return __denied;
  let rows, topology, coverage, rtt, sent;
  try {
    [rows, topology, coverage, rtt, sent] = await Promise.all([listTraceroutes(500), getTopology(2000), tracerouteCoverage(24), tracerouteRttSamples(7), listSentTraceroutes(200)]);
  } catch (e) {
    return <DbError error={e} />;
  }
  const zone = await tz();

  // Resolve every node id shown in the results/paths to a name in one lookup, so TO and the hop
  // chain read like the FROM column instead of bare !ids.
  const names = await nodeNamesFor(
    rows.flatMap((r) => [r.from_node_id, r.to_node_id, ...(r.route ?? [])]),
  );

  // RTT distribution over the last 7 days (median/avg + buckets).
  const rttSorted = [...rtt].sort((a, b) => a - b);
  const rttMedian = rttSorted.length ? rttSorted[Math.floor(rttSorted.length / 2)]! : 0;
  const rttAvg = rtt.length ? rtt.reduce((a, b) => a + b, 0) / rtt.length : 0;
  const RTT_BUCKETS: [string, (ms: number) => boolean][] = [
    ["< 1s", (m) => m < 1000], ["1-2s", (m) => m >= 1000 && m < 2000], ["2-5s", (m) => m >= 2000 && m < 5000],
    ["5-10s", (m) => m >= 5000 && m < 10000], ["10-30s", (m) => m >= 10000 && m < 30000], ["30s+", (m) => m >= 30000],
  ];
  const rttRows = RTT_BUCKETS.map(([label, test]) => ({ label, c: rtt.filter((m) => test(m)).length }));
  const rttMax = Math.max(1, ...rttRows.map((r) => r.c));
  const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  const pct = coverage.active > 0 ? Math.round((coverage.known / coverage.active) * 100) : 0;
  // Feed the graph the accumulated topology (whole known mesh) plus recent full paths.
  const graphPaths = [
    ...topology.map((e) => [e.a_node_id, e.b_node_id]),
    ...rows.map((r) => [r.from_node_id, ...(r.route ?? []), r.to_node_id]),
  ];

  const stats = [
    { label: "Active nodes (24h)", value: coverage.active },
    { label: "Routes known", value: `${coverage.known} (${pct}%)` },
    { label: "Awaiting reply", value: coverage.requested },
    { label: "Topology links", value: coverage.links },
  ];

  const sentPanel = (
    <div className="card overflow-x-auto">
      {sent.length === 0 ? (
        <p className="text-[13px] text-ink-faint">None sent yet. Enable auto-traceroute (Transmit tab) or send one from a node page. RF traceroutes need the station node transport + TX armed.</p>
      ) : (
        <table className="data">
          <thead><tr><th>Target</th><th>Via</th><th>State</th><th className="text-right">Attempts</th><th>Queued ({zone})</th><th>Sent</th><th>Error</th></tr></thead>
          <tbody>
            {sent.map((t) => (
              <tr key={t.id}>
                <td>{t.to_node ? <Link className="callsign" href={`/nodes/${t.to_node}`}>{t.name ?? formatNodeId(t.to_node)}</Link> : "-"}</td>
                <td className={t.transport === "node" ? "text-ok" : "text-ink-mute"}>{t.transport === "node" ? "RF" : "MQTT"}</td>
                <td className={t.state === "acked" || t.state === "heard" ? "text-ok" : t.state === "failed" ? "text-accent-strong" : "text-ink-mute"}>{t.state}</td>
                <td className="text-right tabular-nums">{t.attempts}</td>
                <td className="text-ink-faint">{fmtLocal(t.created_at, zone)}</td>
                <td className="text-ink-faint">{t.sent_at ? fmtAge(t.sent_at) : "-"}</td>
                <td className="text-[11px] text-accent-strong">{t.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-[11px] text-ink-faint">State = success: <span className="text-ok">heard/acked</span> means the target replied (see the Results tab); <span className="text-ink-mute">sent</span> is awaiting a reply; <span className="text-accent-strong">failed</span> gave up after retries; queued/held are still pending.</p>
    </div>
  );

  const resultsPanel = (
    <div className="card overflow-x-auto">
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-faint">No completed traceroutes yet. A result appears here once a target replies with its route.</p>
      ) : (
        <table className="data">
          <thead><tr><th>Time ({zone})</th><th>From</th><th>To</th><th className="text-right">Hops</th><th>Path</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const path = [r.from_node_id, ...(r.route ?? []), r.to_node_id];
              const hops = r.hop_count ?? Math.max(0, path.length - 1);
              return (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-ink-mute" data-sort={new Date(r.observed_at.replace(" ", "T") + "Z").getTime()}>{fmtLocal(r.observed_at, zone)}</td>
                  <td><Link className="callsign" href={`/nodes/${r.from_node_id}`}>{r.from_name ?? formatNodeId(r.from_node_id)}</Link></td>
                  <td><Hop id={r.to_node_id} names={names} /></td>
                  <td className="text-right tabular-nums">{hops}</td>
                  <td>
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {path.map((id, i) => (
                        <span key={`${id}-${i}`} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-ink-faint">&rarr;</span>}
                          <Hop id={id} names={names} />
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-[11px] text-ink-faint">Completed traceroutes (the target replied with its route). Path is source &rarr; intermediate hops &rarr; target. Direct (0-hop) means the two nodes hear each other with no relay.</p>
    </div>
  );

  const linksPanel = (
    <div className="card overflow-x-auto">
      <table className="data">
        <thead><tr><th>Node A</th><th>Node B</th><th className="text-right">Seen</th><th className="text-right">Last SNR</th><th>Last observed</th></tr></thead>
        <tbody>
          {topology.map((e) => (
            <tr key={`${e.a_node_id}-${e.b_node_id}`}>
              <td><Link className="callsign" href={`/nodes/${e.a_node_id}`}>{e.a_name ?? formatNodeId(e.a_node_id)}</Link></td>
              <td><Link className="callsign" href={`/nodes/${e.b_node_id}`}>{e.b_name ?? formatNodeId(e.b_node_id)}</Link></td>
              <td className="text-right tabular-nums text-ink-faint">{fmtNum(e.times_seen)}</td>
              <td className="text-right tabular-nums">{e.last_snr === null ? "-" : `${Number(e.last_snr).toFixed(1)} dB`}</td>
              <td className="text-ink-faint" data-sort={e.last_seen_at ? new Date(e.last_seen_at.replace(" ", "T") + "Z").getTime() : 0}>{fmtAge(e.last_seen_at)} ago</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const rttPanel = (
    <div className="card">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink-mute">Round-trip time distribution (7d)</span>
        <span className="text-[12px] text-ink-mute">median <span className="font-semibold text-ink">{fmtMs(rttMedian)}</span> &middot; avg {fmtMs(rttAvg)} &middot; {fmtNum(rtt.length)} samples</span>
      </div>
      <div className="mt-3 space-y-1.5">
        {rttRows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-[13px]">
            <span className="w-14 text-ink-mute">{r.label}</span>
            <div className="h-3 flex-1 rounded bg-raised"><div className="h-3 rounded bg-rx-direct" style={{ width: `${Math.round((r.c / rttMax) * 100)}%` }} /></div>
            <span className="w-14 text-right tabular-nums text-ink-faint">{fmtNum(r.c)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const stalePanel = (
    <div className="card">
      <div className="flex flex-wrap gap-2">
        {coverage.stale.map((n) => (
          <Link key={n.node_id} href={`/nodes/${n.node_id}`} className="rounded border border-line px-2 py-1 text-[12px] text-ink-mute hover:text-ink" title={n.last_result_at ? `last route ${fmtLocal(n.last_result_at, zone)}` : "never traced"}>
            {n.long_name ?? formatNodeId(n.node_id)} <span className="text-ink-faint">{n.last_result_at ? fmtAge(n.last_result_at) + " ago" : "never"}</span>
          </Link>
        ))}
      </div>
    </div>
  );

  const recentPanel = (
    <div className="space-y-2">
      {rows.map((r) => {
        const path = [r.from_node_id, ...(r.route ?? []), r.to_node_id];
        return (
          <div key={r.id} className="card flex flex-wrap items-center gap-2 py-3">
            <span className="mr-2 text-[11px] text-ink-faint">{fmtLocal(r.observed_at, zone)}</span>
            {path.map((id, i) => (
              <span key={i} className="flex items-center gap-2">
                <Hop id={id} names={names} />
                {i < path.length - 1 && <span className="text-ink-faint">-&gt;</span>}
              </span>
            ))}
            <span className="ml-auto text-[11px] text-ink-faint">{r.hop_count ?? path.length - 1} hops</span>
            <Link className="btn btn-outline h-7 px-2 text-[12px]" href={`/livemap?route=${path.join(",")}`}>Replay on map</Link>
          </div>
        );
      })}
    </div>
  );

  const tabs: TabDef[] = [
    { id: "results", label: `Results (${fmtNum(rows.length)})`, panel: resultsPanel },
    { id: "sent", label: `Sent log (${fmtNum(sent.length)})`, panel: sentPanel },
  ];
  if (graphPaths.length > 0) tabs.push({ id: "graph", label: "Topology graph", panel: <TracerouteGraph paths={graphPaths} /> });
  if (topology.length > 0) tabs.push({ id: "links", label: `Links (${fmtNum(topology.length)})`, panel: linksPanel });
  if (rtt.length > 0) tabs.push({ id: "rtt", label: "Round-trip", panel: rttPanel });
  if (coverage.stale.length > 0) tabs.push({ id: "stale", label: "Next to trace", panel: stalePanel });
  if (rows.length > 0) tabs.push({ id: "recent", label: "Recent (replay)", panel: recentPanel });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="eyebrow"><span className="eyebrow-bar" />Traceroutes &amp; topology</h1>
        <p className="mt-1 text-[13px] text-ink-faint">
          The mesh layout accumulated from observed traceroutes. Enable auto-traceroute under{" "}
          <Link className="text-accent hover:underline" href="/admin/tx">Transmit</Link> to map it automatically without re-tracing fresh nodes.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="card"><div className="stat-label">{s.label}</div><div className="stat mt-1 text-base">{typeof s.value === "number" ? fmtNum(s.value) : s.value}</div></div>
        ))}
      </div>

      <Tabs tabs={tabs} />
    </div>
  );
}
