-- Real wall-clock time the first reception of a packet was ingested. first_seen_at
-- is snapped to the 5-minute dedup bucket (needed so re-broadcasts collapse), which
-- made the packet browser look like traffic only arrived every 5 minutes. Display
-- this instead.
ALTER TABLE packets ADD COLUMN first_reception_at DATETIME(3) NULL;
