"use client";

import { useState } from "react";

export interface PositionEstimationSettings {
  enabled: boolean;
  window_days: number;
  recompute_interval_minutes: number;
  path_loss_exponent: number;
  reference_loss_db_1km: number;
  min_receptions_per_pair: number;
  mobile_variance_threshold_db: number;
  use_terrain_refinement: boolean;
  feed_coverage_heatmap: boolean;
}

const inputCls = "h-9 w-28 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

const NUMS: { key: keyof PositionEstimationSettings; label: string; step: string; hint: string }[] = [
  { key: "window_days", label: "Window (days)", step: "1", hint: "zero-hop receptions this recent feed the estimate" },
  { key: "recompute_interval_minutes", label: "Recompute (min)", step: "1", hint: "how often the worker recomputes" },
  { key: "path_loss_exponent", label: "Path-loss exponent", step: "0.1", hint: "log-distance model exponent (LoRa ~2.7)" },
  { key: "reference_loss_db_1km", label: "Ref loss @1km (dB)", step: "1", hint: "expected path loss at 1 km, 915 MHz" },
  { key: "min_receptions_per_pair", label: "Min rx / pair", step: "1", hint: "ignore source-receiver pairs below this" },
  { key: "mobile_variance_threshold_db", label: "Mobile threshold (dB)", step: "1", hint: "per-pair RSSI std-dev above this flags mobile + widens radius" },
];

export function PositionEstimationManager({ initial }: { initial: PositionEstimationSettings }) {
  const [s, setS] = useState<PositionEstimationSettings>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setNum = (k: keyof PositionEstimationSettings, v: string) => setS({ ...s, [k]: Number(v) });
  const setBool = (k: keyof PositionEstimationSettings, v: boolean) => setS({ ...s, [k]: v });

  async function save() {
    setMsg(null);
    setError(null);
    const res = await fetch("/api/v1/admin/position-estimation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(s),
    });
    if (res.ok) setMsg("Saved. Ingest/worker/web pick up the change within about 5 seconds.");
    else setError((await res.json().catch(() => ({}))).error ?? "save failed");
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="eyebrow"><span className="eyebrow-bar" />Position estimation</h2>
        <p className="mt-1 text-[12px] text-ink-faint">
          Estimate locations for nodes that never transmit a position, from zero-hop receptions of
          positioned gateways. This is estimation, not GPS: results are stored separately, labelled
          <span className="mono"> position_source=estimated</span>, and never shadow a real position.
        </p>
      </div>

      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={s.enabled} onChange={(e) => setBool("enabled", e.target.checked)} />
        Enabled
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {NUMS.map((f) => (
          <label key={f.key} className="space-y-1">
            <span className="block stat-label">{f.label}</span>
            <input
              type="number"
              step={f.step}
              value={String(s[f.key] as number)}
              onChange={(e) => setNum(f.key, e.target.value)}
              className={inputCls}
            />
            <span className="block text-[11px] text-ink-faint">{f.hint}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.use_terrain_refinement} onChange={(e) => setBool("use_terrain_refinement", e.target.checked)} />
          Terrain refinement
        </label>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.feed_coverage_heatmap} onChange={(e) => setBool("feed_coverage_heatmap", e.target.checked)} />
          Feed coverage heatmap (compounds error; off by default)
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>
    </section>
  );
}
