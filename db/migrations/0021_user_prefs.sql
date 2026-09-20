-- Per-user preferences (profile page): default broker/channel filters and similar display
-- defaults. JSON so new keys do not need a migration each time. Null for accounts that have
-- not set any preferences.
ALTER TABLE admin_users ADD COLUMN prefs JSON NULL;
