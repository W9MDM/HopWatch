-- Notification forwarding (mesh -> Discord/Apprise). Rules pick which events and
-- channels to publish and to which Apprise-style targets. Target URLs are stored
-- AES-encrypted at rest (they carry webhook tokens); the master key stays in env.

CREATE TABLE forward_rule (
  id         VARCHAR(64) NOT NULL,
  enabled    TINYINT(1)  NOT NULL DEFAULT 1,
  events     JSON        NOT NULL,
  channels   JSON        NOT NULL,
  targets    JSON        NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE forward_state (
  rule_id        VARCHAR(64) NOT NULL,
  last_text_id   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_node_seen DATETIME(3) NULL,
  updated_at     DATETIME(3) NULL,
  PRIMARY KEY (rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
