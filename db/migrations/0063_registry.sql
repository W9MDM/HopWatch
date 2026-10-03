-- Instance registry: an opt-in directory of HopWatch deployments.
--
-- registry_instance: heartbeats this instance has received while acting as a hub
-- (registry.hub.enabled). Minimal identity only: name, public URL, version, and
-- first/last-seen timestamps. No node data, telemetry, or secrets are ever stored.
--
-- registry_self: this instance's own stable announcer id and last-announce time,
-- used by the worker when registry.announce.enabled so each deployment reports with
-- a consistent id and the hub can dedupe it. Single row (id = 1).
CREATE TABLE registry_instance (
  instance_id VARCHAR(64)  NOT NULL,
  name        VARCHAR(191) NOT NULL DEFAULT '',
  url         VARCHAR(512) NOT NULL DEFAULT '',
  version     VARCHAR(64)  NOT NULL DEFAULT '',
  first_seen  DATETIME     NOT NULL,
  last_seen   DATETIME     NOT NULL,
  last_ip     VARCHAR(64)  NOT NULL DEFAULT '',
  hidden      TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (instance_id),
  KEY ix_registry_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE registry_self (
  id               TINYINT     NOT NULL,
  instance_id      VARCHAR(64) NOT NULL,
  last_announce_at DATETIME    NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
