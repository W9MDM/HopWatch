// CLI helper for scripts/linux-autoupdate.sh: atomically claim a pending admin
// "Update now" request (the service='update' row written by /api/v1/admin/service/update).
// Prints "1" if a request was pending (and consumes it), else "0". Reads the same
// bootstrap DB env as the app (the systemd unit's EnvironmentFile provides it).
import { getPool, closePool } from "../src/db/client.ts";

const op = process.argv[2];
if (op !== "claim") {
  console.error("usage: node scripts/update-request.ts claim");
  process.exit(2);
}

try {
  const [r] = await getPool().execute(`DELETE FROM service_control WHERE service = 'update'`);
  console.log((r as { affectedRows: number }).affectedRows > 0 ? "1" : "0");
} catch {
  console.log("0"); // table missing or DB down: treat as no pending request
} finally {
  await closePool().catch(() => {});
}
