import { z } from "zod";
import { MODULE_KEYS as RBAC_MODULE_KEYS } from "../auth/modules.ts";

// Full HopWatch config schema (spec §6). Every key has a default where sensible so a
// minimal YAML still boots. Validation refinements produce actionable errors at startup.

const tileProvider = z.object({
  name: z.string().default("osm"),
  url_template: z
    .string()
    .default("https://tile.openstreetmap.org/{z}/{x}/{y}.png")
    .refine((u) => u.includes("{z}") && u.includes("{x}") && u.includes("{y}"), {
      message: "tile url_template must contain the {z}/{x}/{y} placeholders",
    }),
  attribution: z.string().default("© OpenStreetMap contributors"),
  api_key: z.string().default(""),
});

// The DARK basemap for the map dark/light toggle (light uses tile_provider above). Separate because
// OSM has no dark raster, so the dark map has always used CARTO. CARTO now requires an API key on
// the raster tiles (free to 5M/month), passed as `?key=YOUR_KEY` on the URL, so this is a full,
// pasteable URL template rather than a hardcoded constant: an operator drops in their keyed CARTO
// URL, or any other dark raster provider, in /admin/settings. The default keeps the historical
// keyless CARTO URL so nothing changes on upgrade, but that URL now shows CARTO's add-a-key notice
// until a key is supplied.
const tileProviderDark = z.object({
  url_template: z
    .string()
    .default("https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png")
    .refine((u) => u.includes("{z}") && u.includes("{x}") && u.includes("{y}"), {
      message: "dark tile url_template must contain the {z}/{x}/{y} placeholders",
    }),
  attribution: z.string().default("© OpenStreetMap © CARTO"),
});

const roleColors = z
  .record(z.string(), z.string())
  .default({
    CLIENT: "#3b82f6",
    CLIENT_MUTE: "#9ca3af",
    ROUTER: "#22c55e",
    ROUTER_CLIENT: "#16a34a",
    REPEATER: "#f59e0b",
  });

