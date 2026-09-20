CREATE TABLE IF NOT EXISTS weather_alert_sent (
  alert_id VARCHAR(255) NOT NULL,
  event VARCHAR(80) NULL,
  severity VARCHAR(16) NULL,
  area VARCHAR(255) NULL,
  sent_at DATETIME NOT NULL,
  PRIMARY KEY (alert_id),
  KEY idx_wx_alert_sent (sent_at)
)
