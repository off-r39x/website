# Database foundation

Infrastructure-only foundation; no business workflows or job tables. `src/schema/`
(barrel `src/schema/index.ts`, published as `@off-r39x/db/schema`) exports Drizzle
bigint-mode tables; reviewed SQL lives in `migrations/`.

## Source layout

- `src/schema/app-schema.ts`: the only definition of the `app` PostgreSQL schema.
- `src/schema/common.ts`: column helpers only (internal ID, public ref, timestamptz).
  Helpers return a fresh column builder per call and never hide a Domain State
  column. Constraints and their explicit names stay in each table definition.
- `src/schema/identity.ts`: `business_profiles` and `role_assignments`.
- `src/schema/audit.ts`: `audit_events` (SPEC-160 §33). Append-only; `app_api_runtime` has INSERT only.
- `src/schema/public-content.ts`: `events`, `faq_items`, `announcements` and `sponsor_logos` (SPEC-100 §13.1–13.4).
- `src/schema/sales.ts`: `entry_ticket_offerings`, `karaoke_sales_configurations` and `goods` (SPEC-100 §15.1–15.3).
- `src/schema/goods.ts`: `goods_inventory`. It is in its own file because SPEC-100 Part IX (§38) owns it; it
  references `goods` from `sales.ts`.
- `src/schema/karaoke.ts`: `karaoke_exclusive_scopes` and `karaoke_slots` (SPEC-100 §27–28). The Scope overlap
  exclusion `ex_karaoke_slots_scope_occupancy` is SQL-only (§57) and is not declared in Drizzle.
- `src/schema/orders.ts`: `orders`, `order_items` and `entry_sales_allocations` (SPEC-100 §16–18). `src/schema/payments.ts`:
  `checkout_attempts`, `payment_bindings`, `webhook_receipts` and `refund_records` (§20–23). The generated columns
  (`line_total_amount`, `payment_deadline_at`) are declared with the migration's expression; the SQL is the source of truth (§57).
- `src/schema/cross-functional.ts`: `idempotency_records` (SPEC-100 §43.1, Part X). Its `bytea` columns use a
  file-local `customType` (`Uint8Array`) so that `common.ts` stays helpers for the shared column kinds only.
  The file name is a repository decision (DEV-AI-003): SPEC-100 §55 names Part X Cross-functional.
- `src/audit-events.ts`: caller-transaction Audit writer (INSERT only, no RETURNING, no retry, per-operation change specs).
- `src/idempotency-records.ts`: caller-transaction primitives of the Transport Idempotency replay record
  (`claimTransportIdempotency`, `setTransportIdempotencyResult`; digests and references only, no retry). Not
  exported from the package root: each Operation's transaction module imports it.
  `src/transactions/idempotency.ts` is the minimal transaction for an Operation that succeeds without a
  business update.
- `src/schema/index.ts`: the barrel. It re-exports `app` and the tables by name,
  unchanged, and exports no helper (`DEV-DB-001`). To add a table, put it in the
  file for its table domain (`SPEC-100 §55`) and add a named export to `index.ts`.
- The Drizzle declarations exist for types and queries. The source of truth for DDL
  is the hand-written SQL in `migrations/` (`SPEC-100 §57`, `DB-MIG-002`); this
  package does not use `drizzle-kit` today.
- `src/transaction.ts` is the generic transaction boundary: isolation, timeout,
  the `SPEC-150` retry policy, `commit_unknown` and advisory locks.
  `src/transactions/` is the planned home of business transaction modules: one
  use case per transaction, no external calls inside (`DEV-DB-010`), and the
  caller of `transaction()` (`DEV-DB-003`, `SPEC-100 §55`). Today it holds
  `src/transactions/profile.ts` (`readCurrentBusinessProfile` /
  `updateCurrentBusinessProfile`, the caller's own Profile for `API-AUTH-002` /
  `API-AUTH-004`).

## Migration numbering

