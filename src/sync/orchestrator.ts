import type { SourceAdapter, SourceNormalizer } from '../sources/adapter.js';
import type { NormalizedRecordRepository } from '../repositories/normalized-record.repository.js';
import type { PaymentRepository } from '../repositories/payment.repository.js';
import type { SyncStateRepository } from '../repositories/sync-state.repository.js';
import type { RejectedRecordRepository } from '../repositories/rejected-record.repository.js';
import type {
  RecordOutcome,
  SourceId,
  SourceSyncResult,
  SyncRunResult,
  RawSourceRecord,
  NormalizationResult,
} from '../shared/types.js';

/**
 * Dependencies injected into the orchestrator.
 */
export interface OrchestratorDeps {
  normalizedRecordRepo: NormalizedRecordRepository;
  paymentRepo: PaymentRepository;
  syncStateRepo: SyncStateRepository;
  rejectedRecordRepo: RejectedRecordRepository;
}

/**
 * A registered source: its adapter and normalizer paired together.
 */
export interface RegisteredSource {
  adapter: SourceAdapter;
  normalizer: SourceNormalizer;
}

/**
 * Shared single-process sync orchestrator.
 *
 * Coordinates: fetch → normalize → validate → persist/reject → progress update
 *
 * Guarantees:
 * - Each source executes with an independent failure boundary.
 * - One source failure does not prevent other sources from executing.
 * - Progress advances only when every record in the fetch boundary is resolved.
 * - Resolved = persisted OR (rejected AND rejection evidence persisted).
 * - Unresolved = persistence failure, infrastructure failure, unexpected error.
 */
export class SyncOrchestrator {
  private readonly sources = new Map<SourceId, RegisteredSource>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Register a source adapter + normalizer pair.
   */
  register(source: RegisteredSource): void {
    this.sources.set(source.adapter.sourceId, source);
  }

  /**
   * Run synchronization for all registered sources.
   * Each source runs independently — one failure does not block others.
   */
  async syncAll(): Promise<SyncRunResult> {
    const sourceIds = Array.from(this.sources.keys());
    return this.syncSources(sourceIds);
  }

  /**
   * Run synchronization for specific sources.
   */
  async syncSources(sourceIds: SourceId[]): Promise<SyncRunResult> {
    const results: Record<string, SourceSyncResult> = {};

    // Execute each source independently — failures are isolated
    for (const sourceId of sourceIds) {
      results[sourceId] = await this.syncOneSource(sourceId);
    }

    // Determine overall status
    const statuses = Object.values(results).map((r) => r.status);
    const allSuccess = statuses.every((s) => s === 'success');
    const allFailed = statuses.every((s) => s === 'failed');

    let status: SyncRunResult['status'];
    if (allSuccess) {
      status = 'success';
    } else if (allFailed) {
      status = 'failed';
    } else {
      status = 'partial_success';
    }

    return { status, sources: results };
  }

