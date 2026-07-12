import { Pool } from 'pg';
import { config } from '../config/index.js';
import { SyncOrchestrator } from '../sync/orchestrator.js';
import { NormalizedRecordRepository } from '../repositories/normalized-record.repository.js';
import { PaymentRepository } from '../repositories/payment.repository.js';
import { SyncStateRepository } from '../repositories/sync-state.repository.js';
import { RejectedRecordRepository } from '../repositories/rejected-record.repository.js';
import { RevenueMetricsService } from '../metrics/revenue.js';
import { HubSpotAdapter } from '../sources/hubspot/adapter.js';
import { HubSpotNormalizer } from '../sources/hubspot/normalizer.js';
import { GoogleCalendarAdapter } from '../sources/google-calendar/adapter.js';
import { GoogleCalendarNormalizer } from '../sources/google-calendar/normalizer.js';
import { SquareAdapter } from '../sources/square/adapter.js';
import { SquareNormalizer } from '../sources/square/normalizer.js';
import { SourceId } from '../shared/types.js';

async function run() {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const deps = {
    normalizedRecordRepo: new NormalizedRecordRepository(pool),
    paymentRepo: new PaymentRepository(pool),
    syncStateRepo: new SyncStateRepository(pool),
    rejectedRecordRepo: new RejectedRecordRepository(pool),
  };

  const createOrch = () => {
    const orchestrator = new SyncOrchestrator(deps);
    if (config.hubspotAccessToken) {
      orchestrator.register({
        adapter: new HubSpotAdapter(config.hubspotAccessToken),
        normalizer: new HubSpotNormalizer(),
      });
    }
    if (config.googleOAuthClient) {
      orchestrator.register({
        adapter: new GoogleCalendarAdapter(config.googleOAuthClient, config.googleCalendarId),
        normalizer: new GoogleCalendarNormalizer(),
      });
    }
    if (config.squareAccessToken && config.squareLocationId) {
      orchestrator.register({
        adapter: new SquareAdapter(
          config.squareAccessToken,
          config.squareLocationId,
          config.squareEnvironment ?? 'sandbox'
        ),
        normalizer: new SquareNormalizer(),
      });
    }
    return orchestrator;
  };

  const countNormalized = async (source: string) => {
    const r = await pool.query('SELECT count(*) FROM normalized_records WHERE source = $1', [source]);
    return parseInt(r.rows[0].count, 10);
  };
  const countPayments = async (source: string) => {
    const r = await pool.query('SELECT count(*) FROM payments WHERE source = $1', [source]);
    return parseInt(r.rows[0].count, 10);
  };

  try {
    console.log('\n--- 1. HubSpot Validation ---');
    console.log('Triggering HubSpot sync...');
    let result = await createOrch().syncSources([SourceId.HUBSPOT]);
    console.log('Sync Response:', JSON.stringify(result));
    
    let count1 = await countNormalized('hubspot');
    console.log('Normalized HubSpot records:', count1);
    
    if (count1 > 0) {
      const row = await pool.query('SELECT * FROM normalized_records WHERE source = $1 ORDER BY source_modified_at DESC LIMIT 1', ['hubspot']);
      console.log('Sample mapped external_id:', row.rows[0].external_id);
      console.log('Sample freshness (source_modified_at):', row.rows[0].source_modified_at);
      console.log('Sample payload:', Object.keys(row.rows[0].payload));
    }

    console.log('Triggering duplicate HubSpot sync...');
    let dupResult = await createOrch().syncSources([SourceId.HUBSPOT]);
    let count2 = await countNormalized('hubspot');
    console.log('Normalized HubSpot records after duplicate sync:', count2);
    console.log('Duplicate test passed:', count1 === count2);

    console.log('\n--- 2. Google Calendar Validation ---');
    console.log('Triggering Google Calendar sync...');
    result = await createOrch().syncSources([SourceId.GOOGLE_CALENDAR]);
    console.log('Sync Response:', JSON.stringify(result));

    count1 = await countNormalized('google_calendar');
    console.log('Normalized Google Calendar records:', count1);

    if (count1 > 0) {
      const row = await pool.query('SELECT * FROM normalized_records WHERE source = $1 ORDER BY source_modified_at DESC LIMIT 1', ['google_calendar']);
      console.log('Sample mapped external_id:', row.rows[0].external_id);
      console.log('Sample freshness (source_modified_at):', row.rows[0].source_modified_at);
      console.log('Sample payload:', Object.keys(row.rows[0].payload));
    }

    console.log('Triggering duplicate GCal sync...');
    await createOrch().syncSources([SourceId.GOOGLE_CALENDAR]);
    count2 = await countNormalized('google_calendar');
    console.log('Normalized GCal records after duplicate sync:', count2);
    console.log('Duplicate test passed:', count1 === count2);

    console.log('\n--- 3. Square Sandbox Validation ---');
    console.log('Triggering Square sync...');
    result = await createOrch().syncSources([SourceId.SQUARE]);
    console.log('Sync Response:', JSON.stringify(result));

    count1 = await countPayments('square');
    console.log('Payments from Square in DB:', count1);

    if (count1 > 0) {
      const row = await pool.query('SELECT * FROM payments WHERE source = $1 ORDER BY source_created_at DESC LIMIT 1', ['square']);
      console.log('Sample mapped external_id:', row.rows[0].external_id);
      console.log('Sample canonical status:', row.rows[0].normalized_status);
      console.log('Sample created_at (sourceCreatedAt):', row.rows[0].source_created_at);
      console.log('Sample freshness (updated_at):', row.rows[0].source_modified_at);
    }

    console.log('Triggering duplicate Square sync...');
    await createOrch().syncSources([SourceId.SQUARE]);
    count2 = await countPayments('square');
    console.log('Square records after duplicate sync:', count2);
    console.log('Duplicate test passed:', count1 === count2);

    console.log('\n--- Square Canonical Metrics Validation ---');
    const metricSvc = new RevenueMetricsService(pool);
    const range = { from: '2015-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' };
    
    console.log('Fetching Summary...');
    const summary = await metricSvc.getSummary(range);
    console.log('Summary Result:', summary);

    console.log('Fetching Daily Breakdown...');
    const daily = await metricSvc.getDailyBreakdown(range);
    console.log('Daily Breakdown Total Amount:', daily.totalAmount);
    console.log('Daily Breakdown sums match:', summary.totalAmount === daily.totalAmount);
    
    const rj = await pool.query('SELECT source, failure_reason FROM rejected_records');
    if (rj.rows.length > 0) {
      console.log('\n--- Rejected Records ---');
      rj.rows.forEach(r => console.log(`${r.source}: ${r.failure_reason}`));
    }
  } catch (err) {
    console.error('Validation Script Error:', err);
  } finally {
    await pool.end();
  }
}

run();
