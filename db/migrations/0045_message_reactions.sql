-- Reply threading and tapback reactions on text messages.
--
-- Data carries reply_id (field 7, the packet id being replied to) and emoji (field 8, non-zero
-- when the payload is a reaction rather than a message). Both were dropped, so a tapback was
-- stored as an ordinary chat message whose body is just the emoji character, indistinguishable
-- from a user typing it: /messages showed reaction traffic as message spam, reply threads could
-- not be reconstructed, and the RF patcher re-broadcast reactions as if they were messages.
--
-- reply_to_packet_id holds the MESH packet id (as sent on the wire), not our internal packets.id,
-- because a reply can reference a packet we never observed.
ALTER TABLE text_message
  ADD COLUMN reply_to_packet_id INT UNSIGNED NULL,
  ADD COLUMN is_reaction TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX ix_reply ON text_message (reply_to_packet_id);
