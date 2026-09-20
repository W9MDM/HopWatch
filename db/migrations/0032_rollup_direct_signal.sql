-- Direct-only RSSI/SNR aggregates on the hourly reception rollup. The existing rssi_p50/snr_p50
-- (and rssi_sum) blend rf_direct with rf_relayed, so a relayed hop's RF (relay->gateway) pollutes
-- what is presented as the source node's link quality and the tropo baseline (Rule 4: only
-- zero-hop RF says anything about the source's signal). These columns hold the same statistics
-- computed over rf_direct receptions only. NULL for hours with no direct reception, and for
-- rollup rows written before this migration until they are re-folded.
ALTER TABLE reception_rollup_hour
  ADD COLUMN rssi_direct_sum BIGINT NULL,
  ADD COLUMN rssi_direct_count INT NULL,
  ADD COLUMN rssi_direct_p50 INT NULL,
  ADD COLUMN snr_direct_p50 DECIMAL(6,2) NULL;
