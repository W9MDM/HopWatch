import { getDistributions, meshActivityClock } from "../../db/queries.ts";
import { portName } from "../../meshtastic/portnum.ts";
import { fmtNum } from "../../lib/format.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { DbError } from "../DbError.tsx";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Current UTC offset (whole hours) for an IANA zone, to render the UTC-bucketed clock in the
// operator's local time (Rule 10). Present-offset approximation for an hour-of-day aggregate.
function tzOffsetHours(zone: string): number {
  try {
    const now = new Date();
    const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    const loc = new Date(now.toLocaleString("en-US", { timeZone: zone })).getTime();
    return Math.round((loc - utc) / 3_600_000);
  } catch { return 0; }
}

function ActivityClock({ cells, zone }: { cells: { dow: number; hour: number; c: number }[]; zone: string }) {
  const off = tzOffsetHours(zone);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 1;
  for (const c of cells) {
    if (c.dow < 0 || c.dow >= 7 || c.hour < 0 || c.hour >= 24) continue;
    const lh = ((c.hour + off) % 24 + 24) % 24;
    const ld = ((c.dow + Math.floor((c.hour + off) / 24)) % 7 + 7) % 7;
    grid[ld]![lh] += Number(c.c);
    max = Math.max(max, grid[ld]![lh]);
  }
  return (
    <div className="card overflow-x-auto">
      <h2 className="eyebrow mb-1"><span className="eyebrow-bar" />Mesh activity clock</h2>
      <p className="mb-3 text-[11px] text-ink-faint">Receptions by hour of day and day of week ({zone}), last 28 days. Darker = busier.</p>
      <div className="min-w-[560px]">
        <div className="flex pl-9 text-[9px] text-ink-faint">
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="flex-1 text-center">{h % 3 === 0 ? h : ""}</div>)}
        </div>
        {grid.map((row, d) => (
          <div key={d} className="flex items-center">
            <div className="w-9 text-[10px] text-ink-faint">{DOW[d]}</div>
            {row.map((c, h) => (
              <div key={h} className="mx-px my-px h-4 flex-1 rounded-sm" title={`${DOW[d]} ${h}:00 - ${fmtNum(c)}`}
                   style={{ background: c === 0 ? "var(--color-raised, #26262400)" : `rgba(63,158,99,${0.12 + 0.88 * (c / max)})` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Bars({ title, note, rows, color = "bg-rx-direct" }: { title: string; note?: string; rows: { label: string; c: number }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.c));
  return (
    <div className="card">
      <h2 className="eyebrow mb-1"><span className="eyebrow-bar" />{title}</h2>
      {note && <p className="mb-2 text-[11px] text-ink-faint">{note}</p>}
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2 text-[13px]">
            <span className="w-44 truncate text-ink-mute" title={r.label}>{r.label}</span>
            <div className="h-3 flex-1 rounded bg-raised"><div className={`h-3 rounded ${color}`} style={{ width: `${Math.round((r.c / max) * 100)}%` }} /></div>
            <span className="w-16 text-right tabular-nums text-ink-faint">{fmtNum(r.c)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const ACTIVITY = ["1-10", "11-50", "51-200", "201-1000", "1000+"];
const GW_ACTIVITY = ["1-100", "101-1000", "1001-5000", "5001-20000", "20000+"];
const SIGNAL = ["Excellent (>= -80 dBm)", "Good (-80 to -95)", "Fair (-95 to -105)", "Weak (-105 to -115)", "Marginal (< -115)"];
const RC_LABEL: Record<string, string> = {
  rf_direct: "Direct RF", rf_direct_low_conf: "Direct RF (low confidence)", rf_relayed: "Relayed RF",
  mqtt_self: "MQTT (self)", mqtt_injected: "MQTT (injected)", unknown: "Unknown",
};

function byBucket(rows: { bkt: number; c: number }[], labels: string[]): { label: string; c: number }[] {
  return labels.map((label, i) => ({ label, c: rows.find((r) => r.bkt === i)?.c ?? 0 }));
}

// Distributions tab of /analytics (formerly the /distributions page).
export async function DistributionsPanel() {
  let d, clock, zone = "UTC";
  try {
    [d, clock] = await Promise.all([getDistributions(), meshActivityClock(28)]);
    try { zone = (await effectiveConfig()).server.local_timezone; } catch { /* default UTC */ }
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div className="space-y-4">
      <ActivityClock cells={clock} zone={zone} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Bars title="Node activity distribution" note="Nodes bucketed by packets sent (24h)." rows={byBucket(d.nodeActivity, ACTIVITY)} />
        <Bars title="Gateway activity distribution" note="Gateways bucketed by receptions handled (24h)." rows={byBucket(d.gatewayActivity, GW_ACTIVITY)} />
        <Bars title="Signal quality distribution" note="Direct receptions bucketed by RSSI (24h)." rows={byBucket(d.signalQuality, SIGNAL)} />
        <Bars title="Message routing patterns" note="How receptions reached us, by class (24h)." rows={d.routing.map((r) => ({ label: RC_LABEL[r.rc] ?? r.rc, c: r.c }))} color="bg-rx-relayed" />
        <Bars title="Protocol usage (24h)" note="Packets by application port." rows={d.protocol.map((r) => ({ label: portName(r.port_num), c: r.c }))} />
      </div>
    </div>
  );
}
