# Implementation PRD: Multi-Source Sync Pipeline and Canonical Revenue Metrics Service

## 1. Objective and Evaluation Focus

Build an assignment-sized backend system that demonstrates two correctness guarantees:

1. A multi-source synchronization pipeline that safely handles duplicate delivery, legitimate source updates, stale synchronization state, malformed records, and isolated source failures without silently losing or duplicating normalized data.
2. A revenue metrics service that applies one canonical definition of collected revenue across multiple views and detects semantic divergence through automated tests.

The implementation must optimize for visible and enforceable correctness rather than infrastructure complexity.

### Primary evaluation focus

The implementation must clearly demonstrate:

* safe incremental synchronization;
* stale cursor recovery through full backfill;
* idempotent but update-aware persistence;
* prevention of stale source state overwriting newer state where reliable source freshness metadata exists;
* independent source failure boundaries;
* record-level malformed-data isolation;
* correct cursor advancement semantics;
* explicit collected-status allow-list behaviour;
* canonical collection-time attribution;
* agreement between revenue summary and breakdown views;
* automated regression detection for supported revenue views.

### Scope principle

This is an assignment-sized implementation.

Use production-minded correctness for behaviours explicitly evaluated by the assignment. Do not introduce infrastructure, operational systems, or abstractions unless required to preserve an agreed correctness invariant.

---

## 2. Scope and Explicit Non-Goals

### In scope

* HubSpot CRM synchronization.
* Google Calendar event synchronization.
* Square Sandbox Payments synchronization.
* Incremental source synchronization where supported.
* Full-fetch/backfill recovery.
* Source-specific normalization.
* Canonical normalized persistence in Supabase Postgres.
* Per-source synchronization state.
* Database-enforced idempotency.
* Source freshness protection where reliable source metadata exists.
* Persisted rejected-record handling.
* Revenue summary for an arbitrary date range.
* Revenue day-by-day breakdown for an arbitrary date range.
* Automated correctness and reconciliation tests.
* HTTP endpoints for live demonstration and sync triggering.

### Explicit non-goals

Do not implement:

* Redis;
* Kafka, RabbitMQ, or another message queue;
* microservices;
* event-stream processing;
* distributed workers;
* authentication or authorization;
* dashboards or frontend UI;
* enterprise monitoring or tracing platforms;
* automatic rejected-record replay;
* point-in-time financial accounting;
* event-sourced transaction history;
* partial-refund accounting;
* financial ledger or reversal-event modelling;
* generic source versioning infrastructure.

A source-specific correctness rule may be added only when supported by verified source API semantics.

---

## 3. Final Architecture

The system is one Node.js TypeScript backend application.

### HTTP layer

Express exposes:

* source synchronization triggers;
* all-source synchronization trigger;
* revenue summary endpoint;
* revenue daily breakdown endpoint.

### Source integration layer

Each external source has its own adapter:

* HubSpot adapter;
* Google Calendar adapter;
* Square Payments adapter.

An adapter owns:

* source API communication;
* incremental fetch behaviour;
* full fetch behaviour;
* source cursor/token handling;
* stale cursor detection;
* extraction of source identity;
* extraction of reliable source freshness metadata when available.

### Normalization layer

Each source has a source-specific normalizer.

Normalizers convert external payloads into canonical normalized models.

A normalizer may reject a record because of:

* validation failure;
* unsupported or malformed required values;
* inability to derive the required canonical representation.

### Sync orchestration layer

A shared single-process orchestrator coordinates:

`fetch → normalize → validate → persist/reject → progress update`

Each source execution has an independent failure boundary.

A source failure must not prevent other requested sources from running.

### Persistence layer

Supabase Postgres stores:

* normalized records;
* per-source synchronization state;
* rejected records.

Database constraints enforce source-scoped external identity.

### Metrics layer

One canonical revenue metrics module owns:

* collected-status qualification;
* collected timestamp eligibility;
* date-range semantics;
* summary aggregation;
* breakdown aggregation semantics.

Supported revenue views must use this canonical metric definition.

---

## 4. Source Integrations and Source-Specific Sync Semantics

