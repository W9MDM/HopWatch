"use client";

import { useState } from "react";

export interface RfSettings {
  link_budget: { enabled: boolean; max_distance_km: number; terrain: boolean; antenna_height_m: number; elevation_url: string };
  propagation: { enabled: boolean; baseline_window_hours: number; improvement_threshold_db: number; dx_distance_threshold_km: number };
  weather: { enabled: boolean; stations: string[] };
  space_weather: { enabled: boolean; refresh_interval_minutes: number; kp_url: string; flux_url: string; solar_wind_url: string };
}
export interface CoverageModel {
  default_eirp_dbm: number; default_height_m: number; rx_height_m: number;
  rx_sensitivity_dbm: number; path_loss_exponent: number; reference_loss_db_1km: number; max_radius_km: number;
}

const inputCls = "h-9 w-40 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export function RfManager({ initial, coverage }: { initial: RfSettings; coverage: CoverageModel }) {
  const [s, setS] = useState<RfSettings>(initial);
  const [cov, setCov] = useState<CoverageModel>(coverage);
  const [stations, setStations] = useState(initial.weather.stations.join(", "));
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lb = <K extends keyof RfSettings["link_budget"]>(k: K, v: RfSettings["link_budget"][K]) => setS({ ...s, link_budget: { ...s.link_budget, [k]: v } });
  const cm = (k: keyof CoverageModel, v: number) => setCov({ ...cov, [k]: v });

  async function save() {
    setMsg(null); setError(null);
    const body = { ...s, weather: { ...s.weather, stations: stations.split(",").map((x) => x.trim()).filter(Boolean) }, coverage: cov };
    const r = await fetch("/api/v1/admin/rf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) setMsg("Saved. Propagation refreshes on the worker's 5-min cycle; link budget and weather on the 30-min cycle. Coverage rings apply immediately.");
    else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  return (
    <section className="card space-y-4">
      <h2 className="eyebrow"><span className="eyebrow-bar" />RF &amp; propagation</h2>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.link_budget.enabled} onChange={(e) => lb("enabled", e.target.checked)} /> Link budget (FSPL, Fresnel, RSSI deficit)</label>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Max distance (km)</span><input type="number" value={String(s.link_budget.max_distance_km)} onChange={(e) => lb("max_distance_km", Number(e.target.value))} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Antenna height (m)</span><input type="number" value={String(s.link_budget.antenna_height_m)} onChange={(e) => lb("antenna_height_m", Number(e.target.value))} className={inputCls} /></label>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.link_budget.terrain} onChange={(e) => lb("terrain", e.target.checked)} /> Terrain clearance (elevation API)</label>
        </div>
        {s.link_budget.terrain && (
          <label className="space-y-1"><span className="block stat-label">Elevation API URL</span><input value={s.link_budget.elevation_url} onChange={(e) => lb("elevation_url", e.target.value)} className={`${inputCls} w-full max-w-xl`} /></label>
        )}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.propagation.enabled} onChange={(e) => setS({ ...s, propagation: { ...s.propagation, enabled: e.target.checked } })} /> Propagation detection (tropo / lift events)</label>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Baseline window (hours)</span><input type="number" value={String(s.propagation.baseline_window_hours)} onChange={(e) => setS({ ...s, propagation: { ...s.propagation, baseline_window_hours: Number(e.target.value) } })} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Enhancement threshold (dB)</span><input type="number" value={String(s.propagation.improvement_threshold_db)} onChange={(e) => setS({ ...s, propagation: { ...s.propagation, improvement_threshold_db: Number(e.target.value) } })} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">DX distance (km)</span><input type="number" value={String(s.propagation.dx_distance_threshold_km)} onChange={(e) => setS({ ...s, propagation: { ...s.propagation, dx_distance_threshold_km: Number(e.target.value) } })} className={inputCls} /></label>
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.weather.enabled} onChange={(e) => setS({ ...s, weather: { ...s.weather, enabled: e.target.checked } })} /> Weather ingest (NWS stations)</label>
        <label className="space-y-1"><span className="block stat-label">Station IDs (comma separated)</span><input value={stations} onChange={(e) => setStations(e.target.value)} placeholder="KSBN, KGYY" className={`${inputCls} w-full max-w-xl`} /></label>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.space_weather.enabled} onChange={(e) => setS({ ...s, space_weather: { ...s.space_weather, enabled: e.target.checked } })} /> Space weather (NOAA SWPC: Kp, solar flux, solar wind)</label>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Refresh interval (min)</span><input type="number" value={String(s.space_weather.refresh_interval_minutes)} onChange={(e) => setS({ ...s, space_weather: { ...s.space_weather, refresh_interval_minutes: Number(e.target.value) } })} className={inputCls} /></label>
        </div>
        {s.space_weather.enabled && (
          <div className="space-y-2">
            <label className="space-y-1"><span className="block stat-label">Planetary Kp URL</span><input value={s.space_weather.kp_url} onChange={(e) => setS({ ...s, space_weather: { ...s.space_weather, kp_url: e.target.value } })} className={`${inputCls} w-full max-w-xl`} /></label>
            <label className="space-y-1"><span className="block stat-label">10.7cm flux URL</span><input value={s.space_weather.flux_url} onChange={(e) => setS({ ...s, space_weather: { ...s.space_weather, flux_url: e.target.value } })} className={`${inputCls} w-full max-w-xl`} /></label>
            <label className="space-y-1"><span className="block stat-label">Solar wind URL</span><input value={s.space_weather.solar_wind_url} onChange={(e) => setS({ ...s, space_weather: { ...s.space_weather, solar_wind_url: e.target.value } })} className={`${inputCls} w-full max-w-xl`} /></label>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Predicted coverage model (per-node height/EIRP overrides live on each node page)</div>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Default EIRP (dBm)</span><input type="number" value={String(cov.default_eirp_dbm)} onChange={(e) => cm("default_eirp_dbm", Number(e.target.value))} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Default height (m)</span><input type="number" value={String(cov.default_height_m)} onChange={(e) => cm("default_height_m", Number(e.target.value))} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">RX height (m)</span><input type="number" value={String(cov.rx_height_m)} onChange={(e) => cm("rx_height_m", Number(e.target.value))} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">RX sensitivity (dBm)</span><input type="number" value={String(cov.rx_sensitivity_dbm)} onChange={(e) => cm("rx_sensitivity_dbm", Number(e.target.value))} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Path-loss exponent</span><input type="number" step="0.1" value={String(cov.path_loss_exponent)} onChange={(e) => cm("path_loss_exponent", Number(e.target.value))} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Ref loss @1km (dB)</span><input type="number" value={String(cov.reference_loss_db_1km)} onChange={(e) => cm("reference_loss_db_1km", Number(e.target.value))} className={inputCls} /></label>
          <label className="space-y-1"><span className="block stat-label">Max radius (km)</span><input type="number" value={String(cov.max_radius_km)} onChange={(e) => cm("max_radius_km", Number(e.target.value))} className={inputCls} /></label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save RF settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>
    </section>
  );
}
