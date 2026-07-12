import type { Pool } from 'pg';
import type { SourceId } from '../shared/types.js';

export interface RejectedRecordInput {
  source: SourceId;
  externalId: string | null;
  rawPayload: Record<string, unknown>;
  rejectionStage: 'validation' | 'normalization';
  failureReason: string;
}

/**
 * Repository for the rejected_records table.
 *
 * Persists terminal validation and normalization rejections.
 * This is NOT a queue — no retry, acknowledgement, or replay semantics.
 *
 * A rejection record is evidence of an intentional terminal data-quality failure.
 */
export class RejectedRecordRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Persist a rejected record.
   *
   * @throws on database/infrastructure errors. The caller must treat a thrown
   *         error as an unresolved outcome (rejection evidence was NOT persisted).
   */
  async insert(input: RejectedRecordInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO rejected_records (source, external_id, raw_payload, rejection_stage, failure_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.source,
        input.externalId,
        JSON.stringify(input.rawPayload),
        input.rejectionStage,
        input.failureReason,
      ]
    );
  }

  /**
   * Count rejected records for a given source.
   * Used primarily in tests.
   */
  async countBySource(source: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM rejected_records WHERE source = $1`,
      [source]
    );
    return result.rows[0].count;
  }
}