### 4.1 HubSpot CRM

Use a free HubSpot developer account seeded with sample CRM records.

The HubSpot adapter must support:

* incremental retrieval based on a verified HubSpot modification field;
* full retrieval for initial synchronization and recovery;
* stable HubSpot record identity;
* extraction of a reliable source modification timestamp.

#### Integration details to verify

Before implementation, verify against the actual HubSpot API response:

* CRM object type to synchronize;
* exact external ID field;
* exact modification timestamp field, such as `updatedAt` or the appropriate CRM property;
* incremental filtering and pagination semantics;
* timestamp boundary behaviour.

Do not invent field mappings before inspecting the actual response.

### 4.2 Google Calendar

Use Google Calendar API with manually seeded sample events.

The Google Calendar adapter must use Google's incremental synchronization semantics.

Expected behaviour:

* initial synchronization performs a full event listing;
* the returned synchronization token is persisted;
* later synchronization uses the persisted sync token;
* an expired or rejected sync token requiring full resynchronization triggers a full fetch;
* full resynchronization safely reprocesses previously normalized events.

#### Integration details to verify

Verify:

* exact event ID field;
* `updated` timestamp semantics;
* ETag behaviour if used for freshness comparison;
* sync token pagination requirements;
* exact stale-token error response;
* deleted/cancelled event representation.

Do not invent deletion semantics until the real API behaviour is verified.

### 4.3 Square Sandbox Payments

Use Square Sandbox Payments as the finance source.

Seed realistic Sandbox payment records.

The Square adapter must support:

* payment listing;
* incremental retrieval using verified `updated_at` filtering semantics;
* full payment retrieval for initial synchronization or recovery;
* stable Square payment IDs;
* source freshness extraction using the verified payment modification timestamp.

Square is the source used for canonical revenue metrics.

#### Integration details to verify

Inspect real Sandbox Payment responses and verify:

* exact payment status values;
* `updated_at` semantics;
* pagination cursor behaviour;
* amount and currency fields;
* exact source field representing successful collection/completion time;
* whether `updated_at` filtering is inclusive or exclusive at boundaries;
* refund representation in the selected sample flow.

The canonical `sourceCreatedAt` mapping must not be finalized until the actual Square payload and lifecycle semantics are verified.

---

## 5. Canonical Normalized Models

Keep normalized models minimal.

### 5.1 Normalized external record

Common synchronization metadata must include:

* internal ID;
* source;
* external ID;
* canonical record type;
* source modification marker, when reliably available;
* normalized payload;
* created timestamp;
* updated timestamp.

The combination of `source + externalId` uniquely identifies an external record.

The normalized payload may remain type-specific. Do not force CRM contacts, calendar events, and payments into an artificial identical business schema.

### 5.2 Normalized payment

The payment model must expose the fields required for canonical revenue calculation:

* internal ID;
* source;
* external ID;
* normalized status;
* source status;
* amount;
* currency;
* collected timestamp;
* source modification timestamp;
* created timestamp;
* updated timestamp.

#### Status semantics

The normalized status vocabulary must be explicit and minimal.

At minimum it must distinguish:

* collected;
* non-collected known state;
* refunded;
* unknown/unmapped.

Exact source-to-canonical mappings must be defined after inspecting Square Sandbox statuses.

An unmapped source status must never default to collected.

### 5.3 Sync state

Each source has independent persisted synchronization state.

Required logical fields:

* source;
* cursor or sync token;
* last successful synchronization timestamp;
* created timestamp;
* updated timestamp.

Source is unique.

Do not use one global synchronization cursor.

### 5.4 Rejected record

A rejected record must contain enough information to prove intentional terminal rejection.

Required logical fields:

* internal ID;
* source;
* external ID when derivable;
* raw source payload;
* rejection stage;
* failure reason;
* rejection timestamp.

Rejection stage must distinguish at least:

* validation;
* normalization.

Persistence, infrastructure, and unexpected internal errors must not be stored as terminal rejected records merely to allow cursor advancement.

---

## 6. Synchronization Flow

For each requested source:

