import type { Pool } from 'pg';
import type { NormalizedRecord } from '../shared/types.js';

/**
 * Upsert result from the database.
 */
export interface UpsertResult {
  /** Whether the row was actually written (inserted or updated). */
  written: boolean;
  /** Whether this was a new insertion vs an update or no-op. */
  inserted: boolean;
}

/**
 * Repository for normalized_records table.
 *
 * Enforces:
 * - Idempotency via UNIQUE(source, external_id) + ON CONFLICT upsert.
 * - Stale-update protection via source_modified_at comparison in the
 *   UPDATE WHERE clause.
 */
export class NormalizedRecordRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Idempotent, update-aware, stale-protected upsert.
   *
   * - INSERT if (source, external_id) does not exist.
   * - UPDATE if incoming source_modified_at is newer than stored, or if
   *   the stored source_modified_at is NULL.
   * - NO-OP if the stored source_modified_at is newer than incoming
   *   (stale-update protection).
   * - Duplicate delivery of identical data is idempotent.
   *
   * @returns UpsertResult indicating whether a write occurred.
   * @throws on database/infrastructure errors (caller must treat as unresolved).
   */
  async upsert(record: NormalizedRecord): Promise<UpsertResult> {
    const result = await this.pool.query(
      `INSERT INTO normalized_records (source, external_id, record_type, source_modified_at, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (source, external_id)
       DO UPDATE SET
         record_type = EXCLUDED.record_type,
         source_modified_at = EXCLUDED.source_modified_at,
         payload = EXCLUDED.payload,
         updated_at = now()
       WHERE
         -- Allow update when no existing freshness marker
         normalized_records.source_modified_at IS NULL
         -- Allow update when incoming is newer or equal (idempotent)
         OR normalized_records.source_modified_at <= EXCLUDED.source_modified_at
         -- Allow update when incoming has no freshness marker (can't compare)
         OR EXCLUDED.source_modified_at IS NULL
       RETURNING
         (xmax = 0) AS inserted`,
      [
        record.source,
        record.externalId,
        record.recordType,
        record.sourceModifiedAt?.toISOString() ?? null,
        JSON.stringify(record.payload),
      ]
    );

    if (result.rowCount === 0) {
      // ON CONFLICT matched but WHERE clause rejected the update (stale)
      return { written: false, inserted: false };
    }

    return {
      written: true,
      inserted: result.rows[0].inserted === true,
    };
  }

  /**
   * Find a normalized record by source + externalId.
   * Used primarily in tests.
   */
  async findBySourceAndExternalId(
    source: string,
    externalId: string
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT * FROM normalized_records WHERE source = $1 AND external_id = $2`,
      [source, externalId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Count normalized records for a given source.
   * Used primarily in tests.
   */
  async countBySource(source: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM normalized_records WHERE source = $1`,
      [source]
    );
    return result.rows[0].count;
  }
}