1. Files are `packages/db/migrations/NNNN_<snake_case>.sql` (`DEV-REP-002`), with
   `NNNN` zero-padded to four digits because the runner applies files in filename
   order. Use the latest number on `dev` plus one (`SPEC-100 §59`).
2. One migration file per PR. Fix the number just before merging to `dev`; if
   another PR merged first, the later PR renumbers. The journal matches by filename
   and source hash, so never apply a migration that is not merged to `dev` to a
   shared database (staging and the like); a renamed file would fail with a source
   hash mismatch.
3. Never change a merged file, neither name nor bytes. Fix forward with a new
   numbered migration (`DB-MIG-005`; the runner fails on any journal mismatch).
   `0001_foundation.sql` also anchors repository-root discovery.
4. Order DDL for a new environment as in `SPEC-100 §59`. Name constraints and
   indexes with the `SPEC-100 §5` prefixes (`DB-ARC-007`). Annotate SQL-only DDL
   with the relevant `DB-*` or upstream Rule ID in an SQL comment (`SPEC-100 §57`).
   `0001_foundation.sql` predates this rule, has no such comments and is immutable,
   so it is an exception; the rule applies from the next migration on.
5. When a migration changes the schema, update `src/schema-contract.json` in the
   same commit and the matching Drizzle declarations in `src/schema/*.ts` in the
   same PR.
6. `pnpm validate:migrations` is a conservative aid. It requires a unique numeric
   prefix (and rejects destructive SQL and similar patterns) but checks neither the
   four-digit / snake_case form nor SQL correctness. Every migration still needs a
   diff review (`DEV-DB-013`) and the real PostgreSQL 17 migration test
   (`SPEC-170 §22`).

## Deployment boundaries

1. A privileged deployment identity runs `installBaselineRoles(client)` once.
   Role credentials are supplied by deployment tooling, not generated here.
   Configure database CONNECT/CREATE and `app_migrator` permissions externally.
2. Run `MIGRATION_DATABASE_URL=... pnpm --filter @off-r39x/db migrate` as a separate
   deployment command using a direct TLS connection
   authenticated as `app_migrator`. Runtime startup never runs migrations.
3. Supply a provider-contract-confirmed mapping to `installIdentityDirectory`.
   It validates types/uniqueness, projects only three columns and does not change
   provider tables. No Neon table names are assumed. Missing mapping is not ready.
4. Configure an environment marker as a deployment-managed PostgreSQL custom
   setting and pass its name and expected value to `checkReadiness`. Optional
   project/branch metadata settings must be externally confirmed, never inferred.
5. Package unchanged SQL at `/app/packages/db/migrations/` with OCI WORKDIR `/app`.
   Source commands may run from a repository subdirectory; migration resolution
   searches ancestors for that fixed source-controlled path, never environment
   input or the bundled entrypoint directory. All SQL sources are ordered by filename,
   hashed individually and checked against the applied journal as an exact prefix.
   Only pending migrations are applied; altered, missing or unknown history fails.
   Readiness requires the bundled set (filename byte order) to be an exact prefix of
   the journal ordered by version byte order; later journal rows and additional
   catalog objects are tolerated only when the journal is ahead, except a NOT NULL
   column without default, identity or generation added to a required table
   (SPEC-180 INF-HLT-006). It reads journal, catalog, journal outside a transaction and judges
   only when both journal reads agree, retrying within the SPEC-150 55P03 budget;
   an exhausted budget is a `release_schema_contract` failure.
   `computeMigrationSetHash()` returns
   the release set identity using sorted filename, NUL, source bytes, NUL.

`createDatabase` requires a runtime-role URL with no query overrides and verifies
TLS trust and hostname. Test harnesses alone use direct local non-TLS connections.
The principal repository is read-only, returns lossless string IDs and never
provisions profiles. `transaction` returns `commit_unknown` rather than replaying
an unacknowledged commit. Its callback must never call external providers.

