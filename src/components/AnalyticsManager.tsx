"use client";

import { useState } from "react";

export interface AnalyticsSettings {
  spam_score: { window_hours: number };
  records: { enabled: boolean };
  health_score: { weights: Record<string, number> };
  rollups: { refold_hours: number };
}

const HEALTH_KEYS: { key: string; label: string }[] = [
  { key: "utilization", label: "Utilization" },
  { key: "delivery_ratio", label: "Delivery ratio" },
  { key: "gateway_coverage", label: "Gateway coverage" },
  { key: "active_node_trend", label: "Active-node trend" },
  { key: "anomalies", label: "Anomalies" },
];

const inp = "h-9 w-28 rounded-md border border-line bg-raised px-3 text-[13px] text-ink focus:border-accent focus:outline-none";

export function AnalyticsManager({ initial }: { initial: AnalyticsSettings }) {
  const [s, setS] = useState<AnalyticsSettings>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weightSum = HEALTH_KEYS.reduce((a, k) => a + (Number(s.health_score.weights[k.key]) || 0), 0);

  function setWeight(key: string, v: number) {
    setS((p) => ({ ...p, health_score: { weights: { ...p.health_score.weights, [key]: v } } }));
  }

  async function save() {
    setMsg(null); setError(null);
    const r = await fetch("/api/v1/admin/analytics", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s),
    });
    if (r.ok) setMsg("Saved. The worker picks up analytics changes on its next tick.");
    else setError((await r.json().catch(() => ({}))).error ?? "save failed");
  }

  return (
    <section className="card space-y-4">
      <h2 className="eyebrow"><span className="eyebrow-bar" />Analytics tuning</h2>

      <div className="flex flex-wrap items-end gap-6">
        <label className="space-y-1">
          <span className="block stat-label">Spam-score window (hours)</span>
          <input className={inp} type="number" min={1} max={720} value={String(s.spam_score.window_hours)}
            onChange={(e) => setS({ ...s, spam_score: { window_hours: Number(e.target.value) } })} />
          <p className="text-[11px] text-ink-faint">Reception-rate window backing the new-node spam score.</p>
        </label>
        <label className="space-y-1">
          <span className="block stat-label">Rollup re-fold window (hours)</span>
          <input className={inp} type="number" min={0} max={168} value={String(s.rollups.refold_hours)}
            onChange={(e) => setS({ ...s, rollups: { refold_hours: Number(e.target.value) } })} />
          <p className="text-[11px] text-ink-faint">Recently closed hours re-aggregated every 30 min, so a reception that arrives with an older timestamp (slow gateway clock, store-and-forward replay) still reaches the rollups. 0 disables.</p>
        </label>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={s.records.enabled} onChange={(e) => setS({ ...s, records: { enabled: e.target.checked } })} /> Maintain records board
        </label>
      </div>

      <div className="space-y-2 border-t border-line pt-3">
        <div className="stat-label">Health-score weights {Math.abs(weightSum - 1) > 0.001 && <span className="text-accent-strong">(sum {weightSum.toFixed(2)}, should be 1.0)</span>}</div>
        <div className="flex flex-wrap gap-4">
          {HEALTH_KEYS.map((k) => (
            <label key={k.key} className="space-y-1">
              <span className="block stat-label">{k.label}</span>
              <input className={inp} type="number" step={0.05} min={0} max={1}
                value={String(s.health_score.weights[k.key] ?? 0)} onChange={(e) => setWeight(k.key, Number(e.target.value))} />
            </label>
          ))}
        </div>
        <p className="text-[11px] text-ink-faint">Relative contribution of each factor to the mesh health score. Keep the total near 1.0.</p>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-9 px-4 text-[13px]" onClick={save}>Save analytics settings</button>
        {msg && <span className="text-[12px] text-ok">{msg}</span>}
        {error && <span className="text-[12px] text-accent-strong">{error}</span>}
      </div>
    </section>
  );
}
