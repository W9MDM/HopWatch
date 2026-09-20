"use client";

import { useState } from "react";

export interface WeatherAlertsSettings {
  enabled: boolean; zones: string[]; min_severity: string; events: string[];
  zones_only: boolean;
  weekly_test: boolean; monthly_test: boolean;
  channel: string; transport: "rf" | "mqtt"; broker_id: string; poll_minutes: number; template: string;
}
interface SentRow {
  alert_id: string; event: string | null; severity: string | null; area: string | null;
  matched_zones: string | null; sent_at: string;
}

const inputCls = "h-9 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";
const taCls = "min-h-16 w-full rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none";

// NWS alert event types (the `event` values from api.weather.gov). Comprehensive; grouped only for
// readability. An empty selection means "any event at/above the severity threshold".
const NWS_EVENTS: string[] = [
  "Tornado Warning", "Tornado Watch", "Severe Thunderstorm Warning", "Severe Thunderstorm Watch",
  "Special Weather Statement", "Severe Weather Statement", "Snow Squall Warning", "Extreme Wind Warning",
  "Dust Storm Warning", "Blowing Dust Advisory", "Dust Advisory",
  "Flash Flood Warning", "Flash Flood Watch", "Flood Warning", "Flood Watch", "Flood Advisory", "Flood Statement",
  "Coastal Flood Warning", "Coastal Flood Watch", "Coastal Flood Advisory", "Lakeshore Flood Warning",
  "Lakeshore Flood Advisory", "Hydrologic Outlook",
  "Winter Storm Warning", "Winter Storm Watch", "Winter Weather Advisory", "Ice Storm Warning",
  "Blizzard Warning", "Blizzard Watch", "Freezing Rain Advisory", "Winter Weather Statement", "Snow And Blowing Snow Advisory",
  "Frost Advisory", "Freeze Warning", "Freeze Watch", "Hard Freeze Warning", "Hard Freeze Watch",
  "Wind Chill Warning", "Wind Chill Watch", "Wind Chill Advisory", "Extreme Cold Warning", "Extreme Cold Watch", "Cold Weather Advisory",
  "Heat Advisory", "Excessive Heat Warning", "Excessive Heat Watch", "Extreme Heat Warning", "Extreme Heat Watch",
  "High Wind Warning", "High Wind Watch", "Wind Advisory", "Lake Wind Advisory",
  "Red Flag Warning", "Fire Weather Watch", "Fire Warning",
  "Dense Fog Advisory", "Freezing Fog Advisory", "Dense Smoke Advisory", "Air Quality Alert", "Air Stagnation Advisory",
  "Ashfall Warning", "Ashfall Advisory",
  "Hurricane Warning", "Hurricane Watch", "Hurricane Force Wind Warning", "Tropical Storm Warning", "Tropical Storm Watch",
  "Storm Surge Warning", "Storm Surge Watch", "Gale Warning", "Gale Watch", "Storm Warning", "Storm Watch",
  "Small Craft Advisory", "Hazardous Seas Warning", "Special Marine Warning", "Marine Weather Statement",
  "High Surf Warning", "High Surf Advisory", "Rip Current Statement", "Beach Hazards Statement", "Low Water Advisory",
  "Tsunami Warning", "Tsunami Watch", "Tsunami Advisory", "Avalanche Warning", "Avalanche Watch", "Avalanche Advisory",
  "Earthquake Warning", "Volcano Warning",
  "Civil Emergency Message", "Civil Danger Warning", "Local Area Emergency", "Evacuation Immediate",
  "Shelter In Place Warning", "Hazardous Materials Warning", "Radiological Hazard Warning", "Nuclear Power Plant Warning",
  "Law Enforcement Warning", "911 Telephone Outage Emergency", "Child Abduction Emergency", "Administrative Message",
];

