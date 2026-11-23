import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { LogEvent } from "@off-r39x/observability";
import {
  type DatabaseRetryState,
  isDatabaseRetryable,
  RETRY_POLICIES,
  retryDelay,
  TIMEOUTS,
} from "@off-r39x/reliability";
import type { Client } from "pg";
import { insertAuditEventReturningId } from "../audit-events.ts";
import { isSqlstate, sqlState } from "../errors.ts";
import {
  acquireMigrationLock,
  invalidateMigrationLock,
  isActiveMigrationLock,
  type MigrationLock,
} from "../migration-lock.ts";
import { type InitialDataInput, type InputRow, parseInitialDataInput } from "./input.ts";
import {
  INITIAL_DATA_AUDIT_CHANGE,
  INITIAL_DATA_TARGETS,
  type InitialDataTarget,
} from "./targets.ts";

// Initial data seeding (SPEC-100 section 13.5 DB-SEED-001..007, SPEC-180 section 45.3 INF-SEED-001..006,
// SPEC-160 OBS-AUD-014). One transaction per attempt: lock, count, (read input), insert, Audit, COMMIT.
// Every value is a bind parameter; table and column names come from `targets.ts`. This module never
// updates or deletes a row, never logs a value from the input, and never retries an unknown result
// blindly: after a lost COMMIT acknowledgement it re-checks on a new connection (DB-SEED-002). Every
// statement runs in a session that holds the migration lock (INF-SEED-003), the re-check included.

export const SEED_OPERATION_ID = "PROVISION.INITIAL_DATA_SEED";
const SEED_XACT_LOCK = "SELECT pg_advisory_xact_lock(hashtext('app:initial-data-seed'))";
const SAFE_REF = /^[A-Za-z0-9_:-]{1,128}$/;
/** SPEC-150 section 11 (55P03 row): the seed transactions of one command run, re-check retries included. */
const MAX_ATTEMPTS = RETRY_POLICIES["55P03"].maxAttempts;
const CLOSE_WAIT_MS = 3000;

export type SeedFailureClass = "TEMPORARY_FAILURE" | "PERMANENT_FAILURE" | "CONSISTENCY_FAILURE";
export type SeedCreated = {
  readonly events: readonly string[];
  readonly entry_ticket_offerings: readonly string[];
};
export type SeedOutcome =
  | {
      readonly outcome: "CREATED";
      readonly operationExecutionId: string;
      readonly attemptNumber: number;
      readonly created: SeedCreated;
      readonly auditEventIds: readonly string[];
    }
  | {
      readonly outcome: "NOOP";
      readonly operationExecutionId: string;
      readonly attemptNumber: number;
    }
  | {
      readonly outcome: "FAILED";
      readonly operationExecutionId: string;
      readonly attemptNumber: number;
      readonly failureClass: SeedFailureClass;
      readonly errorCode: string;
    }
  | {
      readonly outcome: "UNKNOWN_RESULT";
      readonly operationExecutionId: string;
      readonly attemptNumber: number;
      readonly errorCode: "COMMIT_RESULT_UNKNOWN";
    };

/** INF-SEED-004: 0 for CREATED and NOOP, 2 for FAILED, 3 for UNKNOWN_RESULT (never 1, the Node crash code). */
export function outcomeExitCode(outcome: SeedOutcome): 0 | 2 | 3 {
  switch (outcome.outcome) {
    case "CREATED":
    case "NOOP":
      return 0;
    case "FAILED":
      return 2;
    case "UNKNOWN_RESULT":
      return 3;
  }
}

/** INF-SEED-005 and SPEC-160 section 17: the common log `result`, `failure_class` and level of an outcome. */
export function outcomeLogFields(outcome: SeedOutcome): {
  result: "SUCCESS" | "NOOP" | "FAILED" | "PENDING";
  failure_class: SeedFailureClass | "SUCCESS" | "UNKNOWN_RESULT" | null;
  level: "INFO" | "WARN" | "ERROR";
} {
  switch (outcome.outcome) {
    case "CREATED":
      return { result: "SUCCESS", failure_class: "SUCCESS", level: "INFO" };
    case "NOOP":
      return { result: "NOOP", failure_class: null, level: "INFO" };
    case "FAILED":
      return { result: "FAILED", failure_class: outcome.failureClass, level: "ERROR" };
    case "UNKNOWN_RESULT":
      return { result: "PENDING", failure_class: "UNKNOWN_RESULT", level: "WARN" };
  }
}

export type SeedOptions = {
  /**
   * From `acquireMigrationLock`; its client runs the first attempt. If that attempt's COMMIT result
   * becomes unknown, or its connection is abandoned (the transaction deadline passed, or a ROLLBACK
   * got no answer), the client is ended and the handle is invalidated (`release()` then returns false
   * and sends no SQL), whatever the final outcome. Do not use the client after the seed.
   */
  readonly lock: MigrationLock;
  /**
   * A new connected client, for the re-check after an unknown COMMIT result and the retry after it.
   * The seed takes the migration lock on it before the re-check reads anything, and releases the
   * lock and ends the client before it returns. `timeoutMs` is what is left of the 3 second connection
   * budget (SPEC-150 section 11): the attempt should give up by then. The seed stops waiting for it at
   * that time in any case, and ends a client that arrives later.
   */
  readonly connect: (options: { readonly timeoutMs: number }) => Promise<Client>;
  /** Called at most once, and only when a row has to be created (INF-SEED-002). */
  readonly readInput: () => string | undefined;
  /** An INFRASTRUCTURE_OPERATOR reference (SPEC-160 section 19.1). */
  readonly actorRef: string;
  readonly logger?: { log(event: LogEvent): void };
  /**
   * Wall clock of one seed or re-check transaction in ms (SPEC-150 section 9: 8000). Overridable for
   * tests. Every statement of the transaction (the xact lock, the reads and the writes) runs within
   * the time left.
   */
  readonly transactionDeadlineMs?: number;
  /**
   * Wall clock of one re-check transaction in ms, when it should differ from `transactionDeadlineMs`
   * (which it defaults to). Overridable for tests only.
   */
  readonly recheckDeadlineMs?: number;
  /**
   * Client-side limit in ms for taking the migration lock again before the re-check (SPEC-180 section
   * 24: 60000). Overridable for tests. A connection that does not answer within it is abandoned and
   * the result stays unknown.
   */
  readonly migrationLockDeadlineMs?: number;
};

