import { serviceRestartAtMs } from "../db/settings.ts";

// Poll for an admin-issued restart request and, when one arrives after this process booted, exit
// cleanly so systemd (Restart=always) relaunches it with the current code. This is how the admin
// "Restart" button reaches a background process without any direct IPC: the request is a DB row.
export function installRestartWatcher(service: "worker" | "ingest", intervalMs = 8000): void {
  const bootMs = Date.now();
  const timer = setInterval(async () => {
    try {
      const at = await serviceRestartAtMs(service);
      if (at > bootMs) {
        console.log(`[${service}] restart requested from the admin UI; exiting for systemd to relaunch`);
        clearInterval(timer);
        process.exit(0);
      }
    } catch { /* transient DB error: try again next tick */ }
  }, intervalMs);
  timer.unref?.();
}
