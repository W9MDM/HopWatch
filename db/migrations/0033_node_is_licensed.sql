-- Ham "licensed operator" flag from the NodeInfo/User packet (User.is_licensed). Captured so the
-- node page can show it; NULL until a NodeInfo carrying the bit is seen.
ALTER TABLE nodes ADD COLUMN is_licensed TINYINT(1) NULL;
