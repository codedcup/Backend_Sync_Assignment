ALTER TABLE payments RENAME COLUMN collected_at TO source_created_at;

DROP INDEX IF EXISTS idx_payments_status_collected;
DROP INDEX IF EXISTS idx_payments_collected_at;

CREATE INDEX IF NOT EXISTS idx_payments_status_created
  ON payments (normalized_status, source_created_at);

CREATE INDEX IF NOT EXISTS idx_payments_source_created_at
  ON payments (source_created_at);
