-- Record which ingest broker each text message came from, so the messages view can show the
-- source broker (not just the channel). Populated going forward; older rows stay NULL.
ALTER TABLE text_message ADD COLUMN source_broker_id VARCHAR(64) NULL;
