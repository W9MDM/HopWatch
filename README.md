# HopWatch

[![Release](https://img.shields.io/github/v/release/W9MDM/HopWatch?color=e05d2c)](https://github.com/W9MDM/HopWatch/releases)
[![Downloads](https://img.shields.io/github/downloads/W9MDM/HopWatch/total?color=97ca00&label=downloads)](https://github.com/W9MDM/HopWatch/releases)
[![Latest release](https://img.shields.io/github/downloads/W9MDM/HopWatch/latest/total?color=97ca00&label=latest%20release)](https://github.com/W9MDM/HopWatch/releases/latest)
[![License: GPLv3](https://img.shields.io/badge/license-GPLv3-blue)](LICENSE)

A self-hosted Meshtastic MQTT network observatory. It ingests packets from one or more
MQTT brokers, stores them durably in MySQL, and serves a web UI plus an API for analysis.
HopWatch is passive by default: a fresh install only observes and never publishes. An opt-in
TX subsystem (v2.0) can send text, DMs, traceroutes, and requests to the mesh, but only when
explicitly enabled, armed by an admin, and inside per-rate and channel-util limits, with every
send audited. See `docs/tx.md`.

Its defining idea is **receptions, not packets**. One mesh packet uplinked by many gateways
is one logical `packet` with many `reception` rows, one per gateway. Every analytic feature
(coverage, gateway comparison, direct-heard attribution, link quality, position estimation)
builds on receptions.

See `HopWatch-Design-Spec.md` for the full architecture, `docs/config.md` for the config
reference, `docs/tx.md` for the transmit subsystem, `docs/bridge.md` for the MQTT text bridge,
and `docs/rbac.md` for access control and sign-in. **New operators should start with
[`docs/SETUP.md`](docs/SETUP.md).**

## Stack

Next.js (App Router) + Radix UI + Tailwind v4, MySQL 8 / MariaDB, MapLibre GL for maps,
uPlot for charts, SMTP (nodemailer) for mail, ical-generator for calendar feeds, and
prom-client for metrics. Ingest, the background worker, and the web app are three separate
Node processes; the only channel between them is the database.

## Features

### Ingest and data model
- Multi-broker MQTT ingest (protobuf `ServiceEnvelope`, the JSON topic format, and the `/2/map/`
  map-report topic), with hot-reload of broker/key/forwarding changes within ~5s (no restart
  needed).
- Map reports (`MAP_REPORT_APP`) supply node identity, role, hardware and **firmware version** on
  a purely passive install, plus a deliberately coarse self-reported position stored with its own
  `map_report` provenance so it never masquerades as a GPS fix.
- Text messages carry reply threading and tapback reactions (`reply_to_packet_id`,
  `is_reaction`), so a reaction is not shown or re-broadcast as an ordinary message.
- Channel decryption with configurable keys, including the default `AQ==` key. A key is tried only
  when its channel hash matches the 8-bit hash the sender put in `MeshPacket.channel`, exactly as
  the firmware's `Channels::decryptForHash` does, so wrong-key garbage is never accepted as a
  decode. A channel with an empty key is an unencrypted (or ham-mode) channel: its payload is
  plaintext inside the encrypted variant and is read as-is. PKI-encrypted direct messages
  (`channel_id` "PKI", or `pki_encrypted`) are never run against channel keys at all. The raw
  ciphertext is retained for later re-decode whether or not a key opened it.
- **Detections and alerts:** `DETECTION_SENSOR_APP` (10) and `ALERT_APP` (11) bodies are decoded and
  kept in their own `sensor_event` table, shown on the Mesh weather page and served by
  `/api/v1/sensors`. Deliberately not chat: they never appear in messages or cross the text bridge.
- **Telemetry coverage:** device, environment, power, air-quality, health, **local-stats**,
  **host-metrics** and **traffic-management** variants, and **any** stored metric is chartable on a
  node page (a picker over that node's own metric list, not a fixed six). `LocalStats` carries a node's own view of mesh size plus relay counters
  that identify de-facto backbone routers, and a per-site noise floor; `HostMetrics` marks a
  meshtasticd/Linux gateway. Environment `voltage`/`current` are stored as `env_voltage`/`env_current`
  so an INA bus rail (a 12 V solar feed) cannot be mistaken for the device battery by the low-battery
  alert or the death forecast.
- **Key verification:** `KEY_VERIFICATION_APP` (port 12) handshakes are decoded and grouped by their
  correlating nonce on `/flags`, so an exchange that never reached its closing hash shows as
  incomplete. The hashes themselves are handshake material and are not recorded.
- **Integrity flags:** public-key spoof, identity flapping, role violation, plus the between-node
  conflicts: two node ids sharing one public key (a cloned device or a restored NodeDB, which breaks
  PKI DMs for anyone who cached either identity), two active nodes claiming one short name, and a
  node whose role claims ROUTER/REPEATER whose byte never appears as a relay. Firmware changes are
  recorded as identity events, so the fleet's firmware picture has a timeline, not just a current
  value.
- **Radio profile from map reports:** region, modem preset, still-on-default-channel and the
  reporter's own local-node count are recorded and shown on `/fleet`. A node on a mismatched region
  or preset is visible over MQTT but unreachable on RF, which otherwise looks like a bad antenna.
- Reception classification: `rf_direct`, `rf_direct_low_conf`, `rf_relayed`, `mqtt_self`,
  `mqtt_injected`, `unknown`.
- Per-gateway direct-heard roster and a `(gateway, node)` link aggregate.
- Time-partitioned `packets` and `receptions` with daily partitions, retention by partition
  drop, and continuous hourly/daily rollups (per node, per gateway, per pair, mesh-wide).

### Web UI
- **Command palette** (Cmd/Ctrl+K) for global node search and jump-to-page navigation,
  filtered to the modules your role can see.
- **Dashboard** with a live SSE feed, broker/mesh health, 48h trend sparklines (active nodes,
  channel util, packets/hr), and an encryption/PKI-adoption stat, plus an always-visible
  **network condition** badge (Strong/Good/Fair/Degraded/Critical, from the mesh health score)
  and an **Online** viewers chip (how many browser tabs currently have the site open) in the
  header.
- **Packet browser** with filters (node, port, decode status, broker, channel) and CSV export.
- **Nodes** explorer with an activity header (total, active in 1h / 12h / 24h / 7d / 30d,
  with-position, gateway counts; scoped to the selected broker/channel), a full filter row (search, broker, channel, role, kind, hardware, seen-within,
  has-GPS, has-PKI-key, spoof-flagged, sort) and paged results (50/100/250/500 per page). The table
  carries a **hops-away** column (fewest hops any gateway used to hear the node in the last 24h, 0 =
  direct, scoped to the selected broker's vantage, sortable), plus an
  identity card (long/short name, node id, role, hardware, firmware,
  licensed-operator flag, and public key from NodeInfo), per-node biography, identity history, a full latest-telemetry grid
  (device, environment, power, air-quality, and health metrics) plus per-pair RSSI/SNR charts
  (uPlot), GPS altitude, an ego graph of directly-linked nodes, and a spoofing/fingerprint view.
  Node-listing tables (nodes, gateways, watchlist, ghosts, spammers, power, flags, scoreboard,
  mesh weather) show the short name in its own column alongside the long name.
- **Node packets** (`/nodes/<id>/packets`): a tab on every node page listing the packets that node
  originated (newest first, paged), reusing the packet-browser columns, with links to open the full
  packet browser filtered to the node and to export its packets as CSV.
- **Node reach** (`/nodes/<id>/reach`): a CoreScope-style per-node reach view of how far a node's
  transmissions actually propagate. A plain-language **grade + tips** (coverage, best-link headroom,
  reach) for newcomers; summary stats with a **week-over-week trend** on direct receivers (arrow +
  daily sparkline) and a **gained/lost receivers** diff vs the prior period; a **redundancy / SPOF**
  readout (independent gateways + the busiest gateway's share, flagged red when a single station is
  the only path); a reach map (the node with lines out to each direct receiver, colored by signal);
  a direct-receivers table with **link margin** (SNR headroom above the modem preset's demod floor,
  color-classed solid/ok/marginal) alongside count, avg SNR/RSSI and distance from zero-hop positions;
  an optional **relayed-by** map layer + table (amber, off by default) showing gateways that carry the
  node only via a relay, so a router's real footprint is not undersold by a direct-only view (distance
  is left blank, since a relayed reception is not an RF range per Rule 4);
  and a NeighborInfo links table (we-hear / they-hear, two-way). Trends and gained/lost come from the
  hourly reception rollup; the SPOF/margin math is pure receptions, no new tables. A **live activity**
  ticker (off the shared SSE stream) shows the node's packets being heard in real time (which gateway,
  signal, hop count).
- **My reach** (`/my-reach`): a signed-in owner's whole footprint on one map - every node they have
  claimed, plus everyone that hears those nodes (direct) and everyone they hear (NeighborInfo), drawn
  MeshSense-style with the owner's nodes highlighted and links colored by type. Surrounding nodes are
  labeled too (falling back to the `!hex` id when a distant node has no name) and click through to their
  own reach page. An optional **relayed-by** layer (amber dashed, off by default) adds gateways that
  hear the fleet only via a relay. An aggregate stat header (nodes, unique receivers with a
  week-over-week trend + sparkline, unique neighbors, relayed-by count, farthest link, at-risk count,
  best margin), a gained/lost-receivers diff, a per-node table (max reach, best margin, SPOF / no-direct
  flags), and a **live activity** ticker across all the owner's nodes. Auto-refreshes so it can be left
  open, and each of the owner's nodes links to its own reach page. Replaces juggling a reach tab per node.
- **Gateways** list with per-gateway heard-direct roster.
- **MQTT brokers** presence page (`/brokers`), one tab per broker: the live connected-client
  count from the broker's `$SYS` feed (Mosquitto exposes it; a broker that restricts `$SYS` reads
  `n/a`), broker version/uptime, HopWatch's own subscriber state, and the roster of Meshtastic
  gateways observed publishing through it with how long ago each was last seen. The ingest daemon
  subscribes to `$SYS/broker/#` on each broker and flushes the snapshot to `broker_sys`. For a
  broker with a `log_file` configured (a Mosquitto broker on the HopWatch host), it also lists the
  **connected clients** by name, classified as HopWatch / phone-app proxy / node / other, with
  username (admin only), keepalive and connected-since, parsed from the broker log into
  `mqtt_client` (Mosquitto does not expose client identities over `$SYS`). Source IPs are collected
  for the parse but never sent to the browser.
- **Node config read/write:** pull a connected station node's full config (metadata, config,
  module config, channels, node DB) and write practical settings back over the stream API using
  AdminMessages: Owner name; LoRa region/preset/hop/tx-power/tx-enabled; Device role/rebroadcast/
  nodeinfo-interval; Position broadcast/GPS; the MQTT module (enable, address, user/pass, root,
  encryption, JSON, TLS, proxy-to-client, map reporting); and each channel's MQTT uplink/downlink.
  Every write is a **read-modify-write on the node's own reported section**, because the firmware
  assigns a `set_config` section wholesale: the write connection reuses the `want_config` dump it
  already drains, overlays only the fields that changed, and preserves everything else, including
  fields the pinned protobuf schema is too old to name. A section the node did not report is
  refused rather than written from defaults. Channel uplink/downlink toggles therefore send only the
  toggle and the channel's name, key, role and position precision never leave the device (nor reach
  the browser), and the write no longer opens a second connection to read them back. It can also
  **add or replace a whole channel** (name + key + role) at a chosen slot, the way the app and CLI
  provision one, so the station node can decode, transmit and ack on a new channel (e.g. a Testing
  channel): the key mode is the public basic key, a custom base64 key, or plaintext. Writes apply to
  that node locally (not an RF transmit); LoRa changes are behind a confirm and the node is re-read to verify.
  A standalone **Reboot node** button sends a reboot AdminMessage with no config change (the same
  `POST /api/v1/admin/node/write` with `reboot: true` and empty `ops`), for recovering a station node
  whose TCP API still answers but whose receive side has gone silent.
- **NodeDB maintenance:** keep a RAM-constrained station node (ESP32) from overfilling its on-device
  NodeDB and reboot-looping. When `node.nodedb_maint.enabled` is set, the worker periodically
  favorites repeaters/routers (protected from both this prune and the firmware's own eviction) and
  removes nodes not heard within `stale_days`, over the node admin API (not an RF transmit). A "Prune
  now" button (`POST /api/v1/admin/node/nodedb-prune`) runs it on demand.
  The node's broker password and WiFi PSK are **never returned**: the snapshot reports only whether
  each is set, and a write omits an unchanged credential so the device keeps it without the value
  leaving the device.
  **Every** Config and ModuleConfig section is readable and writable, not just the four with
  hand-written mappings: the read path projects each section from the protobuf schema descriptor
  (snake_case names, enums resolved to their upstream names, repeated fields kept, one level of
  nesting) and the write path derives its coercion the same way, so an arm cannot drift out of sync
  with its reader.
  A channel with no name of its own is reported under the wire name the firmware resolves it to
  (the modem-preset name, e.g. `LongFast`), not a placeholder, since that string is the channel's
  identity in the channel hash, in `channel_id`, and in the TX channel-index lookup.
- **Remote admin scanner:** probes recently-heard nodes with a DeviceMetadata admin request (via
  the station node, which PKI-signs it) to discover which ones this station can remotely
  administer, and keeps them in a **persistent** record (firmware, hardware, role, first/last-seen,
  success count) that is not lost when a scan cycles. Admin only, on the Remote admin settings tab.
- **RF receive:** with a station node connected (`node.host` + `node.rx_enabled`), HopWatch ingests
  that node's own RF receptions as a first-class source. The node's TCP API serves one client at a
  time, so the receive stream, TX publishes and admin config operations are serialized by a database
  lease (`docs/tx.md`); the stream is kept alive with a heartbeat and watched by a receive watchdog,
  and reports connected only while frames are actually arriving. It reconnects on its own with
  exponential backoff (1s, 2s, 4s, 8s, 16s, then every 30s), and **Connect now** in `/admin/tx`
  skips that wait after a node has been power-cycled. Each reception records how HopWatch heard
  it (`transport` = `rf` or `mqtt`); the packet page shows a per-reception Via column and a "Heard
  via" summary, and the header shows an RF-node connection chip.
- **About / Help / Privacy** public info pages (linked in the footer): plain-language
  orientation, a glossary + FAQ + "add a node" guide, a public Testing-channel invite (name +
  basic key, plus a one-tap `meshtastic.org/e` add-channel link and scannable QR so other operators
  can add it and respond there too), and a privacy/data-use notice with an unofficial-data
  disclaimer. A dismissible one-line intro banner greets first-time map visitors.
- **Messages** view of observed text messages, with **full-text search** across message bodies
  (RX and HopWatch's own TX), a **channel filter** (every observed channel, e.g. LongFast /
  LongTurbo / ShortTurbo, appears automatically), a **direction filter** (received / sent-by-HopWatch
  / directed-only), and **click-to-sort** columns, plus a MeshMonitor-style **Chat**
  page (`/messages/chat`): a live per-channel conversation where HopWatch's own sends appear as
  outgoing bubbles with ack status (sent to mesh, heard back, delivered/failed).
- **Maps** (dark/light basemap toggle, node-name toggle, a short-names toggle that labels nodes
  by their 4-char short name, an always-visible key, broker/channel filters, an RF-heard-only
  layer toggle that hides nodes present only via their own MQTT uplink, and estimated-node
  overlay):
  - **Map:** node positions plus RF links, hop-colored rings (0 direct .. 7+).
  - **Live map:** animated SSE pulses of observed receptions (source -> relay -> gateway),
    gateway rings, optional audio, and a replayable topology underlay.
  - **Coverage heatmap:** nodes colored by direct-gateway redundancy, sized by RSSI, with
    predicted RF range rings.
  - **History** and **Replay:** time-windowed and replayable views of past topology/receptions.
  - **Graph:** force-directed node/link view laid out in **hop rings** (BFS depth from the gateway
    core, so each relay hop sits one faint ring further out and the topology declutters); focus/center
    on a node, or pick a second node to highlight the path spidering between the two. The focus,
    second-node, and time-window selections live in the URL (`?focus=<id>&between=<id>&hours=`), and a
    **Copy link** button yields a shareable permalink that reopens centered on that node. Declutter
    controls (**max hops** slider, **min links** slider to drop the single-link leaf ring around a big
    gateway, and a **hide MQTT-only** toggle) thin a hairball down to its backbone and are part of the
    permalink too.
- **Analytics:** one page with three tabs. **Traffic** (network totals, packets per hour/day,
  packet types, traffic-by-type, top talkers, busiest RF links and rooms/channels, RF noise-floor
  trend, SNR distribution). **Signal & RF** (gateway compare, longest direct links, hop
  distribution, airtime hogs, link asymmetry, an **RSSI-vs-distance** path-loss scatter).
  **Distributions** (a mesh **activity clock** plus node/gateway activity, signal, routing, and
  protocol distributions). A separate **scoreboard** ranks operators by nodes they run, workhorse
  gateways, longest uptime, and highest altitude.
- **RF / propagation:** link-budget validator (FSPL, Fresnel clearance, optional terrain),
  a **line-of-sight (LOS)** profile (the picked pair is encoded in the URL, so a comparison is a
  shareable link, with a Copy link button), tropospheric-propagation detection with a **space-weather**
  conditions panel (NOAA SWPC Kp / solar flux / solar wind), a **site planner** (drop a
  candidate node, predict its coverage and which existing nodes/gaps it would newly cover),
  and network records.
- **Owned nodes:** claim and manage your own nodes, group them, track maintenance and issues,
  and share access; your claimed nodes also appear in a **My nodes** section on your profile. Admins
  get a **bulk-assign** panel (`POST /api/v1/owned/nodes/bulk-assign`): hand a **user or group** a
  whole fleet at once by a short-name regex (e.g. `^RJ[0-9]+$`) or a list of node ids, creating an
  owned record for any matched node not yet in the registry and reassigning ones that are. The
  registry table is searchable/filterable (by owner and role) and sortable, and each owner links to
  their reach. **My reach** counts a user's directly-owned nodes plus nodes owned by any group they
  belong to; an admin can view any user's reach at `/my-reach?user=<id>`.
  **Watchlist** for nodes of interest, plus a **Power & battery** page (tabs for low-battery
  nodes, router/repeater battery health, and power-channel/solar telemetry from INA219 sensors).
- **Weather alerts:** broadcast NWS active alerts (api.weather.gov, free/keyless) for your UGC
  county/zone codes to a mesh channel, filtered by severity threshold and an optional event
  allow-list, deduped by alert id. Configured on the Weather-alerts settings tab; sent through the
  armed TX subsystem.
- **Mesh weather:** environmental sensors reported by nodes (temperature, humidity, pressure,
  IAQ, CO2, light, wind) aggregated mesh-wide, distinct from the external-station Weather page.
- **Backbone:** the infrastructure carrying the mesh, busiest relays, most-observed links
  (from traceroutes), and most-connected nodes by RF neighbours.
- **Flags & anomalies:** mesh-wide feed of integrity flags (public-key spoof, identity flap,
  role violation, anomaly), open/unacknowledged first.
- Plus **matrix** (gateway x node), **fleet**, **traceroutes** (sent-request log with success
  state, plus a results table showing each completed route: initiator, target, hop count, and the
  full source -> hops -> target path), **new nodes**, **ghosts**,
  **spammers**, **weather**, **ambience**, a **kiosk** mode (full-screen auto-rotating wall
  display), a per-user **profile**, and a **health** page with a subsystem **self-test**
  (database, brokers, ingest flow, worker heartbeat, TX, feeds).

### Position estimation
Estimates the location of nodes that never transmit a position, from the zero-hop receptions
of gateways whose positions are known (RSSI -> distance via a log-distance path-loss model,
then a tier ladder up to weighted multilateration). Results live in a separate table, are
labelled `position_source: estimated` with a confidence radius, and never merge with or
shadow a real position. Estimated nodes render as distinct dashed markers with a confidence
circle and can be toggled on the maps. Recompute runs on the worker only. Configured in the
admin UI (`/admin/settings` -> Position estimation), stored in the database, and hot-reloaded;
off-by-default flags include feeding estimates into the coverage heatmap.

### Alerts and notifications
- Config-driven **alert engine** (node offline, low battery, spoof flag, new node, gateway
  silent, high channel util) with webhook / ntfy / **Discord** / SMTP delivery. The Discord channel
  posts to a channel webhook as a branded "send as" identity (configurable name + avatar, e.g.
  HopWatch) with a one-click test post; webhook URLs are encrypted at rest.
- **Daily digest** with an `.ics` attachment and a public `/feeds/events.ics` feed.
- **Notification forwarding** of mesh events (new channel text messages, new nodes; overheard
  directed messages/DMs are never forwarded) to Discord and
  other targets via Apprise (or native Discord/ntfy/webhook senders), configurable per
  channel and event type in the admin UI. Targets are encrypted at rest.

### Auth and admin
- Token + admin-session auth with a read-only default (`server.auth.anonymous_read_only`).
- **Role-based access control.** Custom roles each grant a set of feature modules; access is
  hard-blocked per module (the nav hides it and the page/API return 403). Anonymous requests
  get `rbac.anonymous_role` (default `public`), API tokens get their `role_key` (or
  `rbac.token_default_role`), and signed-in non-admin accounts get `rbac.member_role`. Roles
  are edited in `/admin/roles` and assigned per user (including Discord logins) in
  `/admin/settings` -> Users; a role's `can_tx` flag grants transmit. See `docs/rbac.md`.
- **Discord SSO** (optional): enable `server.auth.discord`, and users can link Discord and sign
  in with it, resolving to the member role (auto-provisioned unless disabled). See
  `docs/config.md` -> Discord SSO.
- **Discord bot** (optional): a slash-command bot served over HTTP interactions (no persistent
  connection) with `/reach`, `/node`, `/myreach` (uses the caller's linked account), `/status`,
  `/claim`, and `/sendas` (admin-only: posts the pasted text into the channel as the bot). Replies as
  its own identity. Enable and register commands in `/admin/settings` -> Notifications -> Discord bot.
  See `docs/config.md` -> Discord bot.
- Both basemaps are operator-set: the light tile URL and a separate **dark basemap URL** in `/admin/settings` (dark defaults to CARTO, which now needs a free `?key=` on its raster tiles; paste the keyed URL or any other dark provider).
- **Config backup & restore** (`/admin/settings` -> General): download the full configuration
  (UI overrides + brokers + channel keys + forwarding rules) as a JSON file, or restore it on a
  fresh install after a rebuild. Secrets are exported as ciphertext, so a restore needs the same
  `HOPWATCH_MASTER_KEY`; it excludes operational data and login accounts. `GET`/`POST
  /api/v1/admin/config-backup` (admin only; POST replaces the current configuration).
- Admin UI at `/admin`: `/admin/settings` (brokers, channel keys, forwarding rules, users,
  notifications, position estimation, and other config), `/admin/roles` (RBAC), `/admin/mute`
  (mute list; display only, never transmits), and `/admin/tx` (the transmit subsystem, arm/
  disarm, outbox and audit log). Set `HOPWATCH_SESSION_SECRET` and `HOPWATCH_ADMIN_PASSWORD`,
  then sign in at `/admin/login`.
- Operational secrets (broker/SMTP passwords, Discord client secret, forwarding targets, alert
  webhook/ntfy targets) are
  encrypted in the DB with AES-256-GCM; the master key stays in the environment. If the master key
  changes, every stored secret becomes undecryptable at once: each one then reads as **unset**
  (the process keeps running) and is named in the log and in the admin diagnostics bundle, so the
  affected values can be re-entered in `/admin/settings`.
- Optional **Google Analytics (GA4)**, off by default: a client `gtag.js` tag for browser
  pageviews and/or server-side Measurement Protocol events, configured in `/admin/settings`
  (the Measurement Protocol API secret is encrypted at rest). See `docs/config.md`.

### API and metrics
JSON API under `/api/v1`. Read endpoints (module-gated by RBAC) include `packets` (+ CSV,
`packets/:id`), `nodes` (filterable by `q`/`broker`/`channel`/`role`/`hw`/`kind`/`seen`/`pos`/
`key`/`spoof`/`sort`, paged via `limit`+`offset`, returns `total`; + CSV) / `nodes/:id`
(+ telemetry, fingerprint), `brokers` (per-broker `$SYS` client counts + observed-gateway
roster counts), `gateways/:id/heard-direct`
(+ CSV), `messages`, `map`, `livemap`, `history`, `replay`, `traceroutes`, `analytics`,
`search` (module `nodes`), `sensors` (detection/alert events, module `environment`),
`link-budget`, `los`, `propagation`, `space-weather`, `records`, `fleet`, `graph`, `matrix`,
`ghosts`, `weather`, `links/:gateway/:node`, `health`, `health-score`, `messages/thread`
(a channel's merged RX+TX chat thread), `node-rx` (live station-node RF connection state for the
navbar chip), `tx/log` (the worker's TX send-pipeline debug trace, for operators without shell
access), `presence` (POST heartbeat for the navbar "Online" viewers chip: each open tab beacons
a random per-tab id every 30s and gets back the count of tabs active in the last ~90s; denied
to callers whose role grants nothing), and `live/stream` (SSE; one connection per browser tab, shared by every live component on the
page, so a dashboard does not consume several of the browser's six per-origin connections).
When `server.auth.anonymous_read_only` is off, these reads require a signed-in session or a
bearer token; anonymous requests are denied.

Write endpoints exist behind auth: `owned/*` (node ownership, groups, shares, issues,
maintenance); `watchlist` (module-gated, per-user favorites/notes/tags) and `profile`
(session-scoped self-service prefs, Discord unlink), both of which accept POST; and, when the TX
subsystem is enabled and the caller has `can_tx`, `tx/*` (`tx/message`, `tx/traceroute`,
`tx/request`, and `tx/outbox` read/cancel). Discord OAuth login lives under `auth/discord`, and the
Discord slash-command bot's interactions webhook is the public, signature-verified
`POST /api/v1/discord/interactions` (no auth guard: each request is authenticated by its Ed25519
signature, not a session). Admin
endpoints live under `/api/v1/admin` and every one requires an admin session (there is no
`/api/v1/admin/settings` route; the `/admin/settings` page saves through these). They include config
(`general`, `auth`, `rf`, `ingest-status`, `automations`, `bridge`), roles, users, brokers, forwarding,
channel-keys, mute-list, notifications, `discord-bot` (bot settings + register slash commands),
position-estimation, analytics, `tx` (settings) + tx arm/disarm + `tx/auto-responder` +
`tx/traceroute-settings`, `owned-import`, `discord-unlink`, `node/config` + `node/write`, and the
per-node `nodes/:id` review / rf-profile / ignore-position mutators, `service/restart` (asks
the worker/ingest to restart via a DB request that the process acts on and systemd relaunches),
`service/update` (asks the host's hopwatch-update timer to pull the latest code, rebuild, and
restart all services; the request is a DB row the updater claims on its next ~1 min tick),
`service/update-check` (compares the running version to the latest GitHub release of
`server.updates.github_repo` and reports whether a newer one exists; read-only, never installs -
Service controls shows an "Update available" prompt from it),
`remote-admin` (remote-admin scanner settings + persistent administrable-node record + manual
probe/forget), `weather-alerts` (NWS alert-broadcast settings + recent-sent log + test),
`node/reconnect` (force the RF receive stream to reconnect now),
`diagnostics` (read-only 24h flow report: ingest, decode, classification and TX counts per hour,
plus the current station-node lease holder, any stored secrets the current master key cannot
decrypt, and server-computed warnings;
`?download=1` saves it as JSON to attach to a bug report), and
more). Also `/api/version`,
`/api/v1/openapi.json`, `/manifest.webmanifest` (PWA install manifest), `/opengraph-image`
(social-share preview), and `/api/metrics` (Prometheus; public by default, gate with
`server.metrics_public`, or restrict at the network
layer).

## Prerequisites

- Node.js 22.6+ (24 recommended). No Docker is used.
- A MySQL 8 (or MariaDB 10.5+) server you can reach.

## Quick install

Run the installer (Node only, cross-platform). It copies the config and `.env` from the
examples, creates data directories, installs dependencies, and runs migrations:

```bash
# Linux / macOS / Git-Bash
./install.sh

# Windows PowerShell
.\install.ps1

# or directly, anywhere
npm run setup

Useful flags: `--create-db` also creates the MySQL database and user (reads target names from
`config/hopwatch.yaml`; admin creds from `HOPWATCH_DB_ADMIN_USER` / `HOPWATCH_DB_ADMIN_PASSWORD`,
defaulting to `root`). `--skip-install` and `--skip-migrate` skip those steps.

```bash
HOPWATCH_DB_ADMIN_PASSWORD=rootpw ./install.sh --create-db

Setup generates strong random values for `HOPWATCH_SESSION_SECRET`, `HOPWATCH_MASTER_KEY` and
`HOPWATCH_ADMIN_PASSWORD` (printing the admin password once) and locks `.env` to owner-only, so
you do not hand-edit secrets: just point `HOPWATCH_DB_*` at your database. Everything else -
brokers, channel keys, forwarding, TX, alerts, roles - is configured in the admin UI and encrypted
at rest, so a new operator never edits config files after this. Then start the three processes
shown below. (In production the app refuses to start on an empty or example-placeholder session
secret, so a forgeable admin session can't happen by accident.) The manual steps the installer
automates are documented next.

## Linux deployment (systemd)

For a Linux server with MariaDB, one command does everything: installs dependencies,
generates secrets, creates the database and user via MariaDB socket login (`sudo mariadb`,
no root password needed), points the app at the unix socket, migrates, builds, and installs
+ enables the systemd services:

```bash
# from the app directory (e.g. /opt/hopwatch)
sudo bash scripts/linux-install.sh

It prints a generated admin password on first run (also written to `.env`). Flags:
`--no-db`, `--no-systemd`, `--no-build`, `--user=NAME` (service user, defaults to the
invoking user). It installs and enables `hopwatch-ingest`, `hopwatch-worker`, and
`hopwatch-web` (unit templates in `deploy/systemd/`, with `EnvironmentFile=.env`), plus
`hopwatch-update.timer`: an auto-updater that checks every minute and, when the git remote
has new commits or an admin pressed "Update now" in `/admin`, pulls, rebuilds, and restarts
all services (`scripts/linux-autoupdate.sh`; disable with
`systemctl disable --now hopwatch-update.timer`). Check them:

```bash
systemctl status hopwatch-web
journalctl -u hopwatch-ingest -f

Omit `--systemd` to just install/build without services, or `--create-db` if the database
already exists. To update an existing deployment in place (pull, reinstall, migrate, rebuild,
restart services):

```bash
bash scripts/linux-update.sh

Flags: `linux-install.sh` takes `--no-db`, `--no-systemd`, `--no-build`, `--user=NAME`;
`linux-update.sh` takes `--no-build`, `--no-restart`, `--no-pull`.

## Setup (manual)

1. Create the database and a user (adjust names/passwords):

   ```sql
   -- MySQL 8 or MariaDB 10.5+. On MariaDB, connect with socket login: `sudo mariadb`.
   CREATE DATABASE hopwatch CHARACTER SET utf8mb4;
   CREATE USER 'hopwatch'@'localhost' IDENTIFIED BY 'hopwatch';
   GRANT ALL PRIVILEGES ON hopwatch.* TO 'hopwatch'@'localhost';
   FLUSH PRIVILEGES;
   ```

   (The Linux installer does all of this for you; see "Linux deployment" above.)

2. Configure:

   ```bash
   cp config/hopwatch.example.yaml config/hopwatch.yaml
   cp .env.example .env
   ```

   Edit `config/hopwatch.yaml` (timezone, retention, alerts) and set secrets in `.env`. Note:
   **MQTT brokers, channel keys, forwarding rules, position estimation, TX, roles, and Discord
   SSO are managed in the admin UI** (`/admin/settings`, `/admin/tx`, `/admin/roles`) once
   running; YAML values only seed the database on first run. Edits in the UI hot-reload the
   ingest daemon within ~5s. Operational secrets (broker/SMTP passwords, Discord client secret,
   forwarding targets) are entered in the admin UI and encrypted at rest, not put in `.env`.
   The only secrets in `.env` are the bootstrap set: `HOPWATCH_DB_PASSWORD`,
   `HOPWATCH_SESSION_SECRET`, `HOPWATCH_MASTER_KEY`, `HOPWATCH_ADMIN_PASSWORD`.
   Any config key can be overridden by an env var named `HOPWATCH_<DOTTED_PATH_UPPERCASED>`.

3. Install and validate:

   ```bash
   npm install
   npm run config:check
   npm run migrate
   ```

4. Run the three processes (each in its own terminal):

   ```bash
   npm run ingest    # MQTT -> MySQL
   npm run worker    # rollups, roster, retention, RF/propagation, position estimation, forwarding
   npm run dev       # web UI + API at http://localhost:3000
   ```

   For production, build once and start: `npm run build` then `npm run start` (plus the ingest
   and worker processes). A process manager such as pm2 or systemd units is a good fit; the
   three roles are independent and restart-safe.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Next.js dev server (UI + API) |
| `npm run build` / `npm run start` | production web build and serve |
| `npm run ingest` | ingest daemon |
| `npm run worker` | rollups, retention, RF/propagation, position estimation, forwarding |
| `npm run migrate` | apply SQL migrations (also runs on ingest/worker startup; a file that fails mid-way is recorded as partial and resumes from the statement it reached, since MySQL DDL cannot be rolled back) |
| `npm run config:check` | validate config and print a summary |
| `npm run test` | unit tests |
| `npm run typecheck` | `tsc --noEmit` |

## Tests

`npm run test` runs the pure-logic unit tests with Node's built-in test runner (no DB
required). Suites cover: reception classification for every edge case (zero-hop direct,
relayed, self-gated, MQTT-injected, old-firmware missing `hop_start`, relay byte, inconsistent
headers, multi-gateway); channel-key expansion, the channel hash, and AES-CTR round-trip;
envelope decode including channel-hash key selection, PSK-less plaintext channels and the PKI
short-circuit; secret encryption (AES-256-GCM round-trip, and degrading to unset on a master-key
mismatch instead of throwing); node fingerprinting; live-map coalescing/relay
resolution; and position estimation (per-tier synthetic geometry, relay exclusion, and the
mobile-variance radius widening).

## Project layout

```
config/                 example YAML config
db/migrations/          SQL schema (partitioned tables, rollups, event/estimate tables)
src/config/             Zod schema + loader with env overrides
src/meshtastic/         topic parse, decode, crypto, reception classification
src/ingest/             broker connectors, dedup, ingest pipeline, daemon entry
src/worker/             rollups, retention, RF/propagation, position estimation, forwarding
src/db/                 pool, migrate runner, partition helpers, read queries, settings
src/app/                Next.js App Router pages + API routes
src/lib/                time (UTC), formatting, csv, geo, map icons, estimation math
test/                   unit tests
docs/                   config reference, research notes, Grafana dashboard

## Notes

- All datetimes are stored in UTC. The UI renders `server.local_timezone`.
- The mute list affects display only, and HopWatch refuses to DM or traceroute muted nodes.
  With TX disabled or disarmed (the default), nothing HopWatch does reaches the mesh.
- `@meshtastic/protobufs` is the one integration point in `src/meshtastic/decode.ts`; if a
  version bump changes an export name, that file is the only place to adjust.

## License

HopWatch is released under the **GNU General Public License v3.0**. See [LICENSE](LICENSE) for the
full text. You may use, modify, and redistribute it under the terms of the GPLv3; distributed
modified versions must also be made available under the GPLv3.
