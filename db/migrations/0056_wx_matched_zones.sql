-- Which configured zones let a weather alert through.
--
-- An NWS query for `zone=A,B` returns any alert affecting A or B, but the alert covers whatever it
-- covers: a Storm Prediction Center watch that names one local county also names twenty others,
-- routinely across state lines. So the broadcast log showed a wall of counties with no indication of
-- which entry in the operator's own zone list matched, which makes a surprising broadcast (an alert
-- for a county nowhere near the mesh) impossible to diagnose from the UI.
--
-- Recording the matched codes makes it self-explaining: a stray or over-broad zone code shows up by
-- name next to the alert it admitted.
ALTER TABLE weather_alert_sent
  ADD COLUMN matched_zones VARCHAR(255) NULL;