const server = z
  .object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().positive().default(3000),
    local_timezone: z
      .string()
      .default("UTC")
      .refine(isValidTimeZone, { message: "local_timezone must be a valid IANA timezone (e.g. America/Chicago)" }),
    auth: z
      .object({
        anonymous_read_only: z.boolean().default(true),
        // HMAC key for admin session cookies. Set via env for stable sessions across restarts.
        session_secret: z.string().default(""),
        session_ttl_hours: z.number().int().positive().default(720), // 30 days
        admin_users_seed: z
          .array(z.object({ username: z.string(), password: z.string() }))
          .default([]),
        // Discord SSO. client_secret is encrypted at rest (SECRET_PATHS). Configure in
        // /admin/settings; users link Discord to their account, then log in with Discord.
        discord: z
          .object({
            enabled: z.boolean().default(false),
            client_id: z.string().default(""),
            client_secret: z.string().default(""),
            redirect_url: z.string().default(""), // e.g. https://host/api/v1/auth/discord/callback
            // When true, a Discord login with no linked account creates one automatically
            // (as a non-admin `member`) and signs in. When false, only pre-linked accounts sign in.
            auto_provision: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
    // Canonical public origin (e.g. https://hopwatch.example.com), used for absolute OpenGraph/
    // social-share URLs and canonical links. Empty = derive from the request (fine for most
    // crawlers). No trailing slash.
    public_url: z.string().default(""),
    // Prometheus /api/metrics exposure. Public by default (the historical behavior: scrapers
    // are usually unauthenticated and restricted at the network). When false, /api/metrics
    // requires an admin session or a bearer token, so topology counts are not world-readable.
    metrics_public: z.boolean().default(true),
    // Update checker: compares the running version to the latest GitHub release of `github_repo`
    // and prompts an admin in /admin -> Service controls when a newer one exists. The self-update
    // itself is the existing `service/update` flow. Set enabled false (or repoint github_repo to a
    // fork) as needed; a check never installs anything on its own.
    updates: z
      .object({
        enabled: z.boolean().default(true),
        github_repo: z.string().default("W9MDM/HopWatch"),
      })
      .default({}),
    // Location privacy. Meshtastic nodes self-report GPS at full precision, which can pin a
    // hobbyist's home. When fuzz_positions is on, displayed coordinates (maps + public API,
    // including the position-estimate pair and node movement tracks) are rounded to
    // fuzz_decimals places (2 ~= 1.1km, 3 ~= 110m) for non-admins; admins and
    // a node's own owner still see the true fix. Off by default (no behavior change on upgrade).
    privacy: z
      .object({
        fuzz_positions: z.boolean().default(false),
        fuzz_decimals: z.number().int().min(0).max(5).default(2),
      })
      .default({}),
    ui: z
      .object({
        brand_name: z.string().default("HopWatch"),
        // Optional brand icon shown in the header, as a data: URI (uploaded in the admin UI)
        // or an image URL. Empty = the default accent bar.
        brand_icon: z.string().default(""),
        tile_provider: tileProvider.default({}),
        tile_provider_dark: tileProviderDark.default({}),
        role_colors: roleColors,
        // Display unit for temperatures (telemetry is ingested in Celsius from the firmware).
        temperature_unit: z.enum(["c", "f"]).default("f"),
        // Optional Google Analytics (GA4). Off by default (a fresh install sends nothing).
        // `client` injects gtag.js for browser pageviews; `server` enables server-side
        // Measurement Protocol events (api_secret is encrypted at rest, see SECRET_PATHS).
        analytics: z
          .object({
            enabled: z.boolean().default(false),
            measurement_id: z.string().default(""), // G-XXXXXXXX
            client: z.boolean().default(true),
            server: z.boolean().default(false),
            api_secret: z.string().default(""), // Measurement Protocol secret (server only)
          })
          .default({}),
        // Default "max age" node filter (minutes; 0 = show all) per map. Users can still
        // override per-browser with the map's Max-age slider.
        map_max_age: z
          .object({
            map: z.number().int().nonnegative().default(0),
            livemap: z.number().int().nonnegative().default(0),
          })
          .default({}),
        // Default center for all maps (/map, /livemap, /coverage). When lat/lon are set, maps
        // open here at `zoom` instead of auto-fitting to the first node. Null = auto (old behavior).
        map_center: z
          .object({
            lat: z.number().min(-90).max(90).nullable().default(null),
            lon: z.number().min(-180).max(180).nullable().default(null),
            zoom: z.number().min(0).max(20).default(9),
          })
          .default({}),
        // Optional external links shown as icons in the header. Empty = the icon is hidden.
        social_links: z
          .object({
            facebook: z.string().default(""),
            discord: z.string().default(""),
            website: z.string().default(""),
          })
          .default({}),
      })
      .default({}),
  })
  .default({});

const mysql = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(3306),
  // When set, connect over this unix socket instead of host/port (MariaDB socket login).
  socket_path: z.string().default(""),
  database: z.string().default("hopwatch"),
  user: z.string().default("hopwatch"),
  password: z.string().default(""),
  tls: z
    .object({
      enabled: z.boolean().default(false),
      ca_file: z.string().default(""),
      reject_unauthorized: z.boolean().default(true),
    })
    .default({}),
  pool: z
    .object({ min: z.number().int().nonnegative().default(10), max: z.number().int().positive().default(40) })
    .default({}),
});

const database = z
  .object({
    // MySQL/MariaDB only (Rule 7). The mode key is retained for forward-compat but has one value.
    mode: z.enum(["mysql"]).default("mysql"),
    mysql: mysql.default({}),
    partitioning: z
      .object({
        granularity: z.enum(["day", "week"]).default("day"),
        precreate_ahead_days: z.number().int().positive().default(7),
      })
      .default({}),
  })
  .default({});

const retention = z
  .object({
    raw_payload_days: z.number().int().nonnegative().default(14),
    decoded_packet_days: z.number().int().nonnegative().default(90),
    telemetry_days: z.number().int().nonnegative().default(365),
    live_events_minutes: z.number().int().positive().default(10),
    reception_rollup_hour_days: z.number().int().positive().default(365),
    rollups_indefinite: z.boolean().default(true),
    // Activity-driven event tables (text messages, position/identity/link events) grow forever
    // otherwise; pruned by age. 0 disables (keep forever).
    event_history_days: z.number().int().nonnegative().default(365),
    // Non-partitioned rollup tables (node_rollup_hour, reception_rollup_day): pruned by age only
    // when rollups_indefinite is false.
    rollup_days: z.number().int().positive().default(730),
  })
  .refine((r) => r.raw_payload_days <= r.decoded_packet_days, {
    message: "retention.raw_payload_days must be <= retention.decoded_packet_days",
  })
  .default({});

