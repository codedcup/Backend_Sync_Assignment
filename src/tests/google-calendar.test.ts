import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import dotenv from 'dotenv';

import { SyncOrchestrator } from '../sync/orchestrator.js';
import type { OrchestratorDeps } from '../sync/orchestrator.js';
import { NormalizedRecordRepository } from '../repositories/normalized-record.repository.js';
import { PaymentRepository } from '../repositories/payment.repository.js';
import { SyncStateRepository } from '../repositories/sync-state.repository.js';
import { RejectedRecordRepository } from '../repositories/rejected-record.repository.js';
import { GoogleCalendarNormalizer } from '../sources/google-calendar/normalizer.js';
import type { SourceAdapter } from '../sources/adapter.js';
import type { FetchResult, SyncState } from '../shared/types.js';
import { SourceId } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

dotenv.config();

const GOOGLE: SourceId = SourceId.GOOGLE_CALENDAR;

let pool: Pool;
let deps: OrchestratorDeps;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL required for tests');

  pool = new Pool({ connectionString: dbUrl, max: 5 });
  await pool.query('SELECT 1');

  deps = {
    normalizedRecordRepo: new NormalizedRecordRepository(pool),
    paymentRepo: new PaymentRepository(pool),
    syncStateRepo: new SyncStateRepository(pool),
    rejectedRecordRepo: new RejectedRecordRepository(pool),
  };
});