  /**
   * Synchronize a single source with full failure isolation.
   */
  private async syncOneSource(sourceId: SourceId): Promise<SourceSyncResult> {
    const registered = this.sources.get(sourceId);
    if (!registered) {
      return {
        source: sourceId,
        status: 'failed',
        recordsProcessed: 0,
        recordsPersisted: 0,
        recordsRejected: 0,
        recordsUnresolved: 0,
        error: `Source "${sourceId}" is not registered`,
      };
    }

    try {
      return await this.executeSyncForSource(registered);
    } catch (err) {
      // Top-level catch: adapter/infrastructure failure
      // Progress does NOT advance — we never reached persistence
      return {
        source: sourceId,
        status: 'failed',
        recordsProcessed: 0,
        recordsPersisted: 0,
        recordsRejected: 0,
        recordsUnresolved: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute the full sync flow for a single source.
   *
   * Flow: load state → fetch → (normalize → persist/reject per record) → advance cursor
   */
  private async executeSyncForSource(
    registered: RegisteredSource
  ): Promise<SourceSyncResult> {
    const { adapter, normalizer } = registered;
    const sourceId = adapter.sourceId;

    // Step 1: Load persisted sync state
    const syncState = await this.deps.syncStateRepo.findBySource(sourceId);

    let currentCursor = syncState?.cursor ?? null;
    let hasNextPage = true;
    let persisted = 0;
    let rejected = 0;
    let unresolved = 0;
    let totalRecordsProcessed = 0;
    let boundaryHasUnresolved = false;
    let finalCursor = currentCursor;

    // Step 2-7: Fetch and process records, paginating if needed
    while (hasNextPage && !boundaryHasUnresolved) {
      const fetchState = {
        source: sourceId,
        cursor: currentCursor,
        lastSuccessfulSyncAt: syncState?.lastSuccessfulSyncAt ?? null,
      };

      const fetchResult = await adapter.fetch(fetchState);

      for (const rawRecord of fetchResult.records) {
        totalRecordsProcessed++;
        const outcome = await this.processOneRecord(
          sourceId,
          normalizer,
          rawRecord
        );
        
        if (outcome.kind === 'persisted') persisted++;
        else if (outcome.kind === 'rejected') rejected++;
        else if (outcome.kind === 'unresolved') unresolved++;

        if (!outcome.resolved) {
          boundaryHasUnresolved = true;
        }
      }

      finalCursor = fetchResult.nextCursor;
      hasNextPage = fetchResult.hasNextPage;

      if (!boundaryHasUnresolved) {
        currentCursor = fetchResult.nextCursor;
      }
    }

    const allResolved = !boundaryHasUnresolved;

    // Step 8: Advance progress ONLY if every record is resolved across all pages
    if (allResolved && finalCursor) {
      await this.deps.syncStateRepo.upsert(sourceId, finalCursor);
    }

    return {
      source: sourceId,
      status: unresolved > 0 ? 'failed' : 'success',
      recordsProcessed: totalRecordsProcessed,
      recordsPersisted: persisted,
      recordsRejected: rejected,
      recordsUnresolved: unresolved,
    };
  }

  /**
   * Process a single raw record: normalize → persist or reject.
   *
   * This method never throws — it always returns a RecordOutcome.
   * Unexpected errors become unresolved outcomes.
   */
  private async processOneRecord(
    sourceId: SourceId,
    normalizer: SourceNormalizer,
    rawRecord: RawSourceRecord
  ): Promise<RecordOutcome> {
    let normResult: NormalizationResult;

    try {
      normResult = normalizer.normalize(rawRecord);
    } catch (err) {
      // Unexpected normalizer crash — NOT a terminal rejection.
      // This is an internal error, must remain unresolved.
      return {
        kind: 'unresolved',
        resolved: false,
        externalId: rawRecord.externalId,
        error: `Normalizer threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Handle normalization failure → persist rejection evidence
    if (normResult.kind === 'rejection') {
      return this.persistRejection(normResult);
    }

    // Handle successful normalization → persist the normalized record
    return this.persistNormalized(normResult);
  }

  /**
   * Persist a successfully normalized record (or payment).
   * Returns persisted (resolved) or unresolved on DB failure.
   */
  private async persistNormalized(
    normResult: { kind: 'normalized_record'; record: import('../shared/types.js').NormalizedRecord }
    | { kind: 'normalized_payment'; payment: import('../shared/types.js').NormalizedPayment }
  ): Promise<RecordOutcome> {
    try {
      if (normResult.kind === 'normalized_record') {
        await this.deps.normalizedRecordRepo.upsert(normResult.record);
        return {
          kind: 'persisted',
          resolved: true,
          externalId: normResult.record.externalId,
        };
      } else {
        await this.deps.paymentRepo.upsert(normResult.payment);
        return {
          kind: 'persisted',
          resolved: true,
          externalId: normResult.payment.externalId,
        };
      }
    } catch (err) {
      // Database/infrastructure failure — record is UNRESOLVED
      const externalId =
        normResult.kind === 'normalized_record'
          ? normResult.record.externalId
          : normResult.payment.externalId;

      return {
        kind: 'unresolved',
        resolved: false,
        externalId,
        error: `Persistence failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Persist rejection evidence.
   * Returns rejected (resolved) if evidence is persisted.
   * Returns unresolved if evidence persistence fails.
   */
  private async persistRejection(
    rejection: import('../shared/types.js').NormalizationFailure
  ): Promise<RecordOutcome> {
    try {
      await this.deps.rejectedRecordRepo.insert({
        source: rejection.source,
        externalId: rejection.externalId,
        rawPayload: rejection.rawPayload,
        rejectionStage: rejection.rejectionStage,
        failureReason: rejection.failureReason,
      });

      return {
        kind: 'rejected',
        resolved: true,
        externalId: rejection.externalId,
        reason: rejection.failureReason,
      };
    } catch (err) {
      // Rejection evidence persistence failed — UNRESOLVED
      // Progress must NOT advance
      return {
        kind: 'unresolved',
        resolved: false,
        externalId: rejection.externalId,
        error: `Rejection persistence failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
