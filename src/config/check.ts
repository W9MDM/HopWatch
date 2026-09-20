// `npm run config:check`: validate config and print a concise summary, or a
// friendly error. Used by operators before bringing the stack up.
import { loadConfig, ConfigError } from "./load.ts";

try {
  const cfg = loadConfig({ force: true });
  const brokerCount = cfg.ingest.brokers.length;
  const topicCount = cfg.ingest.brokers.reduce((n, b) => n + b.topics.length, 0);
  console.log("✓ config valid");
  console.log(`  brand            : ${cfg.server.ui.brand_name}`);
  console.log(`  db mode          : ${cfg.database.mode}`);
  console.log(`  timezone (render): ${cfg.server.local_timezone}`);
  console.log(`  brokers          : ${brokerCount} (${topicCount} topics)`);
  console.log(`  channel keys     : ${cfg.ingest.decode.channel_keys.map((k) => k.name).join(", ")}`);
  console.log(`  retention        : raw ${cfg.retention.raw_payload_days}d / decoded ${cfg.retention.decoded_packet_days}d / telemetry ${cfg.retention.telemetry_days}d`);
  console.log(`  alert rules      : ${cfg.alerts.rules.filter((r) => r.enabled).length} enabled`);
  console.log(`  anonymous read   : ${cfg.server.auth.anonymous_read_only}`);
  process.exit(0);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error("✗ " + e.message);
    process.exit(1);
  }
  throw e;
}
