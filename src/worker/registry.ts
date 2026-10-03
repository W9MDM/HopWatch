import { getSelfId, getLastAnnounce, setLastAnnounce } from "../db/registry.ts";
import { appVersion } from "../lib/version.ts";
import type { HopWatchConfig } from "../config/schema.ts";

// Opt-in instance registry: announce THIS deployment to a hub so a directory of HopWatch
// instances exists. Off by default (registry.announce.enabled). The heartbeat is minimal
// identity only (stable id, name, public URL, version) sent over HTTP, never the mesh, and
// carries no node data, telemetry, or secrets.
export async function runRegistryAnnounce(cfg: HopWatchConfig): Promise<boolean> {
  const a = cfg.registry.announce;
  if (!a.enabled) return false;

  // Pace by the configured interval so the 30-min slow loop cannot over-announce if retuned.
  const last = await getLastAnnounce();
  if (last && (Date.now() - last.getTime()) / 60000 < a.interval_minutes) return false;

  const hub = a.hub_url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(hub)) return false; // no / invalid hub configured

  const name = (a.name || cfg.server.ui.brand_name || "").slice(0, 191);
  const url = (a.public_url || cfg.server.public_url || "").slice(0, 512);
  const id = await getSelfId();

  try {
    const res = await fetch(`${hub}/api/v1/registry/announce`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `HopWatch/${appVersion()}` },
      body: JSON.stringify({ id, name, url, version: appVersion() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false; // hub rejected or is down: retry next slow tick
  } catch {
    return false; // hub unreachable: retry next slow tick
  }
  await setLastAnnounce(new Date());
  return true;
}
