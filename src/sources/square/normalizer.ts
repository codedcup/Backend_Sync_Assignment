import type { SourceNormalizer } from '../adapter.js';
import type { NormalizationResult, RawSourceRecord } from '../../shared/types.js';
import { SourceId } from '../../shared/types.js';

export class SquareNormalizer implements SourceNormalizer {
  readonly sourceId = SourceId.SQUARE;

  normalize(raw: RawSourceRecord): NormalizationResult {
    const data = raw.data as Record<string, any>;

    if (!raw.externalId) {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: null,
        rawPayload: data,
        rejectionStage: 'validation',
        failureReason: 'Missing Square payment ID',
      };
    }

    const createdAtStr = data.created_at;
    if (!createdAtStr || typeof createdAtStr !== 'string') {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: raw.externalId,
        rawPayload: data,
        rejectionStage: 'validation',
        failureReason: 'Missing created_at timestamp',
      };
    }

    const sourceCreatedAt = new Date(createdAtStr);
    if (isNaN(sourceCreatedAt.getTime())) {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: raw.externalId,
        rawPayload: data,
        rejectionStage: 'normalization',
        failureReason: `Invalid created_at timestamp: ${createdAtStr}`,
      };
    }

    const updatedAtStr = data.updated_at;
    let sourceModifiedAt: Date | null = null;
    if (updatedAtStr && typeof updatedAtStr === 'string') {
      sourceModifiedAt = new Date(updatedAtStr);
      if (isNaN(sourceModifiedAt.getTime())) {
        return {
          kind: 'rejection',
          source: this.sourceId,
          externalId: raw.externalId,
          rawPayload: data,
          rejectionStage: 'normalization',
          failureReason: `Invalid updated_at timestamp: ${updatedAtStr}`,
        };
      }
    }

    const amountMoney = data.amount_money;
    if (!amountMoney || typeof amountMoney.amount !== 'number' || !amountMoney.currency) {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: raw.externalId,
        rawPayload: data,
        rejectionStage: 'validation',
        failureReason: 'Missing or invalid amount_money field',
      };
    }

    const sourceStatus = data.status || 'UNKNOWN';
    let normalizedStatus = 'uncollected';
    if (sourceStatus === 'COMPLETED') {
      normalizedStatus = 'collected';
    } else if (sourceStatus === 'CANCELED' || sourceStatus === 'FAILED' || sourceStatus === 'APPROVED') {
      normalizedStatus = sourceStatus.toLowerCase();
    } else {
      normalizedStatus = 'unknown';
    }

    return {
      kind: 'normalized_payment',
      payment: {
        source: this.sourceId,
        externalId: raw.externalId,
        sourceStatus,
        normalizedStatus,
        amount: amountMoney.amount,
        currency: amountMoney.currency,
        sourceCreatedAt,
        sourceModifiedAt,
      },
    };
  }
}
