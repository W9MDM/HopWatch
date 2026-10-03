-- Wardrive / RF coverage samples. One row per zero-hop (rf_direct) reception of a GPS position
-- packet: it records WHERE a transmitter was (its own self-reported GPS at that moment) and how
-- well a gateway heard it there (SNR/RSSI). Aggregated, these draw an actual over-the-air RF
-- coverage heat map on /wardrive, built by anyone who drives the mesh (Rule 4: direct only;
-- relayed/self/injected receptions say nothing about the source-to-gateway RF path).
CREATE TABLE coverage_sample (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sample_time  DATETIME(3)     NOT NULL,
  latitude     DOUBLE          NOT NULL,
  longitude    DOUBLE          NOT NULL,
  gateway_id   INT UNSIGNED    NOT NULL,
  from_node_id INT UNSIGNED    NOT NULL,
  rx_snr       FLOAT           NULL,
  rx_rssi      SMALLINT        NULL,
  channel_id   VARCHAR(64)     NULL,
  source       VARCHAR(16)     NOT NULL DEFAULT 'live',
  PRIMARY KEY (id),
  KEY ix_time (sample_time),
  KEY ix_geo (latitude, longitude)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
