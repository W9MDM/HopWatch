-- Decoded ROUTING_APP (port 5) acks and NAKs, correlated by request id.
--
-- Routing was counted but never decoded, so the TX outbox had no way to tell an ACK from a NAK or
-- to know WHICH message either referred to. hasRoutingAck asked only "was any port-5 packet
-- addressed to our node since this row was sent", and every in-flight row shares the same
-- from_node (ours), so one node acking one DM promoted EVERY in-flight row to 'acked'. Routing
-- carries failures too (Routing.Error NO_ROUTE / MAX_RETRANSMIT / NO_RESPONSE / RATE_LIMIT_EXCEEDED
-- and the rest), so proof of FAILED delivery was recorded as an ack.
--
-- Data.request_id (mesh.proto field 6) is the packet id being answered, which is what makes the
-- correlation exact. error_reason 0 (Routing.Error.NONE) is an ack; anything else is a NAK, with
-- the enum name kept for display.
CREATE TABLE routing_ack (
  request_id    INT UNSIGNED NOT NULL,
  from_node_id  INT UNSIGNED NOT NULL,
  to_node_id    INT UNSIGNED NULL,
  error_code    INT UNSIGNED NOT NULL DEFAULT 0,
  error_name    VARCHAR(48)  NULL,
  observed_at   DATETIME(3)  NOT NULL,
  source_packet_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (request_id, from_node_id, observed_at),
  KEY ix_request (request_id, error_code),
  KEY ix_time (observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
