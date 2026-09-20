"use client";

import { useEffect, useState } from "react";
import { TelemetryChart, type Series } from "./TelemetryChart.tsx";

// Chart ANY metric a node has reported.
//
// The node page renders a fixed list of six, so everything else a node stores was invisible in the
// UI while being collected with full history: pressure, co2, the particulate counts, iaq, lux, the
// wind and rainfall series, soil moisture and temperature, radiation, weight, gas resistance, the
// per-channel voltages and currents, every health_ metric, and now the ls_ / host_ / tms_ and
// env_voltage / env_current series too. None of the plumbing was missing: getNodeTelemetry takes any
// metric name with downsampling, nodeTelemetryMetrics lists what a node actually has, and
// /api/v1/nodes/:id/telemetry serves any series. Only the page refused to draw them.

/** Stable colour for an arbitrary metric name, so a series keeps its colour between renders. */
const PALETTE = ["#3f9e63", "#e0b43a", "#5bb37e", "#a4a39c", "#7aa7d8", "#c98a5b", "#b07ec0", "#d92b2b"];
function colorFor(metric: string): string {
  let h = 0;
  for (let i = 0; i < metric.length; i++) h = (h * 31 + metric.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

const HOURS = [
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
];

export function MetricExplorer({ nodeId, metrics }: { nodeId: number; metrics: string[] }) {
  const [metric, setMetric] = useState<string>(metrics[0] ?? "");
  const [hours, setHours] = useState(168);
  const [series, setSeries] = useState<Series | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!metric) return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/nodes/${nodeId}/telemetry?metric=${encodeURIComponent(metric)}&hours=${hours}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) setSeries({ label: metric, color: colorFor(metric), points: d.points ?? [] }); })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [nodeId, metric, hours]);

  if (metrics.length === 0) return null;

  return (
    <div className="card">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Explore metrics</h2>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-line bg-raised px-2 text-[12px] text-ink focus:border-accent focus:outline-none"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
          >
            {metrics.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <div className="flex gap-1">
            {HOURS.map((h) => (
              <button
                key={h.value}
                className={`h-8 rounded-md border px-2 text-[12px] ${hours === h.value ? "border-accent text-ink" : "border-line text-ink-mute"}`}
                onClick={() => setHours(h.value)}
              >
                {h.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="mb-2 text-[11px] text-ink-faint">
        Every metric this node has reported ({metrics.length}), not just the headline set above.
      </p>
      {error && <p className="text-[12px] text-accent-strong">{error}</p>}
      {loading && !series && <p className="text-[13px] text-ink-faint">Loading...</p>}
      {series && (series.points.length > 0
        ? <TelemetryChart series={series} />
        : <p className="text-[13px] text-ink-faint">No {metric} readings in this window.</p>)}
    </div>
  );
}
