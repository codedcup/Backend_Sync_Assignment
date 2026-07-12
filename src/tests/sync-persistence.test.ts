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
import type { SourceAdapter, SourceNormalizer } from '../sources/adapter.js';
import type {
  FetchResult,
  NormalizationResult,
  RawSourceRecord,
  SourceId,
  SyncState,
} from '../shared/types.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

dotenv.config();

const TEST_SOURCE: SourceId = 'hubspot';
const OTHER_SOURCE: SourceId = 'google_calendar';

let pool: Pool;
let deps: OrchestratorDeps;

// ---------------------------------------------------------------------------
// Stub Factories
// ---------------------------------------------------------------------------

/**
 * Create a stub adapter that returns a fixed FetchResult.
 */
function createStubAdapter(
  sourceId: SourceId,
  fetchResult: Omit<FetchResult, 'hasNextPage'>
): SourceAdapter {
  return {
    sourceId,
    async fetch(_syncState: SyncState | null): Promise<FetchResult> {
      return { ...fetchResult, hasNextPage: false };
    },
  };
}

/**
 * Create a stub adapter that throws on fetch (simulates source failure).
 */
function createFailingAdapter(sourceId: SourceId, error: string): SourceAdapter {
  return {
    sourceId,
    async fetch(_syncState: SyncState | null): Promise<FetchResult> {
      throw new Error(error);
    },
  };
}

/**
 * Create a normalizer that converts raw records to normalized_records.
 * Rejects records where data.invalid is truthy.
 */
