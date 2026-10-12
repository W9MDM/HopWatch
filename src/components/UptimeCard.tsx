import { cn } from "../lib/cn.ts";

// UTC "YYYY-MM-DD HH" key for an hour, so DB bucket_start strings and generated hours compare
// regardless of seconds/milliseconds formatting.
function hourKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}`;
}

function pctClass(p: number): string {
  if (p >= 95) return "text-ok";
  if (p >= 70) return "text-gold-ink";
  return "text-accent-strong";
}

export interface UptimeCardProps {
  pct: { h24: number; h7d: number; h30d: number };
  onlineHours: string[];        // DB bucket_start strings for hours the node was heard (last 7d)
  currentStr: string | null;    // humanized current device uptime
  reboots: number;              // reboots detected in the last 30d
  lastRebootStr: string | null; // humanized age of the last reboot
  longestRunStr: string | null; // humanized longest observed continuous run
}

export function UptimeCard({ pct, onlineHours, currentStr, reboots, lastRebootStr, longestRunStr }: UptimeCardProps) {
  // Build the last 168 hours (7d), oldest first, and mark the ones the node was heard in.
  const online = new Set(onlineHours.map((s) => s.slice(0, 13)));
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const cells: { key: string; online: boolean; label: string }[] = [];
  for (let i = 167; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 3600_000);
    const k = hourKey(t);
    cells.push({ key: `${i}`, online: online.has(k), label: `${k}:00 UTC` });
  }

  return (
    <div className="card">
      <h2 className="eyebrow mb-3"><span className="eyebrow-bar" />Uptime &amp; availability</h2>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <div><div className="stat-label">Avail 24h</div><div className={cn("stat mt-1 text-base", pctClass(pct.h24))}>{pct.h24}%</div></div>
        <div><div className="stat-label">Avail 7d</div><div className={cn("stat mt-1 text-base", pctClass(pct.h7d))}>{pct.h7d}%</div></div>
        <div><div className="stat-label">Avail 30d</div><div className={cn("stat mt-1 text-base", pctClass(pct.h30d))}>{pct.h30d}%</div></div>
        <div><div className="stat-label">Uptime</div><div className="stat mt-1 text-base">{currentStr ?? "-"}</div></div>
        <div><div className="stat-label">Reboots 30d</div><div className="stat mt-1 text-base">{reboots}</div></div>
        <div><div className="stat-label">Longest run</div><div className="stat mt-1 text-base">{longestRunStr ?? "-"}</div></div>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="stat-label">Heard, hourly (7d)</span>
          <span className="text-[11px] text-ink-faint">
            {lastRebootStr ? `last reboot ${lastRebootStr}` : "no reboot in 30d"}
          </span>
        </div>
        <div className="grid gap-0.5" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
          {cells.map((c) => (
            <div key={c.key} title={`${c.label} - ${c.online ? "heard" : "no data"}`}
                 className={cn("h-3 rounded-sm", c.online ? "bg-ok" : "bg-raised")} />
          ))}
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-faint">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-ok" /> heard</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-raised" /> no data</span>
          <span className="ml-auto">oldest left, newest right</span>
        </div>
      </div>
    </div>
  );
}
