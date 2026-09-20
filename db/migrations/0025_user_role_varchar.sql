-- Let a user's role be any RBAC role key (admin/viewer/member/public/custom), not just the
-- original admin/viewer enum. This is what lets admins change privilege levels per user,
-- including Discord self-provisioned accounts. Existing 'admin'/'viewer' values are preserved.
ALTER TABLE admin_users MODIFY COLUMN role VARCHAR(32) NOT NULL DEFAULT 'viewer';