type Plan = { readonly kind: "all" } | { readonly kind: "offerings"; readonly eventId: string };
type Attempt =
  // `deadlineHit`: the attempt was ended by its wall clock (which, for a retry, can be what was left
  // of the retry budget).
  | { readonly kind: "done"; readonly outcome: SeedOutcome; readonly deadlineHit?: boolean }
  | { readonly kind: "retry"; readonly code: "40001" | "40P01" | "55P03" }
  | { readonly kind: "unknown" };
type Recheck =
  | { readonly kind: "created"; readonly created: SeedCreated; readonly auditEventIds: string[] }
  | { readonly kind: "complete" }
  | { readonly kind: "uncommitted" };

export const failedOutcome = (
  operationExecutionId: string,
  attemptNumber: number,
  failureClass: SeedFailureClass,
  errorCode: string,
): SeedOutcome => ({
  outcome: "FAILED",
  operationExecutionId,
  attemptNumber,
  failureClass,
  errorCode,
});

/**
 * Failure class and error code of an attempt that was rolled back (plan v1.2 section 6). Retryable
 * SQLSTATEs and an unknown COMMIT result are handled before this. An Audit stage failure is always
 * AUDIT_WRITE_FAILED (temporary for a connection-class SQLSTATE or none, else permanent); a statement
 * stage 23xxx is INITIAL_DATA_CONSTRAINT_REJECTED (permanent, REL-DB-002); anything else is unexpected
 * and safe to run again.
 */
export function classifySeedFailure(
  stage: "statement" | "audit",
  sqlstate: string | undefined,
): { failureClass: SeedFailureClass; errorCode: string } {
  if (stage === "audit")
    return {
      failureClass: isConnectionClass(sqlstate) ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE",
      errorCode: "AUDIT_WRITE_FAILED",
    };
  if (sqlstate?.startsWith("23"))
    return { failureClass: "PERMANENT_FAILURE", errorCode: "INITIAL_DATA_CONSTRAINT_REJECTED" };
  return { failureClass: "TEMPORARY_FAILURE", errorCode: "UNEXPECTED_INTERNAL_ERROR" };
}

/** SPEC-150 REL-DB-005/006: only a missing or connection-class SQLSTATE leaves COMMIT undecided. */
function commitAcknowledgementUnknown(error: unknown): boolean {
  const code = sqlState(error);
  return !isSqlstate(code) || code.startsWith("08") || ["57P01", "57P02", "57P03"].includes(code);
}

class DeadlineExceeded extends Error {}

const isConnectionClass = (code: string | undefined): boolean =>
  isSqlstate(code) && (code.startsWith("08") || code.startsWith("57P0"));

/** Resolves true when `work` succeeds within `ms`; false on failure or timeout. Never rejects. */
async function succeedsWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ends a client and makes sure its socket goes. With no query in flight, pg's end() sends Terminate and
 * waits for the server to close the connection; a peer that stops answering never does, and the open
 * socket would keep the process alive. After `waitMs` the socket is destroyed (pg keeps it on a private
 * field), which also ends the server session once the network carries it again.
 */
export async function endConnection(client: Client, waitMs: number = CLOSE_WAIT_MS): Promise<void> {
  if (await succeedsWithin(client.end(), waitMs)) return;
  (
    client as unknown as { connection?: { stream?: { destroy(): void } } }
  ).connection?.stream?.destroy();
}

/** BEGIN with the SPEC-150 section 9 statement and lock timeouts. The xact lock is taken next. */
async function beginTransaction(client: Client): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query(
    `SET LOCAL statement_timeout = '${TIMEOUTS.statementMs}ms'; SET LOCAL lock_timeout = '${TIMEOUTS.lockMs}ms'; SET LOCAL timezone = 'UTC'`,
  );
}

/**
 * The wall clock of one transaction (SPEC-150 section 9), applied to every statement of it. The BEGIN
 * timeouts bound a statement to 5 s and a lock wait to 1 s; once less than 5 s is left, the statement
 * timeout (which also bounds lock waits) is first lowered to the time left, and a timeout it causes is
 * the deadline. The deadline is checked before and after each statement, and again once the lowered
 * timeout is acknowledged (before the statement is sent), so a slow lock wait or read cannot lead to a
 * verdict after the deadline either, and no statement is sent after it.
 *
 * The server-side timeouts cannot end a wait for an answer that never arrives (the network stops
 * answering), so the deadline is also kept on the client: when it passes, the connection is abandoned.
 * pg destroys the socket of a client with a query in flight, so that query fails at once, and the
 * backend ends with its locks (the migration lock included). `abandoned()` then tells the caller that
 * the connection is gone. `disarm()` before COMMIT is sent: a COMMIT in flight has its own wait, and its
 * expiry makes the result unknown (REL-DB-006), not a failure. An acknowledgement that arrives at or
 * after the deadline (`remainingMs()` checked once it is seen) is not in time either, and neither is
 * the acknowledgement of the ROLLBACK that ends a transaction whose verdict was reached before COMMIT.
 */
