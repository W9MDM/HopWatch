-- UI-managed ingest settings. Seeded once from config/hopwatch.yaml, then the
-- admin Settings UI is the source of truth. The ingest daemon hot-reloads on change.

CREATE TABLE mqtt_broker (
  id           VARCHAR(64) NOT NULL,
  enabled      TINYINT(1)  NOT NULL DEFAULT 1,
  host         VARCHAR(255) NOT NULL,
  port         INT UNSIGNED NOT NULL DEFAULT 1883,
  username     VARCHAR(255) NOT NULL DEFAULT '',
  password     VARCHAR(255) NOT NULL DEFAULT '',
  client_id    VARCHAR(128) NOT NULL DEFAULT '',
  tls_enabled  TINYINT(1)  NOT NULL DEFAULT 0,
  tls_insecure TINYINT(1)  NOT NULL DEFAULT 0,
  qos          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  topics       JSON NOT NULL,
  updated_at   DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE channel_key (
  name       VARCHAR(64) NOT NULL,
  key_b64    VARCHAR(128) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Monotonic revision bumped on every settings change; the ingest daemon polls it
-- and reloads when it advances (reliable across deletes, unlike MAX(updated_at)).
CREATE TABLE settings_meta (
  id         INT UNSIGNED NOT NULL DEFAULT 1,
  rev        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO settings_meta (id, rev) VALUES (1, 0);