const tls = z
  .object({
    enabled: z.boolean().default(false),
    insecure_skip_verify: z.boolean().default(false),
    ca_file: z.string().default(""),
    cert_file: z.string().default(""),
    key_file: z.string().default(""),
  })
  .default({});

const broker = z.object({
  id: z.string(),
  host: z.string(),
  port: z.number().int().positive().default(1883),
  username: z.string().default(""),
  password: z.string().default(""),
  client_id: z.string().default(""),
  tls: tls,
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
  topics: z.array(z.string()).min(1, "each broker needs at least one topic"),
  // This broker's Meshtastic topic root (e.g. msh/US/IN/NWI). Used by the MQTT bridge to
  // rewrite forwarded messages onto this broker's namespace. Empty = derive from `topics`.
  root_topic: z.string().default(""),
  // Path to this broker's Mosquitto log file, readable by the ingest process. When set, ingest
  // parses it to list the clients currently connected to the broker (Mosquitto does not expose
  // per-client identity over $SYS). Only meaningful for a broker running on the ingest host; empty
  // disables it. Not a secret.
  log_file: z.string().default(""),
});

const channelKey = z.object({
  name: z.string(),
  key: z.string().refine((k) => k === "" || isBase64(k), { message: "channel key must be base64 or empty" }),
});

const ingest = z
  .object({
    idempotency_window_seconds: z.number().int().positive().default(300),
    brokers: z.array(broker).min(1, "at least one broker must be configured"),
    decode: z
      .object({
        tolerate_malformed: z.boolean().default(true),
        // "default" covers the LongFast default channel; LongTurbo is the US firmware default as of
        // v2.8 and uses the same default key, so seed it too for correct channel attribution.
        channel_keys: z.array(channelKey).default([{ name: "default", key: "AQ==" }, { name: "LongTurbo", key: "AQ==" }]),
      })
      .default({}),
  });

const alertRule = z
  .object({
    id: z.string(),
    type: z.enum([
      "node_offline",
      "battery_threshold",
      "spoof_flag",
      "new_node",
      "gateway_silent",
      "channel_util",
      "battery_forecast",
    ]),
    enabled: z.boolean().default(true),
    channels: z.array(z.enum(["webhook", "ntfy", "discord", "smtp"])).default([]),
  })
  .passthrough(); // rule-type-specific fields (threshold_minutes, threshold_volts, ...) validated per type in code

