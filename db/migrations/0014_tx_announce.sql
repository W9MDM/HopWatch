-- Add the NODEINFO announce kind to the TX outbox so HopWatch can (optionally) tell the mesh
-- its name. Off by default (tx.announce_interval_s = 0).
ALTER TABLE tx_outbox
  MODIFY COLUMN kind ENUM('text','dm','traceroute','position_req','telemetry_req','announce') NOT NULL;