// Broadcast NWS weather alerts to the mesh. Targets UGC county/zone codes, filters by severity +
// optional event allow-list, and posts new alerts (deduped by id) to a channel via the armed TX.
export function WeatherAlertsManager({ initial, initialSent, channels, brokers }: { initial: WeatherAlertsSettings; initialSent: SentRow[]; channels: string[]; brokers: { id: string; host: string }[] }) {
  const [s, setS] = useState<WeatherAlertsSettings>(initial);
  // Textareas hold raw text so blank/new lines survive typing; parsed to arrays only on save.
  const [zonesText, setZonesText] = useState((initial.zones ?? []).join("\n"));
  const [sent, setSent] = useState<SentRow[]>(initialSent);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<WeatherAlertsSettings>) => setS({ ...s, ...patch });
  const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);
  const events = new Set(s.events);
  const toggleEvent = (e: string, on: boolean) => set({ events: on ? [...events, e] : s.events.filter((x) => x !== e) });

  async function save() {
    setMsg(null); setErr(null);
    const body = { ...s, zones: lines(zonesText) };
    const r = await fetch("/api/v1/admin/weather-alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) setMsg("Saved. The worker polls on its next cycle.");
    else setErr(j.error ?? "save failed");
  }
  async function test() {
    setMsg(null); setErr(null);
    const r = await fetch("/api/v1/admin/weather-alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "test" }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setMsg(`Test queued: "${j.preview}" ${j.note ?? ""}`); const g = await fetch("/api/v1/admin/weather-alerts").then((x) => x.json()).catch(() => null); if (g) setSent(g.sent ?? sent); }
    else setErr(j.error ?? "test failed");
  }

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="eyebrow"><span className="eyebrow-bar" />Weather alerts</h2>
        <p className="mt-1 text-[13px] text-ink-faint">
          Broadcasts NWS active alerts for your area to the mesh. Free/keyless (api.weather.gov). Requires TX enabled + armed + dry-run off.
          Deduped by alert id, so nothing is sent twice.
        </p>
      </div>

      <label className="flex items-center gap-2 text-[13px] text-ink"><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="space-y-1"><span className="block stat-label">UGC county/zone codes (one per line)</span>
          <textarea className={taCls} value={zonesText} onChange={(e) => setZonesText(e.target.value)} placeholder={"INC089\nINC091\nINZ011"} />
          <span className="block text-[11px] text-ink-faint">County codes like INC089, or forecast-zone codes like INZ011. Find yours at weather.gov (county warning area). List several for full coverage.</span>
          <label className="flex items-center gap-2 pt-1 text-[13px] text-ink">
            <input type="checkbox" checked={s.zones_only !== false} onChange={(e) => set({ zones_only: e.target.checked })} /> Report only these zones
          </label>
          <span className="block text-[11px] text-ink-faint">
            On (recommended): a broadcast names only the zones above, and an alert covering none of
            them is not sent. A Storm Prediction Center watch that clips one local county also names
            twenty others, often across state lines, and listing them all spends the mesh&apos;s
            220-character budget on places nobody here cares about, truncating away the expiry time.
            Off: the alert&apos;s full area list is sent, as before. Either way <code>{"{area_all}"}</code>
            in the template always gives the full list.
          </span>
        </label>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="stat-label">Event allow-list ({events.size} selected)</span>
            <span className="flex gap-2 text-[11px]">
              <button type="button" className="text-accent hover:underline" onClick={() => set({ events: [...NWS_EVENTS] })}>all</button>
              <button type="button" className="text-accent hover:underline" onClick={() => set({ events: [] })}>none</button>
            </span>
          </div>
          <div className="max-h-56 overflow-auto rounded-md border border-line bg-raised/40 p-2">
            <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
              {NWS_EVENTS.map((e) => (
                <label key={e} className="flex items-center gap-1.5 text-[12px] text-ink-mute">
                  <input type="checkbox" checked={events.has(e)} onChange={(ev) => toggleEvent(e, ev.target.checked)} /> {e}
                </label>
              ))}
            </div>
          </div>
          <span className="block text-[11px] text-ink-faint">None selected = any event at/above the severity below. Selecting events narrows it to exactly those.</span>
        </div>
      </div>

      <div className="space-y-1">
        <span className="block stat-label">EAS test events</span>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={s.weekly_test} onChange={(e) => set({ weekly_test: e.target.checked })} /> Required Weekly Test
          </label>
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={s.monthly_test} onChange={(e) => set({ monthly_test: e.target.checked })} /> Required Monthly Test
          </label>
        </div>
        <span className="block text-[11px] text-ink-faint">Test events carry no severity, so when enabled they always send, bypassing the severity threshold and the event allow-list above.</span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1"><span className="block stat-label">Minimum severity</span>
          <select value={s.min_severity} onChange={(e) => set({ min_severity: e.target.value })} className={`${inputCls} w-36`}>
            <option value="Extreme">Extreme only</option>
            <option value="Severe">Severe and above</option>
            <option value="Moderate">Moderate and above</option>
            <option value="Minor">Minor and above</option>
            <option value="Unknown">Any</option>
          </select>
        </label>
        <label className="space-y-1"><span className="block stat-label">Channel</span>
          <select value={s.channel} onChange={(e) => set({ channel: e.target.value })} className={`${inputCls} w-44`}>
            <option value="">primary</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            {s.channel && !channels.includes(s.channel) && <option value={s.channel}>{s.channel}</option>}
          </select>
        </label>
        <label className="space-y-1"><span className="block stat-label">Transport</span>
          <select value={s.transport} onChange={(e) => set({ transport: e.target.value as "rf" | "mqtt" })} className={`${inputCls} w-40`}><option value="rf">RF (station node)</option><option value="mqtt">MQTT downlink</option></select>
        </label>
        {s.transport === "mqtt" && (
          <label className="space-y-1"><span className="block stat-label">Broker</span>
            <select value={s.broker_id} onChange={(e) => set({ broker_id: e.target.value })} className={`${inputCls} w-48`}>
              <option value="">first enabled</option>
              {brokers.map((b) => <option key={b.id} value={b.id}>{b.id} ({b.host})</option>)}
            </select>
          </label>
        )}
        <label className="space-y-1"><span className="block stat-label">Poll every (min)</span><input type="number" min={1} value={String(s.poll_minutes)} onChange={(e) => set({ poll_minutes: Number(e.target.value) })} className={`${inputCls} w-24`} /></label>
      </div>

      <label className="space-y-1 block"><span className="block stat-label">Message template</span>
        <input value={s.template} onChange={(e) => set({ template: e.target.value })} className={`${inputCls} w-full`} placeholder="WX {event} ({severity}) {area} until {expires}" />
        <span className="block text-[11px] text-ink-faint">Vars: {"{event} {severity} {headline} {area} {expires} {onset} {sender} {area_all}"}. Keep it short (mesh messages cap ~228 bytes).</span>
      </label>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save</button>
        <button className="btn btn-outline h-9 px-3 text-[13px]" onClick={test}>Send test alert</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {err && <span className="text-[12px] text-accent-strong">{err}</span>}
      </div>

      {sent.length > 0 && (
        <div>
          <div className="stat-label mb-1">Recently broadcast</div>
          <div className="max-h-56 overflow-auto"><table className="data">
            <thead><tr><th>Sent</th><th>Event</th><th>Sev</th><th>Area broadcast</th><th>Matched zones</th></tr></thead>
            <tbody>{sent.map((r) => (
              <tr key={r.alert_id}>
                <td className="whitespace-nowrap text-ink-faint">{r.sent_at.slice(0, 16).replace("T", " ")}</td>
                <td>{r.event ?? "-"}</td>
                <td className="text-ink-faint">{r.severity ?? "-"}</td>
                <td className="text-ink-faint">{r.area ?? "-"}</td>
                {/* Which entry in the zone list above admitted this alert. A broadcast for somewhere
                    unexpected names the zone code responsible, instead of leaving it a mystery. */}
                <td className="mono text-ink-faint">{r.matched_zones ?? "-"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </section>
  );
}
