-- Indexes the retention DELETEs and the liveness probes actually need.
--
-- Three of the four age-pruned event tables had no index whose LEADING column is the predicate
-- column: node_identity_events, node_position_events and link_events each index (node_id,
-- observed_at) or (from_node_id, to_node_id, observed_at), which cannot serve
-- `WHERE observed_at < ?`. Only text_message had ix_time(observed_at), which is presumably why the
-- pattern looked fine when it was written. So the worker full-scanned all three tables every 30
-- minutes forever, and with the default 365-day window most of those scans delete nothing at all:
-- the cost is pure overhead that grows with chat, mobile-node and traceroute volume.
CREATE INDEX ix_observed ON node_identity_events (observed_at);
CREATE INDEX ix_observed ON node_position_events (observed_at);
CREATE INDEX ix_observed ON link_events (observed_at);

-- MAX(rx_time) on receptions could not use the "select tables optimized away" shortcut, because no
-- index leads with rx_time (PRIMARY is (id, rx_time), and every secondary index leads with a node
-- or class column). The admin diagnostics bundle asks for it unbounded, so it scanned every row of
-- every daily partition, in a file whose own header promises it "stays cheap on a partitioned
-- install". A leading rx_time index also helps the retention/rollup range scans.
CREATE INDEX ix_rx_time ON receptions (rx_time);
