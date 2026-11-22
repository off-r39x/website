import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endConnection,
  outcomeExitCode,
  outcomeLogFields,
} from "../../packages/db/src/initial-data/seed.ts";
import {
  acquireMigrationLock,
  MigrationLockTimeoutError,
} from "../../packages/db/src/migration-lock.ts";
import {
  type CommitProxyMode,
  startCommitAcknowledgementDropProxy,
} from "../harness/db/commit-proxy.ts";
import { prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  buildInitialDataInput,
  connectAs,
  disallowedStatements,
  endQuietly,
  type InitialDataInput,
  insertedTables,
  type RecordedLog,
  resetInitialData,
  runSeed,
  SEED_ACTOR_REF,
  shape,
  snapshotSeededTables,
  waitUntil,
} from "../harness/db/initial-data.ts";

// PR-SEED C1: COMMIT whose result is unknown (SPEC-170 TST-SEED-006, Fault Point
// FP.DB.AFTER_COMMIT_SENT_BEFORE_ACK; SPEC-100 DB-SEED-002; SPEC-150 REL-DB-005..008; SPEC-160 OBS-DB-004).
// The re-check runs through the library function: the commit proxy cannot carry TLS, so the CLI (which
// requires TLS) cannot be driven into UNKNOWN_RESULT here. Real PostgreSQL 17, synthetic values only.

const url = process.env.TEST_DATABASE_URL;
if (!url || !process.env.TEST_DATABASE_CA)
  throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

// Lock-budget scenarios wait several seconds by design (SPEC-150 section 11); a stall must still fail.
vi.setConfig({ testTimeout: 60_000 });

const OPENED = "reliability.unknown_result.opened";
const RESOLVED = "reliability.unknown_result.resolved";
const RETRY_ATTEMPTED = "reliability.retry.attempted";
const SEED_TABLES = ["app.audit_events", "app.entry_ticket_offerings", "app.events"];
// A session of this database waiting for an advisory lock: the re-check connection, which takes the
// migration lock and then the seed xact lock (both still held by the original session while its
// COMMIT is in progress).
const LOCK_WAIT_SQL = `SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()
    AND wait_event_type = 'Lock' AND wait_event = 'advisory'
    AND query ILIKE '%pg_advisory%lock%'`;
const MIGRATION_LOCK_WAIT_SQL = `SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()
    AND wait_event_type = 'Lock' AND wait_event = 'advisory'
    AND query ILIKE '%r39x:schema-migration%'`;
const MIGRATION_LOCK = /pg_advisory_lock\(hashtext\('r39x:schema-migration'\)\)/i;
const AUDIT_RECHECK = /from app\.audit_events where operation_id/i;

let admin: Client;
beforeAll(async () => {
  admin = new Client({ connectionString: url });
  await admin.connect();
  await prepareFoundationDatabase(admin);
});
afterAll(async () => {
  await admin?.end();
});
beforeEach(async () => {
  await resetInitialData(admin);
});

const events = async () => (await admin.query("SELECT * FROM app.events ORDER BY id")).rows;
const offerings = async () =>
  (await admin.query("SELECT * FROM app.entry_ticket_offerings ORDER BY id")).rows;
const audits = async () => (await admin.query("SELECT * FROM app.audit_events ORDER BY id")).rows;
const counts = async () => ({
  events: (await events()).length,
  offerings: (await offerings()).length,
  audits: (await audits()).length,
});
const named = (logs: RecordedLog[], name: string) => logs.filter((log) => log.event_name === name);

// SPEC-160 section 22: a resolved record carries the elapsed time of the unknown result.
function expectDuration(record: RecordedLog | undefined) {
  const duration = record?.duration_ms;
  expect(Number.isInteger(duration), "duration_ms is an integer").toBe(true);
  expect(duration as number).toBeGreaterThanOrEqual(0);
}

// SPEC-160 section 22: the second and later seed transactions announce themselves as retries.
function expectRetryAttempted(logs: RecordedLog[], executionId: string | undefined) {
  const attempted = named(logs, RETRY_ATTEMPTED);
  expect(attempted).toHaveLength(1);
  expect(attempted[0]).toMatchObject({
    is_retry: true,
    operation_id: "PROVISION.INITIAL_DATA_SEED",
    operation_execution_id: executionId,
  });
  expect(attempted[0]?.attempt_number as number).toBeGreaterThanOrEqual(2);
}

async function insertManualEvent(): Promise<string> {
  return (
    await admin.query(
      "INSERT INTO app.events (name) VALUES ('合成データ 手動イベント') RETURNING id::text",
    )
  ).rows[0].id;
}

