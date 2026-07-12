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
import { SquareNormalizer } from '../sources/square/normalizer.js';
import { RevenueMetricsService } from '../metrics/revenue.js';
import type { SourceAdapter } from '../sources/adapter.js';
import type { FetchResult, SyncState } from '../shared/types.js';
import { SourceId } from '../shared/types.js';

dotenv.config();

const SQUARE = SourceId.SQUARE;

let pool: Pool;
let deps: OrchestratorDeps;

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

describe('Square Integration (Stub Adapter)', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM rejected_records');
    await pool.query('DELETE FROM payments');
    await pool.query('DELETE FROM sync_states');
  });

  it('Square payment normalizes into payments', async () => {
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(): Promise<FetchResult> {
        return {
          records: [
            {
              externalId: 'sq1',
              data: {
                id: 'sq1',
                created_at: '2026-07-01T10:00:00.000Z',
                updated_at: '2026-07-01T10:00:00.000Z',
                status: 'COMPLETED',
                amount_money: { amount: 1500, currency: 'USD' }
              },
            },
          ],
          nextCursor: '2026-07-01T10:00:00.000Z',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();

    const count = await deps.paymentRepo.countBySource(SQUARE);
    assert.equal(count, 1);

    const row = await deps.paymentRepo.findBySourceAndExternalId(SQUARE, 'sq1');
    assert.ok(row);
    assert.equal(row.amount, '1500'); // pg returns bigint as string
    assert.equal(row.currency, 'USD');
    assert.equal(row.normalized_status, 'collected');
  });

  it('Duplicate sync creates one payment row', async () => {
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(): Promise<FetchResult> {
        return {
          records: [
            {
              externalId: 'sq2',
              data: { id: 'sq2', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T10:00:00Z', status: 'COMPLETED', amount_money: { amount: 2000, currency: 'USD' } },
            },
          ],
          nextCursor: 'ts1',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();
    await orchestrator.syncAll();

    const count = await deps.paymentRepo.countBySource(SQUARE);
    assert.equal(count, 1);
  });

  it('Newer payment state updates the existing row', async () => {
    let call = 0;
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(): Promise<FetchResult> {
        call++;
        if (call === 1) {
          return {
            records: [{ externalId: 'sq3', data: { id: 'sq3', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T10:00:00Z', status: 'APPROVED', amount_money: { amount: 500, currency: 'USD' } } }],
            nextCursor: 'ts1',
            isFullFetch: true,
            hasNextPage: false,
          };
        } else {
          return {
            records: [{ externalId: 'sq3', data: { id: 'sq3', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z', status: 'COMPLETED', amount_money: { amount: 500, currency: 'USD' } } }],
            nextCursor: 'ts2',
            isFullFetch: false,
            hasNextPage: false,
          };
        }
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();

    let row = await deps.paymentRepo.findBySourceAndExternalId(SQUARE, 'sq3');
    assert.equal(row?.normalized_status, 'approved');

    await orchestrator.syncAll();
    row = await deps.paymentRepo.findBySourceAndExternalId(SQUARE, 'sq3');
    assert.equal(row?.normalized_status, 'collected');
  });

  it('Older payment state cannot overwrite newer state', async () => {
    let call = 0;
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(): Promise<FetchResult> {
        call++;
        if (call === 1) {
          return {
            records: [{ externalId: 'sq4', data: { id: 'sq4', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-05T10:00:00Z', status: 'COMPLETED', amount_money: { amount: 500, currency: 'USD' } } }],
            nextCursor: 'ts1',
            isFullFetch: true,
            hasNextPage: false,
          };
        } else {
          return {
            records: [{ externalId: 'sq4', data: { id: 'sq4', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-03T10:00:00Z', status: 'CANCELED', amount_money: { amount: 500, currency: 'USD' } } }],
            nextCursor: 'ts2',
            isFullFetch: false,
            hasNextPage: false,
          };
        }
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();
    await orchestrator.syncAll();

    const row = await deps.paymentRepo.findBySourceAndExternalId(SQUARE, 'sq4');
    assert.equal(row?.normalized_status, 'collected', 'Should not overwrite with older state');
  });

  it('Unknown Square/source status maps to unknown and never collected', async () => {
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(): Promise<FetchResult> {
        return {
          records: [{ externalId: 'sq5', data: { id: 'sq5', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T10:00:00Z', status: 'SOMETHING_WEIRD', amount_money: { amount: 100, currency: 'USD' } } }],
          nextCursor: 'ts1',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();

    const row = await deps.paymentRepo.findBySourceAndExternalId(SQUARE, 'sq5');
    assert.equal(row?.normalized_status, 'unknown');
  });

  it('Incremental fetch uses the persisted progress timestamp correctly', async () => {
    let passedCursor: string | null = null;
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(syncState: SyncState | null): Promise<FetchResult> {
        passedCursor = syncState?.cursor ?? null;
        return {
          records: [],
          nextCursor: 'new_ts',
          isFullFetch: !syncState?.cursor,
          hasNextPage: false,
        };
      },
    };

    await deps.syncStateRepo.upsert(SQUARE, 'old_ts');

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();

    assert.equal(passedCursor, 'old_ts');
  });

  it('Pagination does not prematurely advance source progress', async () => {
    let callCount = 0;
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(syncState: SyncState | null): Promise<FetchResult> {
        callCount++;
        const cursor = syncState?.cursor;
        if (!cursor) {
          return {
            records: [{ externalId: 'p1', data: { id: 'p1', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T10:00:00Z', status: 'COMPLETED', amount_money: { amount: 10, currency: 'USD' } } }],
            nextCursor: 'page:2',
            isFullFetch: true,
            hasNextPage: true,
          };
        } else if (cursor === 'page:2') {
          return {
            records: [{ externalId: 'p2', data: { id: 'p2', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T11:00:00Z', status: 'COMPLETED', amount_money: { amount: 20, currency: 'USD' } } }],
            nextCursor: 'final_ts',
            isFullFetch: true,
            hasNextPage: false,
          };
        }
        throw new Error('Unexpected');
      },
    };

    const orchestrator = new SyncOrchestrator(deps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();

    assert.equal(callCount, 2);
    const count = await deps.paymentRepo.countBySource(SQUARE);
    assert.equal(count, 2);

    const state = await deps.syncStateRepo.findBySource(SQUARE);
    assert.equal(state?.cursor, 'final_ts');
  });

  it('Unresolved persistence failure prevents progress advancement', async () => {
    const adapter: SourceAdapter = {
      sourceId: SQUARE,
      async fetch(): Promise<FetchResult> {
        return {
          records: [{ externalId: 'fail1', data: { id: 'fail1', created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T10:00:00Z', status: 'COMPLETED', amount_money: { amount: 10, currency: 'USD' } } }],
          nextCursor: 'should_not_save',
          isFullFetch: true,
          hasNextPage: false,
        };
      },
    };

    const faultyRepo = new PaymentRepository(pool);
    faultyRepo.upsert = async () => { throw new Error('DB DOWN'); };

    const brokenDeps: OrchestratorDeps = { ...deps, paymentRepo: faultyRepo };
    const orchestrator = new SyncOrchestrator(brokenDeps);
    orchestrator.register({ adapter, normalizer: new SquareNormalizer() });
    await orchestrator.syncAll();

    const state = await deps.syncStateRepo.findBySource(SQUARE);
    assert.equal(state, null); // Cursor not advanced
  });
});

describe('Canonical Revenue Metrics', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM payments');

    const svc = new RevenueMetricsService(pool);
    // Fixture setup
    // Range to test: 2026-07-10 to 2026-07-20
    const fixture = [
      // Collected inside range -> +1000
      { externalId: '1', status: 'collected', created: '2026-07-15T12:00:00Z', amount: 1000 },
      // Multiple qualifying collected mappings (Square only has COMPLETED mapped to collected right now, so we just use collected) -> +2000
      { externalId: '2', status: 'collected', created: '2026-07-16T12:00:00Z', amount: 2000 },
      // Pending/Approved payment inside range -> 0
      { externalId: '3', status: 'approved', created: '2026-07-15T12:00:00Z', amount: 5000 },
      // Failed payment inside range -> 0
      { externalId: '4', status: 'failed', created: '2026-07-15T12:00:00Z', amount: 5000 },
      // Canceled payment inside range -> 0
      { externalId: '5', status: 'canceled', created: '2026-07-15T12:00:00Z', amount: 5000 },
      // Refunded payment inside range -> 0 (Refunded maps to 'refunded' theoretically, or we just keep it as uncollected/refunded)
      { externalId: '6', status: 'refunded', created: '2026-07-15T12:00:00Z', amount: 5000 },
      // Unknown status inside range -> 0
      { externalId: '7', status: 'unknown', created: '2026-07-15T12:00:00Z', amount: 5000 },
      // Collected payment BEFORE range -> 0
      { externalId: '8', status: 'collected', created: '2026-07-09T12:00:00Z', amount: 5000 },
      // Collected payment exactly at inclusive start boundary -> +3000
      { externalId: '9', status: 'collected', created: '2026-07-10T00:00:00Z', amount: 3000 },
      // Collected payment exactly at exclusive end boundary -> 0
      { externalId: '10', status: 'collected', created: '2026-07-20T00:00:00Z', amount: 5000 },
      // The schema enforces source_created_at is NOT NULL, so a missing timestamp state is impossible at the DB level.
    ];

    for (const p of fixture) {
      await pool.query(
        `INSERT INTO payments (source, external_id, source_status, normalized_status, amount, currency, source_created_at, source_modified_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        ['square', p.externalId, p.status.toUpperCase(), p.status, p.amount, 'USD', p.created, p.created]
      );
    }
  });

  it('Revenue summary aggregates only eligible canonical collected payments within the date range', async () => {
    const svc = new RevenueMetricsService(pool);
    const summary = await svc.getSummary({ from: '2026-07-10T00:00:00Z', to: '2026-07-20T00:00:00Z' });
    
    // Expected = 1000 + 2000 + 3000 = 6000
    assert.equal(summary.totalAmount, 6000);
    assert.equal(summary.currency, 'USD');
  });

  it('Daily breakdown aggregates only eligible canonical collected payments and reconciles with summary', async () => {
    const svc = new RevenueMetricsService(pool);
    const range = { from: '2026-07-10T00:00:00Z', to: '2026-07-20T00:00:00Z' };
    
    const summary = await svc.getSummary(range);
    const breakdown = await svc.getDailyBreakdown(range);

    // Sum daily bucket totals
    const sumOfDays = breakdown.days.reduce((acc, b) => acc + b.amount, 0);

    // Assert equality with summary total (Cross-view reconciliation)
    assert.equal(sumOfDays, summary.totalAmount);
    assert.equal(breakdown.totalAmount, summary.totalAmount);

    // Verify buckets exist exactly for the expected days
    assert.equal(breakdown.days.find(d => d.date === '2026-07-10')?.amount, 3000);
    assert.equal(breakdown.days.find(d => d.date === '2026-07-15')?.amount, 1000);
    assert.equal(breakdown.days.find(d => d.date === '2026-07-16')?.amount, 2000);
  });
});
