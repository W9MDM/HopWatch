-- NeighborInfo RF adjacency (feeds the mesh graph) and stored text messages.

CREATE TABLE node_neighbor (
  node_id     INT UNSIGNED NOT NULL,
  neighbor_id INT UNSIGNED NOT NULL,
  snr         FLOAT NULL,
  updated_at  DATETIME(3) NOT NULL,
  PRIMARY KEY (node_id, neighbor_id),
  KEY ix_neighbor (neighbor_id),
  KEY ix_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE text_message (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  observed_at      DATETIME(3) NOT NULL,
  from_node_id     INT UNSIGNED NOT NULL,
  to_node_id       INT UNSIGNED NULL,
  channel_id       VARCHAR(64) NULL,
  channel_index    TINYINT UNSIGNED NULL,
  body             VARCHAR(512) NOT NULL,
  source_packet_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_time (observed_at),
  KEY ix_from (from_node_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
