"use client";

export interface LayerToggle { key: string; label: string; checked: boolean; onChange: (v: boolean) => void }
export interface MaxAge { steps: { label: string; min: number }[]; index: number; onChange: (i: number) => void }

// Layers/features control strip. Per Rule 9 it renders in the control row ABOVE the map (not
// floating over the canvas): a wrapping row of layer toggles plus the optional Max-age slider.
export function MapLayersPanel({ toggles, maxAge }: { toggles: LayerToggle[]; maxAge?: MaxAge }) {
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