const alerts = z
  .object({
    enabled: z.boolean().default(true),
    delivery: z
      .object({
        webhook: z.array(z.string().url()).default([]),
        ntfy: z.array(z.string()).default([]),
        // Discord webhook delivery: posts alerts/digests to a Discord channel as a branded identity.
        // Each webhook URL embeds a secret token (encrypted at rest via SECRET_PATHS, Rule 6). The
        // username + avatar are the per-message "send as" override Discord honors, so posts appear as
        // e.g. "HopWatch" with your logo rather than a person or a generic bot name.
        discord: z
          .object({
            username: z.string().default("HopWatch"),
            avatar_url: z.string().default(""),
            webhooks: z.array(z.string().url()).default([]),
          })
          .default({}),
        smtp: z
          .object({
            host: z.string().default(""),
            port: z.number().int().default(587),
            user: z.string().default(""),
            password: z.string().default(""),
            from: z.string().default(""),
            starttls: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
    rules: z.array(alertRule).default([]),
  })
  .default({});

const analytics = z
  .object({
    mute: z.object({ seed: z.array(z.number().int()).default([]) }).default({}),
    spam_score: z
      .object({
        window_hours: z.number().int().positive().default(24),
      })
      .default({}),
    health_score: z
      .object({
        weights: z.record(z.string(), z.number()).default({
          utilization: 0.25,
          delivery_ratio: 0.25,
          gateway_coverage: 0.2,
          active_node_trend: 0.15,
          anomalies: 0.15,
        }),
      })
      .default({}),
    records: z.object({ enabled: z.boolean().default(true) }).default({}),
    rollups: z
      .object({
        // How many already-folded hours the slow loop re-folds each run. The frontier watermark is
        // strictly monotonic, so without this a reception whose rx_time lands in a closed hour (a
        // gateway with a slow clock, or a store-and-forward replay carrying the original packet's
        // rx_time) is stored in `receptions` but appears in no rollup, permanently. The folds are
        // idempotent bucket upserts, so re-folding recomputes rather than double-counts. 0 disables.
        refold_hours: z.number().int().nonnegative().max(168).default(6),
      })
      .default({}),
  })
  .default({});

export const configSchema = z.object({
  version: z.literal(1),
  server: server,
  database: database,
  retention: retention,
  ingest: ingest,
  analytics: analytics,
  alerts: alerts,
  // Phase 4+ blocks are accepted now (off by default) so config need not change later.
  livemap: z
    .object({
      enabled: z.boolean().default(true),
      inference_window_hours: z.number().int().positive().default(24),
      gateway_rings_default: z.boolean().default(true),
      audio_default: z.boolean().default(false),
      max_animations_per_sec: z.number().int().positive().default(50),
      trail_decay_seconds: z.number().int().positive().default(30),
    })
    .default({}),
  // RF / propagation jobs. Structured (not a freeform record) so link budget, propagation
  // detection, and weather ingest are editable in /admin/settings (DB-backed, hot-reloaded)
  // per CLAUDE.md Rule 1, instead of only via YAML/env. Passthrough keeps any extra keys.
  rf: z
    .object({
      link_budget: z
        .object({
          enabled: z.boolean().default(false),
          max_distance_km: z.number().positive().default(60),
          terrain: z.boolean().default(false),
          antenna_height_m: z.number().default(3),
          elevation_url: z.string().default("https://api.open-elevation.com/api/v1/lookup"),
        })
        .default({}),
      propagation: z
        .object({
          enabled: z.boolean().default(false),
          baseline_window_hours: z.number().int().positive().default(24),
          // A link must beat its rolling baseline by this many dB to log an enhancement event.
          improvement_threshold_db: z.number().positive().default(10),
          // A node farther than this (km) heard direct for the first time logs a DX event.
          dx_distance_threshold_km: z.number().positive().default(25),
        })
        .default({}),
      weather: z
        .object({
          enabled: z.boolean().default(false),
          stations: z.array(z.string()).default([]),
        })
        .default({}),
      // Solar/geomagnetic space weather from NOAA SWPC. Provides propagation context
      // (geomagnetic Kp, 10.7cm solar flux, solar wind) alongside detected DX/enhancements.
      space_weather: z
        .object({
          enabled: z.boolean().default(false),
          refresh_interval_minutes: z.number().int().positive().default(30),
          kp_url: z.string().default("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"),
          flux_url: z.string().default("https://services.swpc.noaa.gov/products/summary/10cm-flux.json"),
          solar_wind_url: z.string().default("https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json"),
        })
        .default({}),
    })
    .passthrough()
    .default({}),
  // Estimated positions for nodes that never transmit a location. This is estimation,
  // not GPS: results live in a separate table, are labelled position_source=estimated,
  // and never merge with or shadow a real position row.
  position_estimation: z
    .object({
      enabled: z.boolean().default(true),
      window_days: z.number().int().positive().default(7),
      recompute_interval_minutes: z.number().int().positive().default(60),
      path_loss_exponent: z.number().positive().default(2.7),
      reference_loss_db_1km: z.number().default(100),
      min_receptions_per_pair: z.number().int().positive().default(5),
      mobile_variance_threshold_db: z.number().positive().default(12),
      use_terrain_refinement: z.boolean().default(false),
      feed_coverage_heatmap: z.boolean().default(false),
    })
    .default({}),
  // Two-way mesh TX subsystem (v2.0). Passive by default: TX only happens when `enabled`
  // AND `armed` are both true and `dry_run` is false. Managed in /admin/tx (DB-backed,
  // hot-reloaded); defaults live here per CLAUDE.md Rule 1.
  tx: z
    .object({
      enabled: z.boolean().default(false),
      armed: z.boolean().default(false),
      dry_run: z.boolean().default(true),
      transport: z.enum(["mqtt", "node"]).default("mqtt"),
      broker_id: z.string().default(""), // which broker the mqtt transport publishes to ("" = first enabled)
      default_hop_limit: z.number().int().min(0).max(7).default(3),
      max_hop_limit: z.number().int().min(0).max(7).default(3),
      rate_limit: z
        .object({
          per_minute: z.number().int().positive().default(3),
          per_hour: z.number().int().positive().default(30),
        })
        .default({}),
      max_channel_util: z.number().min(0).max(100).default(25),
      from_node: z.number().int().nonnegative().default(0), // 0 = unset; required before arming
      // Set the OK-to-MQTT bit (Data.bitfield bit 0) on packets HopWatch transmits, so
      // gateways (and MQTT bridges that honor it) will uplink our own traffic to MQTT. Default
      // true. For the node (RF) transport the station node's own config_ok_to_mqtt LoRa setting
      // is the authoritative lever; this bit is set on the packet regardless.
      ok_to_mqtt: z.boolean().default(true),
      node_long_name: z.string().default("HopWatch"), // used by the optional NODEINFO announce
      node_short_name: z.string().default("HOPW"),
      // Deprecated and unused. The MQTT downlink topic root comes from the target broker's
      // root_topic (effectiveTopicRoot), because the firmware builds `<root>/2/e/<channel>/<node>`
      // with no region segment. Kept so existing saved overrides still validate.
      region: z.string().default("US"),
      announce_interval_s: z.number().int().nonnegative().default(0), // 0 = never
      traceroute_cooldown_s: z.number().int().nonnegative().default(300),
      auto_responder: z
        .object({
          enabled: z.boolean().default(false),
          cooldown_s: z.number().int().nonnegative().default(300), // per node+trigger
          respond_to_dm: z.boolean().default(true), // reply to direct messages to our node
          respond_to_channel: z.boolean().default(false), // reply on-channel to broadcasts
          // The channel a NON-DM reply is broadcast on. Empty = the channel the message arrived on
          // (the historical behaviour). Set this when the station node is not a member of every
          // channel it can DECODE: HopWatch may hold a key for a channel (so it decodes traffic
          // there) that the node cannot TRANSMIT on, and a "channel" reply on that channel is then
          // refused. Pinning it to a channel the node actually holds (e.g. LongFast) makes every
          // channel reply land regardless of where the trigger was heard.
          reply_channel: z.string().default(""),
          // Which link a reply goes out on, independent of whether it is a DM or a channel broadcast:
          //   "match" (default) -- reply on the transport the trigger was heard on: RF (station
          //     node) for a message heard on RF, MQTT (published to the broker it arrived on) for one
          //     heard via MQTT. This is what actually reaches the sender: a node heard only over MQTT
          //     (several hops away, not an RF neighbour) cannot be answered by an RF broadcast.
          //   "both" -- send on RF AND MQTT. Maximises reach when unsure, at the cost of the sender
          //     possibly seeing two copies.
          //   "fixed" -- always use tx.transport (the historical behaviour).
          reply_transport: z.enum(["match", "both", "fixed"]).default("match"),
          // Trigger list: first matching pattern wins. `pattern` is a case-insensitive regex matched
          // ANYWHERE in the message (so `\bping\b` fires on "ping test", "^ping$" only on exactly
          // "ping"). `reply` supports template variables:
          // {name} {short} {id} {rssi} {snr} {hops} {via} (RF/MQTT) {msg} {count} (active nodes, 24h) {time}.
          // `reply_via`: how to send the reply -- "match" (same as the incoming: DM->DM, channel->
          // channel broadcast), "dm" (always DM the sender), or "channel" (always broadcast on the
          // message's channel).
          triggers: z
            .array(z.object({
              pattern: z.string(),
              reply: z.string(),
              // Reply used when the message was heard over MQTT (no RSSI/SNR to report). When set it
              // replaces `reply` for MQTT-heard messages so {rssi}/{snr} do not render as "?"; blank
              // falls back to `reply`. RF-heard messages always use `reply`.
              reply_mqtt: z.string().default(""),
              reply_via: z.enum(["match", "dm", "channel"]).default("match"),
              // Only fire on these channels (by name); empty = any channel. Scope a trigger to a
              // specific channel (e.g. Testing) so a channel-broadcast reply lands there without the
              // trigger also firing on the main channel.
              channels: z.array(z.string()).default([]),
            }))
            .default([
              { pattern: "\\bping\\b", reply: "pong to {short}: {rssi} dBm / {snr} dB SNR, {hops} hop(s) via {via}", reply_via: "match" },
              { pattern: "\\btest\\b", reply: "ack {short}: heard you at {rssi} dBm / {snr} dB, {hops} hop(s) via {via}", reply_via: "match" },
            ]),
          // Greet nodes the first time they are heard, if within `within_hops` RF hops (0 = only
          // nodes we hear directly). Sent once per node (deduped via the outbox marker) to
          // newcomers first seen in the last hour. `reply_via`: "dm" to the newcomer, or "channel"
          // broadcast on `channel` (empty = the message's own / primary channel). Same reply vars.
          welcome: z
            .object({
              enabled: z.boolean().default(false),
              within_hops: z.number().int().min(0).max(7).default(0),
              reply_via: z.enum(["dm", "channel"]).default("channel"),
              channel: z.string().default(""),
              message: z.string().default("Welcome to the mesh, {name}! Heard you {hops} hop(s) away via {via}."),
            })
            .default({}),
          // Polite one-time nudge to a node that repeats the same short message many times in a
          // short window (a stuck tester spamming the mesh). Sent as a single DM to that node, then
          // silent for cooldown_minutes so the nudge itself never becomes spam. Off by default.
          // Template vars: {short} {name} {count} (repeats seen) {msg} (the repeated text).
          spam_nudge: z
            .object({
              enabled: z.boolean().default(false),
              threshold: z.number().int().min(2).default(6), // repeats of one message to trigger
              window_minutes: z.number().int().positive().default(10),
              cooldown_minutes: z.number().int().positive().default(60), // min gap between nudges to a node
              message: z.string().default("Hi {short}, we are seeing {count} repeats of the same message from you on the mesh. If you are testing, a couple is plenty. Thanks for keeping the airwaves clear! 73"),
            })
            .default({}),
        })
        .default({}),
      // Automatic topology mapping: the worker enqueues traceroutes only for active nodes
      // whose route is missing or older than interval_hours, so the same nodes are not traced
      // repeatedly. Requires TX enabled + armed + dry-run off (a traceroute must be sent).
      auto_traceroute: z
        .object({
          enabled: z.boolean().default(false),
          send_every_minutes: z.number().int().positive().default(5), // how often to emit a traceroute
          interval_hours: z.number().int().positive().default(24),
          max_per_run: z.number().int().positive().default(1),
          max_active_age_hours: z.number().int().positive().default(24),
          // Traceroutes probe RF paths, so default to the station node (RF). Set "mqtt" to send
          // via a broker downlink instead. Maps to the outbox node transport.
          transport: z.enum(["rf", "mqtt"]).default("rf"),
          only_routers: z.boolean().default(false), // trace only router/repeater infrastructure
        })
        .default({}),
      // Remote-admin scanner: periodically send a DeviceMetadata admin request to active nodes via
      // the station node (which PKI-encrypts it as an authorized admin). Nodes that answer are
      // administrable and kept in a persistent record (remote_admin). Requires TX enabled + armed
      // + dry-run off and a station node.
      admin_scanner: z
        .object({
          enabled: z.boolean().default(false),
          interval_hours: z.number().int().positive().default(24), // retry nodes that have NOT answered, at most this often
          max_per_run: z.number().int().positive().default(3),
          max_active_age_hours: z.number().int().positive().default(24), // only probe recently-heard nodes
          // Confirmed (administrable) nodes are not re-probed by default; set >0 to re-verify them
          // only every this many hours (refreshes firmware / catches revoked access). 0 = never.
          reconfirm_hours: z.number().int().nonnegative().default(0),
        })
        .default({}),
      // Quick/canned messages shown as one-tap buttons in the compose box.
      canned_messages: z.array(z.string()).default([]),
    })
    .default({}),
  // Predicted RF coverage model (the /coverage range-ring layer). Meshtastic does not
  // broadcast power/height, so per-node overrides + these defaults drive the estimate.
  coverage: z
    .object({
      default_eirp_dbm: z.number().default(30), // regional EIRP cap (US ~30)
      default_height_m: z.number().positive().default(8),
      rx_height_m: z.number().positive().default(2), // assumed receiver antenna height
      rx_sensitivity_dbm: z.number().default(-128),
      path_loss_exponent: z.number().positive().default(2.7),
      reference_loss_db_1km: z.number().default(100),
      max_radius_km: z.number().positive().default(60),
    })
    .default({}),
  // MQTT text bridge (opt-in, off by default). Forwards TEXT_MESSAGE_APP packets between the
  // local broker and remote peer brokers, gated by the sender's OK-to-MQTT bit (see Rule 2).
  // Both `enabled` (config) and `armed` (runtime kill switch) must be true to forward anything.
  bridge: z
    .object({
      enabled: z.boolean().default(false),
      armed: z.boolean().default(false),
      text_only: z.boolean().default(true), // only bridge text messages; keep true
      require_ok_to_mqtt: z.boolean().default(true), // only bridge sender-approved packets
      // Which direction to federate: both, out (local -> peers only), or in (peers -> local only).
      direction: z.enum(["both", "out", "in"]).default("both"),
      // Channel names (e.g. LongFast) to bridge. Empty = all decodable text channels.
      channels: z.array(z.string()).default([]),
      local_broker_id: z.string().default(""), // which configured ingest broker is "ours"
      peer_broker_ids: z.array(z.string()).default([]), // configured brokers to bridge with
      // RF cross-link (requires the station node; rf_to_mqtt also needs node.rx_enabled).
      // rf_to_mqtt: publish RF-heard text to the local broker as a faithful gateway uplink
      //   (original sender preserved, re-encrypted with the channel key).
      // mqtt_to_rf: transmit MQTT-heard text onto RF, RE-ORIGINATED as HopWatch's own TX node
      //   via the armed tx_outbox (never spoofs the original sender).
      // patch_hold_seconds: wait this long before patching a message across; if it already
      //   reached the other transport on its own (e.g. a real gateway/your node bridged it, or
      //   it was heard on both), skip -- prevents doubling. Both directions off by default.
      rf_to_mqtt: z.boolean().default(false),
      mqtt_to_rf: z.boolean().default(false),
      patch_hold_seconds: z.number().int().min(3).max(600).default(20),
    })
    .default({}),
  // Optional station node (phase 2): direct TCP/HTTP link to a local Meshtastic node.
  node: z
    .object({
      host: z.string().default(""),
      port: z.number().int().positive().default(4403),
      // Ingest the station node's own RF receptions as a first-class source (transport=rf),
      // in addition to MQTT brokers. Off by default; opt-in once a node is connected.
      rx_enabled: z.boolean().default(false),
      // Keep the station node's on-device NodeDB trimmed so a RAM-constrained board (ESP32) does not
      // overfill and reboot-loop. When enabled, the worker periodically favorites repeaters/routers
      // (so neither this prune nor the firmware's own eviction drops them) and removes nodes not
      // heard within stale_days. Applied over the node admin API (like config writes), not RF TX.
      nodedb_maint: z
        .object({
          enabled: z.boolean().default(false),
          interval_hours: z.number().int().positive().default(24),
          stale_days: z.number().int().positive().default(7),
          favorite_repeaters: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),
  // Scheduled automations: templated messages sent on a daily time or a fixed interval. Each is
  // sent as our own TX node through the armed tx_outbox (RF or MQTT), so it obeys every TX rail +
  // audit. Templates support {count} {total} {gateways} {packets} {msgs} {time} {date} {brand}.
  automations: z
    .array(
      z.object({
        id: z.string(),
        enabled: z.boolean().default(true),
        kind: z.enum(["daily", "interval"]).default("daily"),
        at: z.string().default("09:00"), // HH:MM local (daily)
        every_minutes: z.number().int().positive().default(60), // interval
        transport: z.enum(["mqtt", "rf"]).default("mqtt"),
        channel: z.string().default(""),
        template: z.string().default(""),
      }),
    )
    .default([]),
  // Weather alerts: poll NWS active alerts for the configured UGC county/zone codes and broadcast
  // new matching ones to the mesh through the armed TX subsystem. Deduped by alert id.
  weather_alerts: z
    .object({
      enabled: z.boolean().default(false),
      zones: z.array(z.string()).default([]), // UGC county/zone codes, e.g. INC089, INZ011
      min_severity: z.enum(["Extreme", "Severe", "Moderate", "Minor", "Unknown"]).default("Severe"),
      events: z.array(z.string()).default([]), // optional event allow-list; empty = any (at/above severity)
      // EAS test events (Required Weekly/Monthly Test) carry no meaningful severity, so they can
      // never pass the threshold above. These separate toggles always send them when enabled,
      // bypassing both min_severity and the event allow-list.
      weekly_test: z.boolean().default(false),
      monthly_test: z.boolean().default(false),
      // Report only the areas that are in `zones`, and refuse an alert covering none of them.
      //
      // An NWS query for `zone=A,B` returns any alert affecting A or B, but the alert itself usually
      // covers far more: a Storm Prediction Center watch naming one local county names twenty
      // others, routinely across state lines. Broadcasting the whole list spends most of the mesh's
      // 220-character budget on counties nobody at this station cares about, and truncates away the
      // expiry. With this on, {area} names only the configured zones the alert actually covers.
      zones_only: z.boolean().default(true),
      channel: z.string().default(""),
      transport: z.enum(["rf", "mqtt"]).default("rf"),
      broker_id: z.string().default(""), // which broker to publish to when transport = mqtt ("" = first enabled)
      poll_minutes: z.number().int().positive().default(5),
      // Template vars: {event} {severity} {headline} {area} {expires} {onset} {sender}, plus
      // {area_all} for the alert's full area list regardless of zones_only.
      template: z.string().default("WX {event} ({severity}) {area} until {expires}"),
    })
    .default({}),
  // Role-based access control. Custom roles, each granting a set of module keys; managed in
  // /admin/roles (DB-backed, hot-reloaded). Anonymous users get `anonymous_role`; API tokens
  // default to `token_default_role`; a signed-in non-admin session maps to `member_role`
  // (admins always map to the admin role).
  rbac: z
    .object({
      anonymous_role: z.string().default("public"),
      token_default_role: z.string().default("viewer"),
      // Signed-in, non-admin accounts (e.g. auto-provisioned Discord logins) resolve to this
      // role. Defaults to "member": anonymous-level access plus owned nodes.
      member_role: z.string().default("member"),
      roles: z
        .array(
          z.object({
            key: z.string(),
            label: z.string(),
            admin: z.boolean().default(false),
            can_tx: z.boolean().default(false),
            modules: z.array(z.string()).default([]),
          }),
        )
        .default([
          { key: "admin", label: "Admin", admin: true, can_tx: true, modules: [...RBAC_MODULE_KEYS] },
          { key: "viewer", label: "Viewer", admin: false, can_tx: false, modules: RBAC_MODULE_KEYS.filter((k) => k !== "admin") },
          { key: "member", label: "Member (signed in)", admin: false, can_tx: false, modules: ["dashboard", "map", "livemap", "coverage", "history", "nodes", "owned", "watchlist", "power", "gateways", "messages", "records"] },
          { key: "public", label: "Public (anonymous)", admin: false, can_tx: false, modules: ["dashboard", "map", "livemap", "coverage", "history", "nodes", "power", "gateways", "messages", "records"] },
        ]),
    })
    .default({}),
  digest: z
    .object({
      enabled: z.boolean().default(false),
      time: z.string().default("08:00"), // HH:MM in server.local_timezone
      channels: z.array(z.enum(["webhook", "ntfy", "discord", "smtp"])).default([]),
      include: z.array(z.string()).default([]),
      attach_ics: z.boolean().default(true),
    })
    .default({}),
  features: z
    .object({
      live_views: z.boolean().default(true),
      aprs_is_export: z.boolean().default(false),
      reference_sheet_pdf: z.boolean().default(false),
      ambience_mode: z.boolean().default(false),
    })
    .default({}),
  // Discord slash-command bot, served over HTTP interactions (no persistent gateway; the web process
  // verifies each request's Ed25519 signature and replies). application_id + public_key are public;
  // bot_token is a live credential encrypted at rest (SECRET_PATHS, Rule 6). guild_id is optional: set
  // it to register commands to one server for instant availability (global commands take up to 1h).
  discord_bot: z
    .object({
      enabled: z.boolean().default(false),
      application_id: z.string().default(""),
      public_key: z.string().default(""),
      bot_token: z.string().default(""),
      guild_id: z.string().default(""),
    })
    .default({}),
  aprs_is: z.record(z.string(), z.unknown()).default({}),
});

export type HopWatchConfig = z.infer<typeof configSchema>;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return s.length !== 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  try {
    return Buffer.from(s, "base64").toString("base64").replace(/=+$/, "") === s.replace(/=+$/, "");
  } catch {
    return false;
  }
}