1. Load the source's persisted sync state.
2. Determine incremental or full-fetch mode.
3. Fetch one source result/page/batch.
4. Process each fetched record independently.
5. Attempt source-specific normalization.
6. Validate the normalized result.
7. If normalization and validation succeed, persist using source-scoped idempotent update semantics.
8. If normalization or validation fails, persist a rejected-record entry.
9. Classify each record as resolved or unresolved.
10. Advance source progress only when every record associated with the fetched progress boundary is resolved.
11. Continue pagination when required.
12. Persist the source's new cursor/token only after the associated records are resolved.
13. Report the source result independently from other source results.

### Resolved outcomes

A record is resolved only when:

* normalization and validation succeed and the normalized record is safely persisted; or
* validation/normalization fails and rejection evidence is safely persisted.

### Unresolved outcomes

The following are unresolved:

* normalized-record persistence failure;
* rejected-record persistence failure;
* database infrastructure failure;
* external infrastructure failure after a fetch result has been obtained but before safe resolution;
* unexpected internal processing error.

An unresolved outcome prevents progress advancement for that source's associated fetch boundary.

---

## 7. Cursor and Stale-Cursor Recovery Semantics

### Per-source progress

Synchronization progress is independent per source.

Failure or recovery of one source must not modify another source's cursor or token.

### Cursor advancement rule

A source progress marker may advance only after all records associated with that fetched progress boundary have reached resolved outcomes.

Never advance progress in a `finally` block or based only on successful source fetching.

### Google Calendar stale sync token

When Google Calendar rejects an expired/invalid sync token using its documented stale-token behaviour:

1. discard the unusable incremental token for recovery purposes;
2. perform a full synchronization;
3. process the full result using normal idempotent persistence rules;
4. persist the newly issued sync token only after the full synchronization records are resolved.

The existing normalized data must not be blindly deleted solely because the sync token expired.

Any source-specific deletion reconciliation required by Google Calendar must be based on verified API semantics.

### Timestamp-based incremental sources

For HubSpot and Square:

* use the verified source modification timestamp for incremental retrieval;
* persist source progress only after the associated fetched records are resolved.

Exact timestamp overlap/boundary handling must be based on verified API filtering semantics.

Prefer safe reprocessing over a boundary gap because persistence is idempotent.

---

## 8. Idempotency and Stale-Update Protection

The system implements two strict idempotency boundaries:

1. **Request/execution idempotency** through an `(Idempotency-Key, operation)` pair in the synchronization endpoints.
2. **Record-ingestion idempotency** through `(source, external_id)` constraints and update-aware database upserts.

### Request/Execution Idempotency

* An `Idempotency-Key` header on trigger endpoints blocks duplicate orchestration execution.
* The identity is scoped by the key and the specific operation (e.g., `sync_all`, `sync_source_hubspot`).
* The first request atomically claims execution using a Postgres unique constraint.
* While a claim is in `processing`, concurrent/duplicate requests return `409 Conflict` and do not execute.
* Completed requests automatically replay their finalized HTTP status code and response payload.
* **Abandoned Claims:** If a process crashes while holding a claim, it remains permanently in the `processing` state. Automated lease-stealing or timeouts are intentionally omitted to guarantee single ownership. Recovery from an abandoned processing claim requires explicit administrative database cleanup.

### Source-scoped identity

Database uniqueness must enforce:

`source + external_id`

The same external ID from two different sources must not collide.

### Duplicate delivery

Processing the same source representation multiple times must not create duplicate normalized rows.

This must be enforced by the database-backed write path, not an in-memory duplicate set.

### Legitimate updates

An existing external record may be updated when a newer representation of the same source record is received.

Previously seeing an external ID must not cause later source updates to be ignored.

### Stale-update protection

Where a source exposes a verified reliable modification/version marker:

* persist the marker with normalized state;
* an incoming source representation must not overwrite state derived from a newer source representation.

This rule applies only after source freshness semantics are verified.

Expected candidates:

* HubSpot modification timestamp;
* Google Calendar `updated` or another verified version marker;
* Square `updated_at`.

Do not build a generic version-vector or distributed versioning mechanism.

### Acceptance criteria

