-- Owned-node registry ported from the standalone meshadmin app. These are curated,
-- human-managed node records (ownership, sharing, maintenance logs, issue tracking) as
-- opposed to the observed `nodes` table which is auto-populated from MQTT. The column set
-- mirrors meshadmin's `nodes` table so its data imports one-to-one (see
-- scripts/import-meshadmin.mjs); ownership and sharing are re-keyed onto HopWatch's own
-- admin_users so there is a single identity system.

-- Community node groups (meshadmin `groups`). created_by references an admin_users row.
CREATE TABLE node_group (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(255) NOT NULL,
  description TEXT NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_created_by (created_by),
  CONSTRAINT fk_node_group_creator FOREIGN KEY (created_by) REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Group membership (meshadmin `group_members`).
CREATE TABLE node_group_member (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member (group_id, user_id),
  KEY ix_member_user (user_id),
  CONSTRAINT fk_group_member_group FOREIGN KEY (group_id) REFERENCES node_group (id) ON DELETE CASCADE,
  CONSTRAINT fk_group_member_user  FOREIGN KEY (user_id)  REFERENCES admin_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Curated owned nodes (meshadmin `nodes`). node_id keeps meshadmin's string id (e.g.
-- "!a1b2c3d4"); num_id is the parsed numeric id used to join the observed `nodes` table
-- when available. owner is the legacy free-text owner label; owner_user_id / owner_group_id
-- are the resolved integrated owners (one of them set, matching owner_type).
CREATE TABLE owned_node (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(255) NOT NULL,
  node_id        VARCHAR(32)  NULL,
  num_id         INT UNSIGNED NULL,
  owner          VARCHAR(255) NULL,
  owner_type     ENUM('user','group') NOT NULL DEFAULT 'user',
  owner_user_id  BIGINT UNSIGNED NULL,
  owner_group_id BIGINT UNSIGNED NULL,
  model          VARCHAR(128) NULL,
  elevation      VARCHAR(64)  NULL,
  frequency      VARCHAR(64)  NOT NULL DEFAULT '915 MHz',
  mqtt_topic     VARCHAR(255) NULL,
  mqtt_connected TINYINT(1)   NOT NULL DEFAULT 0,
  online         TINYINT(1)   NOT NULL DEFAULT 0,
  role           VARCHAR(64)  NOT NULL DEFAULT 'Client',
  lat            DOUBLE       NULL,
  lng            DOUBLE       NULL,
  planned_site   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_owned_num (num_id),
  KEY ix_owned_owner_user (owner_user_id),
  KEY ix_owned_owner_group (owner_group_id),
  CONSTRAINT fk_owned_owner_user  FOREIGN KEY (owner_user_id)  REFERENCES admin_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_owned_owner_group FOREIGN KEY (owner_group_id) REFERENCES node_group (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Node sharing (meshadmin `node_permissions`): grant view/edit to a user OR a group.
-- Exactly one of user_id / group_id is set.
CREATE TABLE node_permission (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owned_node_id    BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NULL,
  group_id         BIGINT UNSIGNED NULL,
  permission_level ENUM('view','edit') NOT NULL DEFAULT 'view',
  granted_by       BIGINT UNSIGNED NULL,
  granted_at       DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_node (owned_node_id, user_id),
  UNIQUE KEY uq_group_node (owned_node_id, group_id),
  KEY ix_perm_user (user_id),
  KEY ix_perm_group (group_id),
  CONSTRAINT fk_perm_node  FOREIGN KEY (owned_node_id) REFERENCES owned_node (id) ON DELETE CASCADE,
  CONSTRAINT fk_perm_user  FOREIGN KEY (user_id)       REFERENCES admin_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_perm_group FOREIGN KEY (group_id)      REFERENCES node_group (id) ON DELETE CASCADE,
  CONSTRAINT fk_perm_grantor FOREIGN KEY (granted_by)  REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Maintenance visit log (meshadmin `node_maintenance`).
CREATE TABLE node_maintenance (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owned_node_id BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NULL,
  visit_date    DATETIME(3) NOT NULL,
  notes         TEXT NULL,
  created_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_maint_node (owned_node_id, visit_date),
  CONSTRAINT fk_maint_node FOREIGN KEY (owned_node_id) REFERENCES owned_node (id) ON DELETE CASCADE,
  CONSTRAINT fk_maint_user FOREIGN KEY (user_id)       REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Issue tracking (meshadmin `node_issues`).
CREATE TABLE node_issue (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owned_node_id BIGINT UNSIGNED NOT NULL,
  reported_by   BIGINT UNSIGNED NULL,
  issue_type    VARCHAR(255) NOT NULL,
  description   TEXT NULL,
  status        ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
  reported_at   DATETIME(3) NOT NULL,
  resolved_at   DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_issue_node (owned_node_id, status),
  CONSTRAINT fk_issue_node     FOREIGN KEY (owned_node_id) REFERENCES owned_node (id) ON DELETE CASCADE,
  CONSTRAINT fk_issue_reporter FOREIGN KEY (reported_by)   REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