function transactionDeadline(client: Client, deadlineMs: number) {
  const startedAt = performance.now();
  let abandoned = false;
  const timer = setTimeout(
    () => {
      abandoned = true;
      void endConnection(client);
    },
    Math.max(deadlineMs, 0),
  );
  timer.unref();
  const disarm = () => clearTimeout(timer);
  const remainingMs = () => deadlineMs - (performance.now() - startedAt);
  const check = () => {
    if (remainingMs() <= 0) throw new DeadlineExceeded();
  };
  const within = async <T>(work: () => Promise<T>): Promise<T> => {
    check();
    const left = Math.floor(remainingMs());
    const lowered = left < TIMEOUTS.statementMs;
    if (lowered) {
      await client.query(`SET LOCAL statement_timeout = '${Math.max(left, 1)}ms'`);
      // The SET can be acknowledged at or after the deadline, before the timer callback (an event
      // loop blocked past it): no further statement is sent then.
      check();
    }
    try {
      const result = await work();
      check();
      return result;
    } catch (error) {
      if (lowered && sqlState(error) === "57014") throw new DeadlineExceeded();
      throw error;
    }
  };
  const elapsedMs = () => performance.now() - startedAt;
  return { remainingMs, elapsedMs, check, within, disarm, abandoned: () => abandoned };
}

async function readEventIds(client: Client): Promise<string[]> {
  const result = await client.query("SELECT id, public_ref FROM app.events ORDER BY id LIMIT 2");
  return result.rows.map((row) => String(row.id));
}

async function hasOfferings(client: Client, eventId: string): Promise<boolean> {
  const result = await client.query(
    "SELECT EXISTS (SELECT 1 FROM app.entry_ticket_offerings WHERE event_id = $1) AS present",
    [eventId],
  );
  return result.rows[0]?.present === true;
}

async function insertRow(
  client: Client,
  target: InitialDataTarget,
  row: InputRow,
  parentEventId: string | undefined,
): Promise<{ id: string; publicRef: string; fields: string[] }> {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const values: (string | number)[] = [];
  if (target.condition === "noChildrenOf" && parentEventId !== undefined) {
    columns.push("event_id");
    values.push(parentEventId);
    placeholders.push(`$${values.length}::bigint`);
  }
  // A column without a value is left out so that the database writes NULL (no guessed value).
  const fields: string[] = [];
  for (const column of target.columns) {
    const value = row[column.name];
    if (value === null || value === undefined) continue;
    columns.push(column.name);
    values.push(value);
    const cast =
      column.kind === "integer"
        ? `::${column.sqlType}`
        : column.kind === "timestamp"
          ? "::timestamptz"
          : "";
    placeholders.push(`$${values.length}${cast}`);
    fields.push(column.name);
  }
  for (const fixed of target.fixed) {
    columns.push(fixed.name);
    placeholders.push(fixed.sql);
    fields.push(fixed.name);
  }
  const result = await client.query(
    `INSERT INTO ${target.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id, public_ref`,
    values,
  );
  const inserted = result.rows[0];
  if (inserted === undefined) throw new Error("Row was not returned");
  return { id: String(inserted.id), publicRef: String(inserted.public_ref), fields };
}

/**
 * The server refused the credentials (SQLSTATE class 28: invalid authorization specification, invalid
 * password, a role that may not log in). Not a temporary connection failure (SPEC-150 section 8): it
 * is not retried, and a run of the command reports it as a permanent configuration failure.
 */
export class DatabaseAuthenticationRejected extends Error {
  constructor() {
    super("Database authentication rejected");
    this.name = "DatabaseAuthenticationRejected";
  }
}

const isAuthenticationRejection = (error: unknown): boolean => {
  const code = sqlState(error);
  return isSqlstate(code) && code.startsWith("28");
};

/**
 * What a retry repeats, as a stable source-controlled `query_name` (SPEC-160 section 23): the
 * connection (a DB that cannot be reached), the seed transaction or the re-check transaction.
 */
const RETRY_UNITS = {
  connection: "initial_data.connect",
  seed: "initial_data.seed",
  recheck: "initial_data.recheck",
} as const;

/**
 * The cause of a retry (OBS-DB-003): the unit retried and, for a transaction, the retryable SQLSTATE
 * that caused it (`40001`, `40P01` or `55P03`, a bounded code: OBS-DB-002). A connection retry has
 * none, and neither has the seed retry after a re-check found the run uncommitted (no lock timeout
 * caused it, although it uses the 55P03 budget).
 */
type RetryCause = {
  readonly unit: keyof typeof RETRY_UNITS;
  readonly sqlstate?: DatabaseRetryState | undefined;
};

/**
 * SPEC-160 section 22 `reliability.retry.attempted` (a retry starts) and `reliability.retry.exhausted`
 * (a retry budget of SPEC-150 section 11 ran out, by the number of attempts or by the elapsed time;
 * the run then ends in its own outcome, FAILED, or UNKNOWN_RESULT for a re-check). Both carry the
 * cause, so that lock timeouts, serialization failures, deadlocks and an unreachable DB are counted
 * apart (OBS-DB-003). No other output of the command carries a SQLSTATE. Logging is not business
 * authority.
 */
function logRetry(
  logger: SeedOptions["logger"],
  kind: "attempted" | "exhausted",
  fields: { executionId: string; attemptNumber: number; cause: RetryCause },
): void {
  const { sqlstate } = fields.cause;
  const common = {
    is_retry: fields.attemptNumber > 1,
    operation_id: SEED_OPERATION_ID,
    operation_execution_id: fields.executionId,
    attempt_number: fields.attemptNumber,
    provider: "NEON_DB",
    query_name: RETRY_UNITS[fields.cause.unit],
    ...(sqlstate === undefined ? {} : { sqlstate }),
  } as const;
  try {
    logger?.log(
      kind === "attempted"
        ? { ...common, event_name: "reliability.retry.attempted", level: "INFO", result: "PENDING" }
        : {
            ...common,
            event_name: "reliability.retry.exhausted",
            level: "ERROR",
            result: "FAILED",
            failure_class: "TEMPORARY_FAILURE",
            error_code: "DATABASE_TEMPORARY_FAILURE",
          },
    );
  } catch {
    // Logging is not business authority.
  }
}

