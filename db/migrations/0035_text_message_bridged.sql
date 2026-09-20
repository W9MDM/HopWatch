-- Marks a text message as considered by the RF<->MQTT patcher (so each is handled once). NULL =
-- not yet evaluated; set once the hold window passes and the patcher patches it, or decides it
-- was already carried across on its own (heard on both transports).
ALTER TABLE text_message ADD COLUMN bridged_at DATETIME(3) NULL;
