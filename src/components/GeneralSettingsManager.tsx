"use client";

import { useState } from "react";
import { MapCenterPicker } from "./MapCenterPicker.tsx";

export interface GeneralSettings {
  display: { brand_name: string; brand_icon: string; local_timezone: string; public_url: string; temperature_unit: "c" | "f"; tile: { name: string; url_template: string; attribution: string; api_key: string }; tile_dark: { url_template: string; attribution: string } };
  analytics: { enabled: boolean; measurement_id: string; client: boolean; server: boolean; has_api_secret: boolean; api_secret?: string };
  map_max_age: { map: number; livemap: number };
  map_center: { lat: number | null; lon: number | null; zoom: number };
  social_links: { facebook: string; discord: string; website: string };
  privacy: { metrics_public: boolean; fuzz_positions: boolean; fuzz_decimals: number };
  retention: { raw_payload_days: number; decoded_packet_days: number; telemetry_days: number; reception_rollup_hour_days: number; live_events_minutes: number };
  features: { live_views: boolean; aprs_is_export: boolean; reference_sheet_pdf: boolean; ambience_mode: boolean };
  livemap: { enabled: boolean; inference_window_hours: number; gateway_rings_default: boolean; audio_default: boolean; max_animations_per_sec: number; trail_decay_seconds: number };
}

const inp = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";
// Minutes must match the map's AGE_STEPS; 0 = All (no filter).
const MAX_AGE_OPTS = [
  { label: "All", min: 0 }, { label: "5m", min: 5 }, { label: "1h", min: 60 },
  { label: "6h", min: 360 }, { label: "1d", min: 1440 }, { label: "7d", min: 10080 },
];