* Running the same sync twice produces no duplicate normalized rows.
* Reprocessing a full backfill produces no duplicate normalized rows.
* A newer source update changes the existing normalized record.
* Where reliable freshness metadata exists, processing an older source representation after a newer one does not regress normalized state.

---

## 9. Rejected-Record Handling

The rejected-record store is a persistent observability mechanism for terminal data-quality failures.

It is not a queue.

It may be described as DLQ-like in documentation because it preserves failed payloads and failure reasons, but no queue semantics are implied.

### Terminal rejection rules

Only validation and normalization failures may become terminal rejected outcomes.

A rejection becomes resolved only after the rejection record itself is successfully persisted.

If rejected-record persistence fails:

* the source processing boundary remains unresolved;
* source progress must not advance.

### Required behaviour

A malformed record must not prevent independently valid records in the same fetched result from being processed.

Rejected records must retain:

* source context;
* original payload;
* failure stage;
* human-readable failure reason.

Automatic replay and correction workflows are outside scope.

---

## 10. Revenue Metric Semantics

### Canonical definition

Collected revenue is the sum of payment amounts where:

1. the payment's normalized status is explicitly classified as collected;
2. the payment has a valid canonical `sourceCreatedAt` timestamp (representing the source payment creation timestamp);
3. `sourceCreatedAt` falls within the requested date range.

### Explicit collected status

Square `COMPLETED` maps to canonical `collected`.
Unknown statuses map to canonical `unknown` and must not contribute to collected revenue.
Current-state refund semantics dictate that refunded payments are not counted as collected.

### Metric date semantics and attribution tradeoff

The current finalized metric definition is: “Current collected revenue attributed by the source payment creation timestamp.”

Square `Payment.created_at` serves as the `sourceCreatedAt` metric date dimension.
*Explicit disclaimer*: This is not capture, completion, settlement, or exact collection time. We fall back to the creation timestamp because Square does not expose a reliable canonical collection timestamp directly on the base payment payload without N+1 external fetching.

Filtering date range for the metric is exclusively:
`from <= sourceCreatedAt < to`

Unknown or unmapped source statuses contribute zero.

Do not implement:

`status != failed`

or any equivalent exclusion-list logic.

Unknown source statuses must remain identifiable through the stored source status and normalized mapping.

### Collection timestamp

Revenue date attribution uses the canonical collection timestamp.

Do not silently fall back to:

* source creation time;
* synchronization time;
* database creation time;
* last-update time.

The exact Square field mapped to `sourceCreatedAt` is an integration detail to verify from real Sandbox lifecycle payloads.

### Current-state semantics

Revenue is computed from current normalized payment state.

This is not point-in-time accounting.

A later refund may therefore change the result of a historical date-range query.

A currently normalized `refunded` payment does not qualify as collected.

Partial refunds, reversal accounting, and historical revenue reconstruction are outside scope unless actual Square sample behaviour makes additional handling necessary.

### Date-range semantics

Use one explicit interval convention across all metric views.

Recommended contract:

`from <= sourceCreatedAt < to`

The summary and breakdown views must use the same boundaries.

Daily breakdown buckets must use the same timezone convention.

Use UTC unless verified source/business requirements require otherwise.

---

## 11. API and Sync Trigger Endpoints

Keep the HTTP surface minimal.

### Trigger all source syncs

`POST /sync`

Triggers HubSpot, Google Calendar, and Square synchronization.

The response must report each source independently.

Example logical response:

```json
{
  "sources": {
    "hubspot": {
      "status": "success"
    },
    "google_calendar": {
      "status": "failed",
      "error": "..."
    },
    "square": {
      "status": "success"
    }
  }
}
```

One source failure must not prevent results for other sources.

### Trigger one source

`POST /sync/:source`

Supported source values:

* `hubspot`
* `google-calendar`
* `square`

Reject unsupported source values.

### Revenue summary

`GET /metrics/revenue?from=<ISO_TIMESTAMP>&to=<ISO_TIMESTAMP>`

Returns the canonical collected-revenue total for the date range.

Response must include at minimum:

* total;
* currency or explicitly documented currency assumption;
* from;
* to.

