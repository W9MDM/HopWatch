-- Two-way mesh capability (TX pipeline). Passive-by-default: these tables exist on every
-- install but stay empty unless TX is enabled AND armed by an admin. No code path publishes
-- directly; everything goes through tx_outbox and is enforced/audited by the worker.

-- The outbox is the single audited queue and state machine for all outbound traffic.
CREATE TABLE IF NOT EXISTS tx_outbox (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at    DATETIME(3)   NOT NULL,
  created_by    VARCHAR(128)  NOT NULL,
  transport     ENUM('mqtt','node') NOT NULL DEFAULT 'mqtt',
  kind          ENUM('text','dm','traceroute','position_req','telemetry_req') NOT NULL,
  channel_id    VARCHAR(64)   NULL,
  to_node       INT UNSIGNED  NULL,
  from_node     INT UNSIGNED  NOT NULL,
  payload_text  VARCHAR(512)  NULL,
  encoded       BLOB          NULL,
  packet_id     INT UNSIGNED  NULL,
  hop_limit     TINYINT UNSIGNED NOT NULL DEFAULT 3,
  want_ack      TINYINT(1)    NOT NULL DEFAULT 0,
  state         ENUM('queued','held','dry_run','sent','heard','acked','failed','cancelled') NOT NULL DEFAULT 'queued',
  attempts      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_attempt_at DATETIME(3) NULL,
  sent_at       DATETIME(3)   NULL,
  error         VARCHAR(255)  NULL,
  PRIMARY KEY (id),
  KEY ix_state (state, created_at),
  KEY ix_packet (packet_id),
  KEY ix_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Delivery confirmations: our own transmitted packet observed coming back as receptions is
-- the implicit ACK. Joins into the existing receptions model so the packet browser and maps
-- show our traffic like any other node.
CREATE TABLE IF NOT EXISTS tx_confirmations (
  outbox_id      BIGINT UNSIGNED NOT NULL,
  reception_id   BIGINT UNSIGNED NULL,
  gateway_id     INT UNSIGNED  NOT NULL,
  heard_at       DATETIME(3)   NOT NULL,
  is_routing_ack TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (outbox_id, gateway_id),
  KEY ix_outbox (outbox_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- RBAC: API tokens gain a transmit privilege, default off. Anonymous read-only can never TX.
ALTER TABLE api_tokens ADD COLUMN can_tx TINYINT(1) NOT NULL DEFAULT 0;
