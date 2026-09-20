-- Per-broker connected-client presence, reconstructed from the broker's log by the ingest daemon.
-- Only populated for a broker whose log_file is configured and readable (the local Mosquitto);
-- Mosquitto does not expose per-client identity over $SYS, so its text log is the only source.
ALTER TABLE mqtt_broker ADD COLUMN log_file VARCHAR(512) NOT NULL DEFAULT '';

CREATE TABLE mqtt_client (
  broker_id     VARCHAR(64)  NOT NULL,
  client_id     VARCHAR(191) NOT NULL,
  ip            VARCHAR(64)  NULL,
  username      VARCHAR(128) NULL,
  keepalive_s   INT          NULL,
  protocol      INT          NULL,
  kind          VARCHAR(32)  NULL,   -- classified: hopwatch / app (android|apple) / node / other
  node_id       INT UNSIGNED NULL,   -- resolved mesh node id when the client id encodes one
  connected_at  DATETIME(3)  NULL,   -- start of the current session
  last_event_at DATETIME(3)  NULL,
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (broker_id, client_id),
  KEY ix_broker (broker_id, connected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
