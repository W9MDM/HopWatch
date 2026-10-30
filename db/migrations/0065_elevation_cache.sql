-- Persistent cache of ground elevations sampled from an elevation source (USGS 3DEP by
-- default). Terrain is static, so a sampled point never expires: only genuine cache misses
-- hit the upstream source, which keeps the link-budget batch and the on-demand LOS tool fast
-- and polite to the source. Points are snapped to a ~11 m grid (coordinate * 10000, rounded to
-- an integer) so overlapping paths that share a gateway reuse the same samples. Derived data
-- per Rule 8: cached here, never merged into node_positions.
CREATE TABLE IF NOT EXISTS elevation_cache (
  source      VARCHAR(24) NOT NULL,
  lat_e4      INT NOT NULL,
  lon_e4      INT NOT NULL,
  elevation_m DOUBLE NOT NULL,
  fetched_at  DATETIME(3) NOT NULL,
  PRIMARY KEY (source, lat_e4, lon_e4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
