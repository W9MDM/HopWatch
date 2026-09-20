import { formatNodeId } from "../meshtastic/types.ts";

// Display helpers. Storage is UTC (MySQL DATETIME as strings); the app renders a
// configured local timezone. No naive datetime handling.

/** Parse a MySQL UTC DATETIME string ('YYYY-MM-DD HH:MM:SS.mmm') into a Date. */
export function utcToDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return new Date(iso.endsWith("Z") ? iso : iso + "Z");
}

/** Compact age string relative to now: "12s", "5m", "3h", "2d". */
export function fmtAge(s: string | null | undefined): string {
  const d = utcToDate(s);
  if (!d) return "never";
  const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** Render an instant in the configured local timezone. */
export function fmtLocal(s: string | null | undefined, tz: string): string {
  const d = utcToDate(s);
  if (!d) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export function fmtNode(id: number | null | undefined, longName?: string | null, shortName?: string | null): string {
  if (id === null || id === undefined) return "-";
  if (longName) return longName;
  if (shortName) return shortName;
  return formatNodeId(id);
}

export function fmtRssi(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : `${v} dBm`;
}

export function fmtSnr(v: number | null | undefined): string {
  return v === null || v === undefined ? "-" : `${Number(v).toFixed(1)} dB`;
}

export function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined ? "0" : Number(v).toLocaleString("en-US");
}

export type TempUnit = "c" | "f";

/** Convert a Celsius value (as ingested from firmware) to the display unit. */
export function convertTemp(c: number, unit: TempUnit): number {
  return unit === "f" ? c * 9 / 5 + 32 : c;
}

/** Unit suffix for temperatures, e.g. "C" or "F". */
export function tempUnitLabel(unit: TempUnit): string {
  return unit === "f" ? "F" : "C";
}

/** Ageing status -> pill tone class (uses the theme rx tokens). */
export function ageTone(s: string | null | undefined): "on" | "stale" | "off" {
  const d = utcToDate(s);
  if (!d) return "off";
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 7200) return "on";
  if (secs < 86400) return "stale";
  return "off";
}
