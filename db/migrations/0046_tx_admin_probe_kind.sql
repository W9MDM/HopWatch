-- Add 'admin_probe' to tx_outbox.kind.
--
-- The remote-admin scanner (src/worker/adminscan.ts) enqueues kind='admin_probe' and the TxKind
-- union in src/meshtastic/encode.ts has included it since the feature shipped, but the column ENUM
-- was never widened past 'announce' (0014). Every probe therefore failed at INSERT under strict
-- mode, so the scanner could never discover an administrable node: the feature was inert from the
-- day it landed. Widening the ENUM is additive and does not touch existing rows.
ALTER TABLE tx_outbox
  MODIFY COLUMN kind ENUM('text','dm','traceroute','position_req','telemetry_req','announce','admin_probe') NOT NULL;
