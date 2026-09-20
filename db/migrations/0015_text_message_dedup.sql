-- RX watchdog for messages: one text message per logical packet. Several gateways receiving
-- the same packet must not create duplicate message rows. Remove any existing duplicates
-- (keep the earliest row per packet), then enforce uniqueness on source_packet_id so the
-- ingest INSERT IGNORE can never write a second copy.
DELETE t1 FROM text_message t1
JOIN text_message t2
  ON t1.source_packet_id = t2.source_packet_id
 AND t1.source_packet_id IS NOT NULL
 AND t1.id > t2.id;

ALTER TABLE text_message ADD UNIQUE KEY uq_source_packet (source_packet_id);
