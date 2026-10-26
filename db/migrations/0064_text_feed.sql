-- Public decoded-text JSON feed (feed.*). Re-publishes public-channel TEXT_MESSAGE_APP broadcasts
-- as compact JSON to one MQTT broker so downstream consumers (Home Assistant, dashboards) get the
-- de-duplicated text feed without decrypting themselves.
--
-- feed_at marks a text message as considered by the feed, so each logical message is published at
-- most once. NULL = not yet evaluated; set once the worker publishes it or decides it is ineligible.
-- Kept separate from bridged_at (which the RF<->MQTT patcher owns) so the two forwarders never
-- clobber each other's progress.
ALTER TABLE text_message ADD COLUMN feed_at DATETIME(3) NULL;

-- Record a successful feed publish in the existing bridge_log audit table under a new direction.
-- 'feed' is the JSON text feed; it joins the MQTT federation (out/in) and the RF<->MQTT patcher
-- (rf_to_mqtt/mqtt_to_rf/skip) already recorded there, so /admin/bridge shows every republish path.
ALTER TABLE bridge_log MODIFY direction ENUM('out','in','rf_to_mqtt','mqtt_to_rf','skip','feed') NOT NULL;
