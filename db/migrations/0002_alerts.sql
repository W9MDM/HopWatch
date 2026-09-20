-- Alerts are edge-triggered and auto-resolve, so the same (rule, entity) can fire
-- again after a prior occurrence resolves. Replace the forever-unique key with a
-- lookup index; the worker manages dedup by checking for an unresolved row first.
ALTER TABLE alerts DROP INDEX uq_fire;

ALTER TABLE alerts ADD KEY ix_rule_key (rule_id, fired_key, resolved_at);
