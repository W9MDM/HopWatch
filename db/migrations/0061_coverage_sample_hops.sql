-- Add hop count to coverage samples so /wardrive can show a second "reach" layer built from RELAYED
-- receptions (not just direct). A relayed packet's SNR belongs to the last hop, not the sender, so it
-- is useless for a signal map (Rule 4) -- but the sender's GPS is real and the packet demonstrably
-- reached the mesh, so it is honest as "a node here reached the network in N hops." hops = 0 means
-- heard direct (zero hop); > 0 means relayed that many times; NULL means relayed an unknown number
-- (old firmware without hop_start). Every existing row was captured direct, so backfill it to 0.
ALTER TABLE coverage_sample ADD COLUMN hops TINYINT NULL;
UPDATE coverage_sample SET hops = 0 WHERE hops IS NULL;