/** Seed whose original connection goes through the fault proxy; re-check and retries connect directly. */
async function seedThroughProxy(
  mode: CommitProxyMode,
  options: {
    input?: InitialDataInput;
    connect?: (wrap: <T extends Client>(client: T) => T) => Promise<Client>;
    statements?: string[];
    logs?: RecordedLog[];
    transactionDeadlineMs?: number;
    recheckDeadlineMs?: number;
    migrationLockDeadlineMs?: number;
    delayMs?: number;
  } = {},
) {
  const proxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
    mode,
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
  });
  const statements = options.statements ?? [];
  const logs = options.logs ?? [];
  try {
    const run = await runSeed({
      input: options.input ?? buildInitialDataInput(),
      openMain: () => connectAs("app_migrator", proxy.url),
      connect: options.connect,
      statements,
      logs,
      transactionDeadlineMs: options.transactionDeadlineMs,
      recheckDeadlineMs: options.recheckDeadlineMs,
      migrationLockDeadlineMs: options.migrationLockDeadlineMs,
    });
    return { run, statements, logs, fired: proxy.fired() };
  } finally {
    await proxy.close();
  }
}

describe("TC-TST-SEED-006-001 COMMIT took effect, acknowledgement lost (DB-SEED-002 (1), REL-DB-006, REL-DB-007, OBS-DB-004)", () => {
  it("TC-TST-SEED-006-001 the re-check finds this run's Audit Event: CREATED, one set of rows, opened then resolved(SUCCESS)", async () => {
    const { run, logs, fired } = await seedThroughProxy("drop_ack");
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("CREATED");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    const written = await audits();
    expect(new Set(written.map((row) => row.operation_execution_id))).toEqual(
      new Set([outcome.operationExecutionId]),
    );
    expect([...(outcome.auditEventIds ?? [])].sort()).toEqual(
      written.map((row) => row.audit_event_id as string).sort(),
    );
    const [event] = await events();
    expect(outcome.created?.events).toEqual([event.public_ref]);
    expect([...(outcome.created?.entry_ticket_offerings ?? [])].sort()).toEqual(
      (await offerings()).map((row) => row.public_ref as string).sort(),
    );
    const opened = named(logs, OPENED);
    const resolved = named(logs, RESOLVED);
    expect(opened).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      level: "WARN",
      result: "PENDING",
      failure_class: "UNKNOWN_RESULT",
      operation_id: "PROVISION.INITIAL_DATA_SEED",
      operation_execution_id: outcome.operationExecutionId,
    });
    expect(resolved[0]).toMatchObject({ result: "SUCCESS" });
    expectDuration(resolved[0]);
    expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
    expect(logs.indexOf(opened[0] as RecordedLog)).toBeLessThan(
      logs.indexOf(resolved[0] as RecordedLog),
    );
  });
});

describe("TC-TST-SEED-006-002 another run created the rows meanwhile (DB-SEED-002 (2), REL-DB-008)", () => {
  it("TC-TST-SEED-006-002 uncommitted here, complete elsewhere: NOOP, the other run's rows untouched, no Audit Event of ours", async () => {
    const ours = buildInitialDataInput();
    const theirs = buildInitialDataInput();
    let other: Awaited<ReturnType<typeof runSeed>> | undefined;
    let connects = 0;
    const { run, logs, fired } = await seedThroughProxy("drop_request", {
      input: ours,
      connect: async (wrap) => {
        connects += 1;
        if (connects === 1) {
          // Before the re-check connection is handed back, a different run completes its seed.
          other = await runSeed({ input: theirs, actorRef: "gha:example-repo:other" });
        }
        return wrap(await connectAs("app_migrator"));
      },
    });
    expect(fired).toBe(1);
    expect(shape(other?.outcome).outcome).toBe("CREATED");
    expect(shape(run.outcome).outcome).toBe("NOOP");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    const [event] = await events();
    expect(event.name).toBe(theirs.event.name);
    expect(event.name).not.toBe(ours.event.name);
    const written = await audits();
    expect(new Set(written.map((row) => row.operation_execution_id))).toEqual(
      new Set([shape(other?.outcome).operationExecutionId]),
    );
    expect(new Set(written.map((row) => row.actor_ref))).toEqual(
      new Set(["gha:example-repo:other"]),
    );
    expect(named(logs, OPENED)).toHaveLength(1);
    expect(named(logs, RESOLVED)[0]).toMatchObject({ result: "NOOP" });
    expectDuration(named(logs, RESOLVED)[0]);
  });
});

describe("TC-TST-SEED-006-003 COMMIT never took effect: re-check, then retry (DB-SEED-002 (3), REL-DB-005, REL-DB-006)", () => {
  it("TC-TST-SEED-006-003 the retry runs on a fresh connection with a fresh execution id and creates one set", async () => {
    const statements: string[] = [];
    const { run, logs, fired } = await seedThroughProxy("drop_request", { statements });
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("CREATED");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    const opened = named(logs, OPENED);
    expect(opened).toHaveLength(1);
    const firstAttemptId = opened[0]?.operation_execution_id as string;
    expect(firstAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.operationExecutionId).not.toBe(firstAttemptId);
    const written = await audits();
    expect(new Set(written.map((row) => row.operation_execution_id))).toEqual(
      new Set([outcome.operationExecutionId]),
    );
    expect(written.some((row) => row.operation_execution_id === firstAttemptId)).toBe(false);
    expect(named(logs, RESOLVED)[0]).toMatchObject({
      result: "FAILED",
      failure_class: "TEMPORARY_FAILURE",
    });
    expectDuration(named(logs, RESOLVED)[0]);
    expectRetryAttempted(logs, outcome.operationExecutionId);
    // The Event INSERT was issued twice in total (attempt 1 on the lost connection, attempt 2 on the new
    // one), and the migration lock was taken again on the new connection (INF-SEED-003).
    expect(insertedTables(statements).filter((table) => table === "app.events")).toHaveLength(2);
    expect(
      statements.filter((text) =>
        /pg_advisory_lock\(hashtext\('r39x:schema-migration'\)\)/i.test(text),
      ),
    ).toHaveLength(2);
    expect(disallowedStatements(statements)).toEqual([]);
  });
});

