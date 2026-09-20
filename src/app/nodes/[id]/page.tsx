import { moduleDenied } from "../../../components/ModuleGate.tsx";
import { NodeTabs } from "../../../components/NodeTabs.tsx";
import Link from "next/link";
import { getNode, getNodeBiography, nodeTelemetryMetrics, getNodeTelemetry, bestGatewaysForNode, getNodeFingerprint, getBatteryForecast, getNodeNeighbors, nodePortBreakdown, nodeRecentMessages, nodeActivityHeatmap, nodeSignalTrend, nodePositionTrack, nodeReliability, nodeFarthestGateway, nodeHopProfile, nodeLatestMetric, nodeChannels, nodeChattinessPercentile, nodeLatestMetrics, nodeAdvertisements } from "../../../db/queries.ts";
import { portName } from "../../../meshtastic/portnum.ts";
import { NodeMiniMap } from "../../../components/NodeMiniMap.tsx";
import { NodeEgoGraph } from "../../../components/NodeEgoGraph.tsx";
import { NeighborGraph } from "../../../components/NeighborGraph.tsx";
import { NodeAdminControls } from "../../../components/NodeAdminControls.tsx";
import { pageAccess } from "../../../auth/rbac.ts";
import { fuzzPositions, fuzzNodeCoords, fuzzDecimalsFor, stripNodePosition } from "../../../lib/fuzz.ts";
import { haversineKm } from "../../../lib/geo.ts";
import { buildFingerprint } from "../../../lib/fingerprint.ts";
import { FingerprintGrid } from "../../../components/FingerprintGrid.tsx";
import { fmtLocal, fmtAge, fmtNum, convertTemp, tempUnitLabel, type TempUnit } from "../../../lib/format.ts";
import { roleColor } from "../../../lib/rx.ts";
import { formatNodeId } from "../../../meshtastic/types.ts";
import { cn } from "../../../lib/cn.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { getChannelKeys } from "../../../db/settings.ts";
import { DbError } from "../../../components/DbError.tsx";
import { NodeTxActions } from "../../../components/NodeTxActions.tsx";
import { ClaimNodeButton } from "../../../components/ClaimNodeButton.tsx";
import { NodeWatchControls } from "../../../components/NodeWatchControls.tsx";
import { TelemetryChart, type Series } from "../../../components/TelemetryChart.tsx";
import { MetricExplorer } from "../../../components/MetricExplorer.tsx";
import { mapTiles } from "../../../lib/maptiles.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function tz(): Promise<string> {
  try {
    return (await effectiveConfig()).server.local_timezone;
  } catch {
    return "UTC";
  }
}

const METRIC_COLORS: Record<string, string> = {
  battery_pct: "#3f9e63",
  voltage: "#e0b43a",
  chan_util: "#f04747",
  air_util_tx: "#d92b2b",
  temperature: "#5bb37e",
  humidity: "#a4a39c",
  pressure: "#6f8f5a",
};