### Revenue daily breakdown

`GET /metrics/revenue/daily?from=<ISO_TIMESTAMP>&to=<ISO_TIMESTAMP>`

Returns daily collected-revenue buckets using the same canonical metric semantics.

For the same date range:

`sum(daily buckets) === summary total`

### Optional demonstration endpoint

A read-only rejected-record endpoint may be exposed if useful for the demo:

`GET /sync/rejections`

Implement only if it materially simplifies demonstrating malformed-record observability.

Do not build rejection management workflows.

---

## 12. Database Tables, Constraints, and Important Indexes

Exact migration syntax is an implementation detail, but the following logical structures are required.

### `normalized_records`

Purpose:

Store canonical CRM and Calendar records and any common synchronized record representation.

Important fields:

* `id`
* `source`
* `external_id`
* `record_type`
* `source_modified_at`
* `payload`
* `created_at`
* `updated_at`

Constraint:

`UNIQUE(source, external_id)`

Important index:

* `(source, source_modified_at)` where useful for source-state inspection.

### `payments`

Purpose:

Store normalized Square payment state used by revenue metrics.

Important fields:

* `id`
* `source`
* `external_id`
* `source_status`
* `normalized_status`
* `amount`
* `currency`
* `collected_at`
* `source_modified_at`
* `created_at`
* `updated_at`

Constraint:

`UNIQUE(source, external_id)`

Important indexes:

* `(normalized_status, collected_at)`
* `collected_at`
* `(source, source_modified_at)`

Do not add indexes without a demonstrated query or correctness purpose.

### `sync_states`

Purpose:

Persist independent source synchronization progress.

Important fields:

* `source`
* `cursor`
* `last_successful_sync_at`
* `created_at`
* `updated_at`

Constraint:

`UNIQUE(source)`

### `rejected_records`

Purpose:

Persist terminal normalization and validation rejections.

Important fields:

* `id`
* `source`
* `external_id`
* `raw_payload`
* `rejection_stage`
* `failure_reason`
* `rejected_at`

Important index:

* `(source, rejected_at)`

Do not model queue acknowledgement, delivery attempts, consumers, or retry state.

---

## 13. Failure Behaviour

### Source API unavailable

Expected behaviour:

* mark that source execution as failed;
* do not incorrectly advance its progress;
* continue running other requested sources.

### Stale Google Calendar sync token

Expected behaviour:

* recognize the documented stale-token response;
* perform full synchronization;
* safely reprocess existing events;
* persist the replacement token only after resolved processing.

### One malformed record

Expected behaviour:

* persist rejection evidence;
* treat the record as resolved after rejection persistence succeeds;
* continue processing valid records;
* allow progress advancement if all other records resolve.

### Rejection persistence failure

Expected behaviour:

* malformed record remains unresolved;
* source progress does not advance.

### Normalized-record persistence failure

Expected behaviour:

* affected record remains unresolved;
* source progress does not advance.

### Unexpected internal error

Expected behaviour:

* do not convert the error into a terminal validation rejection;
* source progress does not advance for the affected processing boundary;
* other sources remain independently executable.

### Duplicate processing

Expected behaviour:

* no duplicate normalized rows;
* current state remains correct.

### Older source state processed after newer state

Where verified source freshness metadata exists:

* older representation must not overwrite newer normalized state.

### Unknown payment status

Expected behaviour:

* payment contributes zero to collected revenue;
* source status remains inspectable;
* status must not automatically become collected.

---

## 14. Required Automated Tests

Tests are required for correctness guarantees, not broad coverage percentage.

### Sync correctness tests

#### Duplicate processing

Given the same source record is processed twice:

* one normalized row exists.

#### Legitimate update

Given an existing external record and a newer source representation:

* the normalized row is updated;
* no second row is created.

#### Stale update protection

Given a newer representation is persisted first and an older representation is processed later:

* normalized state remains at the newer version.

Run only for source mappings with verified freshness metadata.

#### Safe backfill

Given existing normalized records:

* full-fetch reprocessing does not create duplicates.

#### Cursor advancement

Given all records resolve:

* source progress advances.

