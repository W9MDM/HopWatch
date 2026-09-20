-- Phase 4: RF/propagation baselines, weather, terrain link budget, health snapshot.
-- (propagation_events, records, records_history already exist from 0001.)

-- Rolling RSSI/SNR baseline per (gateway, node) for tropo/ducting detection.
CREATE TABLE rf_link_baseline (
  gateway_id    INT UNSIGNED NOT NULL,
  node_id       INT UNSIGNED NOT NULL,
  baseline_rssi DOUBLE NULL,
  baseline_snr  DOUBLE NULL,
  sample_count  INT UNSIGNED NOT NULL DEFAULT 0,
  window_hours  INT UNSIGNED NOT NULL DEFAULT 24,
  updated_at    DATETIME(3) NULL,
  PRIMARY KEY (gateway_id, node_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Weather observations (optional; off by default). Forward-fill from enable time.
CREATE TABLE weather_obs (
  station_id   VARCHAR(32) NOT NULL,
  observed_at  DATETIME(3) NOT NULL,
  temp_c       DOUBLE NULL,
  humidity     DOUBLE NULL,
  pressure_hpa DOUBLE NULL,
  wind_speed   DOUBLE NULL,
  precip       DOUBLE NULL,
  PRIMARY KEY (station_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Terrain-aware link budget results per node pair.
CREATE TABLE terrain_link_budget (
  node_a                INT UNSIGNED NOT NULL,
  node_b                INT UNSIGNED NOT NULL,
  computed_at           DATETIME(3) NOT NULL,
  distance_km           DOUBLE NULL,
  expected_path_loss_db DOUBLE NULL,
  fresnel_clearance     DOUBLE NULL,
  observed_rssi         DOUBLE NULL,
  deficit_db            DOUBLE NULL,
  profile               JSON NULL,
  PRIMARY KEY (node_a, node_b)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Latest mesh health score + weighted breakdown (also mirrored into mesh_rollup_hour).
CREATE TABLE health_snapshot (
  id          TINYINT UNSIGNED NOT NULL DEFAULT 1,
  score       DOUBLE NULL,
  breakdown   JSON NULL,
  computed_at DATETIME(3) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
