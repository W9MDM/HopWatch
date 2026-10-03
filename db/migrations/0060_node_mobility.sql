-- Per-node mobility, derived from each node's own GPS track. A node whose reported position spans a
-- wide box has moved (a traveler, a node in a vehicle), as opposed to a fixed gateway whose position
-- only jitters by GPS noise. The /wardrive heat map uses this to drop coverage samples heard by a
-- MOBILE gateway: a receiver riding along with a transmitter hears it strongly the whole trip and
-- paints a false coverage trail. Recomputed by the worker; this is derived data with its own
-- provenance (Rule 8), never merged into the authoritative nodes/positions tables.
CREATE TABLE node_mobility (
  node_id     INT UNSIGNED NOT NULL,
  fixes       INT UNSIGNED NOT NULL,
  lat_span    DOUBLE       NOT NULL,
  lon_span    DOUBLE       NOT NULL,
  is_mobile   TINYINT(1)   NOT NULL DEFAULT 0,
  computed_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (node_id),
  KEY ix_mobile (is_mobile)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
