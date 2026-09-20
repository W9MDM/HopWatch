// Network condition: a named level derived from the 0-100 mesh health score, for the
// always-visible header badge and the dashboard card. Pure and testable. Thresholds match
// the dashboard's existing color breakpoints (70 / 40) so the badge and the number agree.

export type ConditionTone = "ok" | "warn" | "bad" | "unknown";
export interface NetworkCondition {
  label: string;
  tone: ConditionTone;
}

// Health is recomputed on the worker's 5-minute loop; treat anything older than this as stale
// (worker likely down), which reads as Unknown rather than a falsely-green badge.
export const CONDITION_STALE_MINUTES = 15;

export function networkCondition(score: number | null | undefined, ageMinutes: number | null | undefined): NetworkCondition {
  if (score == null || ageMinutes == null || !Number.isFinite(ageMinutes) || ageMinutes > CONDITION_STALE_MINUTES) {
    return { label: "Unknown", tone: "unknown" };
  }
  if (score >= 85) return { label: "Strong", tone: "ok" };
  if (score >= 70) return { label: "Good", tone: "ok" };
  if (score >= 55) return { label: "Fair", tone: "warn" };
  if (score >= 40) return { label: "Degraded", tone: "warn" };
  return { label: "Critical", tone: "bad" };
}

/** Tailwind text color class for a tone, matching the rest of the UI. */
export function conditionTextClass(tone: ConditionTone): string {
  switch (tone) {
    case "ok": return "text-ok";
    case "warn": return "text-gold-ink";
    case "bad": return "text-accent-strong";
    default: return "text-ink-faint";
  }
}
