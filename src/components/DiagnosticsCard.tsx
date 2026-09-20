"use client";

import { useState } from "react";

interface Bundle {
  generated_at: string;
  window_hours: number;
  version: string;
  liveness: Record<string, number | null>;
  ingest: { totals: Record<string, number>; by_broker: Record<string, number> };
  decode: { totals: Record<string, number> };
  classification: { totals: Record<string, number> };
  field_presence: Record<string, number | null>;
  tx: { confirmations: Record<string, number | null> };
  bridge: { forwards_by_direction: Record<string, number>; patched: number };
  warnings: string[];
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? "-" : String(v));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v}%`);

/** Sum a {key: count} map, for the "total across classes" figures. */
const sum = (m: Record<string, number> | undefined) =>
  m ? Object.values(m).reduce((a, b) => a + b, 0) : 0;

/**
 * 24-hour flow check. Runs the diagnostic bundle and shows the few numbers that answer "is data
 * arriving and being interpreted correctly", plus any warnings the server computed. The full
 * bundle is downloadable as JSON to attach to a bug report.
 */
export function DiagnosticsCard() {
  const [b, setB] = useState<Bundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/v1/admin/diagnostics");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setB(await r.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const cls = b?.classification.totals;
  const rfTotal = cls ? (cls.rf_direct ?? 0) + (cls.rf_direct_low_conf ?? 0) + (cls.rf_relayed ?? 0) : 0;

  return (
    <section className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow"><span className="eyebrow-bar" />Diagnostics (last 24h)</h2>
        <div className="flex items-center gap-2">
          {error && <span className="text-[11px] text-accent-strong">{error}</span>}
          <button className="btn h-9 px-3 text-[13px]" onClick={() => void run()} disabled={busy}>
            {busy ? "Checking..." : "Run check"}
          </button>
          <a className="btn btn-primary h-9 px-3 text-[13px]" href="/api/v1/admin/diagnostics?download=1">
            Download JSON
          </a>
        </div>
      </div>
      <p className="text-[12px] text-ink-faint">
        Counts and rates only, never payload bytes or secrets. Use the JSON when reporting a
        problem: it shows 24h of ingest, decode, classification, and TX outcomes.
      </p>

      {b && (
        <div className="space-y-3">
          {b.warnings.length === 0 ? (
            <p className="text-[13px] text-ok">No problems detected.</p>
          ) : (
            <ul className="space-y-1">
              {b.warnings.map((w, i) => (
                <li key={i} className="text-[13px] text-accent-strong">- {w}</li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-4">
            <Stat label="Brokers" v={`${num(b.liveness.brokers_connected)}/${num(b.liveness.brokers_total)}`} />
            <Stat label="Last rx" v={b.liveness.last_reception_age_sec === null ? "never" : `${b.liveness.last_reception_age_sec}s ago`} />
            <Stat label="Receptions" v={num(b.field_presence.receptions)} />
            <Stat label="Packets" v={String(sum(b.decode.totals))} />

            <Stat label="RF receptions" v={String(rfTotal)} />
            <Stat label="Direct (0-hop)" v={String(cls?.rf_direct ?? 0)} />
            <Stat label="Relayed" v={String(cls?.rf_relayed ?? 0)} />
            <Stat label="MQTT-injected" v={String(cls?.mqtt_injected ?? 0)} />

            <Stat label="With RSSI" v={pct(b.field_presence.pct_with_rssi)} />
            <Stat label="With hop_start" v={pct(b.field_presence.pct_with_hop_start)} />
            <Stat label="Malformed" v={String(b.decode.totals.malformed ?? 0)} />
            <Stat label="Encrypted" v={String(b.decode.totals.encrypted ?? 0)} />

            <Stat label="TX sent" v={num(b.tx.confirmations.sent_or_better)} />
            <Stat label="TX heard back" v={num(b.tx.confirmations.heard_back)} />
            <Stat label="TX failed" v={num(b.tx.confirmations.failed)} />
            <Stat label="Bridge/patch" v={`${sum(b.bridge.forwards_by_direction)}/${b.bridge.patched}`} />
          </div>
          <p className="text-[11px] text-ink-faint">
            v{b.version} - generated {b.generated_at}
          </p>
        </div>
      )}
    </section>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return (
    <div>
      <span className="block stat-label">{label}</span>
      <span className="text-ink">{v}</span>
    </div>
  );
}
