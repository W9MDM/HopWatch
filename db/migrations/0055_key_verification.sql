-- KEY_VERIFICATION_APP (port 12) handshake observability.
--
-- The out-of-band PKI key-verification exchange between two nodes. HopWatch counted the port and
-- discarded the payload, so an observatory could see that verification traffic existed but not who
-- was verifying whom, nor whether it completed.
--
-- The correlator is KeyVerification.nonce: the requester picks it, and every message of the same
-- handshake carries it. Which hash is present says where in the exchange a message sits:
--   * neither hash: the opening request from node A;
--   * hash2 only: node B's response (an intermediary hash derived from hash1);
--   * hash1: node A's closing, authoritative hash.
-- So a nonce whose rows never reach the hash1 stage is an abandoned or failed verification, which is
-- exactly the signal worth surfacing. The hashes themselves are recorded only as a presence flag:
-- they are handshake material, not something to publish.
CREATE TABLE key_verification (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nonce         BIGINT UNSIGNED NOT NULL,
  from_node_id  INT UNSIGNED    NOT NULL,
  to_node_id    INT UNSIGNED    NULL,
  stage         ENUM('request','response','final') NOT NULL,
  observed_at   DATETIME(3)     NOT NULL,
  source_packet_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_source_packet (source_packet_id),
  KEY ix_nonce (nonce, observed_at),
  KEY ix_observed (observed_at),
  KEY ix_from (from_node_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