Given one persistence failure:

* source progress does not advance.

Given one validation rejection whose rejection evidence persists:

* the rejected record is resolved;
* source progress may advance when all other records resolve.

Given rejection persistence fails:

* source progress does not advance.

#### Source failure isolation

Given one source throws:

* other requested sources still execute;
* successful source progress is preserved independently.

#### Malformed-record isolation

Given one malformed and multiple valid records:

* valid records persist;
* malformed record is recorded as rejected.

### Revenue semantic fixture tests

Create a mixed normalized payment fixture containing:

* collected known status;
* multiple collected source-status mappings if available;
* pending/non-collected status;
* failed status;
* refunded status;
* unknown status;
* collected status with missing `sourceCreatedAt`;
* collected payment before the requested range;
* collected payment inside the range;
* collected payment at the exclusive end boundary.

Assert one explicit expected collected-revenue total.

The test must prove:

* allow-list semantics;
* unknown-status safety;
* refunded exclusion;
* collection timestamp requirement;
* date-boundary semantics.

### Cross-view reconciliation test

Using the same controlled payment dataset:

1. query the summary metric path;
2. query the daily breakdown metric path independently;
3. sum daily totals;
4. assert equality with the summary total.

The test must fail if one supported view introduces different status or date semantics.

Do not claim to detect arbitrary unused revenue logic elsewhere in the repository.

The enforceable guarantee is:

> Supported collected-revenue views cannot semantically diverge without a regression test failing.

---

## 15. Demo Scenarios Mapped to Assignment Requirements

The demo video must remain under five minutes.

### Scenario 1: Multi-source normalization

Trigger synchronization.

Show:

* HubSpot data landed;
* Google Calendar data landed;
* Square payment data landed;
* differently shaped source records became normalized records.

Assignment requirement demonstrated:

Multi-source normalization.

### Scenario 2: Duplicate sync safety

Run the same synchronization twice.

Show:

* normalized row counts do not double;
* existing source identities remain unique.

Assignment requirement demonstrated:

Idempotent writes and back-to-back sync safety.

### Scenario 3: Legitimate source update

Change a source record or Square payment lifecycle state where practical.

Run incremental synchronization.

Show:

* existing normalized row changes;
* no duplicate row is created.

Assignment requirement demonstrated:

Incremental synchronization and update-aware idempotency.

### Scenario 4: Failure isolation

Force one adapter to fail using a simple demo-controlled failure mechanism.

Trigger all-source synchronization.

Show:

* one source reports failure;
* other sources still synchronize successfully.

Assignment requirement demonstrated:

One source failure does not wedge the whole run.

The demo failure mechanism must remain simple and clearly identified as demonstration support.

### Scenario 5: Malformed record rejection

Feed one malformed record through a controlled source fixture or demonstration path.

Show:

* valid records persist;
* malformed record appears in the rejected-record store;
* source processing can complete because rejection evidence was persisted.

Assignment requirement demonstrated:

Garbage-data isolation and observable terminal rejection.

### Scenario 6: Stale cursor recovery

Demonstrate stale-cursor handling using Google Calendar's documented stale-token behaviour if practical.

If creating a naturally expired token is impractical during a five-minute demo, use a controlled adapter-level test/demo fixture that reproduces the documented stale-token response and clearly explain the limitation.

Show:

* incremental token rejected;
* full synchronization triggered;
* existing records are safely reprocessed;
* duplicates are not created.

Assignment requirement demonstrated:

Stale cursor recovery through full backfill.

### Scenario 7: Revenue consistency

Query:

* revenue summary;
* daily revenue breakdown.

Show:

* both use the same date range;
* daily bucket sum equals summary total.

Briefly show the semantic fixture/reconciliation tests passing.

Assignment requirement demonstrated:

One collected-revenue number that does not drift across supported views.

---

## 16. Implementation Phases in Dependency Order

### Phase 1: Project foundation

Implement:

* Node.js TypeScript project;
* Express application;
* environment configuration;
* Supabase Postgres connection;
* database migrations;
* basic error handling.

Acceptance criteria:

