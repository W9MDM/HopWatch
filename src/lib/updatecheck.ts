// Version comparison for the update checker. Versions are plain "x.y.z" (a leading "v" is
// tolerated); missing or non-numeric parts count as 0, and a pre-release suffix ("-rc1") is
// ignored for ordering. Pure and DB-free so it is unit-testable.

/** 1 if a > b, -1 if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const parts = (s: string) => String(s ?? "").trim().replace(/^v/i, "").split("-")[0]!.split(".").map((p) => parseInt(p, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** True only when `latest` is a strictly higher version than `current`. */
export function isUpdateAvailable(latest: string | null | undefined, current: string): boolean {
  return !!latest && compareVersions(latest, current) > 0;
}
