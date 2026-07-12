import type { SourceNormalizer } from '../adapter.js';
import type { NormalizationResult, RawSourceRecord } from '../../shared/types.js';
import { SourceId, RecordType } from '../../shared/types.js';

/**
 * Google Calendar Event normalizer.
 *
 * Converts a raw Google Event into a canonical NormalizedRecord.
 *
 * Verified field mappings:
 * - externalId:        raw.externalId (= Google response.id)
 * - sourceModifiedAt:  raw.data._google_updated (= Google response.updated)
 * - payload:           cleaned event properties (summary, description, start, end)
 *
 * Rejection rules:
 * - Missing externalId → normalization rejection.
 * - Missing updated timestamp → normalization rejection (required for freshness protection).
 * - Cancelled events (status === 'cancelled') are normalized with archived: true to propagate deletions.
 */
export class GoogleCalendarNormalizer implements SourceNormalizer {
  readonly sourceId = SourceId.GOOGLE_CALENDAR;

  normalize(raw: RawSourceRecord): NormalizationResult {
    if (!raw.externalId) {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: null,
        rawPayload: raw.data,
        rejectionStage: 'validation',
        failureReason: 'Missing Google Calendar event ID',
      };
    }

    const updated = raw.data._google_updated;
    if (!updated || typeof updated !== 'string') {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: raw.externalId,
        rawPayload: raw.data,
        rejectionStage: 'validation',
        failureReason: 'Missing or invalid Google Calendar updated timestamp',
      };
    }

    const sourceModifiedAt = new Date(updated);
    if (isNaN(sourceModifiedAt.getTime())) {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: raw.externalId,
        rawPayload: raw.data,
        rejectionStage: 'normalization',
        failureReason: `Invalid Google Calendar updated timestamp: ${updated}`,
      };
    }

    const isCancelled = raw.data.status === 'cancelled';

    const payload: Record<string, unknown> = {
      summary: raw.data.summary ?? null,
      description: raw.data.description ?? null,
      status: raw.data.status ?? null,
      start: raw.data.start ?? null,
      end: raw.data.end ?? null,
      archived: isCancelled,
    };

    return {
      kind: 'normalized_record',
      record: {
        source: this.sourceId,
        externalId: raw.externalId,
        recordType: RecordType.EVENT,
        sourceModifiedAt,
        payload,
      },
    };
  }
}
