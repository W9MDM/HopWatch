CREATE TABLE IF NOT EXISTS service_control (
  service VARCHAR(32) NOT NULL,
  restart_at DATETIME NOT NULL,
  requested_by VARCHAR(120) NULL,
  PRIMARY KEY (service)
)
