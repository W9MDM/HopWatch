-- Marks whether a packet's decoded side-data (position/telemetry/text/neighbor/traceroute) has
-- been written yet. Lets the first reception that carries a successful decode claim the write
-- atomically, so a packet whose earlier copies were undecodable (encrypted, key missing) still
-- gets its side-data when a later copy decodes, without double-writing when N gateways decode.
ALTER TABLE packets ADD COLUMN decoded_side_written TINYINT NOT NULL DEFAULT 0;