function createStubNormalizer(sourceId: SourceId): SourceNormalizer {
  return {
    sourceId,
    normalize(raw: RawSourceRecord): NormalizationResult {
      if (raw.data.invalid) {
        return {
          kind: 'rejection',
          source: sourceId,
          externalId: raw.externalId,
          rawPayload: raw.data,
          rejectionStage: 'validation',
          failureReason: raw.data.reason as string || 'Invalid record',
        };
      }

      return {
        kind: 'normalized_record',
        record: {
          source: sourceId,
          externalId: raw.externalId,
          recordType: 'contact',
          sourceModifiedAt: raw.data.modifiedAt
            ? new Date(raw.data.modifiedAt as string)
            : null,
          payload: raw.data,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL required for tests');

  pool = new Pool({ connectionString: dbUrl, max: 5 });
  await pool.query('SELECT 1'); // verify connection

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

describe('Sync Orchestrator + Persistence Correctness', () => {
  beforeEach(async () => {
    // Clean all tables before each test for isolation
    await pool.query('DELETE FROM rejected_records');
    await pool.query('DELETE FROM normalized_records');
    await pool.query('DELETE FROM payments');
    await pool.query('DELETE FROM sync_states');
  });
  // =========================================================================
  // 1. Duplicate processing creates one normalized row
  // =========================================================================
  it('duplicate processing creates one normalized row', async () => {
    const records: RawSourceRecord[] = [
      { externalId: 'ext-1', data: { name: 'Alice', modifiedAt: '2026-01-01T00:00:00Z' } },
    ];

    const adapter = createStubAdapter(TEST_SOURCE, {
      records,
      nextCursor: null,
      isFullFetch: false,
    });
    const normalizer = createStubNormalizer(TEST_SOURCE);

    // Run sync twice
    const orchestrator1 = new SyncOrchestrator(deps);
    orchestrator1.register({ adapter, normalizer });
    await orchestrator1.syncAll();

    const orchestrator2 = new SyncOrchestrator(deps);
    orchestrator2.register({ adapter, normalizer });
    await orchestrator2.syncAll();

    // Assert: only one row exists
    const count = await deps.normalizedRecordRepo.countBySource(TEST_SOURCE);
    assert.equal(count, 1, 'Duplicate processing must not create a second row');
  });

  // =========================================================================
  // 2. Newer source state updates the existing row
  // =========================================================================
  it('newer source state updates the existing row', async () => {
    const oldAdapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-1', data: { name: 'Alice-v1', modifiedAt: '2026-01-01T00:00:00Z' } },
      ],
      nextCursor: null,
      isFullFetch: false,
    });

    const newAdapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-1', data: { name: 'Alice-v2', modifiedAt: '2026-02-01T00:00:00Z' } },
      ],
      nextCursor: null,
      isFullFetch: false,
    });

    const normalizer = createStubNormalizer(TEST_SOURCE);

    // Insert v1
    const orc1 = new SyncOrchestrator(deps);
    orc1.register({ adapter: oldAdapter, normalizer });
    await orc1.syncAll();

    // Update to v2
    const orc2 = new SyncOrchestrator(deps);
    orc2.register({ adapter: newAdapter, normalizer });
    await orc2.syncAll();

    // Assert: one row, updated payload
    const count = await deps.normalizedRecordRepo.countBySource(TEST_SOURCE);
    assert.equal(count, 1, 'Must not create a second row');

    const row = await deps.normalizedRecordRepo.findBySourceAndExternalId(TEST_SOURCE, 'ext-1');
    assert.ok(row, 'Row must exist');

    const payload = row.payload as Record<string, unknown>;
    assert.equal(payload.name, 'Alice-v2', 'Payload must be updated to v2');
  });

  // =========================================================================
  // 3. Older source state cannot overwrite newer state
  // =========================================================================
  it('older source state cannot overwrite newer state', async () => {
    const newerAdapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-1', data: { name: 'Alice-v2', modifiedAt: '2026-02-01T00:00:00Z' } },
      ],
      nextCursor: null,
      isFullFetch: false,
    });

    const olderAdapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-1', data: { name: 'Alice-v1', modifiedAt: '2026-01-01T00:00:00Z' } },
      ],
      nextCursor: null,
      isFullFetch: false,
    });

    const normalizer = createStubNormalizer(TEST_SOURCE);

    // Insert newer first
    const orc1 = new SyncOrchestrator(deps);
    orc1.register({ adapter: newerAdapter, normalizer });
    await orc1.syncAll();

    // Attempt to overwrite with older
    const orc2 = new SyncOrchestrator(deps);
    orc2.register({ adapter: olderAdapter, normalizer });
    await orc2.syncAll();

    // Assert: payload remains at v2
    const row = await deps.normalizedRecordRepo.findBySourceAndExternalId(TEST_SOURCE, 'ext-1');
    assert.ok(row, 'Row must exist');

    const payload = row.payload as Record<string, unknown>;
    assert.equal(payload.name, 'Alice-v2', 'Stale state must not overwrite newer state');
  });

  // =========================================================================
  // 4. One source failure does not prevent another source from executing
  // =========================================================================
  it('one source failure does not prevent another source from executing', async () => {
    const failingAdapter = createFailingAdapter(TEST_SOURCE, 'HubSpot API down');
    const workingAdapter = createStubAdapter(OTHER_SOURCE, {
      records: [
        { externalId: 'evt-1', data: { title: 'Meeting', modifiedAt: '2026-01-01T00:00:00Z' } },
      ],
      nextCursor: null,
      isFullFetch: false,
    });

    const normalizer1 = createStubNormalizer(TEST_SOURCE);
    const normalizer2 = createStubNormalizer(OTHER_SOURCE);

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter: failingAdapter, normalizer: normalizer1 });
    orchestrator.register({ adapter: workingAdapter, normalizer: normalizer2 });

    const result = await orchestrator.syncAll();

    // Assert: overall partial_success
    assert.equal(result.status, 'partial_success');

    // Assert: failing source reported as failed
    assert.equal(result.sources[TEST_SOURCE].status, 'failed');

    // Assert: working source succeeded and persisted its record
    assert.equal(result.sources[OTHER_SOURCE].status, 'success');
    assert.equal(result.sources[OTHER_SOURCE].recordsPersisted, 1);

    // Assert: working source's record actually exists in DB
    const count = await deps.normalizedRecordRepo.countBySource(OTHER_SOURCE);
    assert.equal(count, 1);
  });

  // =========================================================================
  // 5. All resolved records allow progress advancement
  // =========================================================================
  it('all resolved records allow progress advancement', async () => {
    const adapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-1', data: { name: 'Alice', modifiedAt: '2026-01-01T00:00:00Z' } },
        { externalId: 'ext-2', data: { name: 'Bob', modifiedAt: '2026-01-01T00:00:00Z' } },
      ],
      nextCursor: 'cursor-abc',
      isFullFetch: false,
    });
    const normalizer = createStubNormalizer(TEST_SOURCE);

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    assert.equal(result.sources[TEST_SOURCE].status, 'success');
    assert.equal(result.sources[TEST_SOURCE].recordsPersisted, 2);
    assert.equal(result.sources[TEST_SOURCE].recordsUnresolved, 0);

    // Assert: sync state was advanced
    const syncState = await deps.syncStateRepo.findBySource(TEST_SOURCE);
    assert.ok(syncState, 'Sync state must be persisted');
    assert.equal(syncState.cursor, 'cursor-abc', 'Cursor must match fetch result');
    assert.ok(syncState.lastSuccessfulSyncAt, 'Last sync timestamp must be set');
  });

  // =========================================================================
  // 6. Normalized-record persistence failure blocks progress
  // =========================================================================
  it('normalized-record persistence failure blocks progress', async () => {
    // Create a repo that throws on upsert to simulate DB failure
    const brokenNormalizedRepo = {
      ...deps.normalizedRecordRepo,
      async upsert() {
        throw new Error('Simulated DB write failure');
      },
    } as unknown as NormalizedRecordRepository;

    const brokenDeps: OrchestratorDeps = {
      ...deps,
      normalizedRecordRepo: brokenNormalizedRepo,
    };

    const adapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-1', data: { name: 'Alice', modifiedAt: '2026-01-01T00:00:00Z' } },
      ],
      nextCursor: 'cursor-should-not-advance',
      isFullFetch: false,
    });
    const normalizer = createStubNormalizer(TEST_SOURCE);

    const orchestrator = new SyncOrchestrator(brokenDeps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    // Assert: source reported as failed due to unresolved records
    assert.equal(result.sources[TEST_SOURCE].status, 'failed');
    assert.equal(result.sources[TEST_SOURCE].recordsUnresolved, 1);

    // Assert: sync state was NOT advanced
    const syncState = await deps.syncStateRepo.findBySource(TEST_SOURCE);
    assert.equal(syncState, null, 'Sync state must not exist when persistence fails');
  });

  // =========================================================================
  // 7. Persisted validation/normalization rejection is resolved
  // =========================================================================
  it('persisted validation/normalization rejection is resolved', async () => {
    const adapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-bad', data: { invalid: true, reason: 'Missing required field' } },
      ],
      nextCursor: 'cursor-after-rejection',
      isFullFetch: false,
    });
    const normalizer = createStubNormalizer(TEST_SOURCE);

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    // Assert: rejection is resolved, source status is success
    assert.equal(result.sources[TEST_SOURCE].status, 'success');
    assert.equal(result.sources[TEST_SOURCE].recordsRejected, 1);
    assert.equal(result.sources[TEST_SOURCE].recordsUnresolved, 0);

    // Assert: rejection evidence was persisted
    const rejectedCount = await deps.rejectedRecordRepo.countBySource(TEST_SOURCE);
    assert.equal(rejectedCount, 1, 'Rejection record must exist in DB');

    // Assert: progress was advanced because rejection is resolved
    const syncState = await deps.syncStateRepo.findBySource(TEST_SOURCE);
    assert.ok(syncState, 'Sync state must be persisted');
    assert.equal(syncState.cursor, 'cursor-after-rejection');
  });

  // =========================================================================
  // 8. Rejected-record persistence failure blocks progress
  // =========================================================================
  it('rejected-record persistence failure blocks progress', async () => {
    // Create a repo that throws on insert to simulate DB failure
    const brokenRejectedRepo = {
      ...deps.rejectedRecordRepo,
      async insert() {
        throw new Error('Simulated rejection DB write failure');
      },
    } as unknown as RejectedRecordRepository;

    const brokenDeps: OrchestratorDeps = {
      ...deps,
      rejectedRecordRepo: brokenRejectedRepo,
    };

    const adapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-bad', data: { invalid: true, reason: 'Bad data' } },
      ],
      nextCursor: 'cursor-should-not-advance',
      isFullFetch: false,
    });
    const normalizer = createStubNormalizer(TEST_SOURCE);

    const orchestrator = new SyncOrchestrator(brokenDeps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    // Assert: source reported as failed
    assert.equal(result.sources[TEST_SOURCE].status, 'failed');
    assert.equal(result.sources[TEST_SOURCE].recordsUnresolved, 1);

    // Assert: sync state was NOT advanced
    const syncState = await deps.syncStateRepo.findBySource(TEST_SOURCE);
    assert.equal(syncState, null, 'Sync state must not exist when rejection persistence fails');
  });

  // =========================================================================
  // 9. One malformed record does not prevent valid records from processing
  // =========================================================================
  it('one malformed record does not prevent valid records from being processed', async () => {
    const adapter = createStubAdapter(TEST_SOURCE, {
      records: [
        { externalId: 'ext-good-1', data: { name: 'Alice', modifiedAt: '2026-01-01T00:00:00Z' } },
        { externalId: 'ext-bad', data: { invalid: true, reason: 'Corrupt payload' } },
        { externalId: 'ext-good-2', data: { name: 'Bob', modifiedAt: '2026-01-01T00:00:00Z' } },
      ],
      nextCursor: 'cursor-mixed',
      isFullFetch: false,
    });
    const normalizer = createStubNormalizer(TEST_SOURCE);

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer });
    const result = await orchestrator.syncAll();

    // Assert: both valid records persisted
    assert.equal(result.sources[TEST_SOURCE].recordsPersisted, 2);

    // Assert: one rejected
    assert.equal(result.sources[TEST_SOURCE].recordsRejected, 1);

    // Assert: no unresolved — all records resolved
    assert.equal(result.sources[TEST_SOURCE].recordsUnresolved, 0);

    // Assert: status is success (all resolved)
    assert.equal(result.sources[TEST_SOURCE].status, 'success');

    // Assert: cursor advanced (all records resolved)
    const syncState = await deps.syncStateRepo.findBySource(TEST_SOURCE);
    assert.ok(syncState, 'Sync state must exist');
    assert.equal(syncState.cursor, 'cursor-mixed');

    // Assert: valid records exist in DB
    const normalizedCount = await deps.normalizedRecordRepo.countBySource(TEST_SOURCE);
    assert.equal(normalizedCount, 2, 'Both valid records must be persisted');

    // Assert: rejection evidence exists
    const rejectedCount = await deps.rejectedRecordRepo.countBySource(TEST_SOURCE);
    assert.equal(rejectedCount, 1, 'Malformed record must be in rejected store');
  });
});
