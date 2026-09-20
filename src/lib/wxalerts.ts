// Pure weather-alert logic: severity ranking and filter/format. DB- and network-free, so it is
// unit-testable. The worker (src/worker/weatheralerts.ts) fetches from NWS and persists.

export type Severity = "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
const RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

export function severityRank(s: string | null | undefined): number {
  return RANK[String(s ?? "Unknown")] ?? 0;
}

export interface AlertLike {
  id: string; event: string; severity: string; status?: string; headline?: string; areaDesc?: string;
  expires?: string; onset?: string; senderName?: string;
  /**
   * UGC codes for the areas this alert covers, from NWS `properties.geocode.UGC`, e.g.
   * ["ILC031","INC089"]. Positionally aligned with the semicolon-separated entries of `areaDesc`:
   * verified against 120 live alerts, where the counts matched in every single one. That alignment
   * is what lets the broadcast name only the areas an operator actually cares about.
   */
  ugc?: string[];
}

/** One area of an alert: its UGC code and the human name from the matching areaDesc entry. */
export interface AlertArea { ugc: string; name: string }

/**
 * Pair each UGC code with its areaDesc entry.
 *
 * Returns [] when the two lists disagree in length, rather than pairing them up wrongly: a
 * mispaired name would put a neighbouring county's name on someone else's warning, which is worse
 * than falling back to the full area string.
 */
export function alertAreas(a: AlertLike): AlertArea[] {
  const ugc = a.ugc ?? [];
  const names = String(a.areaDesc ?? "").split(";").map((x) => x.trim()).filter(Boolean);
  if (ugc.length === 0 || ugc.length !== names.length) return [];
  return ugc.map((u, i) => ({ ugc: u.trim().toUpperCase(), name: names[i]! }));
}

/**
 * The configured zones this alert actually covers.
 *
 * An NWS query for `zone=A,B` returns alerts affecting A or B, but the alert itself usually covers
 * far more: a Storm Prediction Center watch naming one local county also names twenty others, often
 * across state lines. This is the intersection, so the broadcast can say where the operator lives
 * instead of listing every county in the watch box and then being truncated to the mesh's 220-char
 * limit before it reaches the useful part.
 *
 * Matching is on the UGC code, not the name: county names repeat across states (there is a Lake
 * county in both IL and IN), and the areaDesc format varies (a single-state alert omits the state
 * suffix that a multi-state one includes).
 */
export function matchedZoneAreas(a: AlertLike, zones: string[]): AlertArea[] {
  const want = new Set(zones.map((z) => z.trim().toUpperCase()).filter(Boolean));
  if (want.size === 0) return [];
  return alertAreas(a).filter((x) => want.has(x.ugc));
}

/** Should this alert be sent, given a minimum severity and an optional event allow-list? */
export function alertMatches(a: AlertLike, minSeverity: string, events: string[]): boolean {
  if (severityRank(a.severity) < severityRank(minSeverity)) return false;
  if (events.length > 0 && !events.some((e) => e.trim().toLowerCase() === a.event.trim().toLowerCase())) return false;
  return true;
}

/**
 * EAS test events (Required Weekly Test / Required Monthly Test) carry no meaningful severity
 * (NWS publishes them as Minor/Unknown with status "Test"), so they can never pass a severity
 * threshold. When its toggle is on, a test event always sends, bypassing both the severity
 * threshold and the event allow-list.
 */
export function isRequiredTest(a: AlertLike, weekly: boolean, monthly: boolean): boolean {
  const e = a.event.trim().toLowerCase();
  return (weekly && e === "required weekly test") || (monthly && e === "required monthly test");
}

/**
 * Fill a weather-alert template. Unknown tokens are left as-is; result is mesh-length trimmed.
 *
 * `areaOverride` replaces `{area}` with just the areas the operator cares about. `{area_all}` always
 * gives the alert's full area list, for anyone who wants it.
 */
export function fillAlert(tpl: string, a: AlertLike, zone: string, areaOverride?: string): string {
  const map: Record<string, string> = {
    event: a.event || "Alert",
    severity: a.severity || "Unknown",
    headline: a.headline ?? "",
    area: areaOverride ?? a.areaDesc ?? "",
    area_all: a.areaDesc ?? "",
    expires: a.expires ? shortTime(a.expires, zone) : "",
    onset: a.onset ? shortTime(a.onset, zone) : "",
    sender: a.senderName ?? "",
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in map ? map[k]! : m)).slice(0, 220);
}

function shortTime(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}