describe("TC-TST-SEED-006-004 Event exists, only Offerings were being created (DB-SEED-002 (3-1))", () => {
  it("TC-TST-SEED-006-004 an existing Event is not proof of success: 0 Offerings means uncommitted, so retry", async () => {
    const eventId = await insertManualEvent();
    const eventBefore = (await snapshotSeededTables(admin)).events;
    const { run, logs, fired } = await seedThroughProxy("drop_request");
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("CREATED");
    expect(outcome.created?.events).toEqual([]);
    expect(outcome.created?.entry_ticket_offerings).toHaveLength(2);
    expect((await snapshotSeededTables(admin)).events).toEqual(eventBefore);
    const rows = await offerings();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.event_id === eventId)).toBe(true);
    const written = await audits();
    expect(written).toHaveLength(2);
    expect(written.every((row) => row.target_type === "ENTRY_TICKET_OFFERING")).toBe(true);
    expect(named(logs, RESOLVED)[0]).toMatchObject({
      result: "FAILED",
      failure_class: "TEMPORARY_FAILURE",
    });
    expectRetryAttempted(logs, outcome.operationExecutionId);
  });
});

describe("TC-TST-SEED-006-005 the re-check starts while the original COMMIT is in progress (DB-SEED-002 (3-2), REL-DB-006)", () => {
  it("TC-TST-SEED-006-005 the re-check waits on the original session's locks, then sees the committed rows: CREATED, not a false uncommitted", async () => {
    const proxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "hold_request",
    });
    const logs: RecordedLog[] = [];
    const statements: string[] = [];
    const seeding = runSeed({
      input: buildInitialDataInput(),
      openMain: () => connectAs("app_migrator", proxy.url),
      statements,
      logs,
    });
    let run: Awaited<typeof seeding>;
    try {
      try {
        await waitUntil(async () => (await admin.query(LOCK_WAIT_SQL)).rows[0].n > 0, {
          label: "the re-check connection waiting for the original session's advisory locks",
        });
        expect(proxy.fired()).toBe(1);
        // The original transaction is still open: nothing is visible yet.
        expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
      } finally {
        await proxy.releaseCommit();
      }
      run = await seeding;
    } finally {
      await seeding.catch(() => {});
      await proxy.close();
    }
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("CREATED");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    const opened = named(logs, OPENED)[0];
    expect(opened?.operation_execution_id).toBe(outcome.operationExecutionId);
    const written = await audits();
    expect(new Set(written.map((row) => row.operation_execution_id))).toEqual(
      new Set([outcome.operationExecutionId]),
    );
    expect(named(logs, RESOLVED)[0]).toMatchObject({ result: "SUCCESS" });
    expectDuration(named(logs, RESOLVED)[0]);
    expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
  });
});

/** (a) COMMIT succeeded but no new connection can be made for the re-check. */
async function connectionFailureScenario() {
  let attempts = 0;
  const result = await seedThroughProxy("drop_ack", {
    connect: async () => {
      attempts += 1;
      throw new Error("synthetic connection failure");
    },
  });
  return { ...result, attempts };
}

/** (b) COMMIT never happened and another session holds the seed xact lock beyond the retry budget. */
async function lockHeldScenario() {
  const holder = new Client({ connectionString: url });
  await holder.connect();
  let held = false;
  try {
    const result = await seedThroughProxy("drop_request", {
      connect: async (wrap) => {
        if (!held) {
          held = true;
          // Waits for the dead original backend to release its lock, then holds it for the whole re-check.
          await holder.query("BEGIN");
          await holder.query("SELECT pg_advisory_xact_lock(hashtext('app:initial-data-seed'))");
        }
        return wrap(await connectAs("app_migrator"));
      },
    });
    return result;
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await endQuietly(holder);
  }
}

