-- Space weather observations (optional; off by default). Solar/geomagnetic conditions
-- pulled from NOAA SWPC and stored for RF propagation context (correlates with the
-- propagation_events logged by the tropo/DX detector). One row per worker poll.
CREATE TABLE space_weather_obs (
  fetched_at      DATETIME(3) NOT NULL,
  kp              DOUBLE NULL,
  kp_observed_at  DATETIME(3) NULL,
  solar_flux_10cm DOUBLE NULL,
  solar_wind_kms  DOUBLE NULL,
  condition_label VARCHAR(16) NULL,
  PRIMARY KEY (fetched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
