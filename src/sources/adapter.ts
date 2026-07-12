import type {
  FetchResult,
  NormalizationResult,
  RawSourceRecord,
  SourceId,
  SyncState,
} from '../shared/types.js';

// =============================================================================
// Source Adapter Contract
// =============================================================================

/**
 * A source adapter owns external API communication for a single source.
 *
 * Responsibilities:
 * - Fetch records from the external source (incremental or full).
 * - Detect stale cursor / sync token and signal full-fetch recovery.
 * - Extract source identity and reliable freshness metadata.
 */
export interface SourceAdapter {
  readonly sourceId: SourceId;

  /**
   * Fetch a page/batch of records from the source.
   *
   * @param syncState - The current persisted sync state (may be null for first run).
   * @returns A FetchResult containing records and the next cursor/token.
   */
  fetch(syncState: SyncState | null): Promise<FetchResult>;
}

// =============================================================================
// Normalizer Contract
// =============================================================================

/**
 * A normalizer converts a raw source record into a canonical normalized model.
 *
 * It may produce:
 * - A normalized record (CRM/Calendar).
 * - A normalized payment (Square).
 * - A rejection (validation or normalization failure).
 *
 * Normalizers must never throw for data-quality issues.
 * They return a NormalizationFailure instead.
 */
export interface SourceNormalizer {
  readonly sourceId: SourceId;

  /**
   * Normalize a single raw source record.
   */
  normalize(raw: RawSourceRecord): NormalizationResult;
}