const KEY_METRICS = ["battery_pct", "voltage", "chan_util", "air_util_tx", "temperature", "humidity"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function humanUptime(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// Approximate horizontal accuracy from Meshtastic position precision_bits (low bits of the
// lat/lon int are masked). Rough: half the masked span at the equator.
function fmtPrecision(bits: number): string {
  const meters = Math.pow(2, 32 - bits) * 1e-7 * 111319;
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

// Format any telemetry metric for the latest-values grid. Known metrics get a unit; anything
// new the decoder captures still shows with a sensible number so nothing is hidden.
function fmtMetricValue(metric: string, value: number, tempUnit: "c" | "f"): string {
  switch (metric) {
    case "battery_pct": case "chan_util": case "air_util_tx": case "humidity": return `${Math.round(value)}%`;
    case "voltage": return `${value.toFixed(2)} V`;
    case "temperature": return `${convertTemp(value, tempUnit).toFixed(1)} ${tempUnitLabel(tempUnit)}`;
    case "pressure": return `${value.toFixed(1)} hPa`;
    case "uptime": return humanUptime(value);
    case "current": return `${value.toFixed(1)} mA`;
    case "iaq": return String(Math.round(value));
    case "co2": return `${Math.round(value)} ppm`;
    case "lux": case "white_lux": case "uv_lux": return `${Math.round(value)} lx`;
    case "wind_speed": case "wind_gust": case "wind_lull": return `${value.toFixed(1)} m/s`;
    case "wind_direction": return `${Math.round(value)} deg`;
    case "gas_resistance": return `${Math.round(value)} ohm`;
    default: return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

export default async function NodeDetail({ params }: { params: Promise<{ id: string }> }) {
  const __denied = await moduleDenied("nodes"); if (__denied) return __denied;
  const { id } = await params;
  const nodeId = Number(id);

  let node, bio, metrics, bestGw, fpRows, battery, neighbors, ports, recentMsgs, heatmap, signal, track, reliability, farthest, hopProfile, uptimeS, channels, latestMetrics;
  try {
    [node, bio, metrics, bestGw, fpRows, battery, neighbors, ports, recentMsgs, heatmap, signal, track, reliability, farthest, hopProfile, uptimeS, channels, latestMetrics] = await Promise.all([
      getNode(nodeId),
      getNodeBiography(nodeId),
      nodeTelemetryMetrics(nodeId),
      bestGatewaysForNode(nodeId),
      getNodeFingerprint(nodeId, 28),
      getBatteryForecast(nodeId),
      getNodeNeighbors(nodeId),
      nodePortBreakdown(nodeId),
      nodeRecentMessages(nodeId, 10),
      nodeActivityHeatmap(nodeId),
      nodeSignalTrend(nodeId),
      nodePositionTrack(nodeId),
      nodeReliability(nodeId),
      nodeFarthestGateway(nodeId),
      nodeHopProfile(nodeId),
      nodeLatestMetric(nodeId, "uptime"),
      nodeChannels(nodeId),
      nodeLatestMetrics(nodeId),
    ]);
  } catch (e) {
    return <DbError error={e} />;
  }
  const chattiness = node ? await nodeChattinessPercentile(node.total_packet_count) : null;
  const adverts = await nodeAdvertisements(nodeId, 7);
  const fingerprint = buildFingerprint(fpRows);
  if (!node) {
    return <div className="card text-ink-mute">Unknown node {formatNodeId(nodeId)}.</div>;
  }

  const access = await pageAccess();
  const isAdmin = access.admin;

  // Position privacy, applied HERE so every derived value below (the coordinate readout, the
  // mini-map, the movement track, the claim button) inherits it. This page rendered exact
  // toFixed(4) coordinates and an exact polyline regardless of server.privacy.fuzz_positions, and
  // ignored the operator's per-node position_ignored suppression, while /map honoured both.
  let posFuzz: number | null = null;
  try { posFuzz = fuzzDecimalsFor(await effectiveConfig(), isAdmin); } catch { /* exact if config unreadable */ }
  const posSuppressed = !isAdmin && !!node.position_ignored;
  node = fuzzNodeCoords(posSuppressed ? stripNodePosition(node) : node, posFuzz);
  const posTrack = posSuppressed ? [] : fuzzPositions(track, posFuzz);

  // TX actions (DM/traceroute/requests) are offered only when TX is enabled AND the viewer's
  // role can transmit (Rule 2: anonymous read-only can never send). The API enforces this
  // server-side regardless.
  let txEnabled = false, txDryRun = true, keyedChannels: string[] = [], tempUnit: TempUnit = "f";
  try {
    const cfg = await effectiveConfig();
    txEnabled = cfg.tx.enabled && access.canTx;
    txDryRun = cfg.tx.dry_run;
    tempUnit = cfg.server.ui.temperature_unit;
    if (txEnabled) keyedChannels = (await getChannelKeys()).map((k) => k.name);
  } catch { /* tx panel simply hidden if config unavailable */ }

  const zone = await tz();
  const nodeName = node.long_name ?? node.short_name ?? formatNodeId(nodeId);

  // Position for the mini-map: real GPS if present, otherwise the estimate (dashed + circle).
  const mapPos =
    node.position_source === "gps" && node.latitude != null && node.longitude != null
      ? { lat: node.latitude, lon: node.longitude, source: "gps" as const, radius: null }
      : node.position_source === "estimated" && node.est_latitude != null && node.est_longitude != null
        ? { lat: node.est_latitude, lon: node.est_longitude, source: "estimated" as const, radius: node.confidence_radius_m }
        : null;

  // A couple of derived "fun" stats from data we already have.
  const ageDays = node.first_seen_at ? Math.max(0, (Date.now() - new Date(node.first_seen_at.replace(" ", "T") + "Z").getTime()) / 86400000) : null;
  const pktsPerDay = ageDays && ageDays >= 1 ? Math.round(node.total_packet_count / ageDays) : null;
  const portMax = Math.max(1, ...ports.map((p) => Number(p.c)));

  // Activity heatmap grid: 7 rows (Sun..Sat) x 24 hours.
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const cell of heatmap) heat[Number(cell.dow) - 1]![Number(cell.hour)] = Number(cell.c);
  const heatMax = Math.max(1, ...heat.flat());

  // Signal trend series (best RSSI per hour) for the chart.
  const signalSeries: Series | null = signal.length
    ? { label: "best RSSI (dBm)", color: "#5bb37e", points: signal.filter((s) => s.rssi != null).map((s) => ({ t: s.t, v: Number(s.rssi) })) }
    : null;

  // Mobility: total path length through the position history.
  const trackPts: [number, number][] = posTrack.map((p) => [p.longitude, p.latitude]);
  let movedKm = 0;
  for (let i = 1; i < posTrack.length; i++) {
    movedKm += haversineKm({ lat: posTrack[i - 1]!.latitude, lon: posTrack[i - 1]!.longitude }, { lat: posTrack[i]!.latitude, lon: posTrack[i]!.longitude });
  }
  const mobile = movedKm > 0.2 && posTrack.length > 2;

  const hopMax = Math.max(1, ...hopProfile.map((h) => Number(h.c)));
  const totalHeard = reliability.direct + reliability.relayed;
  const directPct = totalHeard > 0 ? Math.round((reliability.direct / totalHeard) * 100) : null;
  const uptimeStr = uptimeS != null ? humanUptime(uptimeS) : null;

  const chartMetrics = metrics.filter((m) => KEY_METRICS.includes(m)).slice(0, 6);
  const seriesList: Series[] = await Promise.all(
    chartMetrics.map(async (m) => {
      const points = await getNodeTelemetry(nodeId, m, 168);
      const isTemp = m === "temperature";
      return {
        label: isTemp ? `temperature (${tempUnitLabel(tempUnit)})` : m,
        color: METRIC_COLORS[m] ?? "#3f9e63",
        points: isTemp ? points.map((p) => ({ ...p, v: convertTemp(p.v, tempUnit) })) : points,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-ink">
            {node.long_name ?? node.short_name ?? formatNodeId(nodeId)}
            {(() => {
              // Silence badge: how long since this node was last heard. Amber past ~1h, red past
              // ~24h, so an operator sees a stale/offline node at a glance (audit: node-down).
              if (!node.last_seen_at) return null;
              const min = (Date.now() - new Date(node.last_seen_at.replace(" ", "T") + "Z").getTime()) / 60000;
              if (min < 60) return null;
              const offline = min >= 1440;
              return (
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", offline ? "bg-accent-strong/15 text-accent-strong" : "bg-[#e0b43a]/15 text-[#e0b43a]")}>
                  {offline ? "offline" : "silent"} {fmtAge(node.last_seen_at)}
                </span>
              );
            })()}
          </h1>
          <p className="mono mt-1 text-[13px] text-ink-mute">
            {formatNodeId(nodeId)}
            {node.role ? <span className={cn("ml-2", roleColor(node.role))}>{node.role}</span> : null}
            {node.hw_model ? <span className="ml-2 text-ink-faint">{node.hw_model}</span> : null}
          </p>
        </div>
        <a className="btn btn-outline h-8 px-3 text-[13px]" href={`/packets?from=${formatNodeId(nodeId)}`}>
          View packets
        </a>
      </div>

      <NodeTabs nodeId={nodeId} active="overview" />

      <ClaimNodeButton numId={nodeId} name={nodeName} lat={node.latitude ?? null} lng={node.longitude ?? null} role={node.role ?? null} />
      <NodeWatchControls nodeId={nodeId} />
      {isAdmin && <NodeAdminControls nodeId={nodeId} muted={!!node.mute_hidden} positionIgnored={!!node.position_ignored} rfHeightM={node.rf_height_m} rfEirpDbm={node.rf_eirp_dbm} />}
      {txEnabled && keyedChannels.length > 0 && <NodeTxActions nodeId={nodeId} channels={keyedChannels} dryRun={txDryRun} />}

      <div className="card">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="eyebrow"><span className="eyebrow-bar" />Identity</h2>
          {/* Honesty marker (audit): names/position/hardware are what the node broadcasts about
              itself over an open, spoofable network, not anything HopWatch has verified. */}
          <span className="rounded bg-raised px-2 py-0.5 text-[11px] text-ink-faint" title="These fields are broadcast by the node itself over an open network and are not independently verified.">
            self-reported
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3 lg:grid-cols-4">
          {[
            ["Long name", node.long_name ?? "-"],
            ["Short name", node.short_name ?? "-"],
            ["Node ID", `${formatNodeId(nodeId)} (${nodeId})`],
            ["Role", node.role ?? "-"],
            ["Hardware", node.hw_model ?? "-"],
            ["Firmware", node.firmware_version ?? "-"],
            ["Licensed", node.is_licensed == null ? "unknown" : node.is_licensed ? "yes" : "no"],
            ["First heard", node.first_seen_at ? fmtLocal(node.first_seen_at, zone) : "-"],
            ["Last heard", node.last_seen_at ? fmtLocal(node.last_seen_at, zone) : "-"],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="stat-label">{k}</dt>
              <dd className="mt-0.5 text-ink">{v}</dd>
            </div>
          ))}
          <div className="col-span-2 sm:col-span-3 lg:col-span-4">
            <dt className="stat-label">Public key</dt>
            <dd className="mt-0.5 mono break-all text-[11px] text-ink-mute" title={node.public_key_hex ?? undefined}>{node.public_key_hex ?? "-"}</dd>
          </div>
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="card">
          <div className="stat-label">First heard</div>
          <div className="mt-1 text-[13px] text-ink">{fmtLocal(node.first_seen_at, zone)}</div>
        </div>
        <div className="card">
          <div className="stat-label">Last heard</div>
          <div className="mt-1 text-[13px] text-ink">{fmtAge(node.last_seen_at)} ago</div>
        </div>
        <div className="card">
          <div className="stat-label">Packets / receptions</div>
          <div className="stat mt-1 text-base">
            {fmtNum(node.total_packet_count)} / {fmtNum(node.total_reception_count)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Position</div>
          <div className="mt-1 text-[13px] text-ink">
            {node.latitude !== null && node.longitude !== null
              ? `${node.latitude.toFixed(4)}, ${node.longitude.toFixed(4)}`
              : "unknown"}
          </div>
          {node.altitude_m != null && (
            <div className="mt-0.5 text-[11px] text-ink-faint">altitude {Math.round(node.altitude_m)} m</div>
          )}
          {node.latitude != null && node.precision_bits != null && node.precision_bits < 32 && (
            <div className="mt-0.5 text-[11px] text-ink-faint">
              precision ~{fmtPrecision(node.precision_bits)} ({node.precision_bits} bits)
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {mapPos && (
          <div className="card">
            <h2 className="eyebrow mb-2">
              <span className="eyebrow-bar" />
              Location
              {mapPos.source === "estimated" && <span className="ml-1 text-[11px] font-normal text-accent-strong">estimated (non-GPS)</span>}
              {mobile && <span className="ml-1 text-[11px] font-normal text-ink-faint">mobile: moved ~{movedKm.toFixed(1)} km</span>}
            </h2>
            <NodeMiniMap lat={mapPos.lat} lon={mapPos.lon} name={nodeName} role={node.role} isGateway={!!node.is_gateway} source={mapPos.source} confidenceRadiusM={mapPos.radius} tile={await mapTiles()} track={mobile ? trackPts : undefined} />
          </div>
        )}
        <div className="card">
          <h2 className="eyebrow mb-2"><span className="eyebrow-bar" />Nearby (direct links)</h2>
          <NodeEgoGraph nodeId={nodeId} />
        </div>
        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />What it transmits (14d)</h2>
          {ports.length === 0 ? (
            <p className="text-[13px] text-ink-faint">No packets in the window.</p>
          ) : (
            <div className="space-y-1.5">
              {ports.slice(0, 8).map((p) => (
                <div key={String(p.port_num)} className="flex items-center gap-2 text-[13px]">
                  <span className="w-40 truncate text-ink-mute">{portName(p.port_num)}</span>
                  <div className="h-3 flex-1 rounded bg-raised">
                    <div className="h-3 rounded bg-rx-direct" style={{ width: `${Math.round((Number(p.c) / portMax) * 100)}%` }} />
                  </div>
                  <span className="w-14 text-right tabular-nums text-ink-faint">{fmtNum(Number(p.c))}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-ink-faint">
            {ageDays != null && <span>On network {ageDays < 1 ? "<1" : Math.round(ageDays)} day{Math.round(ageDays) === 1 ? "" : "s"}</span>}
            {pktsPerDay != null && <span>~{fmtNum(pktsPerDay)} packets/day</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Activity (day x hour, {zone})</h2>
          <div className="space-y-0.5">
            {heat.map((rowVals, d) => (
              <div key={d} className="flex items-center gap-1">
                <span className="w-8 text-[10px] text-ink-faint">{DOW[d]}</span>
                <div className="flex flex-1 gap-0.5">
                  {rowVals.map((c, h) => (
                    <div key={h} className="h-3 flex-1 rounded-sm" title={`${DOW[d]} ${h}:00  ${c}`}
                      style={{ background: c === 0 ? "rgba(255,255,255,0.05)" : `rgba(74,222,128,${0.15 + 0.85 * (c / heatMax)})` }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between pl-9 text-[10px] text-ink-faint"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
        </div>
        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Recent messages</h2>
          {recentMsgs.length === 0 ? (
            <p className="text-[13px] text-ink-faint">This node has not sent observed text.</p>
          ) : (
            <ol className="space-y-1.5 text-[13px]">
              {recentMsgs.map((m, i) => (
                <li key={i} className="flex gap-2">
                  <span className="whitespace-nowrap text-ink-faint">{fmtAge(m.observed_at)}</span>
                  {m.channel_id && <span className="text-ink-faint">[{m.channel_id}]</span>}
                  <span className="text-ink">{m.body}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Reliability &amp; reach</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div><div className="stat-label">Heard direct</div><div className="stat mt-1 text-base">{directPct != null ? `${directPct}%` : "-"}</div></div>
            <div><div className="stat-label">Gateways</div><div className="stat mt-1 text-base">{reliability.gateways}</div></div>
            <div><div className="stat-label">Brokers</div><div className="stat mt-1 text-base">{reliability.brokers}</div></div>
            <div><div className="stat-label">Farthest direct</div><div className="stat mt-1 text-base">{farthest ? `${farthest.distance_km.toFixed(1)} km` : "-"}</div></div>
            <div><div className="stat-label">Uptime</div><div className="stat mt-1 text-base">{uptimeStr ?? "-"}</div></div>
            <div><div className="stat-label">Chattiness</div><div className="stat mt-1 text-base">{chattiness != null ? `${chattiness}%ile` : "-"}</div></div>
            <div><div className="stat-label">Advertisements (7d)</div><div className="stat mt-1 text-base">{fmtNum(adverts)}</div></div>
          </div>
          {hopProfile.length > 0 && (
            <div className="mt-4">
              <div className="stat-label mb-1">Hop distribution</div>
              <div className="space-y-1">
                {hopProfile.map((h) => (
                  <div key={h.hops} className="flex items-center gap-2 text-[12px]">
                    <span className="w-14 text-ink-mute">{Number(h.hops) === 0 ? "direct" : `${h.hops} hop`}</span>
                    <div className="h-3 flex-1 rounded bg-raised"><div className="h-3 rounded bg-rx-direct" style={{ width: `${Math.round((Number(h.c) / hopMax) * 100)}%` }} /></div>
                    <span className="w-14 text-right tabular-nums text-ink-faint">{fmtNum(Number(h.c))}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {channels.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="stat-label">Channels</span>
              {channels.map((c) => <span key={c} className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-mute">{c}</span>)}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />RF neighbor graph</h2>
          <NeighborGraph neighbors={neighbors} />
          <p className="mt-1 text-[11px] text-ink-faint"><span className="text-rx-direct">green</span> = this node hears them; <span className="text-rx-relayed">amber</span> = they hear this node.</p>
        </div>
      </div>

      {signalSeries && signalSeries.points.length > 1 && (
        <div className="card">
          <h2 className="eyebrow mb-2"><span className="eyebrow-bar" />Signal trend (best RSSI, 7d)</h2>
          <TelemetryChart series={signalSeries} />
        </div>
      )}

      {battery && (
        <div className="card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="eyebrow">
              <span className="eyebrow-bar" />
              Battery forecast
            </h2>
            <span className="pill pill-off">{battery.power_profile}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-[13px]">
            <span className="text-ink-mute">
              Current: <span className="text-ink">{battery.current_voltage?.toFixed(2) ?? "-"} V</span>
            </span>
            <span className="text-ink-mute">
              Trend: <span className="text-ink">{battery.slope_v_per_day != null ? `${battery.slope_v_per_day.toFixed(3)} V/day` : "-"}</span>
            </span>
            <span className="text-ink-mute">
              Projected dark:{" "}
              <span className={battery.projected_dead_at ? "text-accent-strong" : "text-ok"}>
                {battery.projected_dead_at ? fmtLocal(battery.projected_dead_at, zone) : "not declining"}
              </span>
            </span>
            <span className="text-ink-faint">fit R2 {battery.confidence != null ? battery.confidence.toFixed(2) : "-"}</span>
          </div>
        </div>
      )}

      {latestMetrics.length > 0 && (
        <div className="card">
          <h2 className="eyebrow mb-3">
            <span className="eyebrow-bar" />
            Telemetry (latest)
          </h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {latestMetrics.map((m) => (
              <div key={m.metric}>
                <div className="stat-label">{m.metric.replace(/_/g, " ")}</div>
                <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">{fmtMetricValue(m.metric, Number(m.value), tempUnit)}</div>
                <div className="text-[10px] text-ink-faint">{fmtAge(m.observed_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {seriesList.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {seriesList.map((s) => (
            <div key={s.label} className="card">
              <h2 className="eyebrow mb-2">
                <span className="eyebrow-bar" />
                {s.label}
              </h2>
              <TelemetryChart series={s} />
            </div>
          ))}
        </div>
      )}

      {/* Anything else this node reports. The six charts above are a fixed headline set; every other
          metric was stored with full history and never plotted anywhere. */}
      <MetricExplorer nodeId={nodeId} metrics={metrics} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="eyebrow mb-3">
            <span className="eyebrow-bar" />
            Biography
          </h2>
          {node.spoof_flag_count > 0 && (
            <div className="mb-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-accent-strong">
              {node.spoof_flag_count} spoof flag(s) raised on this node.
            </div>
          )}
          <ol className="space-y-2 text-[13px]">
            {bio.flags.map((f, i) => (
              <li key={`f${i}`} className="flex gap-2">
                <span className="text-ink-faint">{fmtLocal(f.created_at, zone)}</span>
                <span className="text-accent-strong">{f.flag_type}</span>
                <span className="text-ink-mute">{f.message}</span>
              </li>
            ))}
            {bio.identity.map((e, i) => (
              <li key={`i${i}`} className="flex gap-2">
                <span className="text-ink-faint">{fmtLocal(e.observed_at, zone)}</span>
                <span className="text-ink">{e.event_type}</span>
                <span className="text-ink-mute">
                  {e.old_value ? `${e.old_value} -> ` : ""}
                  {e.new_value ?? ""}
                </span>
              </li>
            ))}
            {bio.identity.length === 0 && bio.flags.length === 0 && (
              <li className="text-ink-faint">No identity changes or flags recorded.</li>
            )}
          </ol>
          {bio.positions.length > 0 && (
            <p className="mt-3 text-[11px] text-ink-faint">
              {bio.positions.length} position report(s); latest {fmtLocal(bio.positions[0]!.observed_at, zone)}.
            </p>
          )}
        </div>

        <div className="card">
          <h2 className="eyebrow mb-3">
            <span className="eyebrow-bar" />
            Heard by gateways
          </h2>
          <table className="data">
            <thead>
              <tr>
                <th>Gateway</th>
                <th>Status</th>
                <th>Last direct</th>
                <th>Last relayed</th>
              </tr>
            </thead>
            <tbody>
              {bio.gatewaysHeardBy.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-ink-faint">
                    Not yet heard by any gateway.
                  </td>
                </tr>
              )}
              {bio.gatewaysHeardBy.map((g) => (
                <tr key={g.gateway_id}>
                  <td>
                    <Link className="mono text-accent-strong" href={`/gateways/${g.gateway_id}`}>
                      {formatNodeId(g.gateway_id)}
                    </Link>
                  </td>
                  <td className={g.status === "direct" ? "text-rx-direct" : g.status === "relayed" ? "text-rx-relayed" : "text-ink-faint"}>
                    {g.status}
                  </td>
                  <td className="text-ink-mute">{g.last_direct_at ? fmtAge(g.last_direct_at) : "-"}</td>
                  <td className="text-ink-mute">{g.last_relayed_at ? fmtAge(g.last_relayed_at) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3">
          <span className="eyebrow-bar" />
          Best gateways (advisor)
        </h2>
        <p className="mb-3 text-[11px] text-ink-faint">
          Ranked by reception quality and consistency. Use this to spot redundant coverage and gaps.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>Gateway</th>
              <th>Status</th>
              <th className="text-right">Direct</th>
              <th className="text-right">Relayed</th>
              <th className="text-right">Avg RSSI</th>
              <th className="text-right">Avg SNR</th>
            </tr>
          </thead>
          <tbody>
            {bestGw.length === 0 && (
              <tr>
                <td colSpan={6} className="text-ink-faint">
                  No gateway has heard this node yet.
                </td>
              </tr>
            )}
            {bestGw.map((g) => (
              <tr key={g.gateway_id}>
                <td>
                  <Link className="mono text-accent-strong" href={`/gateways/${g.gateway_id}`}>
                    {formatNodeId(g.gateway_id)}
                  </Link>
                </td>
                <td className={g.status === "direct" ? "text-rx-direct" : g.status === "relayed" ? "text-rx-relayed" : "text-ink-faint"}>
                  {g.status}
                </td>
                <td className="text-right tabular-nums">{fmtNum(g.direct_count)}</td>
                <td className="text-right tabular-nums">{fmtNum(g.relayed_count)}</td>
                <td className="text-right tabular-nums">{g.avg_rssi === null ? "-" : Math.round(g.avg_rssi)}</td>
                <td className="text-right tabular-nums">{g.avg_snr === null ? "-" : Number(g.avg_snr).toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {neighbors.length > 0 && (
        <div className="card overflow-x-auto">
          <h2 className="eyebrow mb-3">
            <span className="eyebrow-bar" />
            RF neighbors (NeighborInfo)
          </h2>
          <table className="data">
            <thead>
              <tr>
                <th>Neighbor</th>
                <th>Direction</th>
                <th className="text-right">SNR</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {neighbors.map((nb, i) => (
                <tr key={i}>
                  <td>
                    <Link className="mono text-accent-strong" href={`/nodes/${nb.other}`}>
                      {nb.name ?? formatNodeId(nb.other)}
                    </Link>
                  </td>
                  <td className="text-ink-mute">{nb.direction === "reports" ? "hears" : "heard by"}</td>
                  <td className="text-right tabular-nums">{nb.snr === null ? "-" : `${Number(nb.snr).toFixed(1)} dB`}</td>
                  <td className="text-ink-faint">{fmtLocal(nb.updated_at, zone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2 className="eyebrow mb-3">
          <span className="eyebrow-bar" />
          Traffic fingerprint
        </h2>
        <FingerprintGrid fp={fingerprint} />
      </div>
    </div>
  );
}
