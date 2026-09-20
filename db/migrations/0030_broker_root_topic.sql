-- Explicit per-broker Meshtastic topic root (e.g. msh/US/IN/NWI), used by the MQTT bridge to
-- rewrite forwarded messages onto the destination broker's namespace instead of guessing from
-- the subscribe topic. Empty = derive from the broker's subscribe topic.
ALTER TABLE mqtt_broker ADD COLUMN root_topic VARCHAR(255) NOT NULL DEFAULT '';
