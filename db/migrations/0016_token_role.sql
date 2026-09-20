-- RBAC: API tokens carry a role key (default 'viewer'). The role's module set is resolved
-- from the DB-backed rbac config at request time.
ALTER TABLE api_tokens ADD COLUMN role_key VARCHAR(64) NOT NULL DEFAULT 'viewer';
