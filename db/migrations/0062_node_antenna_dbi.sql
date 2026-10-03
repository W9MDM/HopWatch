-- Per-node antenna gain (dBi) for the predicted-coverage model. When an operator knows a node's
-- antenna gain but not its full EIRP, the ring is derived as assumed conducted TX power
-- (coverage.default_tx_power_dbm) + this gain, capped at the regional EIRP limit. An explicit
-- rf_eirp_dbm override still wins; NULL here falls back to the plain default EIRP.
ALTER TABLE nodes ADD COLUMN rf_antenna_dbi DOUBLE NULL;
