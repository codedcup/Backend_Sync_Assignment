# Multi-Source Sync Pipeline and Canonical Revenue Metrics Service

## 1. Assignment Overview
This repository implements a multi-source data synchronization pipeline and a canonical revenue metrics service. The system is designed to provide high-fidelity correctness guarantees across diverse external data sources.

## 2. Architecture Actually Implemented
The application is a single-process Node.js TypeScript backend running an Express server. It fetches data natively via adapters, normalizes it strictly into a canonical model, and safely persists it in Supabase Postgres. An orchestration layer ensures that source synchronization boundaries are isolated (a crash in one source does not halt others) and that database writes are strictly idempotent.

## 3. Source Integrations
- **HubSpot CRM**: Synchronizes Contacts using incremental search (`lastmodifieddate`).
- **Google Calendar**: Synchronizes Events using Google's explicit incremental `syncToken` API to handle pagination and deletions securely.
- **Square Sandbox**: Synchronizes Payments using `updated_at` boundaries to correctly pull new or updated payment transactions.

## 4. Canonical Normalized Models
Data from external sources is mapped strictly to two domain tables:
1. `normalized_records`: Stores generic external state (e.g. CRM contacts, Calendar events).
2. `payments`: Stores canonical payment records extracted from finance sources (Square).

## 5. Synchronization Flow
`fetch → normalize → validate → isolate rejections → persist valid records → persist sync state`
Each source is wrapped in a transactional database boundary. Sync progress is saved *only* after data is durably persisted.

## 6. Incremental Sync Semantics per Source
- **HubSpot**: Filter via `>=` on `lastmodifieddate` using the `cursor` from the database.
- **Google Calendar**: Native `syncToken`. If a `pageToken` is present, pagination completes before a new `syncToken` is stored.
- **Square**: `sort_field=UPDATED_AT` with `updated_at_begin_time` corresponding to the last successfully processed modification timestamp.

## 7. Stale Cursor/Token Recovery
Google Calendar enforces strict token expiry. The adapter detects a `410 Gone` error (stale token), discards the expired token, and automatically triggers a full backfill fetch. The idempotent database layer guarantees this backfill does not duplicate existing rows.

## 8. Dual Idempotency Boundaries and Stale-Update Protection
The system enforces strict execution and ingestion isolation through two boundaries:
1. **Request/Execution Idempotency**: An `Idempotency-Key` header on trigger endpoints blocks duplicate orchestration execution for a specific operation. The first request atomically claims execution using a Postgres unique constraint on `(idempotency_key, operation)`. While a claim is in `processing`, concurrent/duplicate requests safely return `409 Conflict` and do not execute. Completed requests automatically replay their finalized HTTP status code and response payload.
2. **Record-Ingestion Idempotency**: Postgres `ON CONFLICT (source, external_id)` guarantees duplicate deliveries result in exactly one normalized row.
3. **Stale-Update Protection**: A strict `WHERE EXCLUDED.source_modified_at > target.source_modified_at` clause prevents older payloads from silently overwriting newer application state if out-of-order delivery occurs.

## 9. Failure Isolation and Rejected-Record Handling
Malformed records are caught during normalization and persisted securely into the `rejected_records` table with their raw payload and failure reason. A malformed record within a fetched page does not prevent the surrounding valid records from successfully persisting.

## 10. Canonical Collected-Revenue Definition
Collected revenue is defined strictly as the sum of payments where the canonical status is explicitly classified as `collected`.

## 11. Metric Date Semantics and the sourceCreatedAt Tradeoff
The current finalized metric definition is: *“Current collected revenue attributed by the source payment creation timestamp.”* 
Square `created_at` serves as the `sourceCreatedAt` metric date dimension. This is not the exact capture/settlement time, but it guarantees N+1 external API calls are not required, preserving the performance and simplicity requirements of the pipeline.

## 12. Revenue Summary and Daily Endpoints
- `GET /metrics/revenue` (Summary)
- `GET /metrics/revenue/daily` (Daily Breakdown)

## 13. Metric Drift Protection
Automated integration tests freeze semantic definitions, guaranteeing that new unrecognized statuses map strictly to `unknown` and do not accidentally inflate financial metrics. Automated reconciliation verifies that daily breakdown sums precisely match the total summary.

## 14. Local Setup
1. Clone the repository.
2. Ensure you have Node 20+ installed.
3. Install dependencies: `npm install`.

