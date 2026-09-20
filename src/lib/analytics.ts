import { randomUUID } from "node:crypto";
import { effectiveConfig } from "../db/appsettings.ts";

// Server-side Google Analytics (GA4 Measurement Protocol). Sends backend events straight to
// GA over HTTPS, independent of any browser. Off unless analytics is enabled with server-side
// on and both a measurement id and api secret set. Server-only (imports the DB config layer);
// never import from a client component. Best-effort: failures are swallowed so analytics can
// never break a request. Note: without a persistent client_id, GA treats each event's random
// id as a distinct user, so this is best for event counts, not unique-user metrics.
export async function sendServerEvent(
  name: string,
  params: Record<string, unknown> = {},
  clientId?: string,
): Promise<boolean> {
  let a;
  try {
    a = (await effectiveConfig()).server.ui.analytics;
  } catch {
    return false;
  }
  if (!a.enabled || !a.server || !a.measurement_id || !a.api_secret) return false;

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(a.measurement_id)}&api_secret=${encodeURIComponent(a.api_secret)}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId || randomUUID(), events: [{ name, params }] }),
    });
    return true;
  } catch {
    return false;
  }
}