describe("TC-TST-SEED-006-006 the re-check also fails (DB-SEED-002 (4), INF-SEED-004, OBS-AUD-014, REL-DB-007)", () => {
  it("TC-TST-SEED-006-006 (a) no connection for the re-check: UNKNOWN_RESULT, exit code 3, committed rows and Audit Events stay", async () => {
    const { run, logs, statements, attempts, fired } = await connectionFailureScenario();
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("UNKNOWN_RESULT");
    expect(outcome.errorCode).toBe("COMMIT_RESULT_UNKNOWN");
    expect(outcomeExitCode(run.outcome as never)).toBe(3);
    expect(outcomeLogFields(run.outcome as never)).toMatchObject({
      result: "PENDING",
      failure_class: "UNKNOWN_RESULT",
      level: "WARN",
    });
    // SPEC-150 §11 temporary DB connection acquisition: 3 connection attempts.
    expect(attempts).toBe(3);
    // The committed rows and Audit Events are neither deleted nor repaired, and nothing is added.
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    expect(named(logs, OPENED)).toHaveLength(1);
    expect(named(logs, OPENED)[0]).toMatchObject({
      result: "PENDING",
      failure_class: "UNKNOWN_RESULT",
    });
    expect(insertedTables(statements).every((table) => SEED_TABLES.includes(table))).toBe(true);
    // Only the original attempt's INSERTs exist: no second Event, no Review Case, no extra Audit Event.
    expect(insertedTables(statements).filter((table) => table === "app.events")).toHaveLength(1);
    expect(insertedTables(statements).filter((table) => table === "app.audit_events")).toHaveLength(
      3,
    );
  });

  it("TC-TST-SEED-006-006 (b) the xact lock stays held past the budget: UNKNOWN_RESULT, nothing created, no extra Audit Event", async () => {
    const { run, logs, statements, fired } = await lockHeldScenario();
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("UNKNOWN_RESULT");
    expect(outcome.errorCode).toBe("COMMIT_RESULT_UNKNOWN");
    expect(outcomeExitCode(run.outcome as never)).toBe(3);
    // The COMMIT was never sent, so the lost transaction left nothing behind either.
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
    expect(named(logs, OPENED)).toHaveLength(1);
    expect(insertedTables(statements).every((table) => SEED_TABLES.includes(table))).toBe(true);
    expect(insertedTables(statements).filter((table) => table === "app.events")).toHaveLength(1);
  });
});

describe("TC-TST-SEED-006-007 re-running after recovery (INF-SEED-004, REL-DB-007)", () => {
  it("TC-TST-SEED-006-007 (a) after an UNKNOWN_RESULT whose COMMIT had taken effect, the same command is NOOP and nothing duplicates", async () => {
    expect(shape((await connectionFailureScenario()).run.outcome).outcome).toBe("UNKNOWN_RESULT");
    const before = await snapshotSeededTables(admin);
    const rerun = await runSeed({ input: buildInitialDataInput(), actorRef: SEED_ACTOR_REF });
    expect(shape(rerun.outcome).outcome).toBe("NOOP");
    expect(rerun.reads()).toBe(0);
    expect(await snapshotSeededTables(admin)).toEqual(before);
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
  });

  it("TC-TST-SEED-006-007 (b) after an UNKNOWN_RESULT with nothing committed, the same command creates one set, without duplicates", async () => {
    expect(shape((await lockHeldScenario()).run.outcome).outcome).toBe("UNKNOWN_RESULT");
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
    const rerun = await runSeed({ input: buildInitialDataInput() });
    expect(shape(rerun.outcome).outcome).toBe("CREATED");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    const again = await runSeed({ input: buildInitialDataInput() });
    expect(shape(again.outcome).outcome).toBe("NOOP");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
  });
});

describe("TC-TST-SEED-006-008 the transaction deadline passes while COMMIT is in flight (plan v1.2 Q-2, DB-SEED-002, REL-DB-005, REL-DB-006)", () => {
  // The command's own deadline timer (transactionDeadlineMs) fires after COMMIT was sent and before its
  // acknowledgement arrives: the result is unknown, and the re-check decides.
  it("TC-TST-SEED-006-008 (a) the COMMIT took effect: the re-check finds this run's Audit Events, CREATED, one set of rows", async () => {
    const { run, logs, fired } = await seedThroughProxy("delay_ack", {
      transactionDeadlineMs: 1000,
      delayMs: 3000,
    });
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("CREATED");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    expect(new Set((await audits()).map((row) => row.operation_execution_id))).toEqual(
      new Set([outcome.operationExecutionId]),
    );
    const opened = named(logs, OPENED);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      result: "PENDING",
      failure_class: "UNKNOWN_RESULT",
      operation_execution_id: outcome.operationExecutionId,
    });
    expect(named(logs, RESOLVED)[0]).toMatchObject({ result: "SUCCESS" });
    expectDuration(named(logs, RESOLVED)[0]);
    expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
  });

  it("TC-TST-SEED-006-008 (b) the COMMIT never took effect (the session stays open): re-check, retry and CREATED without waiting for the migration lock timeout", async () => {
    const startedAt = Date.now();
    const { run, logs, fired } = await seedThroughProxy("rollback_for_commit", {
      transactionDeadlineMs: 1000,
      delayMs: 4000,
    });
    const elapsedMs = Date.now() - startedAt;
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome.outcome).toBe("CREATED");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    const opened = named(logs, OPENED);
    expect(opened).toHaveLength(1);
    const firstAttemptId = opened[0]?.operation_execution_id as string;
    expect(outcome.operationExecutionId).not.toBe(firstAttemptId);
    expect(new Set((await audits()).map((row) => row.operation_execution_id))).toEqual(
      new Set([outcome.operationExecutionId]),
    );
    expect(named(logs, RESOLVED)[0]).toMatchObject({
      result: "FAILED",
      failure_class: "TEMPORARY_FAILURE",
    });
    expectDuration(named(logs, RESOLVED)[0]);
    expectRetryAttempted(logs, outcome.operationExecutionId);
    // The abandoned session must not keep the migration lock: the retry may not wait for the 60 second
    // lock timeout of INF-DB-008.
    expect(elapsedMs).toBeLessThan(15_000);
  }, 120_000);
});

