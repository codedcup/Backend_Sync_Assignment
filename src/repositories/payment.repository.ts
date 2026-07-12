import type { Pool } from 'pg';
import type { NormalizedPayment } from '../shared/types.js';

export interface PaymentUpsertResult {
  written: boolean;
  inserted: boolean;
}

/**
 * Repository for the payments table.
 *
 * Same idempotency and stale-update protection semantics as NormalizedRecordRepository.
 */
export class PaymentRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Idempotent, update-aware, stale-protected payment upsert.
   */
  async upsert(payment: NormalizedPayment): Promise<PaymentUpsertResult> {
    const result = await this.pool.query(
      `INSERT INTO payments (source, external_id, source_status, normalized_status, amount, currency, source_created_at, source_modified_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (source, external_id)
       DO UPDATE SET
         source_status = EXCLUDED.source_status,
         normalized_status = EXCLUDED.normalized_status,
         amount = EXCLUDED.amount,
         currency = EXCLUDED.currency,
         source_created_at = EXCLUDED.source_created_at,
         source_modified_at = EXCLUDED.source_modified_at,
         updated_at = now()
       WHERE
         payments.source_modified_at IS NULL
         OR payments.source_modified_at <= EXCLUDED.source_modified_at
         OR EXCLUDED.source_modified_at IS NULL
       RETURNING
         (xmax = 0) AS inserted`,
      [
        payment.source,
        payment.externalId,
        payment.sourceStatus,
        payment.normalizedStatus,
        payment.amount,
        payment.currency,
        payment.sourceCreatedAt.toISOString(),
        payment.sourceModifiedAt?.toISOString() ?? null,
      ]
    );

    if (result.rowCount === 0) {
      return { written: false, inserted: false };
    }

    return {
      written: true,
      inserted: result.rows[0].inserted === true,
    };
  }

  async findBySourceAndExternalId(
    source: string,
    externalId: string
  ): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT * FROM payments WHERE source = $1 AND external_id = $2`,
      [source, externalId]
    );
    return result.rows[0] ?? null;
  }

  async countBySource(source: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE source = $1`,
      [source]
    );
    return result.rows[0].count;
  }
}
