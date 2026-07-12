# Project Operating Rules

These rules are mandatory for every implementation phase.

## 1. Scope

* Read the current `.antigravity/PHASE.md`.
* Implement ONLY the active phase.
* Never continue to another phase automatically.
* Inspect existing code before modifying it.
* No UI.
* Do not add requirements not requested by the assignment or current phase.
* Avoid unnecessary infrastructure and abstractions.
* Prefer the simplest design that preserves correctness and testability.

## 2. Architecture

Build a TypeScript, Node.js, Express modular monolith using Supabase PostgreSQL.

Module responsibilities:

* `sources` — external API integration and source-specific normalization.
* `sync` — synchronization orchestration, cursor handling, and recovery.
* `metrics` — canonical revenue definition and metric computation.
* `repositories` — database access and persistence.
* `routes` — HTTP parsing, validation, and responses only.
* `shared` — shared domain types and application errors.
* `config` — environment configuration and validation.

Keep routes thin.

Business rules belong in services or domain modules.

Database operations belong in repositories.

External API behavior belongs in source adapters.

Do not duplicate domain rules.

## 3. Mandatory Guardrails

### Idempotency

External records are identified by:

`(source, external_id)`

Enforce database uniqueness and use UPSERT.

Repeated synchronization or duplicate delivery must not create duplicate rows.

### Cursor Safety

Processing order:

Fetch → Normalize → Persist → Advance Cursor

Never advance a cursor before successful persistence.

At-least-once reprocessing is acceptable.

Silent data loss is not.

### Stale Cursor Recovery

A stale, expired, or rejected incremental cursor must trigger full backfill.

After successful backfill and persistence, save fresh synchronization state.

### Failure Isolation

One source failure must not prevent other sources from attempting synchronization.

Global sync status must accurately represent:

* `success`
* `partial_success`
* `failed`

### Malformed Records

Reject malformed individual records with a reason.

Continue processing valid sibling records when safe.

Never invent fake defaults for required invalid data.

### Money

Store and calculate money using integer minor units.

Never use floating-point arithmetic for revenue totals.

### Revenue

Use exactly one canonical explicit allow-list of collected statuses.

Unknown source = NOT collected.

Unknown status = NOT collected.

New status = NOT collected until explicitly added.

Never use exclusion-based revenue rules.

### Metrics Drift

Summary and breakdown must derive from the same canonical revenue definition.

Required invariant:

`summary total === sum(breakdown totals)`

Revenue eligibility logic must not be duplicated.

Automated tests must detect metric drift.

### Security

Never commit or expose secrets.

Never log API keys, OAuth tokens, database credentials, or sensitive full payloads.

## 4. Validation

Before declaring a phase complete:

1. Run TypeScript compilation.
2. Run relevant tests.
3. Run the complete test suite when available.
4. Fix failures.
5. Verify every current phase requirement.

Never claim a command passed unless it was actually executed successfully.

If blocked, report the blocker instead of inventing a successful result.

## 5. Mandatory Completion Output

After implementation, return ONLY:

### Status

`COMPLETE` | `PARTIAL` | `BLOCKED`

### Implemented

* Short list of completed requirements.

### Files Changed

* `path` — short purpose.

### Validation

* `command` — PASS | FAIL

### Manual Actions

* Actions I must perform manually.

Write `None` when no action is required.

### Issues

* Known limitations, failures, or blockers.

Write `None` when no issue is known.

### Next

State whether the project is ready for the next phase.

STOP after this report.

Never implement the next phase automatically.