export function GeneralSettingsManager({ initial }: { initial: GeneralSettings }) {
  const [s, setS] = useState<GeneralSettings>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disp = <K extends keyof GeneralSettings["display"]>(k: K, v: GeneralSettings["display"][K]) => setS({ ...s, display: { ...s.display, [k]: v } });
  const tile = (k: keyof GeneralSettings["display"]["tile"], v: string) => setS({ ...s, display: { ...s.display, tile: { ...s.display.tile, [k]: v } } });
  const tileDark = (k: keyof GeneralSettings["display"]["tile_dark"], v: string) => setS({ ...s, display: { ...s.display, tile_dark: { ...s.display.tile_dark, [k]: v } } });
  const ret = (k: keyof GeneralSettings["retention"], v: number) => setS({ ...s, retention: { ...s.retention, [k]: v } });
  const feat = (k: keyof GeneralSettings["features"], v: boolean) => setS({ ...s, features: { ...s.features, [k]: v } });
  const lm = <K extends keyof GeneralSettings["livemap"]>(k: K, v: GeneralSettings["livemap"][K]) => setS({ ...s, livemap: { ...s.livemap, [k]: v } });
  const an = <K extends keyof GeneralSettings["analytics"]>(k: K, v: GeneralSettings["analytics"][K]) => setS({ ...s, analytics: { ...s.analytics, [k]: v } });
  const mma = (k: keyof GeneralSettings["map_max_age"], v: number) => setS({ ...s, map_max_age: { ...s.map_max_age, [k]: v } });
  const mc = (patch: Partial<GeneralSettings["map_center"]>) => setS({ ...s, map_center: { ...s.map_center, ...patch } });
  const soc = (k: keyof GeneralSettings["social_links"], v: string) => setS({ ...s, social_links: { ...s.social_links, [k]: v } });
  const priv = <K extends keyof GeneralSettings["privacy"]>(k: K, v: GeneralSettings["privacy"][K]) => setS({ ...s, privacy: { ...s.privacy, [k]: v } });

  function onIcon(file?: File) {
    setError(null);
    if (!file) return;
    if (file.size > 150_000) { setError("icon too large (max ~150KB); use a small PNG/SVG"); return; }
    const reader = new FileReader();
    reader.onload = () => disp("brand_icon", String(reader.result));
    reader.onerror = () => setError("could not read that file");
    reader.readAsDataURL(file);
  }

  async function save() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/admin/general", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
    if (r.ok) setMsg("Saved. Applies immediately (reload the page to see display changes).");
    else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  const numField = (label: string, val: number, on: (v: number) => void, width = "w-28") => (
    <label className="space-y-1"><span className="block stat-label">{label}</span>
      <input type="number" value={String(val)} onChange={(e) => on(Number(e.target.value))} className={`${inp} ${width}`} /></label>
  );

  return (
    <section className="card space-y-4">
      <h2 className="eyebrow"><span className="eyebrow-bar" />General</h2>

      <div className="space-y-2">
        <div className="stat-label">Display</div>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Brand name</span><input value={s.display.brand_name} onChange={(e) => disp("brand_name", e.target.value)} className={`${inp} w-40`} /></label>
          <label className="space-y-1"><span className="block stat-label">Timezone (IANA)</span><input value={s.display.local_timezone} onChange={(e) => disp("local_timezone", e.target.value)} placeholder="America/Chicago" className={`${inp} w-52`} /></label>
          <label className="space-y-1"><span className="block stat-label">Public URL (for share/social previews)</span><input value={s.display.public_url} onChange={(e) => disp("public_url", e.target.value)} placeholder="https://hopwatch.example.net" className={`${inp} w-72`} /></label>
          <label className="space-y-1"><span className="block stat-label">Temperature unit</span>
            <select value={s.display.temperature_unit} onChange={(e) => disp("temperature_unit", e.target.value as "c" | "f")} className={`${inp} w-32`}>
              <option value="f">Fahrenheit</option><option value="c">Celsius</option>
            </select>
          </label>
        </div>
        <div className="space-y-1">
          <span className="block stat-label">Brand icon</span>
          <div className="flex items-center gap-3">
            {s.display.brand_icon
              ? <img src={s.display.brand_icon} alt="" className="h-8 w-8 rounded border border-line object-contain" />
              : <span className="text-[11px] text-ink-faint">none (accent bar)</span>}
            <input type="file" accept="image/*" onChange={(e) => onIcon(e.target.files?.[0])} className="text-[13px] text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-raised file:px-3 file:py-1.5 file:text-[13px] file:text-ink" />
            {s.display.brand_icon && <button type="button" className="btn btn-outline h-8 px-2 text-[12px]" onClick={() => disp("brand_icon", "")}>Remove</button>}
          </div>
          <p className="text-[11px] text-ink-faint">Small PNG or SVG (~64px). Shown in the header next to the name.</p>
        </div>
        <div className="space-y-1">
          <span className="block stat-label">Header links (shown as icons; leave blank to hide)</span>
          <div className="flex flex-wrap gap-3">
            <label className="space-y-1"><span className="block stat-label">Website</span><input value={s.social_links.website} onChange={(e) => soc("website", e.target.value)} placeholder="https://example.org" className={`${inp} w-64`} /></label>
            <label className="space-y-1"><span className="block stat-label">Discord</span><input value={s.social_links.discord} onChange={(e) => soc("discord", e.target.value)} placeholder="https://discord.gg/..." className={`${inp} w-64`} /></label>
            <label className="space-y-1"><span className="block stat-label">Facebook</span><input value={s.social_links.facebook} onChange={(e) => soc("facebook", e.target.value)} placeholder="https://facebook.com/..." className={`${inp} w-64`} /></label>
          </div>
          <p className="text-[11px] text-ink-faint">Must be full http(s) URLs; each opens in a new tab.</p>
        </div>
        <label className="block space-y-1"><span className="block stat-label">Tile URL template</span><input value={s.display.tile.url_template} onChange={(e) => tile("url_template", e.target.value)} className={`${inp} w-full max-w-2xl`} /></label>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Tile attribution</span><input value={s.display.tile.attribution} onChange={(e) => tile("attribution", e.target.value)} className={`${inp} w-72`} /></label>
          <label className="space-y-1"><span className="block stat-label">Tile API key (optional)</span><input value={s.display.tile.api_key} onChange={(e) => tile("api_key", e.target.value)} className={`${inp} w-52`} /></label>
        </div>
        <label className="block space-y-1"><span className="block stat-label">Dark basemap URL template</span><input value={s.display.tile_dark.url_template} onChange={(e) => tileDark("url_template", e.target.value)} placeholder="https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=YOUR_KEY" className={`${inp} w-full max-w-2xl font-mono`} /></label>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Dark tile attribution</span><input value={s.display.tile_dark.attribution} onChange={(e) => tileDark("attribution", e.target.value)} className={`${inp} w-72`} /></label>
        </div>
        <p className="text-[11px] text-ink-faint">Used for the map dark theme (light uses the tile URL above). OpenStreetMap has no dark raster, so the default is CARTO, which now needs a free API key appended as <code>?key=YOUR_KEY</code> (get one at carto.com/basemaps/apikey, free to 5M tiles/month). Paste the full keyed URL here, or point at any other dark raster provider. Must contain {"{z}/{x}/{y}"}.</p>
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1"><span className="block stat-label">Map: default max age</span>
            <select value={s.map_max_age.map} onChange={(e) => mma("map", Number(e.target.value))} className={`${inp} w-32`}>
              {MAX_AGE_OPTS.map((o) => <option key={o.min} value={o.min}>{o.label}</option>)}
            </select>
          </label>
          <label className="space-y-1"><span className="block stat-label">Live map: default max age</span>
            <select value={s.map_max_age.livemap} onChange={(e) => mma("livemap", Number(e.target.value))} className={`${inp} w-32`}>
              {MAX_AGE_OPTS.map((o) => <option key={o.min} value={o.min}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <p className="text-[11px] text-ink-faint">Default node age filter shown on each map; viewers can still change it per-browser with the map slider.</p>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Privacy &amp; exposure</div>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.privacy.metrics_public} onChange={(e) => priv("metrics_public", e.target.checked)} />
          Public Prometheus metrics (/api/metrics)
        </label>
        <p className="text-[11px] text-ink-faint">On: anyone can scrape node/gateway counts (default, matches Prometheus norms). Off: a signed-in session or API token is required.</p>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.privacy.fuzz_positions} onChange={(e) => priv("fuzz_positions", e.target.checked)} />
          Fuzz node locations for non-admins
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><span className="block stat-label">Rounding precision</span>
            <select value={s.privacy.fuzz_decimals} onChange={(e) => priv("fuzz_decimals", Number(e.target.value))} disabled={!s.privacy.fuzz_positions} className={`${inp} w-56 disabled:opacity-50`}>
              <option value={1}>1 decimal (~11 km)</option>
              <option value={2}>2 decimals (~1.1 km)</option>
              <option value={3}>3 decimals (~110 m)</option>
              <option value={4}>4 decimals (~11 m)</option>
            </select>
          </label>
        </div>
        <p className="text-[11px] text-ink-faint">Rounds displayed coordinates on the maps and public API so a hobbyist&apos;s home is not pinned to the meter. Admins always see the true fix.</p>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <div className="stat-label">Default map center</div>
          {s.map_center.lat != null && (
            <button type="button" className="btn btn-outline h-7 px-2 text-[12px]" onClick={() => mc({ lat: null, lon: null })}>Clear (auto-fit)</button>
          )}
        </div>
        <p className="text-[11px] text-ink-faint">Where <span className="mono">/map</span>, <span className="mono">/livemap</span>, and <span className="mono">/coverage</span> open. Click the map (or drag the pin) to set it, or type coordinates. Cleared = auto-fit to nodes (the old behavior).</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><span className="block stat-label">Latitude</span>
            <input type="number" step="any" value={s.map_center.lat ?? ""} placeholder="auto" onChange={(e) => mc({ lat: e.target.value === "" ? null : Number(e.target.value) })} className={`${inp} w-36`} /></label>
          <label className="space-y-1"><span className="block stat-label">Longitude</span>
            <input type="number" step="any" value={s.map_center.lon ?? ""} placeholder="auto" onChange={(e) => mc({ lon: e.target.value === "" ? null : Number(e.target.value) })} className={`${inp} w-36`} /></label>
          <label className="space-y-1"><span className="block stat-label">Zoom</span>
            <input type="number" step="0.5" min={0} max={20} value={String(s.map_center.zoom)} onChange={(e) => mc({ zoom: Number(e.target.value) })} className={`${inp} w-24`} /></label>
        </div>
        <MapCenterPicker
          value={s.map_center}
          onChange={(v) => setS({ ...s, map_center: v })}
          tileUrl={s.display.tile.url_template}
          tileAttribution={s.display.tile.attribution}
        />
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Retention (days, except live events)</div>
        <div className="flex flex-wrap gap-3">
          {numField("Raw payloads", s.retention.raw_payload_days, (v) => ret("raw_payload_days", v))}
          {numField("Decoded packets", s.retention.decoded_packet_days, (v) => ret("decoded_packet_days", v))}
          {numField("Telemetry", s.retention.telemetry_days, (v) => ret("telemetry_days", v))}
          {numField("Reception rollups", s.retention.reception_rollup_hour_days, (v) => ret("reception_rollup_hour_days", v))}
          {numField("Live events (min)", s.retention.live_events_minutes, (v) => ret("live_events_minutes", v))}
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Features</div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.features.live_views} onChange={(e) => feat("live_views", e.target.checked)} /> Live views</label>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.features.aprs_is_export} onChange={(e) => feat("aprs_is_export", e.target.checked)} /> APRS-IS export</label>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.features.reference_sheet_pdf} onChange={(e) => feat("reference_sheet_pdf", e.target.checked)} /> Reference sheet PDF</label>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.features.ambience_mode} onChange={(e) => feat("ambience_mode", e.target.checked)} /> Ambience mode</label>
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Live map defaults</div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.livemap.enabled} onChange={(e) => lm("enabled", e.target.checked)} /> Enabled</label>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.livemap.gateway_rings_default} onChange={(e) => lm("gateway_rings_default", e.target.checked)} /> Gateway rings default</label>
          <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.livemap.audio_default} onChange={(e) => lm("audio_default", e.target.checked)} /> Audio default</label>
          {numField("Inference window (h)", s.livemap.inference_window_hours, (v) => lm("inference_window_hours", v))}
          {numField("Max anim/sec", s.livemap.max_animations_per_sec, (v) => lm("max_animations_per_sec", v))}
          {numField("Trail decay (s)", s.livemap.trail_decay_seconds, (v) => lm("trail_decay_seconds", v))}
        </div>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Google Analytics (GA4, optional)</div>
        <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.analytics.enabled} onChange={(e) => an("enabled", e.target.checked)} /> Enabled</label>
        {s.analytics.enabled && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-4">
              <label className="space-y-1"><span className="block stat-label">Measurement ID</span><input value={s.analytics.measurement_id} onChange={(e) => an("measurement_id", e.target.value)} placeholder="G-XXXXXXXXXX" className={`${inp} w-52`} /></label>
              <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.analytics.client} onChange={(e) => an("client", e.target.checked)} /> Client tag (gtag.js pageviews)</label>
              <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.analytics.server} onChange={(e) => an("server", e.target.checked)} /> Server-side (Measurement Protocol)</label>
            </div>
            {s.analytics.server && (
              <label className="block space-y-1"><span className="block stat-label">Measurement Protocol API secret {s.analytics.has_api_secret && <span className="text-ink-faint">(set; leave blank to keep)</span>}</span>
                <input type="password" value={s.analytics.api_secret ?? ""} onChange={(e) => an("api_secret", e.target.value)} placeholder={s.analytics.has_api_secret ? "unchanged" : "paste secret"} className={`${inp} w-72`} /></label>
            )}
            <p className="text-[11px] text-ink-faint">Off by default. The client tag sets cookies and sends data to Google (consider consent requirements). The API secret is encrypted at rest and never shown again.</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save general settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>
    </section>
  );
}
