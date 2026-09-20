-- Per-node RF profile for predicted coverage. Meshtastic MQTT does not broadcast TX power
-- or antenna height, so these are operator overrides. NULL = fall back to the node's GPS
-- altitude (height) and the configured default EIRP.
ALTER TABLE nodes ADD COLUMN rf_height_m DOUBLE NULL;
ALTER TABLE nodes ADD COLUMN rf_eirp_dbm DOUBLE NULL;