describe("TC-TST-SEED-006-009 the re-check runs under the migration lock (INF-SEED-003, DB-SEED-002, SPEC-180 section 24)", () => {
  it("TC-TST-SEED-006-009 while a migration holds the lock, the re-check waits; it reads only after taking the lock, then CREATED", async () => {
    const migration = new Client({ connectionString: url });
    await migration.connect();
    const statements: string[] = [];
    let migrationHeld = false;
    let settled = false;
    let seeding: ReturnType<typeof seedThroughProxy> | undefined;
    try {
      seeding = seedThroughProxy("drop_ack", {
        statements,
        connect: async (wrap) => {
          if (!migrationHeld) {
            migrationHeld = true;
            // A migration job takes the lock as soon as the original session is gone.
            await migration.query("SELECT pg_advisory_lock(hashtext('r39x:schema-migration'))");
          }
          return wrap(await connectAs("app_migrator"));
        },
      });
      void seeding.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitUntil(async () => (await admin.query(MIGRATION_LOCK_WAIT_SQL)).rows[0].n > 0, {
        label: "the re-check connection waiting for the migration lock",
      });
      // The re-check has not read anything and has not decided while the migration runs.
      expect(statements.filter((text) => AUDIT_RECHECK.test(text))).toEqual([]);
      expect(settled).toBe(false);
    } finally {
      await migration.query("SELECT pg_advisory_unlock(hashtext('r39x:schema-migration'))");
      await endQuietly(migration);
    }
    const { run, fired } = await (seeding as ReturnType<typeof seedThroughProxy>);
    expect(fired).toBe(1);
    expect(shape(run.outcome).outcome).toBe("CREATED");
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
    // On the re-check connection, the migration lock comes before the re-check's first read.
    const lockAt = statements.findLastIndex((text) => MIGRATION_LOCK.test(text));
    const recheckAt = statements.findIndex((text) => AUDIT_RECHECK.test(text));
    expect(recheckAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(recheckAt);
    expect(statements.filter((text) => MIGRATION_LOCK.test(text))).toHaveLength(2);
    expect(disallowedStatements(statements)).toEqual([]);
  });
});

describe("TC-TST-SEED-006-010 uncommitted after the retry budget is spent (DB-SEED-002 (3), REL-DB-001, SPEC-150 section 11)", () => {
  it("TC-TST-SEED-006-010 the COMMIT wait alone outlasts the 5 second budget: the re-check finds it uncommitted, FAILED without a retry", async () => {
    const statements: string[] = [];
    // The deadline (5.2 s) is longer than the 55P03 retry budget (5 s): by the time the re-check
    // decides "uncommitted", the budget measured from the first attempt is already spent.
    const { run, logs, fired } = await seedThroughProxy("rollback_for_commit", {
      statements,
      transactionDeadlineMs: 5200,
      delayMs: 8000,
    });
    const outcome = shape(run.outcome);
    expect(fired).toBe(1);
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(outcomeExitCode(run.outcome as never)).toBe(2);
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
    expect(named(logs, OPENED)).toHaveLength(1);
    expect(named(logs, RESOLVED)[0]).toMatchObject({
      result: "FAILED",
      failure_class: "TEMPORARY_FAILURE",
    });
    // No second seed transaction: one Event INSERT in total, and no retry record.
    expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
    expect(insertedTables(statements).filter((table) => table === "app.events")).toHaveLength(1);
    expect(disallowedStatements(statements)).toEqual([]);
  }, 120_000);
});

describe("TC-TST-SEED-006-011 the re-check transaction runs within the transaction deadline (DB-SEED-002 (4), SPEC-150 section 9, INF-SEED-004)", () => {
  it("TC-TST-SEED-006-011 a re-check read that waits past the deadline (but within the lock timeout) ends in UNKNOWN_RESULT, not a late verdict", async () => {
    const holder = new Client({ connectionString: url });
    await holder.connect();
    const statements: string[] = [];
    let held = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      const { run, logs, fired } = await seedThroughProxy("drop_request", {
        statements,
        // 600 ms per re-check transaction; its Audit Event read waits up to 900 ms, shorter than the
        // 1 s lock timeout and the 5 s statement timeout, so only the deadline can stop it. The seed
        // transaction keeps the default deadline, so that it reaches COMMIT on a slow runner too.
        recheckDeadlineMs: 600,
        connect: async (wrap) => {
          if (!held) {
            held = true;
            await holder.query("BEGIN");
            await holder.query("LOCK TABLE app.audit_events IN ACCESS EXCLUSIVE MODE");
            release = setTimeout(() => {
              void holder.query("ROLLBACK").catch(() => {});
            }, 900);
          }
          return wrap(await connectAs("app_migrator"));
        },
      });
      const outcome = shape(run.outcome);
      expect(fired).toBe(1);
      expect(outcome.outcome).toBe("UNKNOWN_RESULT");
      expect(outcome.errorCode).toBe("COMMIT_RESULT_UNKNOWN");
      expect(outcomeExitCode(run.outcome as never)).toBe(3);
      // The re-check did start its read, and decided nothing from it.
      expect(statements.some((text) => AUDIT_RECHECK.test(text))).toBe(true);
      expect(named(logs, OPENED)).toHaveLength(1);
      expect(named(logs, RESOLVED)).toHaveLength(0);
      expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
      expect(insertedTables(statements).filter((table) => table === "app.events")).toHaveLength(1);
      expect(disallowedStatements(statements)).toEqual([]);
    } finally {
      if (release) clearTimeout(release);
      await holder.query("ROLLBACK").catch(() => {});
      await endQuietly(holder);
    }
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
  });
});