The audit retention purge function and audit reader identity (SPEC-180 §22.6–22.7, §62),
provider mapping, credential issuance, deployment DB metadata,
business write repositories, and production provider evidence are intentionally
not supplied by this foundation. Readiness is an infrastructure check, not proof
that deferred business services are production-ready.

## Initial data seeding

`pnpm db:seed-initial-data` (`packages/db/src/seed-initial-data-cli.ts`, SPEC-180 §45.3) creates the
first Event and its Entry Ticket Offerings in an empty database. There is no Business API or migration
that creates them. Offerings are always created `SUSPENDED` with counters at 0, and the Event
`business_timezone` is `Asia/Tokyo`. Run it after the migration and the schema readiness check and
before the API deploy. The command takes the migration lock (`r39x:schema-migration`) itself; the
library functions `acquireMigrationLock` and `seedInitialData({ lock, ... })` let a migration job run
migrate, readiness and seed under one session lock. Running `db:migrate` and this command as two
processes is for development, tests and re-runs: the lock is released in between. Every statement of the
seed runs in a session that holds the migration lock: when a COMMIT result is lost, the re-check takes
the lock again on its new connection (waiting up to 60 seconds, else `UNKNOWN_RESULT`) before it reads.
The 60 seconds bound the whole lock acquisition on the client as well: a connection that stops
answering while the lock is taken is abandoned (the command fails with `MIGRATION_LOCK_TIMEOUT`, the
re-check ends in `UNKNOWN_RESULT`), and a lock the server may have granted ends with its session.
Each statement of the seed transaction runs within the 8 second transaction deadline (SPEC-150 §9); a
lock wait or read that would pass it ends the attempt as `FAILED`. The re-check transaction has the same
deadline; a re-check that cannot decide within it ends as `UNKNOWN_RESULT`. The command keeps the
deadline itself too: a connection that stops answering is abandoned when the deadline passes (its
session, and the migration lock with it, ends), so the command does not hang. A run that the re-check
finds uncommitted, and a lock timeout, are retried only within the SPEC-150 55P03 budget (4 attempts,
5 seconds from the first attempt, not counting the migration lock wait), backoff included, else
`FAILED` (or `UNKNOWN_RESULT` for the re-check). The retry after an uncommitted re-check waits the same
full jitter backoff as any 55P03 retry. A retried transaction runs within what is left of that budget,
not a new 8 seconds, and a later SQLSTATE with a longer budget (`40001` 2 s, `40P01` 3 s, `55P03`
5 s) never extends a budget already applied. The first connection and the new connection for the
re-check are both acquired within the SPEC-150 budget for a temporary connection failure (3 attempts,
3 seconds in total, backoff included, each attempt bounded by what is left), else `FAILED`
(`DATABASE_TEMPORARY_FAILURE`) for the first one and `UNKNOWN_RESULT` for the re-check. A connection
or a migration lock whose success arrives after its deadline is closed, not used. A COMMIT whose
acknowledgement arrives at or after the wall clock of its transaction (the 8 seconds, or what was left
of the retry budget), as measured on the monotonic clock, is an unknown result like a lost one: it is
re-checked, not reported `CREATED` from the acknowledgement. Likewise, a transaction whose verdict
was reached before COMMIT (`NOOP`, a failure, or a re-check verdict) ends with a ROLLBACK, and a
ROLLBACK acknowledged at or after that wall clock ends the transaction by its wall clock: the seed
transaction is `FAILED` (`TEMPORARY_FAILURE`, `DATABASE_TEMPORARY_FAILURE`), not `NOOP`, and the
re-check decides nothing (`UNKNOWN_RESULT`). A server that refuses
the credentials (SQLSTATE class 28, such as `28P01`) is not retried: the first connection ends as
`FAILED` (`PERMANENT_FAILURE`, `DATABASE_AUTHENTICATION_FAILED`), the re-check as `UNKNOWN_RESULT`.
When a retry budget runs out (by attempts or by elapsed time, for the connection, the seed transaction
or the re-check), `reliability.retry.exhausted` is logged (SPEC-160 §22) before the result. Every retry
of these three logs `reliability.retry.attempted` as it starts. Both events carry the cause
(SPEC-160 OBS-DB-003): `query_name` names what is retried (`initial_data.connect`,
`initial_data.seed` or `initial_data.recheck`), and `sqlstate` the retryable SQLSTATE that caused a
transaction retry (`40001`, `40P01` or `55P03`). A connection retry has no `sqlstate`, and neither has
the seed retry after the re-check found the run uncommitted. No other output carries a SQLSTATE. A
connection whose server stops answering at the close is destroyed after 3 seconds, so the command
still exits.

