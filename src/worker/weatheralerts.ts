import type { HopWatchConfig } from "../config/schema.ts";
import { enqueueTx, txLog } from "../db/tx.ts";
import { alertAlreadySent, recordAlertSent } from "../db/weatheralerts.ts";
import { alertMatches, isRequiredTest, fillAlert, matchedZoneAreas, type AlertLike } from "../lib/wxalerts.ts";

// Poll NWS active alerts for the configured UGC county/zone codes and broadcast new matching ones
// to the mesh via the armed tx_outbox. Deduped by alert id (nothing is sent twice). NWS is free and
// keyless; the `zone` param accepts county UGC codes (INC089) and forecast-zone codes (INZ011).
let lastPollMs = 0;

export async function runWeatherAlerts(cfg: HopWatchConfig): Promise<number> {
  const tx = cfg.tx;
  const wa = cfg.weather_alerts;
  if (!tx.enabled || !tx.armed || tx.from_node <= 0 || !wa?.enabled) return 0;
  if (!wa.zones?.length) return 0;

  // Respect the poll cadence (the tx loop ticks every ~10s; we do not want to hammer NWS).
  const now = Date.now();
  if (now - lastPollMs < Math.max(1, wa.poll_minutes) * 60_000) return 0;
  lastPollMs = now;

  const zones = wa.zones.map((z) => z.trim()).filter(Boolean).join(",");
  // NWS publishes the EAS Required Weekly/Monthly Test with status "Test", which an
  // actual-only query never returns; include test status only when a test toggle is on.
  const status = wa.weekly_test || wa.monthly_test ? "actual,test" : "actual";
  let alerts: AlertLike[] = [];
  try {
    const res = await fetch(`https://api.weather.gov/alerts/active?status=${status}&message_type=alert,update&zone=${encodeURIComponent(zones)}`, {
      headers: { "User-Agent": "HopWatch (+https://github.com/hopwatch)", Accept: "application/geo+json" },
    });
    if (!res.ok) { await txLog(`weather alerts: NWS returned ${res.status}`, { level: "warn" }); return 0; }
    const j: any = await res.json();
    alerts = (Array.isArray(j?.features) ? j.features : []).map((f: any) => {
      const p = f?.properties ?? {};
      // geocode.UGC is the per-area code list, positionally aligned with areaDesc. affectedZones
      // carries the same codes as URLs, so it is the fallback when geocode is absent.
      const ugc: string[] = Array.isArray(p?.geocode?.UGC)
        ? p.geocode.UGC.map((x: unknown) => String(x))
        : Array.isArray(p?.affectedZones)
          ? p.affectedZones.map((u: unknown) => String(u).split("/").pop() ?? "")
          : [];
      return { id: String(f?.id ?? p.id ?? ""), event: String(p.event ?? ""), severity: String(p.severity ?? "Unknown"),
        status: String(p.status ?? "Actual"),
        headline: p.headline ?? undefined, areaDesc: p.areaDesc ?? undefined, expires: p.expires ?? undefined,
        onset: p.onset ?? undefined, senderName: p.senderName ?? undefined,
        ugc: ugc.filter(Boolean) } as AlertLike;
    }).filter((a: AlertLike) => a.id && a.event);
  } catch (e) {
    await txLog(`weather alerts: fetch failed: ${(e as Error).message}`, { level: "warn" });
    return 0;
  }

  const zone = cfg.server.local_timezone;
  const zoneList = wa.zones.map((z) => z.trim()).filter(Boolean);
  const zonesOnly = wa.zones_only !== false;
  let n = 0;
  for (const a of alerts) {
    // Two ways in: a real (status Actual) alert passing the severity/event filters, or an
    // enabled EAS test event, which bypasses them (tests have no meaningful severity). The
    // Actual gate keeps other test-status messages from riding in through the filters.
    // Any test-status product for a configured zone counts when a test toggle is on, not just the
    // two exact "Required Weekly/Monthly Test" event names: NWS also issues tests as "Test Message"
    // and similar, which the exact-name check would silently drop. The zone query already scopes
    // this to the operator's area, so this only sends tests that actually cover a configured zone.
    const anyTest = (wa.weekly_test || wa.monthly_test) && String(a.status ?? "").toLowerCase() === "test";
    const testEvent = isRequiredTest(a, wa.weekly_test, wa.monthly_test) || anyTest;
    if (!testEvent && !(a.status === "Actual" && alertMatches(a, wa.min_severity, wa.events))) continue;

    // Restrict to the configured zones. An EAS test is deliberately exempt: it is a channel check,
    // not a weather event, and is not expected to name a local area.
    const matched = matchedZoneAreas(a, zoneList);
    let areaOverride: string | undefined;
    let matchedCodes: string | undefined;
    if (zonesOnly && !testEvent) {
      if (matched.length === 0) {
        // Nothing local. Normally unreachable (the NWS query already filters by zone), so this is
        // defence in depth: it catches a stray or over-broad zone code in the configured list, an
        // alert whose area lists we could not pair up, and any future change in what the query
        // returns. Either way, an alert that names no configured zone is not broadcast.
        continue;
      }
      areaOverride = matched.map((x) => x.name).join(", ");
      matchedCodes = matched.map((x) => x.ugc).join(",");
    }

    if (await alertAlreadySent(a.id)) continue;
    await enqueueTx({
      createdBy: `wx-alert`, transport: wa.transport === "mqtt" ? "mqtt" : "node",
      brokerId: wa.transport === "mqtt" ? wa.broker_id : null, kind: "text",
      channelId: wa.channel || null, toNode: null, fromNode: tx.from_node,
      payloadText: fillAlert(wa.template, a, zone, areaOverride), hopLimit: tx.default_hop_limit, wantAck: false,
    });
    // Record the area as BROADCAST, plus which configured zones matched. The zone list is what makes
    // a surprising broadcast self-diagnosing: an alert for somewhere unexpected names the zone code
    // in the operator's own list that let it through.
    await recordAlertSent({
      id: a.id, event: a.event, severity: a.severity,
      area: areaOverride ?? a.areaDesc,
      matchedZones: matchedCodes ?? (matched.length ? matched.map((x) => x.ugc).join(",") : undefined),
    });
    n++;
  }
  if (n) await txLog(`weather alerts: broadcast ${n} new alert(s)`);
  return n;
}
