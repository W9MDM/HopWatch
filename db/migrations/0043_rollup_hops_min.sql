-- Audit P3: serve the map's per-node hop counts from the hourly rollup instead of
-- re-aggregating 24h of raw receptions on every /map and /livemap render (the heaviest
-- read in the app). hops_min is the fewest RF hops (hop_start - hop_limit) any reception
-- in the bucket used, computed over rf_direct/rf_relayed only (Rule 4: relayed copies of
-- non-RF classes say nothing about air distance). NULL when the hour had no RF reception
-- with usable hop fields.
ALTER TABLE reception_rollup_hour ADD COLUMN hops_min TINYINT UNSIGNED NULL;

-- One-time backfill of the recent window the maps read (24h + margin). Older buckets keep
-- NULL, which the map queries never consult. CASTs avoid MySQL unsigned-subtraction errors
-- on malformed packets where hop_limit > hop_start; those rows are excluded, matching the
-- plausibility clamps used elsewhere (audit C10).
UPDATE reception_rollup_hour rr
JOIN (
  SELECT gateway_id, from_node_id,
         CAST(DATE_FORMAT(rx_time, '%Y-%m-%d %H:00:00.000') AS DATETIME(3)) AS bs,
         MIN(CAST(hop_start AS SIGNED) - CAST(hop_limit AS SIGNED)) AS h
  FROM receptions
  WHERE rx_time >= (UTC_TIMESTAMP() - INTERVAL 48 HOUR)
    AND hop_start IS NOT NULL AND hop_limit IS NOT NULL
    AND reception_class IN ('rf_direct','rf_relayed')
    AND CAST(hop_start AS SIGNED) - CAST(hop_limit AS SIGNED) BETWEEN 0 AND 255
  GROUP BY gateway_id, from_node_id, bs
) x ON x.gateway_id = rr.gateway_id AND x.from_node_id = rr.node_id AND x.bs = rr.bucket_start
SET rr.hops_min = x.h;
