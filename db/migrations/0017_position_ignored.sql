-- Let an admin ignore a node's location (bad/spoofed GPS placing it in the wrong spot and
-- skewing the maps). This hides the node from all maps and coverage without muting its
-- traffic. Muting everything from a node is separate (mute_hidden / mute_list).
ALTER TABLE nodes ADD COLUMN position_ignored TINYINT(1) NOT NULL DEFAULT 0;
