-- Phase 5 completion: battery death predictor + new-node review marker.

CREATE TABLE battery_forecast (
  node_id           INT UNSIGNED NOT NULL,
  computed_at       DATETIME(3) NOT NULL,
  power_profile     ENUM('solar','mains','battery','unknown') NOT NULL DEFAULT 'unknown',
  slope_v_per_day   DOUBLE NULL,
  current_voltage   DOUBLE NULL,
  projected_dead_at DATETIME(3) NULL,
  confidence        DOUBLE NULL,
  PRIMARY KEY (node_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- New-node review feed: mark a first-heard node as reviewed/acknowledged.
ALTER TABLE nodes ADD COLUMN reviewed_at DATETIME(3) NULL;
