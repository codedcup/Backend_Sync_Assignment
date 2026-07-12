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
import { HubSpotNormalizer } from '../sources/hubspot/normalizer.js';
import type { SourceAdapter } from '../sources/adapter.js';
import type {
  FetchResult,
  RawSourceRecord,
  SourceId,
  SyncState,
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

dotenv.config();

const HUBSPOT: SourceId = 'hubspot';

let pool: Pool;
let deps: OrchestratorDeps;

// ---------------------------------------------------------------------------
// Fake HubSpot Adapter
// ---------------------------------------------------------------------------

/**
 * A test adapter that simulates HubSpot API responses.
 * Returns pre-configured records formatted the same way the real adapter does
 * (with _hubspot_updated_at, _hubspot_id, etc.).
 */
function createFakeHubSpotAdapter(contacts: FakeContact[]): SourceAdapter {
  return {
    sourceId: HUBSPOT,
    async fetch(_syncState: SyncState | null): Promise<FetchResult> {
      const records: RawSourceRecord[] = contacts.map((c) => ({
        externalId: c.id,
        data: {
          firstname: c.firstname,
          lastname: c.lastname,
          email: c.email,
          phone: c.phone ?? null,
          company: c.company ?? null,
          lastmodifieddate: c.updatedAt,
          _hubspot_id: c.id,
          _hubspot_created_at: c.createdAt,
          _hubspot_updated_at: c.updatedAt,
          _hubspot_archived: false,
        },
      }));

      // Compute latest modified timestamp
      const latest = contacts.reduce((max, c) => (c.updatedAt > max ? c.updatedAt : max), '');

      return {
        records,
        nextCursor: latest || null,
        isFullFetch: !_syncState?.cursor,
        hasNextPage: false,
      };
    },
  };
}

interface FakeContact {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  phone?: string;
  company?: string;
  createdAt: string;
  updatedAt: string;
}

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

describe('HubSpot Integration (Stub Adapter)', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM rejected_records');
    await pool.query('DELETE FROM normalized_records');
    await pool.query('DELETE FROM payments');
    await pool.query('DELETE FROM sync_states');
  });
  // =========================================================================
  // 1. Seeded HubSpot records synchronize into normalized_records
  // =========================================================================
  it('seeded HubSpot records synchronize into normalized_records', async () => {
    const contacts: FakeContact[] = [
      {
        id: '101',
        firstname: 'Alice',
        lastname: 'Smith',
        email: 'alice@example.com',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-15T10:30:00.000Z',
      },
      {
        id: '102',
        firstname: 'Bob',
        lastname: 'Jones',
        email: 'bob@example.com',
        phone: '+1234567890',
        company: 'Acme Inc',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-16T08:00:00.000Z',
      },
    ];

    const adapter = createFakeHubSpotAdapter(contacts);
    const normalizer = new HubSpotNormalizer();

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    // Assert: successful sync
    assert.equal(result.sources[HUBSPOT].status, 'success');
    assert.equal(result.sources[HUBSPOT].recordsPersisted, 2);

    // Assert: records exist in DB
    const count = await deps.normalizedRecordRepo.countBySource(HUBSPOT);
    assert.equal(count, 2);

    // Assert: correct data persisted
    const alice = await deps.normalizedRecordRepo.findBySourceAndExternalId(HUBSPOT, '101');
    assert.ok(alice);
    assert.equal((alice.payload as Record<string, unknown>).firstname, 'Alice');
    assert.equal((alice.payload as Record<string, unknown>).email, 'alice@example.com');
    assert.equal(alice.record_type, 'contact');

    const bob = await deps.normalizedRecordRepo.findBySourceAndExternalId(HUBSPOT, '102');
    assert.ok(bob);
    assert.equal((bob.payload as Record<string, unknown>).company, 'Acme Inc');
  });

  // =========================================================================
  // 2. Running HubSpot sync twice creates no duplicates
  // =========================================================================
  it('running HubSpot sync twice creates no duplicates', async () => {
    const contacts: FakeContact[] = [
      {
        id: '201',
        firstname: 'Charlie',
        lastname: 'Brown',
        email: 'charlie@example.com',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-10T12:00:00.000Z',
      },
    ];

    const adapter = createFakeHubSpotAdapter(contacts);
    const normalizer = new HubSpotNormalizer();

    // Run sync twice
    const orc1 = new SyncOrchestrator(deps);
    orc1.register({ adapter, normalizer });
    await orc1.syncAll();

    const orc2 = new SyncOrchestrator(deps);
    orc2.register({ adapter, normalizer });
    await orc2.syncAll();

    // Assert: still only one row
    const count = await deps.normalizedRecordRepo.countBySource(HUBSPOT);
    assert.equal(count, 1, 'Duplicate sync must not create a second row');
  });

  // =========================================================================
  // 3. Modifying a contact and syncing updates the existing row
  // =========================================================================
  it('modifying a HubSpot record updates the existing normalized row', async () => {
    // Initial sync with v1
    const v1: FakeContact[] = [
      {
        id: '301',
        firstname: 'Diana',
        lastname: 'Prince',
        email: 'diana@old.com',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-10T10:00:00.000Z',
      },
    ];

    const adapter1 = createFakeHubSpotAdapter(v1);
    const normalizer = new HubSpotNormalizer();

    const orc1 = new SyncOrchestrator(deps);
    orc1.register({ adapter: adapter1, normalizer });
    await orc1.syncAll();

    // Updated sync with v2 — email changed, newer updatedAt
    const v2: FakeContact[] = [
      {
        id: '301',
        firstname: 'Diana',
        lastname: 'Prince',
        email: 'diana@new.com',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-15T14:00:00.000Z',
      },
    ];

    const adapter2 = createFakeHubSpotAdapter(v2);

    const orc2 = new SyncOrchestrator(deps);
    orc2.register({ adapter: adapter2, normalizer });
    await orc2.syncAll();

    // Assert: one row, updated payload
    const count = await deps.normalizedRecordRepo.countBySource(HUBSPOT);
    assert.equal(count, 1);

    const row = await deps.normalizedRecordRepo.findBySourceAndExternalId(HUBSPOT, '301');
    assert.ok(row);
    assert.equal((row.payload as Record<string, unknown>).email, 'diana@new.com');
  });

  // =========================================================================
  // 4. Source freshness marker is persisted
  // =========================================================================
  it('source freshness marker is persisted', async () => {
    const contacts: FakeContact[] = [
      {
        id: '401',
        firstname: 'Eve',
        lastname: 'Adams',
        email: 'eve@example.com',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-10T09:30:00.000Z',
      },
    ];

    const adapter = createFakeHubSpotAdapter(contacts);
    const normalizer = new HubSpotNormalizer();

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer });
    await orchestrator.syncAll();

    // Assert: source_modified_at is stored in the DB row
    const row = await deps.normalizedRecordRepo.findBySourceAndExternalId(HUBSPOT, '401');
    assert.ok(row);
    assert.ok(row.source_modified_at, 'source_modified_at must be persisted');

    const stored = new Date(row.source_modified_at as string);
    const expected = new Date('2026-04-10T09:30:00.000Z');
    assert.equal(stored.getTime(), expected.getTime(), 'Freshness marker must match source updatedAt');
  });

  // =========================================================================
  // 5. Stale-update protection: older state cannot overwrite newer
  // =========================================================================
  it('older HubSpot state cannot overwrite newer state (stale protection)', async () => {
    // Newer version first
    const newer: FakeContact[] = [
      {
        id: '501',
        firstname: 'Frank',
        lastname: 'Newer',
        email: 'frank@new.com',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-20T16:00:00.000Z',
      },
    ];

    const adapterNew = createFakeHubSpotAdapter(newer);
    const normalizer = new HubSpotNormalizer();

    const orc1 = new SyncOrchestrator(deps);
    orc1.register({ adapter: adapterNew, normalizer });
    await orc1.syncAll();

    // Older version arrives later (e.g., backfill reprocessing)
    const older: FakeContact[] = [
      {
        id: '501',
        firstname: 'Frank',
        lastname: 'Older',
        email: 'frank@old.com',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-10T08:00:00.000Z',
      },
    ];

    const adapterOld = createFakeHubSpotAdapter(older);

    const orc2 = new SyncOrchestrator(deps);
    orc2.register({ adapter: adapterOld, normalizer });
    await orc2.syncAll();

    // Assert: still newer data
    const row = await deps.normalizedRecordRepo.findBySourceAndExternalId(HUBSPOT, '501');
    assert.ok(row);
    assert.equal((row.payload as Record<string, unknown>).email, 'frank@new.com',
      'Older HubSpot state must not overwrite newer');
  });

  // =========================================================================
  // 6. Sync progress advances through the resolved-outcome rule
  // =========================================================================
  it('HubSpot sync progress advances only through the resolved-outcome rule', async () => {
    const contacts: FakeContact[] = [
      {
        id: '601',
        firstname: 'Grace',
        lastname: 'Hopper',
        email: 'grace@example.com',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-15T11:00:00.000Z',
      },
    ];

    const adapter = createFakeHubSpotAdapter(contacts);
    const normalizer = new HubSpotNormalizer();

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    // Assert: success, progress advanced
    assert.equal(result.sources[HUBSPOT].status, 'success');

    const syncState = await deps.syncStateRepo.findBySource(HUBSPOT);
    assert.ok(syncState, 'Sync state must be persisted');
    assert.equal(syncState.cursor, '2026-06-15T11:00:00.000Z');
    assert.ok(syncState.lastSuccessfulSyncAt);
  });

  // =========================================================================
  // 7. HubSpot normalizer rejects malformed records
  // =========================================================================
  it('HubSpot normalizer rejects records with missing updatedAt', async () => {
    // Simulate a contact missing _hubspot_updated_at
    const adapter: SourceAdapter = {
      sourceId: HUBSPOT,
      async fetch(_syncState: SyncState | null): Promise<FetchResult> {
        return {
          records: [
            {
              externalId: '701',
              data: {
                firstname: 'Malformed',
                lastname: 'Contact',
                email: 'bad@example.com',
                // _hubspot_updated_at is MISSING — normalizer should reject
              },
            },
            {
              externalId: '702',
              data: {
                firstname: 'Good',
                lastname: 'Contact',
                email: 'good@example.com',
                _hubspot_updated_at: '2026-07-01T10:00:00.000Z',
                _hubspot_id: '702',
                _hubspot_created_at: '2026-07-01T00:00:00.000Z',
                _hubspot_archived: false,
              },
            },
          ],
          nextCursor: '2026-07-01T10:00:00.000Z',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const normalizer = new HubSpotNormalizer();

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    // Assert: one persisted, one rejected, all resolved → success
    assert.equal(result.sources[HUBSPOT].status, 'success');
    assert.equal(result.sources[HUBSPOT].recordsPersisted, 1);
    assert.equal(result.sources[HUBSPOT].recordsRejected, 1);
    assert.equal(result.sources[HUBSPOT].recordsUnresolved, 0);

    // Assert: good record exists
    const good = await deps.normalizedRecordRepo.findBySourceAndExternalId(HUBSPOT, '702');
    assert.ok(good);

    // Assert: rejected record persisted
    const rejCount = await deps.rejectedRecordRepo.countBySource(HUBSPOT);
    assert.equal(rejCount, 1);

    // Assert: progress advanced (all resolved)
    const syncState = await deps.syncStateRepo.findBySource(HUBSPOT);
    assert.ok(syncState);
  });
});
