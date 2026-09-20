-- Discord SSO: link a Discord account to an admin_users row. Logging in with Discord maps
-- the Discord id to the linked account and its role. Nullable + unique (MySQL allows many
-- NULLs), so accounts without a linked Discord are unaffected.
ALTER TABLE admin_users ADD COLUMN discord_id VARCHAR(64) NULL;
ALTER TABLE admin_users ADD COLUMN discord_username VARCHAR(128) NULL;
ALTER TABLE admin_users ADD UNIQUE KEY uq_discord_id (discord_id);
