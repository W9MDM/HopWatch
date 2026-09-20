-- How HopWatch itself heard a reception: via an MQTT broker, or directly over RF through the
-- station-node transport. Distinct from reception_class (which describes the packet's mesh path).
-- Existing rows predate the RF transport, so they are all 'mqtt'.
ALTER TABLE receptions ADD COLUMN transport ENUM('mqtt','rf') NOT NULL DEFAULT 'mqtt';