// A session of this database that holds the migration lock (granted), other than this one.
const MIGRATION_LOCK_HELD_SQL = `SELECT count(*)::int AS n FROM pg_locks l
  JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.granted AND a.datname = current_database()
    AND a.pid <> pg_backend_pid()`;
const EVENT_COUNT_READ = /FROM app\.events ORDER BY id/i;
// The command must settle on its own well before this; a hang is reported, not waited out.
const SETTLE_LIMIT_MS = 10_000;

async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("TC-TST-SEED-003-009 the network stops answering inside the seed transaction (FP.DB.INSIDE_STATEMENT, SPEC-150 section 9, REL-DB-005)", () => {
  it("TC-TST-SEED-003-009 the deadline is kept by the command itself: the connection is abandoned, FAILED(TEMPORARY), the migration lock goes, nothing is created", async () => {
    const proxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "stall_statement",
      stallOn: EVENT_COUNT_READ,
    });
    const statements: string[] = [];
    const logs: RecordedLog[] = [];
    const startedAt = Date.now();
    try {
      const seeding = runSeed({
        input: buildInitialDataInput(),
        openMain: () => connectAs("app_migrator", proxy.url),
        statements,
        logs,
        transactionDeadlineMs: 800,
      });
      const settled = await settlesWithin(seeding, SETTLE_LIMIT_MS);
      expect(settled, "the command settles by itself after the deadline").not.toBe("hung");
      if (settled === "hung") return;
      expect(Date.now() - startedAt).toBeLessThan(SETTLE_LIMIT_MS);
      expect(proxy.fired()).toBe(1);
      expect(shape(settled.outcome)).toMatchObject({
        outcome: "FAILED",
        failureClass: "TEMPORARY_FAILURE",
        errorCode: "DATABASE_TEMPORARY_FAILURE",
      });
      expect(outcomeExitCode(settled.outcome as never)).toBe(2);
      // Not a COMMIT result: nothing was sent after the stalled read, and nothing is retried.
      expect(named(logs, OPENED)).toHaveLength(0);
      expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
      expect(insertedTables(statements)).toEqual([]);
      expect(statements.some((text) => /^\s*COMMIT/i.test(text))).toBe(false);
      expect(settled.reads()).toBe(0);
    } finally {
      await proxy.close();
    }
    // The abandoned session ends, and with it the migration lock it held.
    await waitUntil(async () => (await admin.query(MIGRATION_LOCK_HELD_SQL)).rows[0].n === 0, {
      label: "the abandoned session releasing the migration lock",
    });
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
  });
});

describe("TC-TST-SEED-006-012 the network stops answering inside the re-check (FP.DB.INSIDE_STATEMENT, DB-SEED-002 (4), SPEC-150 section 9)", () => {
  it("TC-TST-SEED-006-012 the re-check connection is abandoned at the deadline: UNKNOWN_RESULT, no verdict, no retry", async () => {
    const recheckProxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "stall_statement",
      stallOn: AUDIT_RECHECK,
    });
    const statements: string[] = [];
    const logs: RecordedLog[] = [];
    const startedAt = Date.now();
    try {
      const seeding = seedThroughProxy("drop_request", {
        statements,
        logs,
        // Only the re-check transaction is shortened: the seed transaction must reach COMMIT.
        recheckDeadlineMs: 800,
        connect: async (wrap) => wrap(await connectAs("app_migrator", recheckProxy.url)),
      });
      const settled = await settlesWithin(seeding, SETTLE_LIMIT_MS);
      expect(settled, "the command settles by itself after the deadline").not.toBe("hung");
      if (settled === "hung") return;
      expect(Date.now() - startedAt).toBeLessThan(SETTLE_LIMIT_MS);
      expect(settled.fired).toBe(1);
      expect(recheckProxy.fired()).toBe(1);
      const outcome = shape(settled.run.outcome);
      expect(outcome.outcome).toBe("UNKNOWN_RESULT");
      expect(outcome.errorCode).toBe("COMMIT_RESULT_UNKNOWN");
      expect(outcomeExitCode(settled.run.outcome as never)).toBe(3);
      expect(named(logs, OPENED)).toHaveLength(1);
      expect(named(logs, RESOLVED)).toHaveLength(0);
      expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
      expect(insertedTables(statements).filter((table) => table === "app.events")).toHaveLength(1);
      expect(disallowedStatements(statements)).toEqual([]);
    } finally {
      await recheckProxy.close();
    }
    await waitUntil(async () => (await admin.query(MIGRATION_LOCK_HELD_SQL)).rows[0].n === 0, {
      label: "the abandoned re-check session releasing the migration lock",
    });
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
  });
});

