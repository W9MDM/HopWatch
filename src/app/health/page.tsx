import { moduleDenied } from "../../components/ModuleGate.tsx";
import { getHealth, getSelfTestSignals } from "../../db/queries.ts";
import { effectiveConfig } from "../../db/appsettings.ts";
import { fmtAge, fmtNum } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";
import { DbError } from "../../components/DbError.tsx";
import { evaluateSelfTest, overallSelfTest, type SelfTestCheck } from "../../lib/selftest.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = { title: "Health" };

const DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-gold-ink", fail: "bg-accent-strong", off: "bg-ink-faint" };
const LABEL: Record<string, string> = { ok: "OK", warn: "WARN", fail: "FAIL", off: "OFF" };

export default async function HealthPage() {
  const __denied = await moduleDenied("health"); if (__denied) return __denied;
  let health;
  let checks: SelfTestCheck[] = [];
  try {
    health = await getHealth();
    const [sig, cfg] = await Promise.all([getSelfTestSignals(), effectiveConfig()]);
    checks = evaluateSelfTest({
      dbOk: true,
      brokersTotal: sig.brokersTotal,
      brokersConnected: sig.brokersConnected,
      lastReceptionAgeSec: sig.lastReceptionAgeSec,
      rollupWatermarkAgeSec: sig.rollupWatermarkAgeSec,
      healthAgeMin: sig.healthAgeMin,
      tx: { enabled: cfg.tx.enabled, armed: cfg.tx.armed, dryRun: cfg.tx.dry_run },
      weather: { enabled: cfg.rf.weather.enabled, ageMin: sig.weatherAgeMin },
      spaceWeather: { enabled: cfg.rf.space_weather.enabled, ageMin: sig.spaceWeatherAgeMin },
    });
  } catch (e) {
    return <DbError error={e} />;
  }
  const overall = overallSelfTest(checks);

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow"><span className="eyebrow-bar" />Self-test</h2>
          <span className={cn("text-sm font-semibold uppercase tracking-wide", overall === "ok" ? "text-ok" : overall === "warn" ? "text-gold-ink" : "text-accent-strong")}>
            {overall === "ok" ? "All systems nominal" : overall === "warn" ? "Degraded" : "Attention needed"}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {checks.map((c) => (
            <div key={c.name} className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2">
              <span className={cn("inline-block h-2.5 w-2.5 flex-none rounded-full", DOT[c.status])} />
              <span className="text-[13px] text-ink">{c.name}</span>
              <span className="ml-auto text-[11px] text-ink-faint">{c.detail}</span>
              <span className={cn("w-10 text-right text-[11px] font-semibold", c.status === "ok" ? "text-ok" : c.status === "warn" ? "text-gold-ink" : c.status === "fail" ? "text-accent-strong" : "text-ink-faint")}>{LABEL[c.status]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card">
          <div className="stat-label">Ingest lag (5m avg)</div>
          <div className="stat mt-1">
            {health.ingestLagSeconds === null ? "-" : `${health.ingestLagSeconds.toFixed(1)}s`}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Rollup watermark age</div>
          <div className="stat mt-1">
            {health.rollupWatermarkAgeSeconds === null ? "-" : `${Math.round(health.rollupWatermarkAgeSeconds / 60)}m`}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Brokers connected</div>
          <div className="stat mt-1">
            {health.brokers.filter((b) => b.connected).length} / {health.brokers.length}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="eyebrow mb-3">
          <span className="eyebrow-bar" />
          Brokers
        </h2>
        <table className="data">
          <thead>
            <tr>
              <th>Broker</th>
              <th>State</th>
              <th>Last msg</th>
              <th className="text-right">Messages</th>
              <th className="text-right">Malformed</th>
              <th className="text-right">Reconnects</th>
            </tr>
          </thead>
          <tbody>
            {health.brokers.length === 0 && (
              <tr>
                <td colSpan={6} className="text-ink-faint">
                  No broker has reported.
                </td>
              </tr>
            )}
            {health.brokers.map((b) => (
              <tr key={b.broker_id}>
                <td className="mono">{b.broker_id}</td>
                <td>
                  <span className={cn("pill", b.connected ? "pill-on" : "pill-off")}>
                    {b.connected ? "connected" : "down"}
                  </span>
                </td>
                <td className="text-ink-mute">{fmtAge(b.last_message_at)}</td>
                <td className="text-right tabular-nums">{fmtNum(b.messages)}</td>
                <td className="text-right tabular-nums text-rx-relayed">{fmtNum(b.malformed)}</td>
                <td className="text-right tabular-nums">{fmtNum(b.reconnects)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="eyebrow mb-3">
          <span className="eyebrow-bar" />
          Topic decode health
        </h2>
        <table className="data">
          <thead>
            <tr>
              <th>Topic</th>
              <th>Broker</th>
              <th className="text-right">Valid</th>
              <th className="text-right">Malformed</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {health.topics.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-faint">
                  No topics observed yet.
                </td>
              </tr>
            )}
            {health.topics.map((t) => (
              <tr key={t.broker_id + t.topic_path}>
                <td className="mono text-[11px]">{t.topic_path}</td>
                <td className="text-ink-mute">{t.broker_id}</td>
                <td className="text-right tabular-nums">{fmtNum(t.valid_count)}</td>
                <td className="text-right tabular-nums text-rx-relayed">{fmtNum(t.malformed_count)}</td>
                <td className="text-ink-faint">{t.last_error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
