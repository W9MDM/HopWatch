-- Estimated node positions (feature: estimate location of nodes that never TX a position).
-- Provenance is deliberately separate from node_positions: an estimate is never written
-- to, merged with, or allowed to shadow a real position row. History is preserved, one
-- row appended per recompute; the current estimate is MAX(computed_at) per node.
CREATE TABLE IF NOT EXISTS position_estimate (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node_id             INT UNSIGNED    NOT NULL,
  method_tier         TINYINT UNSIGNED NOT NULL,
  latitude            DOUBLE          NOT NULL,
  longitude           DOUBLE          NOT NULL,
  confidence_radius_m DOUBLE          NOT NULL,
  receiver_count      SMALLINT UNSIGNED NOT NULL,
  window_days         SMALLINT UNSIGNED NOT NULL,
  possibly_mobile     TINYINT(1)      NOT NULL DEFAULT 0,
  computed_at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_node_time (node_id, computed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
