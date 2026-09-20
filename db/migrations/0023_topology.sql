-- Accumulated mesh topology + traceroute freshness, so the network layout builds up over
-- time from observed traceroutes instead of being re-reconstructed each view, and the
-- scheduler never re-traces a node whose route is still fresh.

-- Undirected link accumulated from traceroute hops. One row per node pair (a < b).
CREATE TABLE mesh_link (
  a_node_id     INT UNSIGNED NOT NULL,
  b_node_id     INT UNSIGNED NOT NULL,
  first_seen_at DATETIME(3)  NOT NULL,
  last_seen_at  DATETIME(3)  NOT NULL,
  last_snr      FLOAT        NULL,
  times_seen    INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (a_node_id, b_node_id),
  KEY ix_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-node traceroute freshness. last_requested_at is set when the scheduler enqueues a
-- trace (so it will not re-enqueue for the configured interval); last_result_at is set when
-- a route involving the node is actually observed.
CREATE TABLE traceroute_state (
  node_id           INT UNSIGNED NOT NULL,
  last_requested_at DATETIME(3)  NULL,
  last_result_at    DATETIME(3)  NULL,
  attempts          INT UNSIGNED NOT NULL DEFAULT 0,
  last_hop_count    TINYINT UNSIGNED NULL,
  PRIMARY KEY (node_id),
  KEY ix_requested (last_requested_at),
  KEY ix_result (last_result_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
