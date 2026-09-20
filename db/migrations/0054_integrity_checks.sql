-- Three more integrity conflict checks, over data already in `nodes`.
--
-- The pass covered only "this node's public key changed" and identity flapping. The three added
-- here are the ones an observatory is actually asked about:
--   * duplicate_pubkey: two DIFFERENT node ids presenting the SAME public key. This is the converse
--     of the existing check and the signature of a cloned device or a restored NodeDB backup. It
--     breaks PKI DMs for everyone who cached either identity, and nothing detected it.
--   * duplicate_short_name: two active nodes claiming the same short name. The routine cause of
--     operator confusion, and invisible until someone notices by hand.
--   * router_not_relaying: a node whose role claims ROUTER or REPEATER, active in the window, whose
--     low byte never appears in relay_nodes. The inverse of the existing role_violation check
--     (which catches a CLIENT_MUTE that IS relaying), so a router that is not routing goes unseen.
ALTER TABLE node_flags
  MODIFY flag_type ENUM(
    'spoof_pubkey','identity_flap','role_violation','anomaly',
    'duplicate_pubkey','duplicate_short_name','router_not_relaying'
  ) NOT NULL;