Environment variables (an `app_migrator` direct URL on port 5432 over TLS, as for `db:migrate`):

| Name | Meaning |
| --- | --- |
| `APP_ENV` | `production`, `staging`, `development` or `test` |
| `MIGRATION_DATABASE_URL` | Direct `app_migrator` URL with a database name: no query string, no `-pooler` host, port 5432 or none |
| `INITIAL_DATA_SEED_ACTOR_REF` | Stable non-secret identity for the Audit Event, `[A-Za-z0-9_:-]{1,128}` |
| `INITIAL_DATA_SEED_JSON` | The input JSON; read only when a row has to be created |

The input has the two keys `event` and `entry_ticket_offerings` (one or more). See
`packages/db/seed/initial-data.example.json` (synthetic values only). Unknown keys are rejected,
including `id`, `public_ref`, `event_id`, `sale_control_state`, `held_quantity`,
`committed_quantity`, `business_timezone`, `created_at` and `updated_at`. Timestamps need an offset.
Numbers are checked as written: only a plain integer literal is accepted (`1000`, not `1000.0`, `1e3`,
`-0` or a fraction that JSON parsing would round).
Keep the real input in the protected GitHub Environment Secret of each environment; never share it
between staging and production and never put it in the repository, a log or a pull request. For a
local run: `export INITIAL_DATA_SEED_JSON="$(cat packages/db/seed/initial-data.example.json)"` (bash) or
`$env:INITIAL_DATA_SEED_JSON = Get-Content -Raw packages/db/seed/initial-data.example.json` (PowerShell).

The URL is checked as pg reads it (the host percent-decoded, `-pooler` in any case rejected, and a
host with a `/`, which pg would take as a Unix socket directory without TLS, rejected), and pg is
given the checked host, user, password and database with the port fixed to 5432, never the URL itself:
`PGHOST` and `PGPORT` cannot redirect it. A URL without a database name is rejected
(`CONFIGURATION_INVALID`), so `PGDATABASE` cannot choose the database either.

The command never updates or deletes a row: it creates only when there is no Event (or the only Event
has no Offering), reports `NOOP` otherwise, and fails when two or more Events exist. stdout is exactly one
JSON result line (`outcome` is `CREATED`, `NOOP`, `FAILED` or `UNKNOWN_RESULT`); stderr holds the common
log lines. Exit codes: `0` CREATED or NOOP, `2` FAILED (fix the cause, run again), `3` UNKNOWN_RESULT
(the COMMIT result could not be determined; restore the connection and run the same command again).
Exit code `1` is an unexpected crash (no result line is guaranteed) and is handled like `3`: run again.
The root script `db:seed-initial-data` (and the package script `seed:initial-data`) runs `node
--disable-warning=ExperimentalWarning` on the CLI file directly, not through `pnpm --filter`, which would
turn the exit codes 2 and 3 into 1. The flag keeps the Node type stripping warning off stderr, which
carries only JSON log lines (pnpm itself may print its own run lines there); a direct `node` call on an
older Node 24.x prints that warning too. The CLI tests need PostgreSQL on port 5432
with TLS.
