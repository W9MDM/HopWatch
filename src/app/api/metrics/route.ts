import { type NextRequest } from "next/server";
import { Registry, Gauge } from "prom-client";
import { getDashboard, getHealth } from "../../../db/queries.ts";
import { effectiveConfig } from "../../../db/appsettings.ts";
import { metricsAuthorized } from "../../../auth/metrics.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Prometheus /metrics. A fresh registry per scrape keeps values consistent and
// avoids duplicate-registration across hot reloads. Public by default (scrapers are
// unauthenticated); when server.metrics_public is off, a valid session or bearer token
// is required so topology counts are not world-readable.
export async function GET(req: NextRequest) {
  let metricsPublic = true;
  try {
    metricsPublic = (await effectiveConfig()).server.metrics_public;
  } catch {
    /* config unreadable: keep the historical public default rather than locking out scrapers */
  }
  if (!metricsPublic && !(await metricsAuthorized(req))) {
    return new Response("# metrics access requires authentication\n", {
      status: 401,
      headers: { "content-type": "text/plain", "www-authenticate": "Bearer" },
    });
  }
  const reg = new Registry();
  const g = (name: string, help: string, labels: string[] = []) =>
    new Gauge({ name, help, labelNames: labels, registers: [reg] });

  try {
    const [dash, health] = await Promise.all([getDashboard(), getHealth()]);

    g("hopwatch_nodes_total", "Known nodes").set(dash.totalNodes);
    g("hopwatch_active_nodes_24h", "Active nodes in last 24h").set(dash.activeNodes24h);
    g("hopwatch_gateways_active", "Active gateways").set(dash.gateways);
    g("hopwatch_direct_pairs_total", "Confirmed direct (gateway,node) pairs").set(dash.directPairs);
    g("hopwatch_receptions_24h", "Receptions in last 24h").set(dash.receptions24h);
    g("hopwatch_packets_24h", "Logical packets in last 24h").set(dash.packets24h);

    const lag = g("hopwatch_ingest_lag_seconds", "Avg gateway->ingest lag (5m)");
    if (health.ingestLagSeconds !== null) lag.set(health.ingestLagSeconds);

    const wm = g("hopwatch_rollup_watermark_age_seconds", "Age of hourly rollup watermark");
    if (health.rollupWatermarkAgeSeconds !== null) wm.set(health.rollupWatermarkAgeSeconds);

    const connected = g("hopwatch_broker_connected", "Broker connection state (1/0)", ["broker"]);
    const messages = g("hopwatch_broker_messages_total", "Broker messages", ["broker"]);
    const malformed = g("hopwatch_broker_malformed_total", "Broker malformed messages", ["broker"]);
    for (const b of health.brokers) {
      connected.set({ broker: b.broker_id }, b.connected ? 1 : 0);
      messages.set({ broker: b.broker_id }, Number(b.messages));
      malformed.set({ broker: b.broker_id }, Number(b.malformed));
    }

    const body = await reg.metrics();
    return new Response(body, { headers: { "content-type": reg.contentType } });
  } catch (e) {
    console.error(`[metrics] ${(e as Error).message}`);
    return new Response(`# error collecting metrics\n`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }
}
