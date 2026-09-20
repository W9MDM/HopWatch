-- HopWatch Phase 1 schema (MySQL 8, InnoDB, utf8mb4).
-- Conventions (spec §3):
--   * All DATETIME(3) columns store UTC. The app renders the config local timezone.
--   * Node/gateway ids are Meshtastic uint32 -> INT UNSIGNED.
--   * Surrogate keys are BIGINT UNSIGNED AUTO_INCREMENT (never random UUIDs).
--   * Partitioned tables: partition column is in every unique key; NO foreign keys
--     (MySQL forbids FKs on partitioned tables) -- cross-table refs are logical.
--   * Partitioned tables are created with a single pmax partition; the worker
--     REORGANIZEs daily partitions and DROPs expired ones for retention.

-- ---------------------------------------------------------------------------
-- packets: one logical mesh packet (deduped across gateway uplinks)
-- ---------------------------------------------------------------------------
CREATE TABLE packets (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- first_seen_at is the dedup-bucket START (not the individual rx time) so every
  -- gateway copy of one logical packet shares it and collides on uq_dedup. This also
  -- keeps the packet's partition placement stable regardless of per-gateway rx times.
  first_seen_at    DATETIME(3)      NOT NULL,
  mesh_packet_id   INT UNSIGNED     NOT NULL,
  from_node_id     INT UNSIGNED     NOT NULL,
  to_node_id       INT UNSIGNED     NULL,
  dedup_bucket     INT UNSIGNED     NOT NULL,
  channel_index    TINYINT UNSIGNED NULL,
  channel_id       VARCHAR(64)      NULL,
  port_num         SMALLINT UNSIGNED NULL,
  decode_status    ENUM('decoded','encrypted','malformed','partial') NOT NULL,
  decode_error     VARCHAR(255)     NULL,
  want_ack         TINYINT(1)       NOT NULL DEFAULT 0,
  via_mqtt         TINYINT(1)       NOT NULL DEFAULT 0,
  payload_format   ENUM('protobuf','json') NOT NULL,
  raw_json         JSON             NULL,
  reception_count  INT UNSIGNED     NOT NULL DEFAULT 0,
  source_broker_id VARCHAR(64)      NULL,
  PRIMARY KEY (id, first_seen_at),
  UNIQUE KEY uq_dedup (from_node_id, mesh_packet_id, dedup_bucket, first_seen_at),
  KEY ix_from_time (from_node_id, first_seen_at),
  KEY ix_port_time (port_num, first_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (first_seen_at) (
  PARTITION pmin VALUES LESS THAN ('2020-01-01 00:00:00'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- ---------------------------------------------------------------------------
-- receptions: one gateway copy of a packet -- the heart of the model
-- ---------------------------------------------------------------------------
CREATE TABLE receptions (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rx_time              DATETIME(3)      NOT NULL,
  received_at          DATETIME(3)      NOT NULL,
  packet_id            BIGINT UNSIGNED  NOT NULL,
  packet_first_seen_at DATETIME(3)      NOT NULL,
  gateway_id           INT UNSIGNED     NOT NULL,
  from_node_id         INT UNSIGNED     NOT NULL,
  rx_rssi              SMALLINT         NULL,
  rx_snr               FLOAT            NULL,
  hop_start            TINYINT UNSIGNED NULL,
  hop_limit            TINYINT UNSIGNED NULL,
  relay_node           TINYINT UNSIGNED NULL,
  reception_class      ENUM('rf_direct','rf_direct_low_conf','rf_relayed',
                            'mqtt_self','mqtt_injected','unknown') NOT NULL,
  raw_topic            VARCHAR(255)     NOT NULL,
  source_broker_id     VARCHAR(64)      NOT NULL,
  is_json              TINYINT(1)       NOT NULL DEFAULT 0,
  ingest_lag_ms        INT              NULL,
  PRIMARY KEY (id, rx_time),
  -- Restart idempotency: reprocessing the same MQTT message is a no-op (INSERT IGNORE).
  UNIQUE KEY uq_rx (packet_id, gateway_id, rx_time),
  KEY ix_gw_node_time (gateway_id, from_node_id, rx_time),
  KEY ix_node_time    (from_node_id, rx_time),
  KEY ix_class_time   (reception_class, rx_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (rx_time) (
  PARTITION pmin VALUES LESS THAN ('2020-01-01 00:00:00'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- ---------------------------------------------------------------------------
-- packet_payloads: encrypted payloads retained for later re-decode (Malla #24)
-- ---------------------------------------------------------------------------
CREATE TABLE packet_payloads (
  packet_id            BIGINT UNSIGNED NOT NULL,
  packet_first_seen_at DATETIME(3)     NOT NULL,
  stored_at            DATETIME(3)     NOT NULL,
  channel_id           VARCHAR(64)     NULL,
  encrypted_payload    VARBINARY(1024) NOT NULL,
  tried_key_ids        JSON            NULL,
  redecoded_at         DATETIME(3)     NULL,
  PRIMARY KEY (packet_id, stored_at),
  KEY ix_redecode (redecoded_at, stored_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (stored_at) (
  PARTITION pmin VALUES LESS THAN ('2020-01-01 00:00:00'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- ---------------------------------------------------------------------------
-- packet_topics: per-topic decode health (malformed rate is a broker signal)
-- ---------------------------------------------------------------------------
CREATE TABLE packet_topics (
  topic_path      VARCHAR(255) NOT NULL,
  broker_id       VARCHAR(64)  NOT NULL,
  valid_count     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  malformed_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_seen_at    DATETIME(3)  NULL,
  last_error      VARCHAR(255) NULL,
  PRIMARY KEY (broker_id, topic_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- nodes: current identity snapshot + lifetime counters (survive raw purge)
-- ---------------------------------------------------------------------------
CREATE TABLE nodes (
  node_id               INT UNSIGNED NOT NULL,
  long_name             VARCHAR(255) NULL,
  short_name            VARCHAR(16)  NULL,
  hw_model              VARCHAR(64)  NULL,
  role                  VARCHAR(32)  NULL,
  public_key            VARBINARY(32) NULL,
  public_key_hex        CHAR(64)     NULL,
  firmware_version      VARCHAR(64)  NULL,
  first_seen_at         DATETIME(3)  NULL,
  last_seen_at          DATETIME(3)  NULL,
  last_position_at      DATETIME(3)  NULL,
  is_gateway            TINYINT(1)   NOT NULL DEFAULT 0,
  is_relay              TINYINT(1)   NOT NULL DEFAULT 0,
  mute_hidden           TINYINT(1)   NOT NULL DEFAULT 0,
  spoof_flag_count      INT          NOT NULL DEFAULT 0,
  anomaly_flag_count    INT          NOT NULL DEFAULT 0,
  total_packet_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_reception_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_direct_gateways SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  spam_score            FLOAT        NULL,
  last_health_score     FLOAT        NULL,
  PRIMARY KEY (node_id),
  KEY ix_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- node identity / flag / position / telemetry history (feeds biography, spoof)
-- ---------------------------------------------------------------------------
CREATE TABLE node_identity_events (
  event_id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node_id              INT UNSIGNED NOT NULL,
  event_type           ENUM('long_name','short_name','hw_model','role','public_key','firmware') NOT NULL,
  old_value            VARCHAR(255) NULL,
  new_value            VARCHAR(255) NULL,
  observed_at          DATETIME(3)  NOT NULL,
  source_packet_id     BIGINT UNSIGNED NULL,
  PRIMARY KEY (event_id),
  KEY ix_node_time (node_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE node_flags (
  flag_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node_id          INT UNSIGNED NOT NULL,
  flag_type        ENUM('spoof_pubkey','identity_flap','role_violation','anomaly') NOT NULL,
  severity         ENUM('info','warn','critical') NOT NULL DEFAULT 'warn',
  message          VARCHAR(512) NOT NULL,
  created_at       DATETIME(3)  NOT NULL,
  resolved_at      DATETIME(3)  NULL,
  acknowledged_at  DATETIME(3)  NULL,
  acknowledged_by  VARCHAR(64)  NULL,
  evidence         JSON         NULL,
  PRIMARY KEY (flag_id),
  KEY ix_node (node_id, created_at),
  KEY ix_open (resolved_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE node_positions (
  node_id         INT UNSIGNED NOT NULL,
  latitude        DOUBLE       NULL,
  longitude       DOUBLE       NULL,
  altitude_m      DOUBLE       NULL,
  precision_bits  TINYINT UNSIGNED NULL,
  source          VARCHAR(32)  NULL,
  last_updated_at DATETIME(3)  NULL,
  PRIMARY KEY (node_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE node_position_events (
  event_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node_id          INT UNSIGNED NOT NULL,
  latitude         DOUBLE       NOT NULL,
  longitude        DOUBLE       NOT NULL,
  altitude_m       DOUBLE       NULL,
  observed_at      DATETIME(3)  NOT NULL,
  source_packet_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (event_id),
  KEY ix_node_time (node_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE node_telemetry (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  observed_at      DATETIME(3)  NOT NULL,
  node_id          INT UNSIGNED NOT NULL,
  metric           VARCHAR(32)  NOT NULL,
  value            DOUBLE       NOT NULL,
  source_packet_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id, observed_at),
  KEY ix_node_metric_time (node_id, metric, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (observed_at) (
  PARTITION pmin VALUES LESS THAN ('2020-01-01 00:00:00'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- ---------------------------------------------------------------------------
-- gateways + gateway/node link aggregates (direct-heard, matrix)
-- ---------------------------------------------------------------------------
CREATE TABLE gateways (
  gateway_id     INT UNSIGNED NOT NULL,
  is_our_gateway TINYINT(1)   NOT NULL DEFAULT 1,
  owner_node_id  INT UNSIGNED NULL,
  first_seen_at  DATETIME(3)  NULL,
  last_seen_at   DATETIME(3)  NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  broker_id      VARCHAR(64)  NULL,
  metadata       JSON         NULL,
  PRIMARY KEY (gateway_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lifetime aggregate per (gateway, node): backs the matrix and per-pair charts.
CREATE TABLE gateway_node_link (
  gateway_id      INT UNSIGNED NOT NULL,
  node_id         INT UNSIGNED NOT NULL,
  direct_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  relayed_count   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  unknown_count   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  first_direct_at   DATETIME(3) NULL,
  last_direct_at    DATETIME(3) NULL,
  first_relayed_at  DATETIME(3) NULL,
  last_relayed_at   DATETIME(3) NULL,
  rssi_min        SMALLINT NULL,
  rssi_max        SMALLINT NULL,
  rssi_sum        DOUBLE   NOT NULL DEFAULT 0,
  rssi_sumsq      DOUBLE   NOT NULL DEFAULT 0,
  snr_min         FLOAT    NULL,
  snr_max         FLOAT    NULL,
  snr_sum         DOUBLE   NOT NULL DEFAULT 0,
  snr_sumsq       DOUBLE   NOT NULL DEFAULT 0,
  last_rssi       SMALLINT NULL,
  last_snr        FLOAT    NULL,
  last_relay_node TINYINT UNSIGNED NULL,
  best_path       JSON     NULL,
  status          ENUM('direct','relayed','never') NOT NULL DEFAULT 'never',
  PRIMARY KEY (gateway_id, node_id),
  KEY ix_node (node_id),
  KEY ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Materialized direct-only roster for fast rendering + CSV export.
CREATE TABLE gateway_heard_direct (
  gateway_id         INT UNSIGNED NOT NULL,
  node_id            INT UNSIGNED NOT NULL,
  first_heard_direct DATETIME(3) NOT NULL,
  last_heard_direct  DATETIME(3) NOT NULL,
  reception_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rssi_min           SMALLINT NULL,
  rssi_max           SMALLINT NULL,
  rssi_avg           DOUBLE   NULL,
  snr_min            FLOAT    NULL,
  snr_max            FLOAT    NULL,
  snr_avg            DOUBLE   NULL,
  last_rssi          SMALLINT NULL,
  last_snr           FLOAT    NULL,
  trend_slope        DOUBLE   NULL,
  status             ENUM('active','stale','offline') NOT NULL DEFAULT 'active',
  PRIMARY KEY (gateway_id, node_id),
  KEY ix_last (last_heard_direct)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE relay_nodes (
  relay_node_byte TINYINT UNSIGNED NOT NULL,
  candidate_nodes JSON         NULL,
  first_seen_at   DATETIME(3)  NULL,
  last_seen_at    DATETIME(3)  NULL,
  evidence_count  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_role    VARCHAR(32)  NULL,
  role_violation  TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (relay_node_byte)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE link_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_node_id     INT UNSIGNED NOT NULL,
  to_node_id       INT UNSIGNED NOT NULL,
  observed_at      DATETIME(3)  NOT NULL,
  direction        ENUM('forward','back') NOT NULL,
  hop_count        TINYINT UNSIGNED NULL,
  route            JSON         NULL,
  snr_towards      JSON         NULL,
  snr_back         JSON         NULL,
  rtt_ms           INT          NULL,
  source_packet_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_pair_time (from_node_id, to_node_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- rollups (worker-maintained). reception_rollup_hour is partitioned + retained
-- for a configurable window; all others grow slowly and are kept indefinitely.
-- ---------------------------------------------------------------------------
CREATE TABLE reception_rollup_hour (
  bucket_start  DATETIME(3)  NOT NULL,
  gateway_id    INT UNSIGNED NOT NULL,
  node_id       INT UNSIGNED NOT NULL,
  packet_count  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  direct_count  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  relayed_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  unknown_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rssi_min SMALLINT NULL, rssi_max SMALLINT NULL, rssi_sum DOUBLE NOT NULL DEFAULT 0, rssi_sumsq DOUBLE NOT NULL DEFAULT 0, rssi_p50 SMALLINT NULL,
  snr_min FLOAT NULL, snr_max FLOAT NULL, snr_sum DOUBLE NOT NULL DEFAULT 0, snr_sumsq DOUBLE NOT NULL DEFAULT 0, snr_p50 FLOAT NULL,
  PRIMARY KEY (bucket_start, gateway_id, node_id),
  KEY ix_pair (gateway_id, node_id, bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE COLUMNS (bucket_start) (
  PARTITION pmin VALUES LESS THAN ('2020-01-01 00:00:00'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

CREATE TABLE reception_rollup_day (
  bucket_start  DATE         NOT NULL,
  gateway_id    INT UNSIGNED NOT NULL,
  node_id       INT UNSIGNED NOT NULL,
  packet_count  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  direct_count  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  relayed_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  unknown_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rssi_min SMALLINT NULL, rssi_max SMALLINT NULL, rssi_sum DOUBLE NOT NULL DEFAULT 0, rssi_sumsq DOUBLE NOT NULL DEFAULT 0, rssi_p50 SMALLINT NULL,
  snr_min FLOAT NULL, snr_max FLOAT NULL, snr_sum DOUBLE NOT NULL DEFAULT 0, snr_sumsq DOUBLE NOT NULL DEFAULT 0, snr_p50 FLOAT NULL,
  PRIMARY KEY (bucket_start, gateway_id, node_id),
  KEY ix_pair (gateway_id, node_id, bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE node_rollup_hour (
  bucket_start       DATETIME(3)  NOT NULL,
  node_id            INT UNSIGNED NOT NULL,
  packet_count       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reception_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  direct_heard_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  relayed_count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  unique_gateways    INT UNSIGNED NOT NULL DEFAULT 0,
  bytes_seen         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  est_airtime_ms     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  chan_util_avg      DOUBLE NULL,
  air_util_tx_avg    DOUBLE NULL,
  port_counts        JSON   NULL,
  PRIMARY KEY (bucket_start, node_id),
  KEY ix_node (node_id, bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE node_rollup_day  LIKE node_rollup_hour;

CREATE TABLE gateway_rollup_hour (
  bucket_start       DATETIME(3)  NOT NULL,
  gateway_id         INT UNSIGNED NOT NULL,
  packet_count       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reception_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  direct_heard_nodes INT UNSIGNED NOT NULL DEFAULT 0,
  malformed_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lag_ms_avg         DOUBLE NULL,
  last_seen_at       DATETIME(3) NULL,
  PRIMARY KEY (bucket_start, gateway_id),
  KEY ix_gw (gateway_id, bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE gateway_rollup_day LIKE gateway_rollup_hour;

CREATE TABLE mesh_rollup_hour (
  bucket_start       DATETIME(3) NOT NULL,
  active_nodes       INT UNSIGNED NOT NULL DEFAULT 0,
  new_nodes          INT UNSIGNED NOT NULL DEFAULT 0,
  unique_gateways    INT UNSIGNED NOT NULL DEFAULT 0,
  total_packets      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_receptions   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  malformed_packets  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  avg_chan_util      DOUBLE NULL,
  avg_air_util_tx    DOUBLE NULL,
  delivery_ratio     DOUBLE NULL,
  spoof_flags        INT UNSIGNED NOT NULL DEFAULT 0,
  health_score       DOUBLE NULL,
  PRIMARY KEY (bucket_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE mesh_rollup_day LIKE mesh_rollup_hour;

CREATE TABLE rollup_watermark (
  rollup_name        VARCHAR(64) NOT NULL,
  last_bucket_folded DATETIME(3) NULL,
  updated_at         DATETIME(3) NULL,
  PRIMARY KEY (rollup_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Phase 4+ event / record tables (created now so later phases need no re-ingest)
-- ---------------------------------------------------------------------------
CREATE TABLE propagation_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gateway_id    INT UNSIGNED NOT NULL,
  node_id       INT UNSIGNED NOT NULL,
  detected_at   DATETIME(3)  NOT NULL,
  event_type    ENUM('enhancement','dx_direct') NOT NULL,
  baseline_rssi SMALLINT NULL,
  observed_rssi SMALLINT NULL,
  delta_db      DOUBLE   NOT NULL,
  distance_km   DOUBLE   NULL,
  duration_s    INT      NULL,
  confidence    DOUBLE   NULL,
  metadata      JSON     NULL,
  PRIMARY KEY (id),
  KEY ix_time (detected_at),
  KEY ix_pair (gateway_id, node_id, detected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE records (
  record_type   VARCHAR(64) NOT NULL,
  value         DOUBLE      NOT NULL,
  unit          VARCHAR(16) NULL,
  node_a        INT UNSIGNED NULL,
  node_b        INT UNSIGNED NULL,
  achieved_at   DATETIME(3) NOT NULL,
  evidence      JSON        NULL,   -- denormalized so records outlive raw purge
  PRIMARY KEY (record_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE records_history (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_type  VARCHAR(64) NOT NULL,
  value        DOUBLE      NOT NULL,
  unit         VARCHAR(16) NULL,
  node_a       INT UNSIGNED NULL,
  node_b       INT UNSIGNED NULL,
  achieved_at  DATETIME(3) NOT NULL,
  superseded_at DATETIME(3) NULL,
  evidence     JSON        NULL,
  PRIMARY KEY (id),
  KEY ix_type_time (record_type, achieved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE alerts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id         VARCHAR(64) NOT NULL,
  severity        ENUM('info','warn','critical') NOT NULL DEFAULT 'warn',
  title           VARCHAR(255) NOT NULL,
  body            TEXT NOT NULL,
  created_at      DATETIME(3) NOT NULL,
  fired_key       VARCHAR(255) NOT NULL,
  resolved_at     DATETIME(3) NULL,
  acknowledged_at DATETIME(3) NULL,
  delivery        JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fire (rule_id, fired_key),
  KEY ix_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- operational / config tables
-- ---------------------------------------------------------------------------
CREATE TABLE broker_health (
  broker_id       VARCHAR(64) NOT NULL,
  connected       TINYINT(1)  NOT NULL DEFAULT 0,
  last_message_at DATETIME(3) NULL,
  messages        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  malformed       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reconnects      INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at      DATETIME(3) NULL,
  PRIMARY KEY (broker_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only tail for SSE (no LISTEN/NOTIFY in MySQL). Worker trims by age.
CREATE TABLE live_events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at DATETIME(3) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload    JSON        NOT NULL,
  PRIMARY KEY (id),
  KEY ix_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE mute_list (
  node_id  INT UNSIGNED NOT NULL,
  reason   VARCHAR(255) NULL,
  added_by VARCHAR(64)  NULL,
  added_at DATETIME(3)  NOT NULL,
  source   ENUM('config','admin') NOT NULL DEFAULT 'admin',
  PRIMARY KEY (node_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE admin_users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','viewer') NOT NULL DEFAULT 'admin',
  created_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE api_tokens (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash   CHAR(64) NOT NULL,
  label        VARCHAR(128) NULL,
  scopes       JSON NULL,
  created_at   DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at   DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
