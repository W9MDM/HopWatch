# HopWatch configuration reference

Config is a single YAML file (`config/hopwatch.yaml`, or `HOPWATCH_CONFIG`), validated at
startup against the Zod schema in `src/config/schema.ts` (the source of truth for keys and
defaults). Every key is overridable by an environment variable named
`HOPWATCH_<DOTTED_PATH_UPPERCASED>`, for example:

- `server.port` -> `HOPWATCH_SERVER_PORT`
- `database.mysql.password` -> `HOPWATCH_DATABASE_MYSQL_PASSWORD`
- `ingest.brokers[0].host` -> `HOPWATCH_INGEST_BROKERS_0_HOST`

`${VAR}` placeholders inside string values are resolved from the environment. All datetimes
are stored UTC; `server.local_timezone` only affects rendering. No em dashes anywhere.

**YAML is a first-run seed only.** MQTT brokers, channel keys, forwarding rules, and every
setting below are managed in the admin UI (`/admin/settings`, `/admin/tx`, `/admin/roles`),
stored in the database, and hot-reloaded within ~5s. YAML values seed the database on first
run; after that the database wins. Sensitive values (broker/SMTP passwords, Discord client
secret, forwarding targets) are AES-256-GCM encrypted at rest and never round-tripped to the
client. See `CLAUDE.md` Rule 1.

`alerts.delivery.webhook`, `alerts.delivery.ntfy` and `alerts.delivery.discord.webhooks` are
**encrypted at rest** and never returned to the browser: the URL carries its own bearer token, so
`GET /api/v1/admin/notifications` reports `webhook_count`/`ntfy_count`/`discord.webhook_count` instead
(the Discord `username`/`avatar_url` are branding, not secret, so they round-trip). In `/admin/settings` a blank box keeps the stored targets,
typing replaces them, and a "remove all stored targets" checkbox clears them, which is the same
idiom the SMTP password uses.

**Rotating the master key invalidates every stored secret.** They are all encrypted with
`HOPWATCH_MASTER_KEY` (falling back to `HOPWATCH_SESSION_SECRET`), so adding, changing or losing
that value makes all of them fail authentication at once, as does restoring a database dump onto a
host whose installer generated its own key. Each affected secret then reads as **unset** rather
than taking the process down: a broker connects without a password, a channel key decrypts nothing.
Every such value is named (never printed) once in the process log, and listed under `secrets`
plus a warning in `GET /api/v1/admin/diagnostics` and the `/admin` diagnostics card. Re-enter them
in `/admin/settings` to recover.

## server

