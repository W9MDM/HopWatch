-- Repair: earlier revisions of 0005 did not include settings_meta (it was added to
-- that file after some databases had already applied 0005). Migrations are recorded
-- by filename and never re-run, so create it here idempotently. Without this table,
-- saving a broker and the ingest hot-reload both fail.
CREATE TABLE IF NOT EXISTS settings_meta (
  id         INT UNSIGNED NOT NULL DEFAULT 1,
  rev        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO settings_meta (id, rev) VALUES (1, 0);
