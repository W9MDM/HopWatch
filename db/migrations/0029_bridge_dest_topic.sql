-- Record the rewritten destination topic per bridged forward (the existing `topic` column is
-- the source topic), so the bridge audit log shows the full source -> destination mapping.
ALTER TABLE bridge_log ADD COLUMN dest_topic VARCHAR(255) NULL;
