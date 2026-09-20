-- MQTT text bridge (opt-in). Records the sender's "OK to MQTT" approval per packet and logs
-- every bridged text message for audit. The bridge only forwards TEXT_MESSAGE_APP packets
-- whose sender set the OK-to-MQTT bit; see CLAUDE.md Rule 2.
ALTER TABLE packets ADD COLUMN ok_to_mqtt TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE bridge_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bridged_at    DATETIME(3)  NOT NULL,
  direction     ENUM('out','in') NOT NULL,
  from_broker   VARCHAR(64)  NULL,
  to_broker     VARCHAR(64)  NULL,
  from_node_id  INT UNSIGNED NULL,
  mesh_packet_id INT UNSIGNED NULL,
  channel_id    VARCHAR(64)  NULL,
  topic         VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY ix_time (bridged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