after(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Google Calendar Integration (Stub Adapter)', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM rejected_records');
    await pool.query('DELETE FROM normalized_records');
    await pool.query('DELETE FROM payments');
    await pool.query('DELETE FROM sync_states');
  });

  // =========================================================================
  // 1. Initial full sync normalizes Calendar events
  // =========================================================================
  it('initial full sync normalizes Calendar events', async () => {
    const adapter: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(_syncState: SyncState | null): Promise<FetchResult> {
        return {
          records: [
            {
              externalId: 'evt1',
              data: {
                id: 'evt1',
                summary: 'Meeting A',
                status: 'confirmed',
                _google_updated: '2026-01-01T10:00:00.000Z',
              },
            },
          ],
          nextCursor: 'sync:token1',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new GoogleCalendarNormalizer() });
    await orchestrator.syncAll();

    const count = await deps.normalizedRecordRepo.countBySource(GOOGLE);
    assert.equal(count, 1);

    const row = await deps.normalizedRecordRepo.findBySourceAndExternalId(GOOGLE, 'evt1');
    assert.ok(row);
    assert.equal((row.payload as any).summary, 'Meeting A');
    assert.equal((row.payload as any).archived, false);
    
    const state = await deps.syncStateRepo.findBySource(GOOGLE);
    assert.equal(state?.cursor, 'sync:token1');
  });

  // =========================================================================
  // 2. Duplicate full sync does not create duplicate rows
  // =========================================================================
  it('duplicate full sync does not create duplicate rows', async () => {
    const adapter: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(_syncState: SyncState | null): Promise<FetchResult> {
        return {
          records: [
            {
              externalId: 'evt2',
              data: { id: 'evt2', summary: 'Meeting B', status: 'confirmed', _google_updated: '2026-01-01T10:00:00.000Z' },
            },
          ],
          nextCursor: 'sync:token2',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new GoogleCalendarNormalizer() });
    await orchestrator.syncAll();
    await orchestrator.syncAll(); // Duplicate run

    const count = await deps.normalizedRecordRepo.countBySource(GOOGLE);
    assert.equal(count, 1);
  });

  // =========================================================================
  // 3. Incremental sync uses the persisted sync token
  // =========================================================================
  it('incremental sync uses the persisted sync token', async () => {
    let passedCursor: string | null = null;
    
    const adapter: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(syncState: SyncState | null): Promise<FetchResult> {
        passedCursor = syncState?.cursor ?? null;
        return {
          records: [],
          nextCursor: 'sync:token3_new',
          isFullFetch: false,
          hasNextPage: false,
        };
      },
    };

    await deps.syncStateRepo.upsert(GOOGLE, 'sync:token3_old');

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new GoogleCalendarNormalizer() });
    await orchestrator.syncAll();

    assert.equal(passedCursor, 'sync:token3_old');
    const state = await deps.syncStateRepo.findBySource(GOOGLE);
    assert.equal(state?.cursor, 'sync:token3_new');
  });

  // =========================================================================
  // 4. Changed event updates the existing normalized row
  // =========================================================================
  it('changed event updates the existing normalized row and maps cancelled to archived', async () => {
    const adapter1: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(): Promise<FetchResult> {
        return {
          records: [
            {
              externalId: 'evt4',
              data: { id: 'evt4', summary: 'Meeting C', status: 'confirmed', _google_updated: '2026-01-01T10:00:00.000Z' },
            },
          ],
          nextCursor: 'sync:token4_old',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const orchestrator1 = new SyncOrchestrator(deps);
    orchestrator1.register({ adapter: adapter1, normalizer: new GoogleCalendarNormalizer() });
    await orchestrator1.syncAll();

    const adapter2: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(): Promise<FetchResult> {
        return {
          records: [
            {
              // Event is now cancelled (archived)
              externalId: 'evt4',
              data: { id: 'evt4', summary: 'Meeting C', status: 'cancelled', _google_updated: '2026-01-02T10:00:00.000Z' },
            },
          ],
          nextCursor: 'sync:token4_new',
          isFullFetch: false,
          hasNextPage: false,
        };
      },
    };

    const orchestrator2 = new SyncOrchestrator(deps);
    orchestrator2.register({ adapter: adapter2, normalizer: new GoogleCalendarNormalizer() });
    await orchestrator2.syncAll();

    const count = await deps.normalizedRecordRepo.countBySource(GOOGLE);
    assert.equal(count, 1);
    const row = await deps.normalizedRecordRepo.findBySourceAndExternalId(GOOGLE, 'evt4');
    assert.equal((row!.payload as any).archived, true);
  });

  // =========================================================================
  // 5. Multi-page synchronization does not persist the final sync token prematurely
  // =========================================================================
  it('multi-page synchronization correctly processes pages and persists final sync token', async () => {
    let callCount = 0;
    
    const adapter: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(syncState: SyncState | null): Promise<FetchResult> {
        callCount++;
        const cursor = syncState?.cursor;
        
        if (!cursor) {
          // Page 1
          return {
            records: [
              { externalId: 'p1', data: { id: 'p1', status: 'confirmed', _google_updated: '2026-01-01T10:00:00.000Z' } },
            ],
            nextCursor: 'page:token_p2',
            isFullFetch: true,
            hasNextPage: true, // Orchestrator must loop
          };
        } else if (cursor === 'page:token_p2') {
          // Page 2
          return {
            records: [
              { externalId: 'p2', data: { id: 'p2', status: 'confirmed', _google_updated: '2026-01-01T11:00:00.000Z' } },
            ],
            nextCursor: 'sync:final_token',
            isFullFetch: true,
            hasNextPage: false, // Orchestrator stops looping
          };
        }
        throw new Error('Unexpected fetch call');
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new GoogleCalendarNormalizer() });
    await orchestrator.syncAll();

    assert.equal(callCount, 2);
    
    const count = await deps.normalizedRecordRepo.countBySource(GOOGLE);
    assert.equal(count, 2);

    const state = await deps.syncStateRepo.findBySource(GOOGLE);
    assert.equal(state?.cursor, 'sync:final_token', 'Must persist the sync token from the final page');
  });

  // =========================================================================
  // 6 & 7. 410 stale-token response triggers full synchronization & recovery is idempotent
  // =========================================================================
  it('410 stale-token response triggers full synchronization, keeping data intact (idempotent)', async () => {
    // We mock the adapter to simulate throwing a 410, and catching it by doing a full sync.
    // In our real adapter, the adapter handles this internally. For this test, we simulate that internal logic.
    const adapter: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(syncState: SyncState | null): Promise<FetchResult> {
        if (syncState?.cursor === 'sync:stale_token') {
          // In real life, the adapter does this internally:
          // throw new Error('410 Gone'); -> catches -> doFetch(null, true)
          // We return what the real adapter would return after recovering:
          return {
            records: [
              { externalId: 'existing', data: { id: 'existing', summary: 'Recovered', status: 'confirmed', _google_updated: '2026-01-01T10:00:00.000Z' } },
            ],
            nextCursor: 'sync:fresh_token',
            isFullFetch: true,
            hasNextPage: false,
          };
        }
        
        // Initial setup
        return {
          records: [
            { externalId: 'existing', data: { id: 'existing', summary: 'Initial', status: 'confirmed', _google_updated: '2026-01-01T10:00:00.000Z' } },
          ],
          nextCursor: 'sync:stale_token',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new GoogleCalendarNormalizer() });
    
    // Run 1: initial setup -> gives us 'sync:stale_token'
    await orchestrator.syncAll();
    
    let count = await deps.normalizedRecordRepo.countBySource(GOOGLE);
    assert.equal(count, 1);

    // Run 2: simulates next cron run where token is stale.
    // The adapter mock sees 'sync:stale_token' and acts as if it recovered from 410 by doing a full fetch.
    await orchestrator.syncAll();
    
    count = await deps.normalizedRecordRepo.countBySource(GOOGLE);
    assert.equal(count, 1, 'Data must not be duplicated or deleted during recovery');

    const state = await deps.syncStateRepo.findBySource(GOOGLE);
    assert.equal(state?.cursor, 'sync:fresh_token', 'Replacement token persisted');
  });

  // =========================================================================
  // 8. Unresolved record processing prevents replacement sync-token advancement
  // =========================================================================
  it('unresolved record processing prevents replacement sync-token advancement', async () => {
    const adapter: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(): Promise<FetchResult> {
        return {
          records: [
            { externalId: 'err', data: { id: 'err', _google_updated: 'bad_date' } }, // will cause normalization error due to bad date
          ],
          nextCursor: 'sync:should_not_save',
          isFullFetch: false,
          hasNextPage: false,
        };
      },
    };

    // Pretend normalizer throws an actual error for bad dates instead of returning rejection (to simulate unresolved)
    // Wait, our normalizer returns a rejection (which IS resolved). Let's simulate a DB failure for persistence.
    // We can do this by closing the pool? No, just drop the table.
    // Easier way to simulate unresolved: mock normalizer to throw an Error.
    const failingNormalizer = new GoogleCalendarNormalizer();
    failingNormalizer.normalize = () => { throw new Error('Unresolved crash'); };

    await deps.syncStateRepo.upsert(GOOGLE, 'sync:valid_old_token');

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: failingNormalizer });
    await orchestrator.syncAll();

    const state = await deps.syncStateRepo.findBySource(GOOGLE);
    assert.equal(state?.cursor, 'sync:valid_old_token', 'Cursor must not advance if records are unresolved');
  });

  // =========================================================================
  // 9. Calendar failure remains isolated from another source
  // =========================================================================
  it('calendar failure remains isolated from another source', async () => {
    const failingGoogleAdapter: SourceAdapter = {
      sourceId: GOOGLE,
      async fetch(): Promise<FetchResult> {
        throw new Error('Google API down');
      },
    };

    const goodHubSpotAdapter: SourceAdapter = {
      sourceId: SourceId.HUBSPOT,
      async fetch(): Promise<FetchResult> {
        return {
          records: [],
          nextCursor: 'hs:done',
          isFullFetch: false,
          hasNextPage: false,
        };
      },
    };

    // We need a dummy normalizer for HubSpot since we registered it
    const dummyNormalizer = {
      sourceId: SourceId.HUBSPOT,
      normalize: (r: any) => ({ kind: 'normalized_record', record: { source: SourceId.HUBSPOT, externalId: r.externalId, recordType: 'contact', sourceModifiedAt: new Date(), payload: {} } } as any)
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter: failingGoogleAdapter, normalizer: new GoogleCalendarNormalizer() });
    orchestrator.register({ adapter: goodHubSpotAdapter, normalizer: dummyNormalizer });
    
    const result = await orchestrator.syncAll();
    
    assert.equal(result.sources[GOOGLE].status, 'failed');
    assert.equal(result.sources[SourceId.HUBSPOT].status, 'success');
  });
});
