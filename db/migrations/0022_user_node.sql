-- Per-user node watchlist: favorites/stars, private notes, tags, and per-node alert
-- subscriptions (distinct from the global alert rules). Keyed to admin_users so it is private
-- to each account. One row per (user, node); absent row means "not watched".
CREATE TABLE user_node (
  user_id       BIGINT UNSIGNED NOT NULL,
  node_id       INT UNSIGNED NOT NULL,
  favorite      TINYINT(1)   NOT NULL DEFAULT 0,
  note          TEXT         NULL,
  tags          JSON         NULL,
  alert_offline TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (user_id, node_id),
  KEY ix_un_user (user_id),
  KEY ix_un_node (node_id),
  CONSTRAINT fk_user_node_user FOREIGN KEY (user_id) REFERENCES admin_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
