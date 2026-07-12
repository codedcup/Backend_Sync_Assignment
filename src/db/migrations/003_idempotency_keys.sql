CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key VARCHAR(255) NOT NULL,
  operation VARCHAR(255) NOT NULL,
  fingerprint TEXT NOT NULL,
  status VARCHAR(50) NOT NULL,
  http_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (idempotency_key, operation)
);
