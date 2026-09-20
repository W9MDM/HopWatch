ALTER TABLE tx_outbox MODIFY state ENUM('queued','held','sending','dry_run','sent','heard','acked','failed','cancelled') NOT NULL DEFAULT 'queued'
