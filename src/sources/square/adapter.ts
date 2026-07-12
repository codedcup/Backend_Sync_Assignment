import type { SourceAdapter } from '../adapter.js';
import type { FetchResult, RawSourceRecord, SyncState } from '../../shared/types.js';
import { SourceId } from '../../shared/types.js';

interface SquarePayment {
  id: string;
  created_at: string; // RFC3339
  updated_at: string; // RFC3339
  status: string; // APPROVED, COMPLETED, CANCELED, FAILED
  amount_money?: {
    amount: number;
    currency: string;
  };
  [key: string]: unknown;
}

interface SquareListPaymentsResponse {
  payments?: SquarePayment[];
  cursor?: string;
  errors?: unknown[];
}

export class SquareAdapter implements SourceAdapter {
  readonly sourceId = SourceId.SQUARE;
  private readonly baseUrl: string;

  constructor(
    private readonly accessToken: string,
    private readonly locationId: string,
    environment: string
  ) {
    this.baseUrl =
      environment === 'sandbox'
        ? 'https://connect.squareupsandbox.com'
        : 'https://connect.squareup.com';
  }

  async fetch(syncState: Omit<SyncState, 'source'> | null): Promise<FetchResult> {
    const cursor = syncState?.cursor ?? null;
    const isFullFetch = !cursor;

    // Check if the cursor is a pagination cursor or a time boundary
    const isPagination = cursor ? cursor.startsWith('page:') : false;
    const timeBoundary = isPagination ? null : cursor;
    const pageCursor = isPagination && cursor ? cursor.slice(5) : null;

    const params = new URLSearchParams();
    params.set('location_id', this.locationId);
    // Square sort order
    params.set('sort_field', 'UPDATED_AT');
    params.set('sort_order', 'ASC'); // Ascending ensures we process oldest updates first

    if (pageCursor) {
      params.set('cursor', pageCursor);
    } else if (timeBoundary) {
      params.set('updated_at_begin_time', timeBoundary);
    } else {
      params.set('updated_at_begin_time', '2000-01-01T00:00:00.000Z');
    }

    const url = `${this.baseUrl}/v2/payments?${params.toString()}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-06-04',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Square API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as SquareListPaymentsResponse;
    const payments = data.payments ?? [];

    const records: RawSourceRecord[] = payments.map((p) => ({
      externalId: p.id,
      data: p,
    }));

    let nextCursor: string | null = null;
    let hasNextPage = false;

    if (data.cursor) {
      // There are more pages in this boundary
      nextCursor = `page:${data.cursor}`;
      hasNextPage = true;
    } else {
      // End of boundary. The next boundary should start from the latest updated_at we saw.
      // If we saw no records, keep the same time boundary or use current time if it was a full fetch.
      // To prevent missing concurrent updates, it's safer to use the exact max updated_at.
      hasNextPage = false;
      if (payments.length > 0) {
        const latestUpdate = payments[payments.length - 1].updated_at;
        nextCursor = latestUpdate;
      } else {
        nextCursor = timeBoundary ?? new Date().toISOString();
      }
    }

    return {
      records,
      nextCursor,
      isFullFetch,
      hasNextPage,
    };
  }
}