/**
 * SPEC-160 section 22 `reliability.timeout.occurred`: a seed or re-check transaction reached its wall
 * clock (SPEC-150 section 9), whether the timer or the monotonic clock saw it first, or the
 * acknowledgement of its COMMIT came too late. `duration_ms` is the time from the transaction's start.
 * The failure class is what the run then reports for it: a seed transaction ended before COMMIT is a
 * temporary failure; a COMMIT not acknowledged in time, or a re-check that could not decide, leaves the
 * result unknown (REL-DB-006). No SQLSTATE: the wall clock, not the database, ended it.
 */
function logTimeout(
  logger: SeedOptions["logger"],
  fields: {
    executionId: string;
    attemptNumber: number;
    unit: "seed" | "recheck";
    durationMs: number;
    resultUnknown: boolean;
  },
): void {
  try {
    logger?.log({
      event_name: "reliability.timeout.occurred",
      level: "ERROR",
      is_retry: fields.attemptNumber > 1,
      operation_id: SEED_OPERATION_ID,
      operation_execution_id: fields.executionId,
      attempt_number: fields.attemptNumber,
      provider: "NEON_DB",
      query_name: RETRY_UNITS[fields.unit],
      duration_ms: Math.max(Math.round(fields.durationMs), 0),
      ...(fields.resultUnknown
        ? {
            result: "PENDING",
            failure_class: "UNKNOWN_RESULT",
            error_code: "COMMIT_RESULT_UNKNOWN",
          }
        : {
            result: "FAILED",
            failure_class: "TEMPORARY_FAILURE",
            error_code: "DATABASE_TEMPORARY_FAILURE",
          }),
    });
  } catch {
    // Logging is not business authority.
  }
}

/** The connection budget's retries and exhaustion, logged for one run (`logRetry`). */
const connectionRetryLog = (logger: SeedOptions["logger"], executionId: string) => {
  const cause: RetryCause = { unit: "connection" };
  return {
    onRetry: (attemptNumber: number) =>
      logRetry(logger, "attempted", { executionId, attemptNumber, cause }),
    onExhausted: (attemptNumber: number) =>
      logRetry(logger, "exhausted", { executionId, attemptNumber, cause }),
  };
};

/**
 * SPEC-150 section 11 "temporary DB connection acquisition": 3 attempts within 3 seconds in total,
 * the attempts and the backoff included. Each attempt gets only what is left of the 3 seconds; a
 * client that arrives after that, even one whose success is seen before the timer, is ended, not
 * used. No attempt starts after the budget. Used for the command's first connection and for the
 * re-check connection. Resolves undefined when the budget runs out (`onExhausted` is told after how
 * many attempts); rejects with DatabaseAuthenticationRejected, without a further attempt, when the
 * server refuses the credentials. `onRetry` is told the number of each attempt after the first, as it
 * starts.
 */
