import type { Pool } from 'pg';
import type { SourceId, SyncState } from '../shared/types.js';

/**
 * Repository for the sync_states table.
 *
 * Persists independent per-source synchronization progress.
 */
export class SyncStateRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Load the current sync state for a source.
   * Returns null if no state exists (first run).
   */
  async findBySource(source: SourceId): Promise<SyncState | null> {
    const result = await this.pool.query(
      `SELECT source, cursor, last_successful_sync_at FROM sync_states WHERE source = $1`,
      [source]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      source: row.source as SourceId,
      cursor: row.cursor ?? null,
      lastSuccessfulSyncAt: row.last_successful_sync_at
        ? new Date(row.last_successful_sync_at)
        : null,
    };
  }

  /**
   * Upsert the sync state for a source.
   * Called only after all records associated with the fetch boundary are resolved.
   */
  async upsert(source: SourceId, cursor: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO sync_states (source, cursor, last_successful_sync_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (source)
       DO UPDATE SET
         cursor = EXCLUDED.cursor,
         last_successful_sync_at = now(),
         updated_at = now()`,
      [source, cursor]
    );
  }
}
