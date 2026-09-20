-- Backfill channel on historical text messages. Older rows were inserted with a NULL
-- channel_id/channel_index (bug: the ingest never stored it), so the Messages page shows
-- "-" and channel-filtered forwarding never matched them. The linked packet already
-- carries the channel, so copy it across. New rows store the channel directly.
UPDATE text_message t
JOIN packets p ON p.id = t.source_packet_id
SET t.channel_id = p.channel_id,
    t.channel_index = p.channel_index
WHERE t.channel_id IS NULL AND p.channel_id IS NOT NULL;
