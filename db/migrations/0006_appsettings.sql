-- UI-editable config overrides (merged over config/hopwatch.yaml at runtime).
-- Secret fields inside the JSON (e.g. SMTP password) are AES-encrypted at rest;
-- the master key stays in env. Non-secret operators' settings are stored plainly.
CREATE TABLE app_setting (
  skey       VARCHAR(128) NOT NULL,
  sval       MEDIUMTEXT   NULL,
  updated_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (skey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
