CREATE TABLE IF NOT EXISTS tx_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at DATETIME NOT NULL,
  outbox_id BIGINT UNSIGNED NULL,
  level VARCHAR(8) NOT NULL DEFAULT 'info',
  message VARCHAR(500) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_tx_log_created (created_at)
)