export async function connectWithinBudget(
  connect: SeedOptions["connect"],
  options: {
    readonly onRetry?: (attempt: number) => void;
    readonly onExhausted?: (attempts: number) => void;
  } = {},
): Promise<Client | undefined> {
  const policy = RETRY_POLICIES.databaseConnection;
  const startedAt = performance.now();
  const leftMs = () => policy.maxElapsedMs - (performance.now() - startedAt);
  let attempts = 0;
  for (let n = 1; n <= policy.maxAttempts; n += 1) {
    const timeoutMs = leftMs();
    if (timeoutMs <= 0) break;
    attempts = n;
    if (n > 1) options.onRetry?.(n);
    let connecting: Promise<Client>;
    try {
      connecting = connect({ timeoutMs: Math.ceil(timeoutMs) });
    } catch (error) {
      connecting = Promise.reject(error);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      connecting.then(
        (connection) => ({ kind: "connected" as const, connection }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      new Promise<{ kind: "late" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "late" }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (settled.kind === "connected") {
      settled.connection.on("error", () => {});
      // The success can be seen before the timer callback runs: the budget is checked on the clock.
      if (leftMs() > 0) return settled.connection;
      void endConnection(settled.connection);
      break;
    }
    // A failure seen at or after the end of the budget (before the timer callback, an event loop
    // blocked past it) is the budget running out, as the timer would have made it, whatever it is.
    if (settled.kind === "failed" && leftMs() <= 0) break;
    if (settled.kind === "failed" && isAuthenticationRejection(settled.error))
      throw new DatabaseAuthenticationRejected();
    if (settled.kind === "late") {
      // Too late for this run: a client that still arrives is closed at once.
      connecting.then(
        (connection) => {
          connection.on("error", () => {});
          void endConnection(connection);
        },
        () => {},
      );
      break;
    }
    if (n >= policy.maxAttempts) break;
    const delay = retryDelay(policy, n);
    if (delay >= leftMs()) break;
    await sleep(delay);
  }
  options.onExhausted?.(attempts);
  return undefined;
}

/**
 * The command's first connection, within the connection budget. A failure is reported as attempt 1 of
 * the seed (no seed attempt ran): the budget running out is a temporary failure, logged as retry
 * exhaustion; a refused authentication is a permanent configuration failure, not retried.
 */
export async function openSeedConnection(
  connect: SeedOptions["connect"],
  options: { readonly executionId: string; readonly logger?: SeedOptions["logger"] },
): Promise<
  | { readonly kind: "connected"; readonly client: Client }
  | { readonly kind: "failed"; readonly outcome: SeedOutcome }
> {
  const { executionId, logger } = options;
  let client: Client | undefined;
  try {
    client = await connectWithinBudget(connect, connectionRetryLog(logger, executionId));
  } catch (error) {
    if (!(error instanceof DatabaseAuthenticationRejected)) throw error;
    return {
      kind: "failed",
      outcome: failedOutcome(executionId, 1, "PERMANENT_FAILURE", "DATABASE_AUTHENTICATION_FAILED"),
    };
  }
  if (client === undefined)
    return {
      kind: "failed",
      outcome: failedOutcome(executionId, 1, "TEMPORARY_FAILURE", "DATABASE_TEMPORARY_FAILURE"),
    };
  return { kind: "connected", client };
}

export async function seedInitialData(options: SeedOptions): Promise<SeedOutcome> {
  // A handle that acquireMigrationLock did not issue, or that was released: no SQL, no input read.
  if (!isActiveMigrationLock(options.lock)) throw new Error("Active migration lock required");
  const { actorRef, readInput, connect } = options;
  if (!SAFE_REF.test(actorRef))
    return failedOutcome(randomUUID(), 1, "PERMANENT_FAILURE", "CONFIGURATION_INVALID");
  const deadlineMs = options.transactionDeadlineMs ?? TIMEOUTS.transactionMs;
  const recheckDeadlineMs = options.recheckDeadlineMs ?? deadlineMs;

  const log = (event: LogEvent) => {
    try {
      options.logger?.log(event);
    } catch {
      // Logging is not business authority.
    }
  };

  let client: Client = options.lock.client;
  // The connection (and its migration lock) this run opened itself after an unknown COMMIT result.
  let ownedConnection: Client | undefined;
  let ownedLock: MigrationLock | undefined;
  // Cleanup, not business work: unlock and end on the connection this run opened. On a connection
  // that is already gone these fail fast and the failure is ignored. The caller's own connection and
  // lock handle are never touched here.
  const closeOwned = async () => {
    const lock = ownedLock;
    const connection = ownedConnection;
    ownedLock = undefined;
    ownedConnection = undefined;
    if (lock) await succeedsWithin(lock.release(), CLOSE_WAIT_MS);
    if (connection) await endConnection(connection);
  };
  // A connection given up on (its COMMIT result was lost, its transaction deadline passed, or its
  // ROLLBACK got no answer). Its session may still hold the migration lock until the backend ends:
  // invalidate the lock handle (the caller's release() then sends nothing) and end the client. With a
  // query in flight pg destroys the socket, so the backend ends and drops its session lock. No unlock
  // is sent on it.
  const abandonConnection = async (lost: Client) => {
    invalidateMigrationLock(lost === ownedConnection && ownedLock ? ownedLock : options.lock);
    if (lost === ownedConnection) {
      ownedLock = undefined;
      ownedConnection = undefined;
    }
    await endConnection(lost);
  };

  let parsedInput: ReturnType<typeof parseInitialDataInput> | undefined;
  const loadInput = () => {
    parsedInput ??= parseInitialDataInput(readInput());
    return parsedInput;
  };

  // What the attempt in flight was creating, for the re-check after a lost COMMIT acknowledgement.
  let plan: Plan = { kind: "all" };

  /**
   * One seed transaction. `attemptDeadlineMs` is its wall clock: the transaction deadline, or, for a
   * retry, what is left of the retry budget when that is less (REL-DB-011: the budget covers the
   * attempts and the backoff from the first attempt on).
   */
  const attemptOnce = async (
    executionId: string,
    attemptNumber: number,
    attemptDeadlineMs: number,
  ): Promise<Attempt> => {
    const fail = (failureClass: SeedFailureClass, errorCode: string): Attempt => ({
      kind: "done",
      outcome: failedOutcome(executionId, attemptNumber, failureClass, errorCode),
    });
    // Ended by its wall clock: a temporary failure, not retried (SPEC-150 section 9). Every path that
    // ends the attempt by its wall clock comes here once, so the timeout is logged once.
    const deadlineFailure = (): Attempt => {
      logTimeout(options.logger, {
        executionId,
        attemptNumber,
        unit: "seed",
        durationMs: deadline.elapsedMs(),
        resultUnknown: false,
      });
      return {
        kind: "done",
        outcome: failedOutcome(
          executionId,
          attemptNumber,
          "TEMPORARY_FAILURE",
          "DATABASE_TEMPORARY_FAILURE",
        ),
        deadlineHit: true,
      };
    };
    // COMMIT was sent and its acknowledgement did not come within the wall clock: the result is
    // unknown (REL-DB-006) and the timeout is logged with it.
    const commitTimedOut = (): Attempt => {
      logTimeout(options.logger, {
        executionId,
        attemptNumber,
        unit: "seed",
        durationMs: deadline.elapsedMs(),
        resultUnknown: true,
      });
      return { kind: "unknown" };
    };
    let commitSent = false;
    let stage: "statement" | "audit" = "statement";
    // Each statement runs within the time left, so a slow lock wait or read cannot end in NOOP
    // after the deadline either, and a connection that stops answering is abandoned at the deadline.
    const deadline = transactionDeadline(client, attemptDeadlineMs);
    const { remainingMs, check: checkDeadline, within: withinDeadline } = deadline;
    // A verdict reached before COMMIT ends the transaction with ROLLBACK, and the transaction ends
    // within its wall clock too (SPEC-150 section 9): the acknowledgement can be seen before the timer
    // callback (an event loop blocked past the deadline), so it is checked on the monotonic clock. A
    // ROLLBACK acknowledged at or after the deadline ends the attempt by its wall clock, whatever the
    // verdict (never NOOP from it).
    const rollbackThen = async (verdict: Attempt): Promise<Attempt> => {
      await client.query("ROLLBACK");
      return remainingMs() <= 0 ? deadlineFailure() : verdict;
    };
    try {
      await beginTransaction(client);
      await withinDeadline(() => client.query(SEED_XACT_LOCK));
      const eventIds = await withinDeadline(() => readEventIds(client));
      if (eventIds.length >= 2)
        return await rollbackThen(fail("CONSISTENCY_FAILURE", "INITIAL_DATA_EVENT_NOT_UNIQUE"));
      if (eventIds.length === 1) {
        const eventId = eventIds[0] as string;
        if (await withinDeadline(() => hasOfferings(client, eventId)))
          return await rollbackThen({
            kind: "done",
            outcome: { outcome: "NOOP", operationExecutionId: executionId, attemptNumber },
          });
        plan = { kind: "offerings", eventId };
      } else {
        plan = { kind: "all" };
      }

      const parsed = loadInput();
      if (!parsed.ok) return await rollbackThen(fail("PERMANENT_FAILURE", parsed.errorCode));
      const data: InitialDataInput = parsed.value;

      const created: { events: string[]; entry_ticket_offerings: string[] } = {
        events: [],
        entry_ticket_offerings: [],
      };
      const auditEventIds: string[] = [];
      let parentEventId = plan.kind === "offerings" ? plan.eventId : undefined;
      for (const target of INITIAL_DATA_TARGETS) {
        // An existing Event is never touched; the input's `event` was validated but is not used.
        if (target.cardinality === "one" && plan.kind !== "all") continue;
        const rows = target.cardinality === "one" ? [data.event] : data.entry_ticket_offerings;
        for (const row of rows) {
          stage = "statement";
          const inserted = await withinDeadline(() =>
            insertRow(client, target, row, parentEventId),
          );
          if (target.cardinality === "one") parentEventId = inserted.id;
          if (target.cardinality === "one") created.events.push(inserted.publicRef);
          else created.entry_ticket_offerings.push(inserted.publicRef);
          stage = "audit";
          auditEventIds.push(
            await withinDeadline(() =>
              insertAuditEventReturningId(client, {
                auditEventType: "BUSINESS_EFFECT",
                actorType: "INFRASTRUCTURE_OPERATOR",
                actorRef,
                operationId: SEED_OPERATION_ID,
                operationExecutionId: executionId,
                targetType: target.auditTargetType,
                targetRef: inserted.publicRef,
                preconditionResult: "PASSED",
                auditResult: "COMMITTED",
                change: INITIAL_DATA_AUDIT_CHANGE.change({
                  afterState: target.afterState,
                  changedFields: inserted.fields,
                }),
              }),
            ),
          );
        }
      }
      stage = "statement";
      // Wall clock (SPEC-150 section 9), checked before COMMIT rather than only by a timer: a
      // synchronous callback can block the event loop past the deadline. Not yet sent: roll back.
      checkDeadline();
      const commitWaitMs = remainingMs();
      deadline.disarm();
      commitSent = true;
      const committed = client.query("COMMIT").then(() => "ok" as const);
      committed.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          committed,
          new Promise<"late">((resolve) => {
            timer = setTimeout(() => resolve("late"), commitWaitMs);
          }),
        ]);
        // COMMIT is sent and not acknowledged in time: the result is unknown, never a plain failure.
        if (settled === "late") return commitTimedOut();
        // The acknowledgement can be seen before the timer callback (an event loop blocked past the
        // deadline): the wall clock is checked on the monotonic clock too, as for the connection and
        // the migration lock. Acknowledged at or after the deadline is not acknowledged in time
        // (SPEC-150 section 9): the result is re-checked, never CREATED from the late acknowledgement.
        if (remainingMs() <= 0) return commitTimedOut();
      } finally {
        if (timer) clearTimeout(timer);
      }
      return {
        kind: "done",
        outcome: {
          outcome: "CREATED",
          operationExecutionId: executionId,
          attemptNumber,
          created,
          auditEventIds,
        },
      };
    } catch (error) {
      // A lost COMMIT seen at or after the deadline is a COMMIT not acknowledged in time, as the timer
      // would have made it: the same unknown result, with the timeout.
      if (commitSent && commitAcknowledgementUnknown(error))
        return remainingMs() <= 0 ? commitTimedOut() : { kind: "unknown" };
      // Abandoned at the deadline before COMMIT was sent: nothing can have been committed (REL-DB-005)
      // and the backend ends, so the transaction is rolled back. Not retried, like any deadline.
      if (deadline.abandoned()) {
        await abandonConnection(client);
        return deadlineFailure();
      }
      // Not committed: close the transaction. A connection that cannot even roll back is gone, which
      // proves nothing was committed (REL-DB-005): a temporary failure, to be run again. It is
      // abandoned, so that a connection that stopped answering does not keep the migration lock.
      // The transaction ends within its wall clock too (SPEC-150 section 9): ended past it, by the
      // timer or as measured on the monotonic clock once the error and the ROLLBACK are seen (an event
      // loop blocked past the deadline sees them before the timer callback), the attempt is ended by
      // its wall clock, whatever the error. The result never depends on which is seen first.
      const pastDeadline = () => deadline.abandoned() || remainingMs() <= 0;
      if (!(await succeedsWithin(client.query("ROLLBACK"), CLOSE_WAIT_MS))) {
        await abandonConnection(client);
        return pastDeadline()
          ? deadlineFailure()
          : fail("TEMPORARY_FAILURE", "DATABASE_TEMPORARY_FAILURE");
      }
      if (error instanceof DeadlineExceeded || pastDeadline()) return deadlineFailure();
      if (isDatabaseRetryable(error)) return { kind: "retry", code: error.code };
      const code = sqlState(error);
      const { failureClass, errorCode } = classifySeedFailure(
        stage,
        isSqlstate(code) ? code : undefined,
      );
      return fail(failureClass, errorCode);
    } finally {
      deadline.disarm();
    }
  };

  // A connection refused for its credentials, or none within the budget: the re-check cannot run.
  const reconnect = async (executionId: string): Promise<Client | undefined> => {
    try {
      return await connectWithinBudget(connect, connectionRetryLog(options.logger, executionId));
    } catch {
      return undefined;
    }
  };

  /**
   * DB-SEED-002 (1)-(4). Resolves undefined when the result cannot be determined (4). Each re-check
   * transaction has the same wall clock as a seed transaction (SPEC-150 section 9): a re-check that
   * cannot decide within it is rolled back, is not retried, and the result stays unknown. A connection
   * that stops answering is abandoned at that deadline. A retryable SQLSTATE is retried within its
   * budget, backoff included; a retried re-check transaction runs within what is left of that budget,
   * and a later SQLSTATE never extends a budget already applied.
   */
  const recheck = async (connection: Client, executionId: string): Promise<Recheck | undefined> => {
    const startedAt = performance.now();
    const elapsed = () => performance.now() - startedAt;
    let budgetLimitMs = Number.POSITIVE_INFINITY;
    // The SQLSTATE of the latest retry: the cause of the next attempt and of an exhaustion.
    let sqlstate: DatabaseRetryState | undefined;
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      if (n > 1)
        logRetry(options.logger, "attempted", {
          executionId,
          attemptNumber: n,
          cause: { unit: "recheck", sqlstate },
        });
      // A retried re-check whose wall clock is what is left of the budget: reaching it is exhaustion.
      const budgetBound = budgetLimitMs - elapsed() < recheckDeadlineMs;
      const deadline = transactionDeadline(
        connection,
        Math.min(recheckDeadlineMs, budgetLimitMs - elapsed()),
      );
      const { within, remainingMs } = deadline;
      const exhausted = () => {
        logRetry(options.logger, "exhausted", {
          executionId,
          attemptNumber: n,
          cause: { unit: "recheck", sqlstate },
        });
        return undefined;
      };
      // Ended by its wall clock (the timer or the monotonic clock): the timeout is logged, nothing is
      // decided, and reaching a budget-bound deadline is exhaustion too.
      const timedOut = () => {
        logTimeout(options.logger, {
          executionId,
          attemptNumber: n,
          unit: "recheck",
          durationMs: deadline.elapsedMs(),
          resultUnknown: true,
        });
        return budgetBound ? exhausted() : undefined;
      };
      try {
        await beginTransaction(connection);
        await within(() => connection.query(SEED_XACT_LOCK));
        const audit = await within(() =>
          connection.query(
            "SELECT audit_event_id, target_type, target_ref FROM app.audit_events WHERE operation_id = $1 AND operation_execution_id = $2",
            [SEED_OPERATION_ID, executionId],
          ),
        );
        let verdict: Recheck;
        if (audit.rows.length > 0) {
          const refs = (type: string) =>
            audit.rows
              .filter((row) => row.target_type === type)
              .map((row) => String(row.target_ref));
          verdict = {
            kind: "created",
            created: {
              events: refs("PUBLIC_CONTENT"),
              entry_ticket_offerings: refs("ENTRY_TICKET_OFFERING"),
            },
            auditEventIds: audit.rows.map((row) => String(row.audit_event_id)),
          };
        } else {
          // Another run may have completed meanwhile. An Event alone is not proof of success.
          let eventId: string | undefined;
          if (plan.kind === "offerings") eventId = plan.eventId;
          else {
            const eventIds = await within(() => readEventIds(connection));
            if (eventIds.length === 1) eventId = eventIds[0];
          }
          const target = eventId;
          verdict =
            target !== undefined && (await within(() => hasOfferings(connection, target)))
              ? { kind: "complete" }
              : { kind: "uncommitted" };
        }
        await connection.query("ROLLBACK");
        // The re-check transaction ends within its wall clock too (SPEC-150 section 9): a ROLLBACK
        // acknowledged at or after the deadline, seen before the timer callback (an event loop
        // blocked past it), decides nothing, like a re-check ended by its deadline.
        if (remainingMs() <= 0) return timedOut();
        return verdict;
      } catch (error) {
        if (deadline.abandoned()) {
          await abandonConnection(connection);
          return timedOut();
        }
        // As for the seed transaction: a re-check ended past its wall clock, by the timer or as
        // measured on the monotonic clock once the error and the ROLLBACK are seen, is ended by its
        // deadline whatever the error (never retried; reaching a budget-bound deadline is exhaustion).
        const pastDeadline = () => deadline.abandoned() || remainingMs() <= 0;
        const closed = await succeedsWithin(connection.query("ROLLBACK"), CLOSE_WAIT_MS);
        if (!closed) {
          await abandonConnection(connection);
          return pastDeadline() ? timedOut() : undefined;
        }
        if (error instanceof DeadlineExceeded || pastDeadline()) return timedOut();
        if (!isDatabaseRetryable(error)) return undefined;
        sqlstate = error.code;
        if (n >= MAX_ATTEMPTS) return exhausted();
        const policy = RETRY_POLICIES[error.code];
        budgetLimitMs = Math.min(budgetLimitMs, policy.maxElapsedMs);
        const delay = retryDelay(policy, Math.min(n, policy.maxAttempts - 1));
        // The backoff is part of the budget: a wait that would end past it is not started, and a wait
        // that ended late does not start another re-check transaction either.
        if (elapsed() + delay >= budgetLimitMs) return exhausted();
        // This transaction has ended (rolled back); the next one gets its own deadline.
        deadline.disarm();
        await sleep(delay);
        if (elapsed() >= budgetLimitMs) return exhausted();
      } finally {
        deadline.disarm();
      }
    }
    return undefined;
  };

  try {
    let attemptNumber = 0;
    let retries = 0;
    const budgetStartedAt = performance.now();
    // Time spent waiting for the migration lock is not part of the retry budget (SPEC-180 section 24).
    let lockWaitMs = 0;
    const budgetElapsedMs = () => performance.now() - budgetStartedAt - lockWaitMs;
    // The smallest elapsed budget of the retry classes applied so far (SPEC-150 section 11): a later
    // SQLSTATE with a longer budget does not extend it. No limit until the first retry.
    let budgetLimitMs = Number.POSITIVE_INFINITY;
    // The cause of the latest retry: its SQLSTATE, or none after an uncommitted re-check.
    let cause: RetryCause = { unit: "seed" };
    for (;;) {
      attemptNumber += 1;
      const executionId = randomUUID();
      if (attemptNumber > 1)
        logRetry(options.logger, "attempted", { executionId, attemptNumber, cause });
      // A retry whose wall clock is what is left of the budget: reaching it is exhaustion.
      const budgetBound = budgetLimitMs - budgetElapsedMs() < deadlineMs;
      const attempt = await attemptOnce(
        executionId,
        attemptNumber,
        Math.min(deadlineMs, budgetLimitMs - budgetElapsedMs()),
      );
      if (attempt.kind === "done") {
        if (budgetBound && attempt.deadlineHit)
          logRetry(options.logger, "exhausted", { executionId, attemptNumber, cause });
        return attempt.outcome;
      }

      if (attempt.kind === "retry") {
        retries += 1;
        cause = { unit: "seed", sqlstate: attempt.code };
        const policy = RETRY_POLICIES[attempt.code];
        const exhausted = () => {
          logRetry(options.logger, "exhausted", { executionId, attemptNumber, cause });
          return failedOutcome(
            executionId,
            attemptNumber,
            "TEMPORARY_FAILURE",
            "DATABASE_TEMPORARY_FAILURE",
          );
        };
        budgetLimitMs = Math.min(budgetLimitMs, policy.maxElapsedMs);
        if (attemptNumber >= MAX_ATTEMPTS || retries >= policy.maxAttempts) return exhausted();
        // The backoff is part of the budget (SPEC-150 section 11): a wait that would end past it is
        // not started, and the budget is checked again after the wait, which can end late. The next
        // attempt then runs within what is left of the budget.
        const delay = retryDelay(policy, retries);
        if (budgetElapsedMs() + delay >= budgetLimitMs) return exhausted();
        await sleep(delay);
        if (budgetElapsedMs() >= budgetLimitMs) return exhausted();
        continue;
      }

      // COMMIT was sent and its acknowledgement was lost: the result is unknown (REL-DB-006).
      const unknownAt = performance.now();
      const common = {
        is_retry: attemptNumber > 1,
        operation_id: SEED_OPERATION_ID,
        operation_execution_id: executionId,
        attempt_number: attemptNumber,
        provider: "NEON_DB",
      } as const;
      log({
        ...common,
        event_name: "reliability.unknown_result.opened",
        level: "WARN",
        result: "PENDING",
        failure_class: "UNKNOWN_RESULT",
        error_code: "COMMIT_RESULT_UNKNOWN",
      });
      const unknown: SeedOutcome = {
        outcome: "UNKNOWN_RESULT",
        operationExecutionId: executionId,
        attemptNumber,
        errorCode: "COMMIT_RESULT_UNKNOWN",
      };
      // Abandon the connection that lost the result, before the re-check and any retry. It may still
      // be alive (the deadline timer fired while COMMIT was in flight), and its session holds the
      // migration lock: a retry would wait for that lock. A late COMMIT that takes effect is found by
      // the re-check (1); an uncommitted one is retried (3).
      await abandonConnection(client);
      const reconnected = await reconnect(executionId);
      if (reconnected === undefined) return unknown;
      ownedConnection = reconnected;
      // The re-check reads only under the migration lock (INF-SEED-003, SPEC-180 section 24): a
      // migration that started after the lost session ended finishes first. While the session of the
      // lost COMMIT still lives it holds the lock too, so this also waits for that COMMIT to end. Not
      // acquired (the 60 second wait passed, the connection stopped answering and was abandoned, or
      // it failed): the re-check cannot run and
      // the result stays unknown (DB-SEED-002 (4)). The wait is not part of the retry budget.
      const lockStartedAt = performance.now();
      try {
        ownedLock = await acquireMigrationLock(
          reconnected,
          options.migrationLockDeadlineMs === undefined
            ? {}
            : { deadlineMs: options.migrationLockDeadlineMs },
        );
      } catch {
        return unknown;
      } finally {
        lockWaitMs += performance.now() - lockStartedAt;
      }
      const checked = await recheck(reconnected, executionId);
      if (checked === undefined) return unknown;
      const resolved = () => ({
        ...common,
        event_name: "reliability.unknown_result.resolved" as const,
        duration_ms: Math.round(performance.now() - unknownAt),
      });

      if (checked.kind === "created") {
        log({ ...resolved(), level: "INFO", result: "SUCCESS", failure_class: "SUCCESS" });
        return {
          outcome: "CREATED",
          operationExecutionId: executionId,
          attemptNumber,
          created: checked.created,
          auditEventIds: checked.auditEventIds,
        };
      }
      if (checked.kind === "complete") {
        log({ ...resolved(), level: "INFO", result: "NOOP", failure_class: null });
        return { outcome: "NOOP", operationExecutionId: executionId, attemptNumber };
      }
      // Not committed (DB-SEED-002 (3)): start over on the new connection, which already holds the
      // migration lock, with a new execution id, only within the REL-DB-001 retry budget (SPEC-150
      // section 11, 55P03 row: 4 attempts, 5 s from the first attempt). The time of the lost COMMIT,
      // the reconnect and the re-check counts against that budget; the migration lock wait does not.
      // Like any 55P03 retry it waits a full jitter backoff first; the wait is part of the budget, a
      // wait that would end past it is not started, and the budget is checked again after the wait.
      // The retry then runs within what is left of it, and a smaller budget already applied stays.
      const uncommittedPolicy = RETRY_POLICIES["55P03"];
      budgetLimitMs = Math.min(budgetLimitMs, uncommittedPolicy.maxElapsedMs);
      log({
        ...resolved(),
        level: "WARN",
        result: "FAILED",
        failure_class: "TEMPORARY_FAILURE",
      });
      cause = { unit: "seed" };
      const uncommittedExhausted = () => {
        logRetry(options.logger, "exhausted", { executionId, attemptNumber, cause });
        return failedOutcome(
          executionId,
          attemptNumber,
          "TEMPORARY_FAILURE",
          "DATABASE_TEMPORARY_FAILURE",
        );
      };
      retries += 1;
      if (attemptNumber >= MAX_ATTEMPTS || budgetElapsedMs() >= budgetLimitMs)
        return uncommittedExhausted();
      const delay = retryDelay(
        uncommittedPolicy,
        Math.min(retries, uncommittedPolicy.maxAttempts - 1),
      );
      if (budgetElapsedMs() + delay >= budgetLimitMs) return uncommittedExhausted();
      await sleep(delay);
      if (budgetElapsedMs() >= budgetLimitMs) return uncommittedExhausted();
      client = reconnected;
    }
  } finally {
    await closeOwned();
  }
}
