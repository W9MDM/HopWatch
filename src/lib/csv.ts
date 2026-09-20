/** Minimal RFC-4180-ish CSV serializer for API exports. */
export function toCsv(rows: readonly object[], columns?: string[]): string {
  if (rows.length === 0) return (columns ?? []).join(",") + "\n";
  const asRec = rows as readonly Record<string, unknown>[];
  const cols = columns ?? Object.keys(asRec[0]!);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // Neutralize spreadsheet formula injection (CWE-1236). Node identity fields are free-form text
    // set by any radio on the air: a hostile NODEINFO_APP long_name of `=cmd|'/c calc'!A0` fits
    // inside mesh.proto's 40-byte limit, and it reaches operator-clicked exports on /nodes,
    // /packets and /gateways/{id}. Quoting alone does NOT disarm it, because the importer strips
    // the quotes before evaluating the cell, so prefix a single quote (the conventional
    // "treat this cell as text" marker) whenever the value opens with a formula trigger.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.join(",");
  const body = asRec.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return head + "\n" + body + "\n";
}