const MIGRATION_LOCK_STATEMENT = /pg_advisory_lock\(hashtext\('r39x:schema-migration'\)\)/i;

describe("TC-TST-SEED-003-011 the network stops answering while the migration lock is acquired (FP.DB.INSIDE_STATEMENT, SPEC-180 section 24, INF-SEED-003)", () => {
  async function acquireThroughStall(stallOn: RegExp, forwardStalled: boolean) {
    const proxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "stall_statement",
      stallOn,
      forwardStalled,
    });
    const client = await connectAs("app_migrator", proxy.url);
    client.on("error", () => {});
    const startedAt = Date.now();
    try {
      const acquiring = acquireMigrationLock(client, { deadlineMs: 800 }).then(
        () => "acquired" as const,
        (error: unknown) => error,
      );
      const settled = await settlesWithin(acquiring, SETTLE_LIMIT_MS);
      return { settled, elapsedMs: Date.now() - startedAt, fired: proxy.fired() };
    } finally {
      await endQuietly(client);
      await proxy.close();
    }
  }

  it("TC-TST-SEED-003-011 (a) a setting statement before the lock gets no answer: MigrationLockTimeoutError at the deadline, not a hang", async () => {
    const { settled, elapsedMs, fired } = await acquireThroughStall(/SET lock_timeout/i, false);
    expect(settled, "the acquisition settles by itself after the deadline").not.toBe("hung");
    expect(settled).toBeInstanceOf(MigrationLockTimeoutError);
    expect(elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
    expect(fired).toBe(1);
  });

  it("TC-TST-SEED-003-011 (b) the server grants the lock but the answer is lost: MigrationLockTimeoutError, and no session keeps the lock", async () => {
    const { settled, elapsedMs, fired } = await acquireThroughStall(MIGRATION_LOCK_STATEMENT, true);
    expect(settled, "the acquisition settles by itself after the deadline").not.toBe("hung");
    expect(settled).toBeInstanceOf(MigrationLockTimeoutError);
    expect(elapsedMs).toBeLessThan(SETTLE_LIMIT_MS);
    expect(fired).toBe(1);
    await waitUntil(async () => (await admin.query(MIGRATION_LOCK_HELD_SQL)).rows[0].n === 0, {
      label: "the abandoned session releasing the migration lock",
    });
  });
});

describe("TC-TST-SEED-006-014 the network stops answering while the re-check takes the migration lock (FP.DB.INSIDE_STATEMENT, DB-SEED-002 (4), INF-SEED-003)", () => {
  it("TC-TST-SEED-006-014 the lock is granted but its answer is lost: the re-check connection is abandoned, UNKNOWN_RESULT, no session keeps the lock", async () => {
    const recheckProxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "stall_statement",
      stallOn: MIGRATION_LOCK_STATEMENT,
      forwardStalled: true,
    });
    const statements: string[] = [];
    const logs: RecordedLog[] = [];
    const startedAt = Date.now();
    try {
      const seeding = seedThroughProxy("drop_request", {
        statements,
        logs,
        migrationLockDeadlineMs: 800,
        connect: async (wrap) => wrap(await connectAs("app_migrator", recheckProxy.url)),
      });
      const settled = await settlesWithin(seeding, SETTLE_LIMIT_MS);
      expect(settled, "the command settles by itself after the deadline").not.toBe("hung");
      if (settled === "hung") return;
      expect(Date.now() - startedAt).toBeLessThan(SETTLE_LIMIT_MS);
      expect(settled.fired).toBe(1);
      expect(recheckProxy.fired()).toBe(1);
      const outcome = shape(settled.run.outcome);
      expect(outcome.outcome).toBe("UNKNOWN_RESULT");
      expect(outcome.errorCode).toBe("COMMIT_RESULT_UNKNOWN");
      expect(outcomeExitCode(settled.run.outcome as never)).toBe(3);
      // The re-check never read anything: it could not take the lock.
      expect(statements.some((text) => AUDIT_RECHECK.test(text))).toBe(false);
      expect(named(logs, OPENED)).toHaveLength(1);
      expect(named(logs, RESOLVED)).toHaveLength(0);
      expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
      expect(disallowedStatements(statements)).toEqual([]);
    } finally {
      await recheckProxy.close();
    }
    await waitUntil(async () => (await admin.query(MIGRATION_LOCK_HELD_SQL)).rows[0].n === 0, {
      label: "the abandoned re-check session releasing the migration lock",
    });
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
  });
});

