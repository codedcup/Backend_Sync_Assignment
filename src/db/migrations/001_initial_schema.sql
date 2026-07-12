-- Migration 001: Initial schema
-- Creates all four required tables with constraints and justified indexes.

-- Enable UUID generation (native to Postgres 13+ / Supabase)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- normalized_records
-- Purpose: Store canonical CRM and Calendar records.
-- =============================================================================
CREATE TABLE IF NOT EXISTS normalized_records (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT        NOT NULL,
  external_id    TEXT        NOT NULL,
  record_type    TEXT        NOT NULL,
  source_modified_at TIMESTAMPTZ,
  payload        JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- PRD §12: UNIQUE(source, external_id) — enforces source-scoped identity
  CONSTRAINT uq_normalized_records_source_external_id UNIQUE (source, external_id)
);

-- PRD §12: (source, source_modified_at) for source-state inspection
CREATE INDEX IF NOT EXISTS idx_normalized_records_source_modified
  ON normalized_records (source, source_modified_at);

-- =============================================================================
-- payments
-- Purpose: Store normalized Square payment state used by revenue metrics.
-- =============================================================================
CREATE TABLE IF NOT EXISTS payments (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source             TEXT        NOT NULL,
  external_id        TEXT        NOT NULL,
  source_status      TEXT        NOT NULL,
  normalized_status  TEXT        NOT NULL,
  amount             BIGINT      NOT NULL,
  currency           TEXT        NOT NULL,
  collected_at       TIMESTAMPTZ,
  source_modified_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- PRD §12: UNIQUE(source, external_id) — enforces source-scoped identity
  CONSTRAINT uq_payments_source_external_id UNIQUE (source, external_id)
);

-- PRD §12: (normalized_status, collected_at) — revenue metric queries
CREATE INDEX IF NOT EXISTS idx_payments_status_collected
  ON payments (normalized_status, collected_at);

-- PRD §12: collected_at — date-range revenue queries
CREATE INDEX IF NOT EXISTS idx_payments_collected_at
  ON payments (collected_at);

-- PRD §12: (source, source_modified_at) — source-state inspection
CREATE INDEX IF NOT EXISTS idx_payments_source_modified
  ON payments (source, source_modified_at);

-- =============================================================================
-- sync_states
-- Purpose: Persist independent source synchronization progress.
-- =============================================================================
CREATE TABLE IF NOT EXISTS sync_states (
  source                  TEXT        PRIMARY KEY,
  cursor                  TEXT,
  last_successful_sync_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- PRD §12: UNIQUE(source) — enforced via PRIMARY KEY
  CONSTRAINT uq_sync_states_source UNIQUE (source)
);

-- =============================================================================
-- rejected_records
-- Purpose: Persist terminal normalization and validation rejections.
-- =============================================================================
CREATE TABLE IF NOT EXISTS rejected_records (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source           TEXT        NOT NULL,
  external_id      TEXT,
  raw_payload      JSONB       NOT NULL DEFAULT '{}',
  rejection_stage  TEXT        NOT NULL,
  failure_reason   TEXT        NOT NULL,
  rejected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- rejection_stage constrained to known values
  CONSTRAINT chk_rejection_stage CHECK (rejection_stage IN ('validation', 'normalization'))
);

-- PRD §12: (source, rejected_at) — rejected-record inspection
CREATE INDEX IF NOT EXISTS idx_rejected_records_source_rejected_at
  ON rejected_records (source, rejected_at);
