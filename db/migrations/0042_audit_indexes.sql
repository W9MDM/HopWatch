-- Audit C6/P2: indexes matching hot read paths.
-- getPacketDetail side-lookups filtered every side table by source_packet_id with no index
-- (full partition scans on click); the battery pages group node_telemetry by a metric-only
-- filter (metric-leading index needed); getGraphData filters gateway_node_link by link recency.
ALTER TABLE node_telemetry ADD KEY ix_src_packet (source_packet_id), ADD KEY ix_metric_time (metric, observed_at, node_id);
ALTER TABLE node_position_events ADD KEY ix_src_packet (source_packet_id);
ALTER TABLE node_identity_events ADD KEY ix_src_packet (source_packet_id);
ALTER TABLE link_events ADD KEY ix_src_packet (source_packet_id);
ALTER TABLE gateway_node_link ADD KEY ix_last_direct (last_direct_at), ADD KEY ix_last_relayed (last_relayed_at);
