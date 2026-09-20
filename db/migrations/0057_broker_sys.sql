-- Broker-side $SYS statistics, one row per configured broker. Populated by the ingest daemon,
-- which subscribes to $SYS/broker/# on each broker that exposes it (Mosquitto does by default;
-- many public brokers restrict it, in which case these columns stay NULL). This is the true
-- broker view: how many clients are connected right now, versus the observed-gateway roster which
-- is derived from published traffic. Mirrors broker_health's shape (one flushed snapshot per broker).
CREATE TABLE broker_sys (
  broker_id            VARCHAR(64)     NOT NULL,
  clients_connected    INT             NULL,
  clients_active       INT             NULL,
  clients_total        INT             NULL,
  clients_disconnected INT             NULL,
  uptime_s             BIGINT          NULL,
  version              VARCHAR(128)    NULL,
  msgs_received        BIGINT          NULL,
  msgs_sent            BIGINT          NULL,
  updated_at           DATETIME(3)     NULL,
  PRIMARY KEY (broker_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
