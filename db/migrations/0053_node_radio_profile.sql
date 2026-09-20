-- The MapReport fields that were decoded and then discarded.
--
-- MAP_REPORT_APP is unencrypted by design and is not downconverted by the firmware's own JSON
-- serializer, so this is data only the protobuf path can see, and HopWatch was reading it and
-- throwing it away. What it enables:
--   * region + modem_preset: a node on a preset or region that does not match the rest of the mesh
--     is visible over MQTT but cannot be heard on RF, which today looks identical to a node with a
--     bad antenna. This is the single most common real misconfiguration.
--   * has_default_channel: a one-column list of nodes still on the public default PSK.
--   * num_online_local_nodes: each reporter's own count of its local mesh. Divergence between two
--     reporters is the cheapest partition evidence available.
ALTER TABLE nodes
  ADD COLUMN region VARCHAR(16) NULL,
  ADD COLUMN modem_preset VARCHAR(24) NULL,
  ADD COLUMN has_default_channel TINYINT(1) NULL,
  ADD COLUMN reported_local_nodes INT UNSIGNED NULL,
  ADD COLUMN radio_profile_at DATETIME(3) NULL;

CREATE INDEX ix_region_preset ON nodes (region, modem_preset);
