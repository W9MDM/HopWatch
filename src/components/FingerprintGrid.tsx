import { type Fingerprint, DOW_LABELS } from "../lib/fingerprint.ts";

// Duty-cycle heatmap: 7 rows (day of week) x 24 columns (hour, UTC), cell intensity
// scaled to the node's busiest hour. Pure render, no client JS.
export function FingerprintGrid({ fp }: { fp: Fingerprint }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink-mute">
          Profile: <span className="text-ink">{fp.profile}</span>
        </span>
        <span className="text-[11px] text-ink-faint">{fp.total.toLocaleString("en-US")} receptions, UTC hours</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th></th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} className="text-[9px] font-normal text-ink-faint">
                  {h % 6 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fp.grid.map((row, dow) => (
              <tr key={dow}>
                <td className="pr-2 text-[10px] text-ink-faint">{DOW_LABELS[dow]}</td>
                {row.map((c, hour) => {
                  const intensity = fp.max ? c / fp.max : 0;
                  return (
                    <td key={hour}>
                      <div
                        className="h-3.5 w-3.5 rounded-sm"
                        style={{
                          backgroundColor:
                            c === 0 ? "var(--color-raised)" : `color-mix(in srgb, var(--color-rx-direct) ${Math.round(15 + intensity * 85)}%, var(--color-raised))`,
                        }}
                        title={`${DOW_LABELS[dow]} ${hour}:00 UTC: ${c}`}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
