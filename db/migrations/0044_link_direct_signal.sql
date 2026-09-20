-- Direct-only RSSI/SNR aggregates on gateway_node_link.
--
-- The existing rssi_sum/snr_sum accumulate EVERY reception class (rf_direct, rf_direct_low_conf,
-- rf_relayed, unknown), but three consumers divide them by the total count and present the
-- result as direct-link signal: gatewayCompare's avg_direct_rssi, bestGatewaysForNode's
-- avg_rssi/avg_snr, and the node page's pair history. A node that reaches a gateway mostly via a
-- nearby strong relay therefore shows an inflated "direct" RSSI, and gateways get ranked by a
-- number that is not direct RSSI at all. Rule 4: only zero-hop (rf_direct) RF says anything
-- about the source's own link.
--
-- These columns hold the same statistics over rf_direct receptions only. NULL/0 for links with
-- no direct reception, and for rows written before this migration until new receptions accumulate
-- (this is a running counter table, so historical rows are not back-filled. The direct counters
-- start from zero and converge as traffic arrives).
ALTER TABLE gateway_node_link
  ADD COLUMN rssi_direct_sum DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN rssi_direct_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN rssi_direct_min SMALLINT NULL,
  ADD COLUMN rssi_direct_max SMALLINT NULL,
  ADD COLUMN snr_direct_sum DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN snr_direct_count BIGINT UNSIGNED NOT NULL DEFAULT 0;

-- The hourly rollup already carries rssi_direct_sum/count (0032) but has no direct-only SNR sum,
-- so the pair-history chart had no honest direct SNR series to draw.
ALTER TABLE reception_rollup_hour
  ADD COLUMN snr_direct_sum DOUBLE NULL,
  ADD COLUMN snr_direct_count INT NULL;
