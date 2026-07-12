// =============================================================================
// Source Identifiers
// =============================================================================

/**
 * Supported synchronization sources.
 * Each value maps to the `source` column in database tables.
 */
export const SourceId = {
  HUBSPOT: 'hubspot',
  GOOGLE_CALENDAR: 'google_calendar',
  SQUARE: 'square',
} as const;

export type SourceId = (typeof SourceId)[keyof typeof SourceId];

/** All supported source identifiers. */
export const ALL_SOURCES: readonly SourceId[] = Object.values(SourceId);

// =============================================================================
// Canonical Record Types
// =============================================================================

export const RecordType = {
  CONTACT: 'contact',
  EVENT: 'event',
  PAYMENT: 'payment',
} as const;

export type RecordType = (typeof RecordType)[keyof typeof RecordType];

// =============================================================================
// Normalized Models
// =============================================================================

/**
 * Canonical normalized external record (CRM contacts, calendar events).
 * Maps to the `normalized_records` table.
 */
export interface NormalizedRecord {
  source: SourceId;
  externalId: string;
  recordType: RecordType;
  sourceModifiedAt: Date | null;
  payload: Record<string, unknown>;
}

/**
 * Canonical normalized payment record.
 * Maps to the `payments` table.
 */
export interface NormalizedPayment {
  source: SourceId;
  externalId: string;
  sourceStatus: string;
  normalizedStatus: string;
  amount: number; // Integer minor units (cents)
  currency: string;
  sourceCreatedAt: Date;
  sourceModifiedAt: Date | null;
}

// =============================================================================
// Source Adapter Contracts
// =============================================================================

/**
 * A single raw record fetched from an external source.
 */
export interface RawSourceRecord {
  externalId: string;
  data: Record<string, unknown>;
}

/**
 * A page/batch of fetched records from a source, with an optional next cursor.
 */
export interface FetchResult {
  records: RawSourceRecord[];
  /** The cursor/token representing this fetch boundary. null = no more pages. */
  nextCursor: string | null;
  isFullFetch: boolean;
  /** Whether there are more pages in the current sync boundary. */
  hasNextPage: boolean;
}

/**
 * Persisted sync state for a source.
 */
export interface SyncState {
  source: SourceId;
  cursor: string | null;
  lastSuccessfulSyncAt: Date | null;
}

// =============================================================================
// Normalization Outcomes
// =============================================================================

export interface NormalizationSuccess {
  kind: 'normalized_record';
  record: NormalizedRecord;
}

export interface NormalizationPaymentSuccess {
  kind: 'normalized_payment';
  payment: NormalizedPayment;
}

export interface NormalizationFailure {
  kind: 'rejection';
  source: SourceId;
  externalId: string | null;
  rawPayload: Record<string, unknown>;
  rejectionStage: 'validation' | 'normalization';
  failureReason: string;
}

export type NormalizationResult =
  | NormalizationSuccess
  | NormalizationPaymentSuccess
  | NormalizationFailure;

// =============================================================================
// Record Processing Outcomes
// =============================================================================

/** Record was successfully persisted (insert or idempotent update). */
export interface PersistedOutcome {
  kind: 'persisted';
  resolved: true;
  externalId: string;
}

/** Record was rejected and rejection evidence was successfully persisted. */
export interface RejectedOutcome {
  kind: 'rejected';
  resolved: true;
  externalId: string | null;
  reason: string;
}

/**
 * Record could not be fully resolved due to a persistence, infrastructure,
 * or unexpected internal failure. Progress must NOT advance.
 */
export interface UnresolvedOutcome {
  kind: 'unresolved';
  resolved: false;
  externalId: string | null;
  error: string;
}

export type RecordOutcome = PersistedOutcome | RejectedOutcome | UnresolvedOutcome;

// =============================================================================
// Source Sync Result
// =============================================================================

export interface SourceSyncResult {
  source: SourceId;
  status: 'success' | 'failed';
  recordsProcessed: number;
  recordsPersisted: number;
  recordsRejected: number;
  recordsUnresolved: number;
  error?: string;
}

export interface SyncRunResult {
  status: 'success' | 'partial_success' | 'failed';
  sources: Record<string, SourceSyncResult>;
}
