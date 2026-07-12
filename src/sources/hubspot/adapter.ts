import type { SourceAdapter } from '../adapter.js';
import type { FetchResult, RawSourceRecord, SyncState } from '../../shared/types.js';
import { SourceId } from '../../shared/types.js';

/**
 * HubSpot CRM API response shapes.
 */
interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

interface HubSpotListResponse {
  results: HubSpotContact[];
  paging?: {
    next?: {
      after: string;
    };
  };
}

interface HubSpotSearchResponse {
  total: number;
  results: HubSpotContact[];
  paging?: {
    next?: {
      after: string;
    };
  };
}

/**
 * Verified HubSpot field mappings:
 *
 * - External ID:              response.id (= properties.hs_object_id)
 * - Source modification:       response.updatedAt (= properties.lastmodifieddate)
 * - Incremental filter field:  lastmodifieddate (property name for Search API)
 * - Pagination:               cursor-based via paging.next.after
 *
 * Full fetch:        GET  /crm/v3/objects/contacts?limit=100&properties=...&after=<cursor>
 * Incremental fetch: POST /crm/v3/objects/contacts/search (lastmodifieddate GTE cursor, ASC sort)
 *
 * Boundary strategy: GTE (inclusive) — safe overlap, idempotent reprocessing.
 * PRD §7: "Prefer safe reprocessing over a boundary gap because persistence is idempotent."
 */

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const PAGE_LIMIT = 100;

/** Properties to request from HubSpot. */
const REQUESTED_PROPERTIES = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'company',
  'lastmodifieddate',
];

/**
 * HubSpot CRM Contacts adapter.
 *
 * Supports:
 * - Full fetch for initial sync (no cursor).
 * - Incremental fetch using lastmodifieddate GTE cursor.
 * - Pagination via after cursor.
 * - Stable external ID from response.id.
 * - Source freshness from response.updatedAt.
 */
export class HubSpotAdapter implements SourceAdapter {
  readonly sourceId = SourceId.HUBSPOT;

  constructor(private readonly accessToken: string) {}

  async fetch(syncState: SyncState | null): Promise<FetchResult> {
    if (!syncState?.cursor) {
      return this.fullFetch();
    }
    return this.incrementalFetch(syncState.cursor);
  }

  /**
   * Full fetch: GET all contacts using the list endpoint.
   * Used for initial sync (no prior cursor).
   */
  private async fullFetch(): Promise<FetchResult> {
    const allRecords: RawSourceRecord[] = [];
    let afterCursor: string | undefined;
    let latestModified: string | null = null;

    do {
      const url = this.buildListUrl(afterCursor);
      const response = await this.httpGet<HubSpotListResponse>(url);

      for (const contact of response.results) {
        allRecords.push(this.toRawRecord(contact));
        latestModified = this.maxTimestamp(latestModified, contact.updatedAt);
      }

      afterCursor = response.paging?.next?.after;
    } while (afterCursor);

    return {
      records: allRecords,
      // Store the latest modification timestamp as the cursor for future incremental fetches
      nextCursor: latestModified,
      isFullFetch: true,
      hasNextPage: false,
    };
  }

  /**
   * Incremental fetch: Search for contacts modified since the cursor timestamp.
   * Uses GTE (inclusive) boundary — safe overlap, idempotent reprocessing.
   */
  private async incrementalFetch(cursor: string): Promise<FetchResult> {
    const allRecords: RawSourceRecord[] = [];
    let afterCursor: string | undefined;
    let latestModified: string = cursor;

    do {
      const response = await this.searchModifiedSince(cursor, afterCursor);

      for (const contact of response.results) {
        allRecords.push(this.toRawRecord(contact));
        latestModified = this.maxTimestamp(latestModified, contact.updatedAt) ?? latestModified;
      }

      afterCursor = response.paging?.next?.after;
    } while (afterCursor);

    return {
      records: allRecords,
      nextCursor: latestModified,
      isFullFetch: false,
      hasNextPage: false,
    };
  }

  /**
   * Convert a HubSpot contact to a RawSourceRecord.
   */
  private toRawRecord(contact: HubSpotContact): RawSourceRecord {
    return {
      externalId: contact.id,
      data: {
        ...contact.properties,
        _hubspot_id: contact.id,
        _hubspot_created_at: contact.createdAt,
        _hubspot_updated_at: contact.updatedAt,
        _hubspot_archived: contact.archived,
      },
    };
  }

  /**
   * Build the URL for the contacts list endpoint.
   */
  private buildListUrl(after?: string): string {
    const params = new URLSearchParams({
      limit: String(PAGE_LIMIT),
      properties: REQUESTED_PROPERTIES.join(','),
    });
    if (after) {
      params.set('after', after);
    }
    return `${HUBSPOT_API_BASE}/crm/v3/objects/contacts?${params.toString()}`;
  }

  /**
   * Search for contacts modified since a given timestamp (inclusive GTE).
   */
  private async searchModifiedSince(
    sinceTimestamp: string,
    after?: string
  ): Promise<HubSpotSearchResponse> {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'lastmodifieddate',
              operator: 'GTE',
              value: sinceTimestamp,
            },
          ],
        },
      ],
      properties: REQUESTED_PROPERTIES,
      sorts: [
        {
          propertyName: 'lastmodifieddate',
          direction: 'ASCENDING',
        },
      ],
      limit: PAGE_LIMIT,
    };

    if (after) {
      body.after = after;
    }

    const url = `${HUBSPOT_API_BASE}/crm/v3/objects/contacts/search`;
    return this.httpPost<HubSpotSearchResponse>(url, body);
  }

  /**
   * Return the later of two ISO timestamps, or the non-null one.
   */
  private maxTimestamp(a: string | null, b: string): string {
    if (!a) return b;
    return a >= b ? a : b;
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers — minimal, no external HTTP library
  // ---------------------------------------------------------------------------

  private async httpGet<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HubSpot GET ${res.status}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  private async httpPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubSpot POST ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }
}