| Key | Default | Description |
|---|---|---|
| `server.host` | `0.0.0.0` | Web bind address. Overridden by the `HOST` env var. |
| `server.port` | `3000` | Web/API listen port. Overridden by the `PORT` env var. |
| `server.local_timezone` | `UTC` | IANA zone for rendering. Validated at startup. |
| `server.auth.anonymous_read_only` | `true` | When true, anonymous users get the `rbac.anonymous_role` access. When false, reads (API and pages) require a signed-in session or a bearer token; anonymous requests are denied. Editable in `/admin/settings` -> Login &amp; Discord SSO. |
| `server.auth.session_secret` | `""` | HMAC key for admin session cookies. Set via env for stable sessions across restarts; an ephemeral key is generated if empty. |
| `server.auth.session_ttl_hours` | `720` | Admin/session cookie lifetime (30 days). |
| `server.auth.admin_users_seed` | `[]` | `{username, password}` list seeded once when `admin_users` is empty. |
| `server.auth.discord.enabled` | `false` | Enable Discord SSO login (see "Discord SSO" below). |
| `server.auth.discord.client_id` | `""` | Discord OAuth application client id. |
| `server.auth.discord.client_secret` | `""` | Discord OAuth client secret. Encrypted at rest. |
| `server.auth.discord.redirect_url` | `""` | OAuth callback, e.g. `https://host/api/v1/auth/discord/callback`. |
| `server.auth.discord.auto_provision` | `true` | When true, an unlinked Discord login creates a non-admin `member` account and signs in. When false, only pre-linked accounts sign in. |
| `server.metrics_public` | `true` | When true, `/api/metrics` (Prometheus) is world-readable (the historical default; scrapers are usually unauthenticated). When false, a signed-in session or bearer token is required. Editable in `/admin/settings` -> General -> Privacy &amp; exposure. |
| `server.updates.enabled` | `true` | When true, `/admin` Service controls checks GitHub for a newer release and prompts if one exists. The check only reads (never installs); the update itself is the `service/update` flow. Editable in `/admin/settings` -> General -> Software updates. |
| `server.updates.github_repo` | `"W9MDM/HopWatch"` | The `owner/name` repo whose latest release the update check compares against. Repoint it to a fork, or set `enabled` false to turn checking off. |
| `server.privacy.fuzz_positions` | `false` | When true, node coordinates shown on the maps and public API are rounded for non-admins so a self-reported home GPS is not pinned exactly. Admins always see the true fix. Covers every coordinate surface: `/map`, `/livemap`, `/coverage`, `/replay`, `/site-planner`, `/nodes/{id}` (its readout, mini-map and movement track), and the `map`, `livemap`, `history`, `replay` and `nodes/{id}` API routes, including the position estimate pair, not just the GPS pair. A node whose position an operator marked ignored (`/admin` per-node controls) is withheld from these surfaces entirely for non-admins, not merely rounded. `test/positionprivacy.test.ts` fails the build if a new coordinate surface skips the policy. |
| `server.privacy.fuzz_decimals` | `2` | Rounding precision when `fuzz_positions` is on: 1 ~= 11 km, 2 ~= 1.1 km, 3 ~= 110 m, 4 ~= 11 m. |
| `server.ui.brand_name` | `HopWatch` | Shown in the header and footer. |
| `server.ui.brand_icon` | `""` | Optional header icon as a `data:` URI (uploaded in the admin UI) or image URL. Empty = the default accent bar. |
| `server.ui.tile_provider.name` | `osm` | Tile provider label. |
| `server.ui.tile_provider.url_template` | OSM | Raster tile URL; must contain `{z}/{x}/{y}`. |
| `server.ui.tile_provider.attribution` | OSM | Attribution string. |
| `server.ui.tile_provider.api_key` | `""` | Optional key for commercial tile providers. |
| `server.ui.tile_provider_dark.url_template` | CARTO dark | Raster tile URL for the map dark theme (light uses `tile_provider` above); must contain `{z}/{x}/{y}`. OpenStreetMap has no dark raster, so the default is CARTO, which now requires a free API key on its raster tiles: paste the full keyed URL, e.g. `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=YOUR_KEY` (get one at carto.com/basemaps/apikey, free to 5M tiles/month), or point at any other dark raster provider. Blank keeps the default (unkeyed) URL. |
| `server.ui.tile_provider_dark.attribution` | `© OpenStreetMap © CARTO` | Attribution for the dark basemap. |
| `server.ui.role_colors` | see example | Meshtastic node role -> hex, used across map, graph, tables. |
| `server.ui.temperature_unit` | `f` | Display unit for temperatures (`c` or `f`); telemetry is ingested in Celsius. |
| `server.ui.analytics.enabled` | `false` | Master switch for optional Google Analytics (GA4). Off = a fresh install sends nothing. |
| `server.ui.analytics.measurement_id` | `""` | GA4 measurement id (`G-XXXXXXXXXX`), used by both the client tag and server events. |
| `server.ui.analytics.client` | `true` | Inject `gtag.js` for browser pageviews/events (requires the CSP allowance for `googletagmanager.com`, already shipped). |
| `server.ui.analytics.server` | `false` | Send server-side events via the GA4 Measurement Protocol. |
| `server.ui.analytics.api_secret` | `""` | Measurement Protocol API secret (server-side only). Encrypted at rest; admin GET reports `has_api_secret`, never the value. |
| `server.ui.map_max_age.map` | `0` | Default node "max age" filter on `/map` in minutes (0 = show all). Viewers can override per-browser with the map slider. |
| `server.ui.map_max_age.livemap` | `0` | Default node "max age" filter on `/livemap` in minutes (0 = show all). |
| `server.ui.map_center.lat` / `.lon` | `null` | Default center for `/map`, `/livemap`, and `/coverage`. When both are set, maps open here; `null` (either unset) = auto-fit to nodes. Set via **/admin/settings -> Default map center** (type coordinates or click the map). |
| `server.ui.map_center.zoom` | `9` | Initial zoom when a center is set. |
| `node.host` / `node.port` | `""` / `4403` | Station node's stream-API address (TCP). Used for the station-node TX transport and RF receive. |
| `node.rx_enabled` | `false` | Ingest the station node's own RF receptions as a first-class source (tagged `transport=rf`), alongside MQTT brokers. Editable in `/admin/tx` -> Station node connection. |
| `node.nodedb_maint` | disabled | On-device NodeDB pruning so a RAM-constrained board (ESP32) does not overfill and reboot-loop. `{enabled, interval_hours (24), stale_days (7), favorite_repeaters (true)}`. When enabled, the worker every `interval_hours` favorites repeaters/routers (protected from prune and the firmware's own eviction) and removes nodes not heard within `stale_days`, over the node admin API (like config writes, not RF TX). Editable in `/admin/tx` -> Station node connection; "Prune now" runs it once. |
| `server.ui.social_links.website` / `.discord` / `.facebook` | `""` | Optional external links shown as icons in the header (website / Discord / Facebook). Each must be a full `http(s)` URL and opens in a new tab; empty hides that icon. Set in **/admin/settings -> General -> Header links**. |

### Discord SSO

When `server.auth.discord.enabled` is true, `/admin/login` offers "Sign in with Discord".
Register an OAuth app in the Discord developer portal, set the redirect to
`https://<host>/api/v1/auth/discord/callback`, and enter the client id/secret and redirect URL
in `/admin/settings`. A signed-in Discord user resolves to `rbac.member_role` (admins are
mapped by explicit account, not by Discord). Users can link/unlink Discord from their profile;
admins can force-unlink an account. With `auto_provision` off, a Discord login only succeeds
for an already-linked account.

### Discord bot (slash commands)

A Discord slash-command bot served over **HTTP interactions**: Discord POSTs each interaction to
`POST /api/v1/discord/interactions`, the web process verifies its Ed25519 signature against
`discord_bot.public_key`, and replies. There is no persistent gateway connection and no extra process.
Configure it in `/admin/settings -> Notifications -> Discord bot`.

| Key | Default | Description |
|---|---|---|
| `discord_bot.enabled` | `false` | When true the interactions endpoint answers Discord; when false it 404s. |
| `discord_bot.application_id` | `""` | Discord application id (used to register commands). |
| `discord_bot.public_key` | `""` | The application's Ed25519 public key (64 hex chars), used to verify every request. |
| `discord_bot.bot_token` | `""` | Bot token, used to register commands. Encrypted at rest; returned to the browser as `has_token` only. |
| `discord_bot.guild_id` | `""` | Optional. Set to register commands to one server (instant); blank registers globally (up to 1h to appear). |

Setup: create an application in the Discord developer portal, invite the bot with the `bot` and
`applications.commands` scopes, paste the application id, public key and bot token into the admin panel,
enable the bot and save, then paste the panel's **Interactions Endpoint URL**
(`https://<host>/api/v1/discord/interactions`) into the portal (Discord validates it with a signed
PING) and click **Register slash commands**. Commands: `/reach <node>`, `/node <query>`, `/myreach`
(uses the caller's linked Discord account), `/status`, `/claim`, and `/sendas <message>` (admin-only by
default; posts the pasted text into the channel as the bot, so name the application HopWatch and give it
Send Messages). The bot replies as its own configured identity (name + avatar set in the portal),
unlike the webhook channel which overrides the name per message.

## database

| Key | Default | Description |
|---|---|---|
| `database.mode` | `mysql` | Always `mysql` (MySQL/MariaDB only, per Rule 7). |
| `database.mysql.host` | `127.0.0.1` | MySQL/MariaDB host (ignored when `socket_path` is set). |
| `database.mysql.port` | `3306` | Port (ignored when `socket_path` is set). |
| `database.mysql.socket_path` | `""` | When set, connect over this unix socket instead of host/port (MariaDB socket login). The Linux installer sets this. |
| `database.mysql.database` / `user` / `password` | `hopwatch` | Credentials. |
| `database.mysql.tls.enabled` | `false` | Enable TLS to MySQL. |
| `database.mysql.tls.ca_file` | `""` | CA bundle for verifying the server certificate. |
| `database.mysql.tls.reject_unauthorized` | `true` | Reject certs that fail verification. |
| `database.mysql.pool.min` / `max` | `10` / `40` | Connection pool sizing. |
| `database.partitioning.granularity` | `day` | `day` or `week` partitions. |
| `database.partitioning.precreate_ahead_days` | `7` | Future partitions the worker pre-creates. |

## retention

| Key | Default | Description |
|---|---|---|
| `retention.raw_payload_days` | `14` | Encrypted payloads kept for re-decode. Must be <= `decoded_packet_days`. |
| `retention.decoded_packet_days` | `90` | `packets` + `receptions` partition retention. Held back when the hourly rollup fold is behind: a partition the fold has not consumed is the only copy of data no aggregate has recorded, so retention keeps it and logs that it is doing so. |
| `retention.telemetry_days` | `365` | Telemetry retention. |
| `retention.live_events_minutes` | `10` | SSE tail-table trim window. |
| `retention.reception_rollup_hour_days` | `365` | High-cardinality hourly rollup retention (daily kept indefinitely). |
| `retention.rollups_indefinite` | `true` | Keep node/day rollups forever; set false to prune them at `rollup_days`. When false, the daily rollup also stops re-aggregating days older than `rollup_days`, which previously re-inserted exactly the rows retention had just deleted. |
| `retention.event_history_days` | `365` | Age-prune the unbounded event tables (text_message, node/position/identity/link events, records_history); 0 = keep forever. |
| `retention.rollup_days` | `730` | Age cutoff for node_rollup_hour / reception_rollup_day when `rollups_indefinite` is false. |

## ingest

| Key | Default | Description |
|---|---|---|
| `ingest.idempotency_window_seconds` | `300` | Dedup bucket width; also the packet dedup window. Hot-reloads in the ingest daemon. |
| `ingest.brokers[]` | one entry | Per-broker `id, host, port, username, password, client_id, tls{...}, qos, topics[], root_topic, log_file`. Managed in `/admin/settings`. `root_topic` (e.g. `msh/US/IN/NWI`) is the broker's own topic namespace, used by the MQTT bridge to republish forwarded messages; blank derives it from the first subscribe topic. `log_file` (e.g. `/var/log/mosquitto/mosquitto.log`) is the broker's Mosquitto log path on the HopWatch host; when set and readable, ingest parses it to list the clients currently connected to that broker on `/brokers` (Mosquitto does not expose per-client identity over `$SYS`). Blank disables it. Not a secret. |
| `ingest.decode.tolerate_malformed` | `true` | Continue past malformed messages (counted per topic). |
| `ingest.geo_fence` | disabled | `{enabled, min_lat, max_lat, min_lon, max_lon}`. When enabled, the worker marks any node whose known position is outside this bounding box `position_ignored`, so a far-off region bridged in over MQTT stops polluting maps/coverage/graph. Hides (never deletes); only sets the flag, so it never undoes a manual ignore. Managed in `/admin/settings -> General -> Geo-fence`. |
| `ingest.decode.channel_keys[]` | `[{default, AQ==}, {LongTurbo, AQ==}, {Wardrive, AQ==}]` | `{name, key}` base64 channel keys, including the default `AQ==`, LongTurbo (the US firmware default as of Meshtastic v2.8, same default key), and Wardrive (a coverage-mapping channel; default key). The `name` is part of the wire identity, not a label: a key is tried only when `xorHash(name) ^ xorHash(key)` equals the 8-bit hash in `MeshPacket.channel`, so a key entered under the wrong channel name will not decrypt that channel. An empty `key` declares an unencrypted (PSK-less or ham-mode) channel, whose payload is plaintext and is read without decryption. |

## analytics

`analytics.mute.seed[]` (node ids hidden from default views),
`analytics.spam_score.window_hours`, `analytics.health_score.weights`
(`utilization, delivery_ratio, gateway_coverage, active_node_trend, anomalies`),
`analytics.records.enabled` (when false the worker skips the records board),
`analytics.rollups.refold_hours` (default `6`, max 168, 0 disables): how many already-closed hours
the slow loop re-aggregates each run. The hourly fold's watermark only moves forward, so without
this a reception whose `rx_time` falls in a closed hour (a gateway with a slow clock, or a
store-and-forward replay, which upstream re-sends carrying the original packet's `rx_time`) is stored
but appears in no rollup, permanently. The folds are idempotent bucket upserts, so re-folding
recomputes rather than double-counts.

`spam_score.window_hours`, `health_score.weights`, `records.enabled`, and `rollups.refold_hours`
are editable in
`/admin/settings` -> Analytics tuning (`POST /api/v1/admin/analytics`); they hot-reload on the
worker's next tick.

## alerts

| Key | Default | Description |
|---|---|---|
| `alerts.enabled` | `true` | Master switch. |
| `alerts.delivery.webhook[]` | `[]` | POST URLs (generic `{title, body}` JSON body). |
| `alerts.delivery.ntfy[]` | `[]` | ntfy topics or full URLs. |
| `alerts.delivery.discord.username` | `"HopWatch"` | The "send as" display name Discord shows on each post. |
| `alerts.delivery.discord.avatar_url` | `""` | Optional avatar image URL shown next to the name. |
| `alerts.delivery.discord.webhooks[]` | `[]` | Discord channel webhook URLs. Encrypted at rest. |
| `alerts.delivery.smtp.{host,port,user,password,from,starttls}` | empty | SMTP settings. |
| `alerts.rules[]` | see example | `{id, type, enabled, channels[]}` plus type fields. |

Channels are `webhook`, `ntfy`, `discord`, and `smtp`. The **discord** channel posts to a Discord
channel webhook formatted the way Discord expects (an embed), with the configured `username` and
`avatar_url` as the per-message "send as" override, so alerts appear from a branded identity (e.g.
HopWatch) rather than a person or a generic bot. Create the webhook in Discord under Channel -> Edit ->
Integrations -> Webhooks, paste its URL in `/admin/settings -> Notifications -> Discord`, and use
"Save &amp; send test post" to confirm it. Add `discord` to any rule's or the digest's `channels[]` to
route to it. `alerts.delivery.discord.webhooks` is encrypted at rest and reported to the browser as a
count only, exactly like `webhook`/`ntfy`.

Rule types and their required fields: `node_offline` (`threshold_minutes`), `battery_threshold`
(`threshold_volts`), `gateway_silent` (`threshold_minutes`), `channel_util` (`threshold_pct`),
`battery_forecast` (`days_ahead`), `spoof_flag`, `new_node`.

## livemap

| Key | Default | Description |
|---|---|---|
| `livemap.enabled` | `true` | Enable the live map SSE animations. |
| `livemap.inference_window_hours` | `24` | Window used to infer the topology underlay. |
| `livemap.gateway_rings_default` | `true` | Show gateway rings by default. |
| `livemap.audio_default` | `false` | Play audio pings by default. |
| `livemap.max_animations_per_sec` | `50` | Animation rate cap. |
| `livemap.trail_decay_seconds` | `30` | Pulse trail fade time. |

## rf (off by default)

| Key | Default | Description |
|---|---|---|
| `rf.link_budget.enabled` | `false` | Enable the link-budget validator (FSPL, Fresnel, optional terrain). |
| `rf.link_budget.max_distance_km` | `60` | Max link distance considered. |
| `rf.link_budget.terrain` | `false` | Use terrain/elevation lookups. |
| `rf.link_budget.antenna_height_m` | `3` | Assumed antenna height when unknown. |
| `rf.link_budget.elevation_url` | open-elevation | Elevation lookup endpoint. |
| `rf.propagation.enabled` | `false` | Enable tropospheric-propagation detection. |
| `rf.propagation.baseline_window_hours` | `24` | Rolling per-link RSSI baseline window. |
| `rf.propagation.improvement_threshold_db` | `10` | dB a link must beat its baseline by to log an `enhancement` event. |
| `rf.propagation.dx_distance_threshold_km` | `25` | Distance beyond which a first direct-heard node logs a `dx_direct` event. |
| `rf.weather.enabled` | `false` | Enable weather ingest. |
| `rf.weather.stations[]` | `[]` | Weather station identifiers. |
| `rf.space_weather.enabled` | `false` | Enable NOAA SWPC space-weather ingest (Kp, solar flux, solar wind), shown on `/propagation`. |
| `rf.space_weather.refresh_interval_minutes` | `30` | Minimum minutes between SWPC polls. |
| `rf.space_weather.kp_url` | SWPC planetary-K | Planetary Kp index product URL. |
| `rf.space_weather.flux_url` | SWPC 10cm flux | 10.7cm solar flux summary URL. |
| `rf.space_weather.solar_wind_url` | SWPC solar wind | Solar-wind speed summary URL. |

The `rf` block is `.passthrough()`, so extra keys are tolerated but have no effect unless the
code reads them.

## position_estimation

Estimates positions for nodes that never transmit a location. Results live in a separate table
(`position_estimate`), are labelled `position_source: estimated`, and never merge with a real
position. Recompute runs on the worker only.

| Key | Default | Description |
|---|---|---|
| `position_estimation.enabled` | `true` | Enable the estimator. |
| `position_estimation.window_days` | `7` | Reception window used per recompute. |
| `position_estimation.recompute_interval_minutes` | `60` | Worker recompute cadence. |
| `position_estimation.path_loss_exponent` | `2.7` | Log-distance path-loss exponent. |
| `position_estimation.reference_loss_db_1km` | `100` | Reference loss at 1 km. |
| `position_estimation.min_receptions_per_pair` | `5` | Minimum zero-hop receptions per gateway/node pair. |
| `position_estimation.mobile_variance_threshold_db` | `12` | RSSI variance above which the confidence radius widens (mobile node). |
| `position_estimation.use_terrain_refinement` | `false` | Refine with terrain. |
| `position_estimation.feed_coverage_heatmap` | `false` | Feed estimated positions into the coverage heatmap. |

## tx (transmit subsystem, off by default)

Passive by default: TX only happens when `tx.enabled` AND `tx.armed` are both true and
`tx.dry_run` is false. Managed in `/admin/tx`. See `docs/tx.md` for the full safety model.

| Key | Default | Description |
|---|---|---|
| `tx.enabled` | `false` | Master TX switch (config gate). |
| `tx.armed` | `false` | Runtime arm toggle; disarming is the kill switch. |
| `tx.dry_run` | `true` | Run the full pipeline but publish nothing (rows land in state `dry_run`). |
| `tx.transport` | `mqtt` | `mqtt` (publish `ServiceEnvelope`) or `node` (direct station-node link, see `node.*`). |
| `tx.broker_id` | `""` | Which broker the `mqtt` transport publishes to; empty = first enabled broker. |
| `tx.default_hop_limit` | `3` | Default hop limit for queued sends (0..7). |
| `tx.max_hop_limit` | `3` | Hard cap applied to every send (0..7). |
| `tx.rate_limit.per_minute` | `3` | Global sends per minute. |
| `tx.rate_limit.per_hour` | `30` | Global sends per hour. |
| `tx.max_channel_util` | `25` | Hold sends when mesh channel utilization exceeds this percent. |
| `tx.from_node` | `0` | Station node id (u32). Must be non-zero before arming. |
| `tx.ok_to_mqtt` | `true` | Set the OK-to-MQTT bit (`Data.bitfield` bit 0) on packets HopWatch sends, so gateways may uplink our own traffic to MQTT. |
| `tx.node_long_name` | `HopWatch` | Long name used by the optional NODEINFO announce. |
| `tx.node_short_name` | `HOPW` | Short name used by the announce. |
| `tx.region` | `US` | Deprecated and unused. The downlink topic root now comes from the target broker's `root_topic`, since the firmware topic has no region segment. |
| `tx.announce_interval_s` | `0` | Seconds between NODEINFO announces; `0` = never. |
| `tx.traceroute_cooldown_s` | `300` | Per-node traceroute cooldown. |
| `tx.auto_responder.enabled` | `false` | Auto-reply to matching inbound text. |
| `tx.auto_responder.respond_to_dm` / `.respond_to_channel` | `true` / `false` | React to DMs to our node and/or channel broadcasts. |
| `tx.auto_responder.triggers[]` | ping/test | `{pattern (regex), reply (template), reply_mqtt (template), reply_via}` list; first match wins. `pattern` is a case-insensitive regex matched anywhere (`\btest\b`, not `^test$`). `reply` is used for RF-heard messages; `reply_mqtt` (when non-blank) replaces it for MQTT-heard messages, which have no RSSI/SNR so `{rssi}/{snr}` would render as `?` (blank falls back to `reply`). `reply_via` is `match` (in-kind), `dm`, or `channel` (broadcast). Reply vars: `{name} {short} {id} {rssi} {snr} {hops} {via} {msg} {count} {time}`. |
| `tx.auto_responder.reply_channel` | `""` | Channel a non-DM reply broadcasts on (blank = the channel the message arrived on, then the first keyed channel). Set it to a channel the node can transmit on. |
| `tx.auto_responder.reply_transport` | `match` | Which link a reply goes out on: `match` (the transport it was heard on: RF->station node, MQTT->the broker it arrived on), `both`, or `fixed` (the configured TX transport). |
| `tx.auto_responder.cooldown_s` | `300` | Per node+trigger auto-reply cooldown. |
| `tx.auto_responder.welcome` | disabled | Greet first-time nodes within `within_hops` RF hops (0 = direct only), once per node. `{enabled, within_hops, reply_via (dm\|channel), channel, message (template)}`. A DM greeting rides the keyed channel the newcomer was last heard on (fallback: `channel`, then the first keyed channel). |
| `tx.auto_responder.spam_nudge` | disabled | Politely DM a node once when it repeats the same short message `threshold` times within `window_minutes` (a stuck tester spamming the mesh), then stay silent for `cooldown_minutes` per node so the nudge never becomes spam. `{enabled, threshold (6), window_minutes (10), cooldown_minutes (60), message (template: {short} {name} {count} {msg})}`. Sent as a DM on the transport the node was last heard on, through the armed `tx_outbox`. |
| `tx.admin_scanner` | disabled | Remote-admin scanner: probe recently-heard nodes for admin access via the station node; administrable nodes are kept in the persistent `remote_admin` table. `{enabled, interval_hours (retry non-answering nodes), max_per_run, max_active_age_hours, reconfirm_hours (re-verify confirmed nodes; 0 = never)}`. |
| `tx.canned_messages[]` | `[]` | Quick messages shown as one-tap buttons in the Messages compose box. |
| `tx.auto_traceroute.enabled` | `false` | Automatically traceroute active nodes with missing/stale routes. |
| `tx.auto_traceroute.send_every_minutes` | `5` | How often to emit a traceroute batch. Never emits while one is still queued (no stacking). |
| `tx.auto_traceroute.interval_hours` | `24` | Minimum age of a node's route before it is re-traced. |
| `tx.auto_traceroute.max_per_run` | `1` | Max auto-traceroutes enqueued per batch. |
| `tx.auto_traceroute.max_active_age_hours` | `24` | Only trace nodes active within this window. |
| `tx.auto_traceroute.transport` | `rf` | `rf` (station node) or `mqtt` (broker downlink). RF requires the node transport. |
| `tx.auto_traceroute.only_routers` | `false` | Trace only router/repeater/gateway infrastructure. |

## bridge (MQTT text federation, off by default)

Forwards text messages between the local broker and peer brokers, gated by OK-to-MQTT. See
`docs/bridge.md`. Managed in `/admin/bridge`.

| Key | Default | Description |
|---|---|---|
| `bridge.enabled` | `false` | Master switch. |
| `bridge.armed` | `false` | Runtime kill switch; nothing forwards until armed. |
| `bridge.text_only` | `true` | Only forward `TEXT_MESSAGE_APP` packets. |
| `bridge.require_ok_to_mqtt` | `true` | Only forward packets whose sender set OK-to-MQTT. |
| `bridge.direction` | `both` | `both`, `out` (local to peers only), or `in` (peers to local only). |
| `bridge.channels` | `[]` | Channel names to bridge; empty = all decodable text channels. |
| `bridge.local_broker_id` | `""` | Which configured ingest broker is "ours". |
| `bridge.peer_broker_ids` | `[]` | Configured brokers to bridge text with. |
| `bridge.rf_to_mqtt` | `false` | RF cross-link: publish RF-heard text to the local broker as a faithful gateway uplink (needs the station node + `node.rx_enabled`). |
| `bridge.mqtt_to_rf` | `false` | RF cross-link: transmit MQTT-heard text onto RF, re-originated as HopWatch's own TX node via the armed `tx_outbox`. |
| `bridge.patch_hold_seconds` | `20` | Wait before patching a message across; skip if it already reached the other transport on its own (prevents doubling). |

## node (optional station node, phase 2)

Direct link to a local Meshtastic node, used when `tx.transport` is `node`.

| Key | Default | Description |
|---|---|---|
| `node.host` | `""` | Station node host/IP (empty = disabled). |
| `node.port` | `4403` | Station node TCP port. |

## rbac (role-based access control)

Custom roles, each granting a set of module keys. Managed in `/admin/roles`. Module keys come
from `src/auth/modules.ts` (e.g. `dashboard`, `map`, `livemap`, `coverage`, `nodes`, `owned`,
`watchlist`, `packets`, `analytics`, `admin`, ...). See "RBAC and roles" in the README.

| Key | Default | Description |
|---|---|---|
| `rbac.anonymous_role` | `public` | Role assigned to anonymous requests. |
| `rbac.token_default_role` | `viewer` | Role for API tokens without an explicit `role_key`. |
| `rbac.member_role` | `member` | Role for signed-in non-admin accounts (e.g. Discord logins). |
| `rbac.roles[]` | admin/viewer/member/public | `{key, label, admin, can_tx, modules[]}`. A role with `admin: true` grants all modules; `can_tx: true` lets its members/tokens transmit. |

Seeded roles: `admin` (all modules + admin + can_tx), `viewer` (all except `admin`), `member`
(dashboard/map/livemap/coverage/history/nodes/owned/watchlist/routers/battery/gateways/messages/records),
`public` (member minus owned/watchlist/routers). The roles editor refuses to save if no admin
role would remain, and forbids an anonymous/token-default role that is an admin role.

## automations

`automations[]` (edited in `/admin/tx`): scheduled templated messages. Each `{id, enabled, kind
(daily|interval), at (HH:MM local), every_minutes, transport (mqtt|rf), channel, template}`. The
worker fires due ones through the armed `tx_outbox` (so they need the TX subsystem enabled +
armed, and obey every TX rail + audit). Template vars: `{count}` (active nodes 24h), `{total}`
(known nodes), `{gateways}`, `{packets}` (24h), `{msgs}` (texts 24h), `{time}`, `{date}`,
`{brand}`. Fire tracking uses the outbox marker so a restart never double-fires.

## weather_alerts

`weather_alerts` (edited in `/admin/settings` -> Weather alerts): broadcast NWS active alerts to
the mesh. `{enabled, zones[] (UGC county/zone codes, e.g. INC089/INZ011), min_severity
(Extreme|Severe|Moderate|Minor|Unknown), events[] (optional allow-list; empty = any),
zones_only, weekly_test, monthly_test, channel,
transport (rf|mqtt), broker_id (which broker when transport=mqtt; empty = first enabled),
poll_minutes, template}`. Channel and broker are picked from DB dropdowns in the UI. The worker polls `api.weather.gov/alerts/active`
(free/keyless) for the zones, filters by severity + event allow-list, and sends new alerts through
the armed `tx_outbox` (needs TX enabled + armed + dry-run off). Deduped by alert id in
`weather_alert_sent`. `weekly_test`/`monthly_test` (default off) always send the EAS Required
Weekly/Monthly Test when it appears: test events carry no meaningful severity, so they bypass
`min_severity` and `events[]` entirely (each has its own toggle, and enabling one also widens the
NWS poll to include test-status alerts).

`zones_only` (default **true**) scopes the broadcast to `zones[]`. An NWS query for `zone=A,B`
returns any alert affecting A or B, but the alert covers whatever it covers: a Storm Prediction
Center watch that clips one local county also names twenty others, routinely across state lines. With
`zones_only` on, `{area}` names only the configured zones the alert actually covers, and an alert
covering none of them is not broadcast at all. That matters because a mesh text caps at 220
characters: a sixteen-county watch fills the whole budget with county names and truncates away the
expiry time before it is sent. Matching is on the UGC code, not the county name, since names repeat
across states (there is a Lake county in both IL and IN) and the area format varies (a single-state
alert omits the state suffix a multi-state one includes). EAS test events are exempt, being a channel
check rather than a weather event. Turn it off to send the alert's full area list.

`weather_alert_sent.matched_zones` records which configured zones admitted each broadcast, shown in
the "Recently broadcast" table, so an alert for an unexpected area names the entry in your own zone
list that let it through.

Template vars: `{event} {severity} {headline} {area} {expires} {onset} {sender}`, plus `{area_all}`
for the alert's full area list regardless of `zones_only`.

## digest

`digest.{enabled, time (HH:MM local), channels[], include[], attach_ics}`. `include` is the
section allowlist; empty means every implemented section. Implemented sections: `new_nodes`,
`silent_nodes`, `spoof_flags`.

## features

`features.{live_views, aprs_is_export, reference_sheet_pdf, ambience_mode}`.

## coverage (predicted RF coverage range rings)

Meshtastic does not broadcast power/height, so per-node overrides plus these defaults drive the
`/coverage` range-ring estimate.

| Key | Default | Description |
|---|---|---|
| `coverage.default_eirp_dbm` | `30` | Assumed EIRP (regional cap, US ~30). |
| `coverage.default_height_m` | `8` | Assumed transmitter antenna height. |
| `coverage.rx_height_m` | `2` | Assumed receiver antenna height. |
| `coverage.rx_sensitivity_dbm` | `-128` | Assumed receiver sensitivity. |
| `coverage.path_loss_exponent` | `2.7` | Log-distance path-loss exponent. |
| `coverage.reference_loss_db_1km` | `100` | Reference loss at 1 km. |
| `coverage.max_radius_km` | `60` | Max ring radius drawn. |

## aprs_is

`aprs_is` is an open (`record`) block reserved for APRS-IS export configuration; gated by
`features.aprs_is_export`.

## Validation performed at startup

At least one broker with host/port/topics; retention coherence (`raw_payload_days <=
decoded_packet_days`); base64 channel keys; tile template contains `{z}/{x}/{y}`; valid IANA
timezone; each alert rule references a known type and supplies its required fields; SMTP host
present if any rule/digest uses the smtp channel.
