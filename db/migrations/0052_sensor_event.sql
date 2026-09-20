-- DETECTION_SENSOR_APP (10) and ALERT_APP (11) bodies.
--
-- Both carry plain UTF-8 text, exactly like TEXT_MESSAGE_APP: the firmware treats all three as
-- "text message" for delivery purposes (MeshService.h returns true for TEXT_MESSAGE_APP,
-- DETECTION_SENSOR_APP and ALERT_APP alike). HopWatch counted the port and discarded the body, so a
-- physical-world event stream (door opened, motion, water level, from the firmware's
-- DetectionSensorModule) and the mesh's critical-alert broadcasts were both thrown away. This
-- matters on a self-hosted observatory in particular: the firmware suppresses detection-sensor
-- uplinks only when isConfiguredForDefaultServer, so on a private broker they flow normally.
--
-- A separate table, not text_message: these are not chat, and putting them there would make a door
-- sensor appear in /messages and be eligible for the RF<->MQTT patcher.
CREATE TABLE sensor_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node_id       INT UNSIGNED    NOT NULL,
  kind          ENUM('detection','alert') NOT NULL,
  body          VARCHAR(512)    NOT NULL,
  channel_id    VARCHAR(64)     NULL,
  observed_at   DATETIME(3)     NOT NULL,
  source_packet_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_source_packet (source_packet_id),
  KEY ix_node_time (node_id, observed_at),
  KEY ix_observed (observed_at),
  KEY ix_kind_time (kind, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
