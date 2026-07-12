import type { SourceAdapter } from '../adapter.js';
import type { FetchResult, RawSourceRecord, SyncState } from '../../shared/types.js';
import { SourceId } from '../../shared/types.js';
import type { OAuth2Client } from 'google-auth-library';

/**
 * Google Calendar API event shapes.
 */
interface GoogleEvent {
  id: string;
  status: string; // 'confirmed', 'tentative', 'cancelled'
  updated: string; // RFC3339 timestamp
  summary?: string;
  description?: string;
  start?: {
    dateTime?: string;
    date?: string;
  };
  end?: {
    dateTime?: string;
    date?: string;
  };
  [key: string]: unknown;
}

interface GoogleCalendarListResponse {
  items: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

const GOOGLE_API_BASE = 'https://www.googleapis.com';

/**
 * Google Calendar source adapter.
 *
 * - Identity: `id` (stable event ID).
 * - Freshness: `updated` (modification timestamp).
 * - Pagination: `nextPageToken` inside a sync boundary.
 * - Incremental Sync: `nextSyncToken` to start the next boundary.
 * - Stale Token Recovery: Catches 410 Gone, falls back to full sync without deleting data.
 */
export class GoogleCalendarAdapter implements SourceAdapter {
  readonly sourceId = SourceId.GOOGLE_CALENDAR;

  constructor(
    private readonly auth: OAuth2Client,
    private readonly calendarId: string = 'primary'
  ) {}

  async fetch(syncState: Omit<SyncState, 'source'> | null): Promise<FetchResult> {
    const cursor = syncState?.cursor;

    // Determine fetch mode from the cursor prefix
    if (!cursor) {
      return this.doFetch(null, true); // Full sync
    }

    if (cursor.startsWith('page:')) {
      return this.doFetch({ pageToken: cursor.slice(5) }, false); // Continue pagination
    }

    if (cursor.startsWith('sync:')) {
      try {
        return await this.doFetch({ syncToken: cursor.slice(5) }, false); // Incremental sync
      } catch (err: unknown) {
        // Recover from 410 Gone (stale sync token)
        if (err instanceof Error && err.message.includes('410')) {
          console.warn('[GoogleCalendarAdapter] Sync token expired (410 Gone). Recovering with full backfill.');
          return this.doFetch(null, true);
        }
        throw err;
      }
    }

    throw new Error(`[GoogleCalendarAdapter] Invalid cursor format: ${cursor}`);
  }

  private async doFetch(
    tokens: { syncToken?: string; pageToken?: string } | null,
    isFullFetch: boolean
  ): Promise<FetchResult> {
    const params = new URLSearchParams();

    // The API documentation states that if you use a syncToken, you should not
    // use other parameters like timeMin, except for fields that don't restrict results.
    // If you use a pageToken, you must not use other parameters.
    if (tokens?.pageToken) {
      params.set('pageToken', tokens.pageToken);
    } else {
      // We want all events (including deleted/cancelled ones) for incremental sync to work,
      // but for a full sync, we could theoretically exclude deleted ones. However, 
      // keeping the request identical ensures we get the correct sync token.
      if (tokens?.syncToken) {
        params.set('syncToken', tokens.syncToken);
      }
    }

    const url = `${GOOGLE_API_BASE}/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?${params.toString()}`;
    const response = await this.httpGet<GoogleCalendarListResponse>(url);

    const records: RawSourceRecord[] = response.items.map((event) => ({
      externalId: event.id,
      data: {
        ...event,
        _google_updated: event.updated,
      },
    }));

    let nextCursor: string | null = null;
    let hasNextPage = false;

    if (response.nextPageToken) {
      nextCursor = `page:${response.nextPageToken}`;
      hasNextPage = true;
    } else if (response.nextSyncToken) {
      nextCursor = `sync:${response.nextSyncToken}`;
      hasNextPage = false;
    }

    return {
      records,
      nextCursor,
      isFullFetch,
      hasNextPage,
    };
  }

  private async httpGet<T>(url: string): Promise<T> {
    try {
      const res = await this.auth.request<T>({
        url,
        method: 'GET',
      });
      return res.data;
    } catch (err: any) {
      if (err.response) {
        throw new Error(`Google API GET ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }
}
