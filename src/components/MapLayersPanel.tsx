"use client";

export interface LayerToggle { key: string; label: string; checked: boolean; onChange: (v: boolean) => void }
export interface MaxAge { steps: { label: string; min: number }[]; index: number; onChange: (i: number) => void }
export interface NewFilter { steps: { label: string; hours: number }[]; index: number; onChange: (i: number) => void }
export interface HopFilter { steps: { label: string }[]; index: number; onChange: (i: number) => void }

// Layers/features control strip. Per Rule 9 it renders in the control row ABOVE the map (not
// floating over the canvas): a wrapping row of layer toggles plus the optional Max-age / Max-hops
// sliders and New-nodes filter.
export function MapLayersPanel({ toggles, maxAge, maxHops, newFilter }: { toggles: LayerToggle[]; maxAge?: MaxAge; maxHops?: HopFilter; newFilter?: NewFilter }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface/60 px-3 py-2 text-[12px]">
      <span className="eyebrow"><span className="eyebrow-bar" />Layers</span>
      {maxAge && (
        <label className="flex items-center gap-2 text-ink-mute">
          <span className="stat-label">Max age</span>
          <input
            type="range" min={0} max={maxAge.steps.length - 1} step={1} value={maxAge.index}
            onChange={(e) => maxAge.onChange(Number(e.target.value))}
            className="w-32"
          />
          <span className="w-8 text-ink-faint">{maxAge.steps[maxAge.index]!.label}</span>
        </label>
      )}
      {maxHops && (
        <label className="flex items-center gap-2 text-ink-mute">
          <span className="stat-label">Max hops</span>
          <input
            type="range" min={0} max={maxHops.steps.length - 1} step={1} value={maxHops.index}
            onChange={(e) => maxHops.onChange(Number(e.target.value))}
            className="w-28"
          />
          <span className="w-8 text-ink-faint">{maxHops.steps[maxHops.index]!.label}</span>
        </label>
      )}
      {newFilter && (
        <label className="flex items-center gap-2 text-ink-mute">
          <span className="stat-label">New</span>
          <select
            value={newFilter.index}
            onChange={(e) => newFilter.onChange(Number(e.target.value))}
            className="rounded-md border border-line bg-raised px-1.5 py-0.5 text-[12px] text-ink"
          >
            {newFilter.steps.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
          </select>
        </label>
      )}
      {toggles.map((t) => (
        <label key={t.key} className="flex cursor-pointer items-center gap-1.5 text-ink-mute hover:text-ink">
          <input type="checkbox" checked={t.checked} onChange={(e) => t.onChange(e.target.checked)} />
          {t.label}
        </label>
      ))}
    </div>
  );
}

// Shared age steps for the Max-age slider. Last step ("All") = no age filter.
export const AGE_STEPS = [
  { label: "5m", min: 5 },
  { label: "1h", min: 60 },
  { label: "6h", min: 360 },
  { label: "1d", min: 1440 },
  { label: "7d", min: 10080 },
  { label: "All", min: Infinity },
];

/** AGE_STEPS index for a configured default (minutes; 0 or missing = All). Falls back to the
 * nearest finite step if the exact minutes are not a step. */
export function ageStepForMinutes(min: number | null | undefined): number {
  if (!min || min <= 0) return AGE_STEPS.length - 1;
  const exact = AGE_STEPS.findIndex((s) => s.min === min);
  if (exact >= 0) return exact;
  let best = AGE_STEPS.length - 1, bd = Infinity;
  AGE_STEPS.forEach((s, i) => { if (Number.isFinite(s.min)) { const d = Math.abs(s.min - min); if (d < bd) { bd = d; best = i; } } });
  return best;
}

/** True if a last-seen timestamp is within maxMin minutes (Infinity = always). */
export function withinAge(lastSeenAt: string | null, maxMin: number): boolean {
  if (!Number.isFinite(maxMin)) return true;
  if (!lastSeenAt) return false;
  const ageMin = (Date.now() - new Date(lastSeenAt.replace(" ", "T") + "Z").getTime()) / 60000;
  return ageMin <= maxMin;
}

// Shared "New nodes" filter steps: keep only nodes FIRST seen within this window. hours 0 = Off.
export const NEW_STEPS = [
  { label: "Off", hours: 0 },
  { label: "New 24h", hours: 24 },
  { label: "New 48h", hours: 48 },
  { label: "New 7d", hours: 168 },
];

/** True if a first-seen timestamp is within `hours` (hours 0 = Off, keep all). */
export function isNewWithin(firstSeenAt: string | null, hours: number): boolean {
  if (!hours) return true;
  if (!firstSeenAt) return false;
  const ageH = (Date.now() - new Date(firstSeenAt.replace(" ", "T") + "Z").getTime()) / 3600000;
  return ageH <= hours;
}

// Shared "Max hops" slider: show only nodes within this many hops of a gateway (0 = direct-heard
// only). Last step ("All") = no hop filter. maxHops is the step's max hop count (Infinity = All).
export const HOP_STEPS = [
  { label: "0", max: 0 },
  { label: "1", max: 1 },
  { label: "2", max: 2 },
  { label: "3", max: 3 },
  { label: "4", max: 4 },
  { label: "5", max: 5 },
  { label: "6", max: 6 },
  { label: "7+", max: 7 },
  { label: "All", max: Infinity },
];

/** True if a node's hop count is within maxHops. A null hop count (no RF observation, e.g. an
 * MQTT-only node or an estimated position) is hidden while a hop filter is active, shown at All. */
export function withinHops(hops: number | null, maxHops: number): boolean {
  if (!Number.isFinite(maxHops)) return true;
  if (hops == null) return false;
  return hops <= maxHops;
}