// pg keeps the socket on a private field; the tests only read whether it is gone.
const socketOf = (client: Client) =>
  (client as unknown as { connection: { stream: { destroyed: boolean } } }).connection.stream;
const MIGRATOR_SESSIONS_SQL = `SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename = 'app_migrator'`;

describe("TC-TST-SEED-003-012 ending a connection whose peer stops answering after the last answer (FP.DB.INSIDE_STATEMENT, INF-SEED-004, REL-DB-005)", () => {
  it("TC-TST-SEED-003-012 the Terminate and the FIN get no answer: endConnection destroys the socket after its wait, and the session ends", async () => {
    const proxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "stall_statement",
      stallOnTerminate: true,
    });
    try {
      const client = await connectAs("app_migrator", proxy.url);
      const lock = await acquireMigrationLock(client);
      // The unlock is answered: only what comes after it is lost.
      expect(await lock.release()).toBe(true);
      const startedAt = Date.now();
      const settled = await settlesWithin(endConnection(client, 500), SETTLE_LIMIT_MS);
      expect(settled, "endConnection settles by itself").not.toBe("hung");
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(proxy.fired()).toBe(1);
      // The socket no longer keeps the process alive (the command can exit).
      expect(socketOf(client).destroyed).toBe(true);
    } finally {
      await proxy.close();
    }
    await waitUntil(async () => (await admin.query(MIGRATOR_SESSIONS_SQL)).rows[0].n === 0, {
      label: "the stalled session ending",
    });
  });
});

describe("TC-TST-SEED-006-015 the re-check connection's peer stops answering after the unlock (FP.DB.INSIDE_STATEMENT, DB-SEED-002 (1), INF-SEED-004)", () => {
  it("TC-TST-SEED-006-015 the seed still returns CREATED and the re-check socket is destroyed, not left open", async () => {
    const recheckProxy = await startCommitAcknowledgementDropProxy(new URL(url as string), {
      mode: "stall_statement",
      stallOnTerminate: true,
    });
    let recheckClient: Client | undefined;
    try {
      const seeding = seedThroughProxy("drop_ack", {
        connect: async (wrap) => {
          recheckClient = wrap(await connectAs("app_migrator", recheckProxy.url));
          return recheckClient;
        },
      });
      const settled = await settlesWithin(seeding, SETTLE_LIMIT_MS);
      expect(settled, "the command settles by itself").not.toBe("hung");
      if (settled === "hung") return;
      expect(settled.fired).toBe(1);
      expect(shape(settled.run.outcome).outcome).toBe("CREATED");
      expect(recheckProxy.fired()).toBe(1);
      expect(recheckClient && socketOf(recheckClient).destroyed).toBe(true);
    } finally {
      await recheckProxy.close();
    }
    expect(await counts()).toEqual({ events: 1, offerings: 2, audits: 3 });
  });
});

describe("TC-TST-SEED-006-017 the reconnect after an unknown COMMIT result stays within 3 seconds (SPEC-150 section 11, DB-SEED-002 (4), REL-DB-006)", () => {
  it("TC-TST-SEED-006-017 a slow failed attempt leaves only what is left of 3 s to the next: UNKNOWN_RESULT, no re-check, the late connection is ended", async () => {
    const statements: string[] = [];
    let calls = 0;
    let firstCallAt = 0;
    let late: Client | undefined;
    const { run, logs, fired } = await seedThroughProxy("drop_request", {
      statements,
      connect: async (wrap) => {
        calls += 1;
        if (calls === 1) {
          firstCallAt = Date.now();
          await delay(2500);
          throw new Error("synthetic slow connection failure");
        }
        // The second attempt would connect only 2 s later, past the 3 s budget.
        await delay(2000);
        late = wrap(await connectAs("app_migrator"));
        return late;
      },
    });
    const settledAt = Date.now();
    expect(fired).toBe(1);
    const outcome = shape(run.outcome);
    expect(outcome.outcome).toBe("UNKNOWN_RESULT");
    expect(outcome.errorCode).toBe("COMMIT_RESULT_UNKNOWN");
    expect(calls).toBe(2);
    expect(settledAt - firstCallAt).toBeLessThan(3500);
    // Nothing was decided: no lock statement and no Audit Event read on a re-check connection.
    // Only the original connection took the migration lock; no re-check connection did.
    expect(statements.filter((text) => MIGRATION_LOCK.test(text))).toHaveLength(1);
    expect(statements.some((text) => AUDIT_RECHECK.test(text))).toBe(false);
    expect(named(logs, RESOLVED)).toHaveLength(0);
    expect(named(logs, RETRY_ATTEMPTED)).toHaveLength(0);
    // The connection that arrived after the budget is ended, not left open.
    await waitUntil(async () => late !== undefined, { label: "the late connection arriving" });
    await waitUntil(async () => (await admin.query(MIGRATOR_SESSIONS_SQL)).rows[0].n === 0, {
      label: "the late connection being ended",
    });
    expect(await counts()).toEqual({ events: 0, offerings: 0, audits: 0 });
  });
});
