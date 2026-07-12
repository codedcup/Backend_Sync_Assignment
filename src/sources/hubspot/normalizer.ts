import type { SourceNormalizer } from '../adapter.js';
import type { NormalizationResult, RawSourceRecord } from '../../shared/types.js';
import { SourceId, RecordType } from '../../shared/types.js';

/**
 * HubSpot CRM Contact normalizer.
 *
 * Converts a raw HubSpot contact into a canonical NormalizedRecord.
 *
 * Verified field mappings:
 * - externalId:        raw.externalId (= HubSpot response.id)
 * - sourceModifiedAt:  raw.data._hubspot_updated_at (= HubSpot response.updatedAt)
 * - payload:           cleaned contact properties (firstname, lastname, email, phone, company)
 *
 * Rejection rules:
 * - Missing externalId → normalization rejection.
 * - Missing _hubspot_updated_at → normalization rejection (required for freshness protection).
 * - Archived contacts are still normalized (they represent valid state transitions).
 */
export class HubSpotNormalizer implements SourceNormalizer {
  readonly sourceId = SourceId.HUBSPOT;

  normalize(raw: RawSourceRecord): NormalizationResult {
    // Validate external ID
    if (!raw.externalId) {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: null,
        rawPayload: raw.data,
        rejectionStage: 'validation',
        failureReason: 'Missing HubSpot contact ID',
      };
    }

    // Validate source modification timestamp
    const updatedAt = raw.data._hubspot_updated_at;
    if (!updatedAt || typeof updatedAt !== 'string') {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: raw.externalId,
        rawPayload: raw.data,
        rejectionStage: 'validation',
        failureReason: 'Missing or invalid HubSpot updatedAt timestamp',
      };
    }

    const sourceModifiedAt = new Date(updatedAt);
    if (isNaN(sourceModifiedAt.getTime())) {
      return {
        kind: 'rejection',
        source: this.sourceId,
        externalId: raw.externalId,
        rawPayload: raw.data,
        rejectionStage: 'normalization',
        failureReason: `Invalid HubSpot updatedAt timestamp: ${updatedAt}`,
      };
    }

    // Build the canonical payload — only meaningful contact properties
    const payload: Record<string, unknown> = {
      firstname: raw.data.firstname ?? null,
      lastname: raw.data.lastname ?? null,
      email: raw.data.email ?? null,
      phone: raw.data.phone ?? null,
      company: raw.data.company ?? null,
      archived: raw.data._hubspot_archived ?? false,
    };

    return {
      kind: 'normalized_record',
      record: {
        source: this.sourceId,
        externalId: raw.externalId,
        recordType: RecordType.CONTACT,
        sourceModifiedAt,
        payload,
      },
    };
  }
}