* application runs locally;
* application connects to Supabase;
* migrations create required tables and constraints;
* basic health endpoint responds.

### Phase 2: Core synchronization contracts

Implement:

* source identifiers;
* adapter contract;
* normalizer contract;
* resolved/unresolved outcome model;
* source sync result model;
* shared orchestrator skeleton.

Acceptance criteria:

* orchestrator can execute multiple stub sources independently;
* one stub source failure does not prevent another from executing;
* progress advancement decision is based on resolved outcomes.

Do not integrate external APIs yet.

### Phase 3: Persistence correctness

Implement:

* source-scoped idempotent write path;
* legitimate update handling;
* source freshness comparison support;
* sync-state persistence;
* rejected-record persistence.

Acceptance criteria:

* duplicate processing creates one row;
* newer source state updates the row;
* verified freshness comparison prevents stale overwrite;
* failed normalized persistence blocks progress;
* persisted validation rejection is resolved;
* failed rejection persistence blocks progress.

### Phase 4: HubSpot integration

Implement:

* HubSpot adapter;
* HubSpot normalizer;
* full fetch;
* incremental fetch using verified source modification semantics;
* pagination;
* freshness marker mapping.

Acceptance criteria:

* seeded HubSpot records synchronize;
* rerun is idempotent;
* changed HubSpot record updates normalized state.

Document verified HubSpot field mappings.

### Phase 5: Google Calendar integration

Implement:

* Calendar adapter;
* event normalizer;
* full synchronization;
* sync-token persistence;
* incremental synchronization;
* documented stale-token recovery;
* verified freshness marker handling.

Acceptance criteria:

* seeded events synchronize;
* incremental changes synchronize;
* full recovery safely reprocesses events;
* no duplicate rows appear.

Document verified Google Calendar field mappings and deletion/cancellation behaviour.

### Phase 6: Square Sandbox integration

Implement:

* Square adapter;
* payment normalizer;
* full payment fetch;
* incremental `updated_at` retrieval;
* pagination;
* source freshness mapping;
* source-status mapping.

Verify the Square creation timestamp before implementing `sourceCreatedAt`.

Acceptance criteria:

* Sandbox payments synchronize;
* duplicate sync is idempotent;
* payment updates modify existing normalized state;
* unknown statuses cannot default to collected.

Document exact Square field and lifecycle mappings.

### Phase 7: Canonical revenue metrics

Implement:

* canonical collected qualification;
* canonical date-range eligibility;
* summary aggregation;
* daily aggregation;
* metric endpoints.

Acceptance criteria:

* only explicitly collected normalized statuses count;
* missing `sourceCreatedAt` does not count;
* unknown status does not count;
* refunded current state does not count;
* summary and daily views use identical interval semantics.

### Phase 8: Correctness test suite

Implement all required sync and metric tests.

Acceptance criteria:

* semantic fixture total is explicitly asserted;
* cross-view reconciliation passes;
* intentionally changing one view's status semantics causes reconciliation or semantic regression tests to fail;
* cursor advancement failure tests pass;
* source isolation tests pass;
* duplicate and stale-update tests pass.

### Phase 9: Live demo support and deployment

Implement only minimal demonstration support required for repeatable failure scenarios.

Deploy the application to Render.

Acceptance criteria:

* live endpoints are reachable;
* sync can be triggered;
* metric endpoints return real normalized Square Sandbox data;
* at least one failure/edge case can be demonstrated live;
* README explains setup, verified source mappings, assumptions, tradeoffs, references, and AI usage.

### Phase 10: README and five-minute demo

README must document:

* system purpose;
* architecture summary;
* source setup;
* local setup;
* environment variables;
* database migration steps;
* sync endpoints;
* metric endpoints;
* collected-revenue semantics;
* current-state refund limitation;
* cursor advancement semantics;
* rejected-record semantics;
* source freshness rules;
* tradeoffs and explicit non-goals;
* sources and references;
* AI usage.

The demo must prioritize correctness evidence over code walkthrough depth.

Final implementation review question:

> For every component or abstraction, identify the assignment requirement or core invariant it protects. If no such requirement or invariant exists, remove or simplify it.
