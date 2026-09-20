-- Last-reception RF metrics restricted to zero-hop (rf_direct) receptions.
--
-- gateway_node_link.last_rssi/last_snr are written by EVERY reception class, because upsertLink
-- runs for rf_direct, rf_direct_low_conf, rf_relayed and unknown alike. Several consumers then
-- read them as the source node's own direct-link signal, which is only true of a zero-hop
-- reception (Rule 4). A relayed hop's RSSI describes the RELAY's link to the gateway, so mixing
-- it in corrupts:
--   - the DX / longest-link permanent records (src/worker/records.ts), which pair the value with
--     a source-to-gateway distance it does not describe
--   - the terrain link budget's observed_rssi and therefore its RSSI deficit vs free-space loss
--     (src/worker/linkbudget.ts)
--   - the dx_direct propagation events (src/worker/tropo.ts)
--
-- Populated only on an rf_direct reception. NULL until such a reception is seen, which is the
-- honest answer: a node heard only via relays has no measured direct signal.
-- snr_direct_min/max complete the direct-only set alongside the rssi_direct_min/max added in
-- 0044, so the direct-heard roster can publish honest SNR bounds instead of the blended ones.
ALTER TABLE gateway_node_link
  ADD COLUMN last_direct_rssi SMALLINT NULL,
  ADD COLUMN last_direct_snr FLOAT NULL,
  ADD COLUMN last_direct_rf_at DATETIME(3) NULL,
  ADD COLUMN snr_direct_min FLOAT NULL,
  ADD COLUMN snr_direct_max FLOAT NULL;