## 15. Required Environment Variables
Create a `.env` file at the root:
```env
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://postgres.xxx:password@xxx.supabase.com:6543/postgres

HUBSPOT_ACCESS_TOKEN=your_token
GOOGLE_CALENDAR_ID=your_calendar_id@group.calendar.google.com
SQUARE_ACCESS_TOKEN=your_token
SQUARE_LOCATION_ID=your_location
SQUARE_ENVIRONMENT=sandbox
```

## 16. Google Local OAuth Setup
Run `npx tsx src/scripts/google-auth.ts`.
This will spin up a local server. Authenticate in the browser. It will securely persist `token.json` in the project root, enabling automatic background token refreshes for the `GoogleCalendarAdapter`.

## 17. Database Migration Commands
Execute `npx tsx src/scripts/migrate.ts` to automatically bootstrap the Supabase Postgres schema.

## 18. Run, Build, Type-check, and Test Commands
- **Type-Check**: `npm run typecheck`
- **Test**: `npm test`
- **Build**: `npm run build`
- **Run (Dev)**: `npm run dev`
- **Run (Prod)**: `npm start`

## 19. API Endpoint Examples
- Sync all sources: `curl -H "Idempotency-Key: req-123" -X POST http://localhost:3000/sync`
- Sync one source: `curl -H "Idempotency-Key: req-456" -X POST http://localhost:3000/sync/square`
- Metrics Summary: `curl "http://localhost:3000/metrics/revenue?from=2024-01-01T00:00:00Z&to=2024-12-31T00:00:00Z"`

## 20. Demo Walkthrough
1. Boot the app: `npm run dev`
2. Trigger the sync loop: `POST /sync`.
3. Hit `GET /metrics/revenue` to observe the generated metrics.
4. Modify an external record (e.g. change a HubSpot contact) and run `POST /sync` again to demonstrate idempotency and successful incremental upsert.

## 21. Tradeoffs and Known Limitations
- **Test-Database Contamination**: The current test suite runs against the primary local database. As a consequence, it leaves test fixtures (e.g., `ext-good-1`, `cursor-mixed`) behind, which requires manual cleanup before live validation scripts can run accurately. Production deployments would utilize a separate test schema.
- **Job Scheduler**: The system requires external polling (via HTTP `POST /sync`) or manual execution. An embedded cron loop was intentionally omitted.
- **Abandoned Processing Claims**: Request-level idempotency uses strict Postgres uniqueness bounds to enforce single-request execution. We deliberately do not implement automated lease-expiry/theft. As a tradeoff, if the server crashes abruptly while holding an idempotency lock, that key remains permanently in `processing` state. Recovery requires an explicit manual/administrative database cleanup.

## 22. Live Validation Evidence
- **HubSpot**: Real live records successfully fetched and persisted (HTTP 200 OK). Duplicate live sync did not create duplicate rows. Sample payload keys retrieved natively without synthetic modification.
- **Google Calendar**: Authentication and API connectivity validated (OAuth token refresh functional), but configured calendar returned zero events during live validation. We do not claim zero-row duplicate runs as proof of live record idempotency.
- **Square Sandbox**: Authentication and ListPayments query compatibility validated (`updated_at` query parameters were accepted successfully), but configured location returned zero payments during live validation. We do not describe zero-value metric reconciliation as meaningful non-zero live revenue validation.

## 23. Automated Test Evidence vs. Live-Integration Evidence
Extensive evidence (such as dual idempotency, duplicate delivery isolation, 410 Gone recovery, failure isolation) was proven via the 43 automated integration tests utilizing stub adapters. The live validations strictly proved API connectivity, OAuth flows, and payload mapping, but could not synthesize data where source endpoints returned zero rows.

## 24. AI Usage Disclosure
AI was used for implementation assistance, writing boilerplate, and code review. However, all architecture design, semantic decision-making (e.g., pivoting from `collectedAt` to `sourceCreatedAt`), scope changes, and ultimate acceptance/rejection of AI recommendations were directed manually through the shared conversation.

---

### Sources and References
- [HubSpot CRM Contacts Search API](https://developers.hubspot.com/docs/api/crm/contacts)
- [Google Calendar Events Incremental Sync](https://developers.google.com/calendar/api/guides/sync)
- [Square ListPayments API](https://developer.squareup.com/reference/square/payments-api/list-payments)
- [Supabase Postgres Documentation](https://supabase.com/docs/guides/database)
