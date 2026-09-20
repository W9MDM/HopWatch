-- Record the MQTT topic each text message arrived on, so the messages view can show it.
-- Populated going forward; older rows stay NULL.
ALTER TABLE text_message ADD COLUMN source_topic VARCHAR(255) NULL;
