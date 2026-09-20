CREATE TABLE IF NOT EXISTS remote_admin (
  node_id BIGINT UNSIGNED NOT NULL,
  first_ok_at DATETIME NULL,
  last_ok_at DATETIME NULL,
  last_scan_at DATETIME NULL,
  ok_count INT UNSIGNED NOT NULL DEFAULT 0,
  firmware_version VARCHAR(64) NULL,
  hw_model VARCHAR(64) NULL,
  role VARCHAR(48) NULL,
  PRIMARY KEY (node_id),
  KEY idx_remote_admin_last_ok (last_ok_at)
)
