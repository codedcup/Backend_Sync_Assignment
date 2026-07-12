import { Router, Request, Response } from 'express';
import { pool } from '../db/connection.js';
import { config } from '../config/index.js';
import { SyncOrchestrator } from '../sync/orchestrator.js';
import { NormalizedRecordRepository } from '../repositories/normalized-record.repository.js';
import { PaymentRepository } from '../repositories/payment.repository.js';
import { SyncStateRepository } from '../repositories/sync-state.repository.js';
import { RejectedRecordRepository } from '../repositories/rejected-record.repository.js';
import { HubSpotAdapter } from '../sources/hubspot/adapter.js';
import { HubSpotNormalizer } from '../sources/hubspot/normalizer.js';
import { GoogleCalendarAdapter } from '../sources/google-calendar/adapter.js';
import { GoogleCalendarNormalizer } from '../sources/google-calendar/normalizer.js';
import { SquareAdapter } from '../sources/square/adapter.js';
import { SquareNormalizer } from '../sources/square/normalizer.js';
import { withIdempotency } from '../middlewares/idempotency.js';
import { SourceId } from '../shared/types.js';
import type { SourceId as SourceIdType } from '../shared/types.js';

const router = Router();

/**
 * Map of URL path parameter values to SourceId constants.
 * PRD §11: POST /sync/:source — supported source values.
 */
const SOURCE_PATH_MAP: Record<string, SourceIdType> = {
  hubspot: SourceId.HUBSPOT,
  'google-calendar': SourceId.GOOGLE_CALENDAR,
  square: SourceId.SQUARE,
};

/**
 * Build a SyncOrchestrator with all currently available sources registered.
 */
function createOrchestrator(): SyncOrchestrator {
  const deps = {
    normalizedRecordRepo: new NormalizedRecordRepository(pool),
    paymentRepo: new PaymentRepository(pool),
    syncStateRepo: new SyncStateRepository(pool),
    rejectedRecordRepo: new RejectedRecordRepository(pool),
  };

  const orchestrator = new SyncOrchestrator(deps);

  // Register HubSpot if configured
  if (config.hubspotAccessToken) {
    orchestrator.register({
      adapter: new HubSpotAdapter(config.hubspotAccessToken),
      normalizer: new HubSpotNormalizer(),
    });
  }

  // Register Google Calendar if configured
  if (config.googleOAuthClient) {
    orchestrator.register({
      adapter: new GoogleCalendarAdapter(config.googleOAuthClient, config.googleCalendarId),
      normalizer: new GoogleCalendarNormalizer(),
    });
  }

  // Register Square if configured
  if (config.squareAccessToken && config.squareLocationId && config.squareEnvironment) {
    orchestrator.register({
      adapter: new SquareAdapter(
        config.squareAccessToken,
        config.squareLocationId,
        config.squareEnvironment
      ),
      normalizer: new SquareNormalizer(),
    });
  }

  return orchestrator;
}

/**
 * POST /sync
 *
 * Trigger synchronization for all registered sources.
 * Each source runs independently — one failure does not block others.
 */
router.post('/sync', async (req: Request, res: Response) => {
  await withIdempotency(req, res, 'sync_all', async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.syncAll();
    const httpStatus = result.status === 'failed' ? 500 : 200;
    return { status: httpStatus, body: result };
  });
});

/**
 * POST /sync/:source
 *
 * Trigger synchronization for a single source.
 * PRD §11: Reject unsupported source values.
 */
router.post('/sync/:source', async (req: Request, res: Response) => {
  const rawParam = req.params.source;
  const sourceParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  const sourceId = SOURCE_PATH_MAP[sourceParam];

  if (!sourceId) {
    res.status(400).json({
      error: `Unsupported source: "${sourceParam}". Supported: ${Object.keys(SOURCE_PATH_MAP).join(', ')}`,
    });
    return;
  }

  await withIdempotency(req, res, `sync_source_${sourceId}`, async () => {
    const orchestrator = createOrchestrator();
    const result = await orchestrator.syncSources([sourceId]);
    const httpStatus = result.status === 'failed' ? 500 : 200;
    return { status: httpStatus, body: result };
  });
});

export default router;
