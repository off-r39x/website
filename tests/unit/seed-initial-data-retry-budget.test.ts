import { performance } from "node:perf_hooks";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectWithinBudget,
  DatabaseAuthenticationRejected,
  openSeedConnection,
  seedInitialData,
} from "../../packages/db/src/initial-data/seed.ts";
import {
  acquireMigrationLock,
  MigrationLockTimeoutError,
} from "../../packages/db/src/migration-lock.ts";
import { createLogger } from "../../packages/observability/src/index.ts";
import { buildInitialDataInput, SEED_ACTOR_REF } from "../harness/db/initial-data.ts";

// PR-SEED: the retry budget includes the backoff wait (SPEC-150 section 11, 55P03 row: 4 attempts, 5 s
// from the first attempt; REL-DB-001, DB-SEED-002). The decision depends on elapsed time only, so it is
// checked here with a controlled clock and a scripted connection double instead of real lock waits:
// every lock wait "takes" LOCK_WAIT_MS of the controlled clock, and the backoff wait advances it by the
// chosen delay (plus an overshoot, for a wait that ends late). No database, no network, no real wait.

const clock = vi.hoisted(() => ({ now: 0, overshootMs: 0, sleeps: [] as number[] }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: async (ms: number) => {
    clock.sleeps.push(ms);
    clock.now += ms + clock.overshootMs;
  },
}));

const LOCK_WAIT_MS = 1600;
const XACT_LOCK = /pg_advisory_xact_lock\(hashtext\('app:initial-data-seed'\)\)/;

type Query = string | { text: string; rowMode?: string };
const textOf = (query: Query) => (typeof query === "string" ? query : query.text);
const lockTimeout = () => Object.assign(new Error("synthetic lock timeout"), { code: "55P03" });

/**
 * A scripted stand-in for a pg Client. `xactLock` decides what the seed xact lock does; every other
 * statement succeeds with the rows the seed expects (no Event yet, inserted rows, Audit Event ids).
 */
function scriptedClient(options: {
  xactLock: "timeout" | "grant";
  commit?: "lost" | "ok";
  /**
   * How long an acknowledged COMMIT "takes" on the controlled clock. The acknowledgement still arrives
   * at once in real time, before any timer callback: an event loop that was blocked past the deadline.
   */
  commitAdvanceMs?: number;
  /** The re-check finds the Audit Events of the run: its COMMIT took effect. */
  committedAudit?: boolean;
  /** How many Events exist (each with an Offering). 0 when unset. */
  events?: number;
  /**
   * How long each ROLLBACK "takes" on the controlled clock; like `commitAdvanceMs`, the
   * acknowledgement arrives at once in real time, before any timer callback.
   */
  rollbackAdvanceMs?: number;
  /** Consumed in order before `xactLock` applies: how long each xact lock takes, and its SQLSTATE. */
  xactLocks?: { advanceMs: number; code?: "40001" | "40P01" | "55P03" }[];
}) {
  const statements: string[] = [];
  const script = [...(options.xactLocks ?? [])];
  let inserted = 0;
  const client = {
    on: () => client,
    end: async () => {},
    query: async (query: Query) => {
      const text = textOf(query);
      statements.push(text);
      if (/current_user/i.test(text)) return { rows: [{ role: "app_migrator" }] };
      if (XACT_LOCK.test(text)) {
        const step = script.shift();
        if (step) {
          clock.now += step.advanceMs;
          if (step.code)
            throw Object.assign(new Error("synthetic retryable failure"), { code: step.code });
          return { rows: [] };
        }
        if (options.xactLock === "timeout") {
          clock.now += LOCK_WAIT_MS;
          throw lockTimeout();
        }
        return { rows: [] };
      }
      if (/^\s*COMMIT/i.test(text)) {
        if (options.commit === "lost") throw new Error("synthetic connection loss");
        clock.now += options.commitAdvanceMs ?? 0;
        return { rows: [] };
      }
      if (/^\s*ROLLBACK/i.test(text)) {
        clock.now += options.rollbackAdvanceMs ?? 0;
        return { rows: [] };
      }
      if (/FROM app\.events ORDER BY id LIMIT 2/i.test(text))
        return {
          rows: Array.from({ length: options.events ?? 0 }, (_, i) => ({
            id: String(1000 + i),
            public_ref: `00000000-0000-4000-9000-${String(1000 + i).padStart(12, "0")}`,
          })),
        };
      if (/FROM app\.entry_ticket_offerings WHERE event_id/i.test(text))
        return { rows: [{ present: (options.events ?? 0) > 0 }] };
      if (options.committedAudit && /from app\.audit_events where operation_id/i.test(text))
        return {
          rows: [
            {
              audit_event_id: "00000000-0000-4000-8000-0000000000c1",
              target_type: "PUBLIC_CONTENT",
              target_ref: "00000000-0000-4000-9000-0000000000c1",
            },
          ],
        };
      if (/^\s*insert into "app"\."audit_events"/i.test(text)) {
        inserted += 1;
        return { rows: [[`00000000-0000-4000-8000-${String(inserted).padStart(12, "0")}`]] };
      }
      if (/^\s*INSERT INTO app\./i.test(text)) {
        inserted += 1;
        return {
          rows: [
            {
              id: String(inserted),
              public_ref: `00000000-0000-4000-9000-${String(inserted).padStart(12, "0")}`,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { client: client as unknown as Client, statements };
}

const xactLocks = (statements: string[]) => statements.filter((text) => XACT_LOCK.test(text));
const commits = (statements: string[]) => statements.filter((text) => /^\s*COMMIT/i.test(text));
const AUDIT_RECHECK = /from app\.audit_events where operation_id/i;
/** The statement timeouts (ms) the deadline lowered, in order. */
const loweredTimeouts = (statements: string[]) =>
  statements.flatMap((text) => {
    const match = /^SET LOCAL statement_timeout = '(\d+)ms'$/.exec(text);
    return match ? [Number(match[1])] : [];
  });

async function seedWith(
  main: Client,
  connect: () => Promise<Client>,
  logger?: { log(event: Parameters<ReturnType<typeof createLogger>["log"]>[0]): void },
) {
  const lock = await acquireMigrationLock(main);
  return await seedInitialData({
    lock,
    connect,
    readInput: () => JSON.stringify(buildInitialDataInput()),
    actorRef: SEED_ACTOR_REF,
    ...(logger === undefined ? {} : { logger }),
  });
}

const collected: Record<string, unknown>[] = [];
/** A schema-checking logger (the one the command uses) whose records are collected. */
function collectingLogger() {
  const records: Record<string, unknown>[] = [];
  const logger = createLogger(
    {
      service: "RECOVERY",
      environment: "test",
      actor_type: "INFRASTRUCTURE_OPERATOR",
      actor_ref: SEED_ACTOR_REF,
    },
    (line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      records.push(record);
      collected.push(record);
    },
  );
  const named = (name: string) => records.filter((record) => record.event_name === name);
  return { logger, records, named };
}
const EXHAUSTED = "reliability.retry.exhausted";

const ATTEMPTED = "reliability.retry.attempted";
const RETRY_SQLSTATES = ["40001", "40P01", "55P03"];

afterEach(() => {
  // A SQLSTATE is written only as the cause of a retry (OBS-DB-002, OBS-DB-003), and only a retryable
  // one: never on any other record of the command (seed-initial-data-cli.ts).
  for (const record of collected) {
    if (!("sqlstate" in record)) continue;
    expect([ATTEMPTED, EXHAUSTED]).toContain(record.event_name);
    expect(RETRY_SQLSTATES).toContain(record.sqlstate);
  }
  collected.length = 0;
});

beforeEach(() => {
  clock.now = 0;
  clock.overshootMs = 0;
  clock.sleeps = [];
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  // Full jitter at the top of each cap: 49.5, 99 and 198 ms for the first three retries.
  vi.spyOn(Math, "random").mockReturnValue(0.99);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("TC-TST-SEED-003-010 the 55P03 retry of the seed transaction stays within its budget, backoff included (REL-DB-001, SPEC-150 section 11)", () => {
  it("TC-TST-SEED-003-010 (a) a backoff that would end past the budget is not started: FAILED after the third attempt, no fourth transaction", async () => {
    const main = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, async () => {
      throw new Error("no re-check expected");
    });
    // Attempts end at 1600, 3249.5 and 4948.5 ms; a 198 ms backoff would end at 5146.5 ms.
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 3,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(xactLocks(main.statements)).toHaveLength(3);
    expect(clock.sleeps).toEqual([49.5, 99]);
  });

  it("TC-TST-SEED-003-010 (b) a backoff that ends late is checked again: FAILED, the next transaction is not started after the budget", async () => {
    // The first wait is chosen within the budget (1600 + 49.5 ms) but ends 3500 ms late, past 5 s.
    clock.overshootMs = 3500;
    const main = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, async () => {
      throw new Error("no re-check expected");
    });
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 1,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(xactLocks(main.statements)).toHaveLength(1);
    expect(clock.sleeps).toEqual([49.5]);
  });
});

describe("TC-TST-SEED-006-013 the 55P03 retry of the re-check stays within its budget, backoff included (DB-SEED-002 (4), REL-DB-001, SPEC-150 section 11)", () => {
  it("TC-TST-SEED-006-013 (a) a re-check backoff that would end past the budget is not started: UNKNOWN_RESULT after the third re-check transaction", async () => {
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, async () => recheck.client);
    expect(outcome).toMatchObject({
      outcome: "UNKNOWN_RESULT",
      attemptNumber: 1,
      errorCode: "COMMIT_RESULT_UNKNOWN",
    });
    expect(xactLocks(recheck.statements)).toHaveLength(3);
    expect(clock.sleeps).toEqual([49.5, 99]);
  });

  it("TC-TST-SEED-006-013 (b) a re-check backoff that ends late is checked again: UNKNOWN_RESULT, no re-check transaction after the budget", async () => {
    clock.overshootMs = 3500;
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, async () => recheck.client);
    expect(outcome).toMatchObject({
      outcome: "UNKNOWN_RESULT",
      errorCode: "COMMIT_RESULT_UNKNOWN",
    });
    expect(xactLocks(recheck.statements)).toHaveLength(1);
    expect(clock.sleeps).toEqual([49.5]);
  });
});

describe("TC-TST-SEED-003-013 a retry of the seed transaction runs within what is left of the budget (REL-DB-011, SPEC-150 section 11)", () => {
  it("TC-TST-SEED-003-013 (a) a retry started 4.85 s in has 150 ms, not a new 8 s: its xact lock ends past the budget, FAILED, no COMMIT", async () => {
    // Attempt 1 times out at 4800 ms; the 49.5 ms backoff ends at 4849.5 ms, within the 5 s budget.
    // Attempt 2 is granted its xact lock only at 5049.5 ms, past the budget.
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4800, code: "55P03" }, { advanceMs: 200 }],
    });
    const outcome = await seedWith(main.client, async () => {
      throw new Error("no re-check expected");
    });
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 2,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(clock.sleeps).toEqual([49.5]);
    expect(xactLocks(main.statements)).toHaveLength(2);
    // The second transaction's statement timeout is lowered to what is left of the 5 s budget.
    expect(Math.max(...loweredTimeouts(main.statements))).toBeLessThanOrEqual(151);
    expect(commits(main.statements)).toEqual([]);
  });

  it("TC-TST-SEED-003-013 (b) a later SQLSTATE does not extend the budget already applied: 40001 (2 s) then 55P03 (5 s) stops at 2 s", async () => {
    // Attempt 1: 40001 at 1500 ms (2 s budget); backoff 49.5 ms. Attempt 2: 55P03 at 1949.5 ms; its
    // 99 ms backoff would end at 2048.5 ms, past the 2 s budget that already applies.
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: [
        { advanceMs: 1500, code: "40001" },
        { advanceMs: 400, code: "55P03" },
      ],
    });
    const outcome = await seedWith(main.client, async () => {
      throw new Error("no re-check expected");
    });
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 2,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(clock.sleeps).toEqual([49.5]);
    expect(xactLocks(main.statements)).toHaveLength(2);
    expect(commits(main.statements)).toEqual([]);
  });
});

describe("TC-TST-SEED-006-016 a retry of the re-check transaction runs within what is left of its budget (DB-SEED-002 (4), REL-DB-011, SPEC-150 section 11)", () => {
  it("TC-TST-SEED-006-016 a re-check retried 4.85 s in has 150 ms: its xact lock ends past the budget, UNKNOWN_RESULT, nothing read", async () => {
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4800, code: "55P03" }, { advanceMs: 200 }],
    });
    const outcome = await seedWith(main.client, async () => recheck.client);
    expect(outcome).toMatchObject({
      outcome: "UNKNOWN_RESULT",
      attemptNumber: 1,
      errorCode: "COMMIT_RESULT_UNKNOWN",
    });
    expect(clock.sleeps).toEqual([49.5]);
    expect(xactLocks(recheck.statements)).toHaveLength(2);
    expect(Math.max(...loweredTimeouts(recheck.statements))).toBeLessThanOrEqual(151);
    // The late second re-check decides nothing: no Audit Event read, no retry of the seed.
    expect(recheck.statements.some((text) => AUDIT_RECHECK.test(text))).toBe(false);
    expect(commits(recheck.statements)).toEqual([]);
  });
});

describe("TC-TST-SEED-006-018 the retry after an uncommitted re-check waits the 55P03 backoff, within the budget (DB-SEED-002 (3), REL-DB-011, SPEC-150 section 11)", () => {
  it("TC-TST-SEED-006-018 (a) the retry starts only after a full jitter backoff: CREATED at attempt 2 after one 49.5 ms wait", async () => {
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "grant" });
    const outcome = await seedWith(main.client, async () => recheck.client);
    expect(outcome).toMatchObject({ outcome: "CREATED", attemptNumber: 2 });
    expect(clock.sleeps).toEqual([49.5]);
    // The re-check transaction, then the retried seed transaction, on the new connection.
    expect(xactLocks(recheck.statements)).toHaveLength(2);
    expect(commits(recheck.statements)).toHaveLength(1);
  });

  it("TC-TST-SEED-006-018 (b) a backoff that would end past the budget is not started: FAILED, no second seed transaction", async () => {
    // The first attempt takes 4970 ms; the 49.5 ms backoff would end at 5019.5 ms, past the 5 s budget.
    const main = scriptedClient({
      xactLock: "grant",
      commit: "lost",
      xactLocks: [{ advanceMs: 4970 }],
    });
    const recheck = scriptedClient({ xactLock: "grant" });
    const outcome = await seedWith(main.client, async () => recheck.client);
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 1,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(clock.sleeps).toEqual([]);
    expect(xactLocks(recheck.statements)).toHaveLength(1);
    expect(commits(recheck.statements)).toEqual([]);
  });

  it("TC-TST-SEED-006-018 (c) a backoff that ends late is checked again: FAILED, no second seed transaction after the budget", async () => {
    clock.overshootMs = 5000;
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "grant" });
    const outcome = await seedWith(main.client, async () => recheck.client);
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 1,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(clock.sleeps).toEqual([49.5]);
    expect(xactLocks(recheck.statements)).toHaveLength(1);
    expect(commits(recheck.statements)).toEqual([]);
  });
});

describe("TC-TST-SEED-003-014 the first connection of the command is retried within the connection budget (REL-DB-011, SPEC-150 section 11)", () => {
  // The command opens its first connection with connectWithinBudget, as the re-check does: 3 attempts
  // within 3 s in total, full jitter backoff (100 ms initial, 500 ms max) included.
  const connectionLoss = () => new Error("synthetic connection failure");
  const fakeClient = () => scriptedClient({ xactLock: "grant" }).client;

  it("TC-TST-SEED-003-014 (a) two temporary failures, then a connection: the third attempt's client, after 99 and 198 ms of backoff", async () => {
    const timeouts: number[] = [];
    const connected = fakeClient();
    let calls = 0;
    const client = await connectWithinBudget(async ({ timeoutMs }) => {
      timeouts.push(timeoutMs);
      calls += 1;
      if (calls < 3) throw connectionLoss();
      return connected;
    });
    expect(client).toBe(connected);
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([99, 198]);
    // Each attempt gets only what is left of the 3 s.
    expect(timeouts).toEqual([3000, 2901, 2703]);
  });

  it("TC-TST-SEED-003-014 (b) every attempt fails: no client after three attempts, no fourth", async () => {
    let calls = 0;
    const client = await connectWithinBudget(async () => {
      calls += 1;
      throw connectionLoss();
    });
    expect(client).toBeUndefined();
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([99, 198]);
  });

  it("TC-TST-SEED-003-014 (c) a slow failure leaves less than the backoff: no further attempt within the 3 s", async () => {
    let calls = 0;
    const client = await connectWithinBudget(async () => {
      calls += 1;
      clock.now += 2950;
      throw connectionLoss();
    });
    expect(client).toBeUndefined();
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});

/** A connection double that counts how often it was ended. */
function trackedClient(lockAdvanceMs = 0) {
  const state = { ended: 0 };
  const client = {
    on: () => client,
    end: async () => {
      state.ended += 1;
    },
    query: async (query: Query) => {
      const text = textOf(query);
      if (/current_user/i.test(text)) return { rows: [{ role: "app_migrator" }] };
      if (/pg_advisory_lock\(/i.test(text)) clock.now += lockAdvanceMs;
      return { rows: [] };
    },
  };
  return { client: client as unknown as Client, state };
}
const authenticationRejected = (code: "28P01" | "28000") =>
  Object.assign(new Error("synthetic authentication failure"), { code });
const EXECUTION_ID = "00000000-0000-4000-8000-0000000000a1";

describe("TC-TST-SEED-003-015 a connection or a migration lock that arrives after its deadline is not used (REL-DB-011, SPEC-150 section 11, SPEC-180 section 24)", () => {
  it("TC-TST-SEED-003-015 (a) a connection that succeeds at 3001 ms is ended, not returned: no client, no further attempt", async () => {
    const late = trackedClient();
    let calls = 0;
    const client = await connectWithinBudget(async () => {
      calls += 1;
      clock.now += 3001;
      return late.client;
    });
    expect(client).toBeUndefined();
    expect(calls).toBe(1);
    expect(late.state.ended).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("TC-TST-SEED-003-015 (b) a migration lock granted after its deadline is refused: MigrationLockTimeoutError, the connection is ended", async () => {
    const late = trackedClient(1001);
    await expect(acquireMigrationLock(late.client, { deadlineMs: 1000 })).rejects.toBeInstanceOf(
      MigrationLockTimeoutError,
    );
    expect(late.state.ended).toBe(1);
  });

  it("TC-TST-SEED-003-015 (c) a migration lock granted within its deadline is held: the connection is not ended", async () => {
    const inTime = trackedClient(999);
    const lock = await acquireMigrationLock(inTime.client, { deadlineMs: 1000 });
    expect(lock.client).toBe(inTime.client);
    expect(inTime.state.ended).toBe(0);
  });
});

describe("TC-TST-SEED-003-016 an authentication rejection is a permanent failure and is not retried (SPEC-150 sections 8 and 11, INF-SEED-005)", () => {
  it.each(["28P01", "28000"] as const)(
    "TC-TST-SEED-003-016 (a) SQLSTATE %s on the first attempt: rejected at once, no second attempt, no backoff",
    async (code) => {
      let calls = 0;
      await expect(
        connectWithinBudget(async () => {
          calls += 1;
          throw authenticationRejected(code);
        }),
      ).rejects.toBeInstanceOf(DatabaseAuthenticationRejected);
      expect(calls).toBe(1);
      expect(clock.sleeps).toEqual([]);
    },
  );

  it("TC-TST-SEED-003-016 (b) the command's first connection: FAILED(PERMANENT_FAILURE, DATABASE_AUTHENTICATION_FAILED), no retry exhaustion", async () => {
    const { logger, named } = collectingLogger();
    let calls = 0;
    const opened = await openSeedConnection(
      async () => {
        calls += 1;
        throw authenticationRejected("28P01");
      },
      { executionId: EXECUTION_ID, logger },
    );
    expect(opened).toEqual({
      kind: "failed",
      outcome: {
        outcome: "FAILED",
        operationExecutionId: EXECUTION_ID,
        attemptNumber: 1,
        failureClass: "PERMANENT_FAILURE",
        errorCode: "DATABASE_AUTHENTICATION_FAILED",
      },
    });
    expect(calls).toBe(1);
    expect(named(EXHAUSTED)).toEqual([]);
  });

  it("TC-TST-SEED-003-016 (c) the re-check connection after a lost COMMIT is rejected: UNKNOWN_RESULT after one attempt", async () => {
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    let calls = 0;
    const outcome = await seedWith(main.client, async () => {
      calls += 1;
      throw authenticationRejected("28P01");
    });
    expect(outcome).toMatchObject({
      outcome: "UNKNOWN_RESULT",
      errorCode: "COMMIT_RESULT_UNKNOWN",
    });
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("TC-TST-SEED-003-017 an exhausted retry budget emits reliability.retry.exhausted (SPEC-160 section 22, OBS-DB-003, SPEC-150 section 11)", () => {
  const common = {
    level: "ERROR",
    result: "FAILED",
    failure_class: "TEMPORARY_FAILURE",
    operation_id: "PROVISION.INITIAL_DATA_SEED",
    provider: "NEON_DB",
  };
  const noRecheck = async (): Promise<Client> => {
    throw new Error("no re-check expected");
  };

  it("TC-TST-SEED-003-017 (a) the seed transaction's 55P03 budget runs out by elapsed time: one event at attempt 3 with SQLSTATE 55P03, then FAILED", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, noRecheck, logger);
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 3,
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({
        ...common,
        attempt_number: 3,
        is_retry: true,
        error_code: "DATABASE_TEMPORARY_FAILURE",
        operation_execution_id: outcome.operationExecutionId,
      }),
    ]);
  });

  it("TC-TST-SEED-003-017 (b) the 40001 budget runs out by count: one event at attempt 4 with SQLSTATE 40001, then FAILED", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: Array.from({ length: 4 }, () => ({ advanceMs: 10, code: "40001" as const })),
    });
    const outcome = await seedWith(main.client, noRecheck, logger);
    expect(outcome).toMatchObject({ outcome: "FAILED", attemptNumber: 4 });
    expect(clock.sleeps).toEqual([49.5, 99, 198]);
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({ ...common, attempt_number: 4, is_retry: true }),
    ]);
  });

  it("TC-TST-SEED-003-017 (c) the command's first connection fails three times: one event at attempt 3, then FAILED(TEMPORARY_FAILURE)", async () => {
    const { logger, named } = collectingLogger();
    const opened = await openSeedConnection(
      async () => {
        throw new Error("synthetic connection failure");
      },
      { executionId: EXECUTION_ID, logger },
    );
    expect(opened).toMatchObject({
      kind: "failed",
      outcome: {
        outcome: "FAILED",
        failureClass: "TEMPORARY_FAILURE",
        errorCode: "DATABASE_TEMPORARY_FAILURE",
      },
    });
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({
        ...common,
        attempt_number: 3,
        is_retry: true,
        error_code: "DATABASE_TEMPORARY_FAILURE",
        operation_execution_id: EXECUTION_ID,
      }),
    ]);
  });

  it("TC-TST-SEED-003-017 (d) the retry after an uncommitted re-check cannot start within the budget: one event, then FAILED", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      commit: "lost",
      xactLocks: [{ advanceMs: 4970 }],
    });
    const recheck = scriptedClient({ xactLock: "grant" });
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({ outcome: "FAILED", attemptNumber: 1 });
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({
        ...common,
        attempt_number: 1,
        operation_execution_id: outcome.operationExecutionId,
      }),
    ]);
  });

  it("TC-TST-SEED-003-017 (e) the re-check's 55P03 budget runs out: one event at re-check attempt 3, the result stays UNKNOWN_RESULT", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({ outcome: "UNKNOWN_RESULT" });
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({
        ...common,
        attempt_number: 3,
        is_retry: true,
        operation_execution_id: outcome.operationExecutionId,
      }),
    ]);
  });

  it("TC-TST-SEED-003-017 (g) a retry cut off by what is left of the budget: one event at attempt 2, then FAILED", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4800, code: "55P03" }, { advanceMs: 200 }],
    });
    const outcome = await seedWith(main.client, noRecheck, logger);
    expect(outcome).toMatchObject({ outcome: "FAILED", attemptNumber: 2 });
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({
        ...common,
        attempt_number: 2,
        is_retry: true,
        operation_execution_id: outcome.operationExecutionId,
      }),
    ]);
  });

  it("TC-TST-SEED-003-017 (h) a re-check retry cut off by what is left of its budget: one event at re-check attempt 2, UNKNOWN_RESULT", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4800, code: "55P03" }, { advanceMs: 200 }],
    });
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({ outcome: "UNKNOWN_RESULT" });
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({ ...common, attempt_number: 2, is_retry: true }),
    ]);
  });

  it("TC-TST-SEED-003-017 (i) a first attempt that reaches the 8 second transaction deadline is not retry exhaustion", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", xactLocks: [{ advanceMs: 8001 }] });
    const outcome = await seedWith(main.client, noRecheck, logger);
    expect(outcome).toMatchObject({ outcome: "FAILED", attemptNumber: 1 });
    expect(named(EXHAUSTED)).toEqual([]);
  });

  it("TC-TST-SEED-003-017 (f) runs that succeed after a retry emit no exhaustion event", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "grant" });
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({ outcome: "CREATED", attemptNumber: 2 });
    let calls = 0;
    const opened = await openSeedConnection(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("synthetic connection failure");
        return trackedClient().client;
      },
      { executionId: EXECUTION_ID, logger },
    );
    expect(opened.kind).toBe("connected");
    expect(named(EXHAUSTED)).toEqual([]);
  });
});

describe("TC-TST-SEED-003-018 every retry is observable with its cause: the SQLSTATE and the unit retried (SPEC-160 section 22, OBS-DB-002, OBS-DB-003)", () => {
  const SEED = "initial_data.seed";
  const RECHECK = "initial_data.recheck";
  const CONNECT = "initial_data.connect";
  const noRecheck = async (): Promise<Client> => {
    throw new Error("no re-check expected");
  };
  /** attempt_number, query_name and sqlstate (undefined when absent) of each record, in order. */
  const causes = (records: Record<string, unknown>[]) =>
    records.map((record) => ({
      attempt: record.attempt_number,
      unit: record.query_name,
      sqlstate: record.sqlstate,
    }));

  it("TC-TST-SEED-003-018 (a) 55P03 retries of the seed transaction: attempted at 2 and 3 and exhausted at 3, each with 55P03", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, noRecheck, logger);
    expect(outcome).toMatchObject({ outcome: "FAILED", attemptNumber: 3 });
    expect(named(ATTEMPTED)).toEqual([
      expect.objectContaining({ is_retry: true, operation_id: "PROVISION.INITIAL_DATA_SEED" }),
      expect.objectContaining({ is_retry: true, operation_id: "PROVISION.INITIAL_DATA_SEED" }),
    ]);
    expect(causes(named(ATTEMPTED))).toEqual([
      { attempt: 2, unit: SEED, sqlstate: "55P03" },
      { attempt: 3, unit: SEED, sqlstate: "55P03" },
    ]);
    expect(causes(named(EXHAUSTED))).toEqual([{ attempt: 3, unit: SEED, sqlstate: "55P03" }]);
  });

  it("TC-TST-SEED-003-018 (b) 40001 until the count runs out: attempted at 2 to 4 and exhausted at 4, each with 40001", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: Array.from({ length: 4 }, () => ({ advanceMs: 10, code: "40001" as const })),
    });
    await seedWith(main.client, noRecheck, logger);
    expect(causes(named(ATTEMPTED))).toEqual([
      { attempt: 2, unit: SEED, sqlstate: "40001" },
      { attempt: 3, unit: SEED, sqlstate: "40001" },
      { attempt: 4, unit: SEED, sqlstate: "40001" },
    ]);
    expect(causes(named(EXHAUSTED))).toEqual([{ attempt: 4, unit: SEED, sqlstate: "40001" }]);
  });

  it("TC-TST-SEED-003-018 (c) each retry names the SQLSTATE that caused it: 40P01, then 40001, then CREATED", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: [
        { advanceMs: 10, code: "40P01" },
        { advanceMs: 10, code: "40001" },
      ],
    });
    const outcome = await seedWith(main.client, noRecheck, logger);
    expect(outcome).toMatchObject({ outcome: "CREATED", attemptNumber: 3 });
    expect(causes(named(ATTEMPTED))).toEqual([
      { attempt: 2, unit: SEED, sqlstate: "40P01" },
      { attempt: 3, unit: SEED, sqlstate: "40001" },
    ]);
    expect(named(EXHAUSTED)).toEqual([]);
  });

  it("TC-TST-SEED-003-018 (d) connection retries: attempted at 2 and 3 and exhausted at 3 for the connection, with no SQLSTATE", async () => {
    const { logger, named } = collectingLogger();
    await openSeedConnection(
      async () => {
        throw new Error("synthetic connection failure");
      },
      { executionId: EXECUTION_ID, logger },
    );
    expect(named(ATTEMPTED)).toEqual([
      expect.objectContaining({ is_retry: true, operation_execution_id: EXECUTION_ID }),
      expect.objectContaining({ is_retry: true, operation_execution_id: EXECUTION_ID }),
    ]);
    expect(causes(named(ATTEMPTED))).toEqual([
      { attempt: 2, unit: CONNECT, sqlstate: undefined },
      { attempt: 3, unit: CONNECT, sqlstate: undefined },
    ]);
    expect(causes(named(EXHAUSTED))).toEqual([{ attempt: 3, unit: CONNECT, sqlstate: undefined }]);
  });

  it("TC-TST-SEED-003-018 (e) 55P03 retries of the re-check: attempted at re-check 2 and 3 and exhausted at 3, for the re-check", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "timeout" });
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({ outcome: "UNKNOWN_RESULT" });
    const ours = expect.objectContaining({
      is_retry: true,
      operation_execution_id: outcome.operationExecutionId,
    });
    expect(named(ATTEMPTED)).toEqual([ours, ours]);
    expect(causes(named(ATTEMPTED))).toEqual([
      { attempt: 2, unit: RECHECK, sqlstate: "55P03" },
      { attempt: 3, unit: RECHECK, sqlstate: "55P03" },
    ]);
    expect(causes(named(EXHAUSTED))).toEqual([{ attempt: 3, unit: RECHECK, sqlstate: "55P03" }]);
  });

  it("TC-TST-SEED-003-018 (f) the retry after an uncommitted re-check is a seed retry without a SQLSTATE (no lock timeout caused it)", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({ xactLock: "grant" });
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({ outcome: "CREATED", attemptNumber: 2 });
    expect(causes(named(ATTEMPTED))).toEqual([{ attempt: 2, unit: SEED, sqlstate: undefined }]);
  });

  it("TC-TST-SEED-003-018 (g) a retry cut off by what is left of the budget is exhausted with the SQLSTATE that started the retries", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4800, code: "55P03" }, { advanceMs: 200 }],
    });
    await seedWith(main.client, noRecheck, logger);
    expect(causes(named(ATTEMPTED))).toEqual([{ attempt: 2, unit: SEED, sqlstate: "55P03" }]);
    expect(causes(named(EXHAUSTED))).toEqual([{ attempt: 2, unit: SEED, sqlstate: "55P03" }]);
  });

  it("TC-TST-SEED-003-018 (h) a re-check retry cut off by what is left of its budget: exhausted for the re-check with 55P03", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commit: "lost" });
    const recheck = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4800, code: "55P03" }, { advanceMs: 200 }],
    });
    await seedWith(main.client, async () => recheck.client, logger);
    expect(causes(named(ATTEMPTED))).toEqual([{ attempt: 2, unit: RECHECK, sqlstate: "55P03" }]);
    expect(causes(named(EXHAUSTED))).toEqual([{ attempt: 2, unit: RECHECK, sqlstate: "55P03" }]);
  });
});

describe("TC-TST-SEED-006-019 a COMMIT acknowledged after the wall clock is an unknown result and is re-checked (SPEC-150 section 9, REL-DB-006, DB-SEED-002)", () => {
  // The acknowledgement is seen before the timer callback (the event loop was blocked past the
  // deadline): only the monotonic clock shows that it came too late.
  const OPENED = "reliability.unknown_result.opened";
  const RESOLVED = "reliability.unknown_result.resolved";
  const recheckFinding = () => scriptedClient({ xactLock: "grant", committedAudit: true });

  it("TC-TST-SEED-006-019 (a) acknowledged at 8001 ms of the 8 s: not CREATED from the acknowledgement; the re-check finds the commit", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commitAdvanceMs: 8001 });
    const recheck = recheckFinding();
    let connects = 0;
    const outcome = await seedWith(
      main.client,
      async () => {
        connects += 1;
        return recheck.client;
      },
      logger,
    );
    expect(connects).toBe(1);
    expect(outcome).toMatchObject({
      outcome: "CREATED",
      attemptNumber: 1,
      auditEventIds: ["00000000-0000-4000-8000-0000000000c1"],
    });
    expect(named(OPENED)).toEqual([
      expect.objectContaining({ attempt_number: 1, error_code: "COMMIT_RESULT_UNKNOWN" }),
    ]);
    expect(named(RESOLVED)).toEqual([expect.objectContaining({ result: "SUCCESS" })]);
    // Re-checked, not run again.
    expect(xactLocks(recheck.statements)).toHaveLength(1);
    expect(commits(recheck.statements)).toEqual([]);
  });

  it("TC-TST-SEED-006-019 (b) acknowledged at exactly 8000 ms: the deadline is reached, the result is re-checked", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commitAdvanceMs: 8000 });
    const recheck = recheckFinding();
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({ outcome: "CREATED", attemptNumber: 1 });
    expect(named(OPENED)).toHaveLength(1);
    expect(recheck.statements.some((text) => AUDIT_RECHECK.test(text))).toBe(true);
  });

  it("TC-TST-SEED-006-019 (c) acknowledged at 7999 ms: CREATED from the acknowledgement, no re-check", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", commitAdvanceMs: 7999 });
    const outcome = await seedWith(
      main.client,
      async () => {
        throw new Error("no re-check expected");
      },
      logger,
    );
    expect(outcome).toMatchObject({ outcome: "CREATED", attemptNumber: 1 });
    expect(outcome.outcome === "CREATED" ? outcome.auditEventIds : []).not.toContain(
      "00000000-0000-4000-8000-0000000000c1",
    );
    expect(named(OPENED)).toEqual([]);
  });

  it("TC-TST-SEED-006-019 (d) a retry acknowledged after what was left of the 5 s budget: re-checked, not CREATED from the acknowledgement", async () => {
    // Attempt 1 ends at 4800 ms with 55P03; after the 49.5 ms backoff attempt 2 has 150.5 ms left.
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4800, code: "55P03" }],
      commitAdvanceMs: 151,
    });
    const recheck = recheckFinding();
    const outcome = await seedWith(main.client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({
      outcome: "CREATED",
      attemptNumber: 2,
      auditEventIds: ["00000000-0000-4000-8000-0000000000c1"],
    });
    expect(named(OPENED)).toEqual([expect.objectContaining({ attempt_number: 2 })]);
    expect(commits(recheck.statements)).toEqual([]);
  });
});

describe("TC-TST-SEED-003-019 a seed transaction whose ROLLBACK is acknowledged after the wall clock is FAILED, not NOOP (SPEC-150 section 9, DB-SEED-002)", () => {
  // The acknowledgement is seen before the timer callback (the event loop was blocked past the
  // deadline): only the monotonic clock shows that the transaction ran past its wall clock.
  const noReconnect = async (): Promise<Client> => {
    throw new Error("no new connection expected");
  };

  it("TC-TST-SEED-003-019 (a) NOOP verdict, ROLLBACK acknowledged at 8001 ms of the 8 s: FAILED, not retried", async () => {
    const { logger, named } = collectingLogger();
    const main = scriptedClient({ xactLock: "grant", events: 1, rollbackAdvanceMs: 8001 });
    const outcome = await seedWith(main.client, noReconnect, logger);
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 1,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(xactLocks(main.statements)).toHaveLength(1);
    expect(commits(main.statements)).toEqual([]);
    expect(named(ATTEMPTED)).toEqual([]);
  });

  it("TC-TST-SEED-003-019 (b) NOOP verdict, ROLLBACK acknowledged at exactly 8000 ms: the deadline is reached, FAILED", async () => {
    const main = scriptedClient({ xactLock: "grant", events: 1, rollbackAdvanceMs: 8000 });
    const outcome = await seedWith(main.client, noReconnect);
    expect(outcome).toMatchObject({ outcome: "FAILED", failureClass: "TEMPORARY_FAILURE" });
  });

  it("TC-TST-SEED-003-019 (c) NOOP verdict, ROLLBACK acknowledged at 7999 ms: NOOP", async () => {
    const main = scriptedClient({ xactLock: "grant", events: 1, rollbackAdvanceMs: 7999 });
    const outcome = await seedWith(main.client, noReconnect);
    expect(outcome).toMatchObject({ outcome: "NOOP", attemptNumber: 1 });
  });

  it("TC-TST-SEED-003-019 (d) a retry with a NOOP verdict, ROLLBACK acknowledged after what was left of the 5 s budget: FAILED, budget exhausted", async () => {
    // Attempt 1 fails with 55P03 at 4649 ms and its ROLLBACK (every ROLLBACK takes 151 ms here) ends
    // at 4800 ms; after the 49.5 ms backoff attempt 2 has 150.5 ms left.
    const { logger, named } = collectingLogger();
    const main = scriptedClient({
      xactLock: "grant",
      xactLocks: [{ advanceMs: 4649, code: "55P03" }],
      events: 1,
      rollbackAdvanceMs: 151,
    });
    const outcome = await seedWith(main.client, noReconnect, logger);
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      attemptNumber: 2,
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
    expect(named(EXHAUSTED)).toEqual([
      expect.objectContaining({ attempt_number: 2, sqlstate: "55P03" }),
    ]);
  });

  it("TC-TST-SEED-003-019 (e) the Event is not unique, ROLLBACK acknowledged at 8001 ms: FAILED by the wall clock like any verdict", async () => {
    const main = scriptedClient({ xactLock: "grant", events: 2, rollbackAdvanceMs: 8001 });
    const outcome = await seedWith(main.client, noReconnect);
    expect(outcome).toMatchObject({
      outcome: "FAILED",
      failureClass: "TEMPORARY_FAILURE",
      errorCode: "DATABASE_TEMPORARY_FAILURE",
    });
  });
});

describe("TC-TST-SEED-006-020 a re-check whose ROLLBACK is acknowledged after the wall clock decides nothing: UNKNOWN_RESULT (SPEC-150 section 9, REL-DB-006, DB-SEED-002 (4))", () => {
  const OPENED = "reliability.unknown_result.opened";
  const RESOLVED = "reliability.unknown_result.resolved";
  /** The COMMIT of the seed transaction is lost: the result goes to the re-check. */
  const lostCommit = () => scriptedClient({ xactLock: "grant", commit: "lost" });

  it("TC-TST-SEED-006-020 (a) the re-check finds the Audit Events, ROLLBACK acknowledged at 8001 ms: UNKNOWN_RESULT, not CREATED", async () => {
    const { logger, named } = collectingLogger();
    const recheck = scriptedClient({
      xactLock: "grant",
      committedAudit: true,
      rollbackAdvanceMs: 8001,
    });
    const outcome = await seedWith(lostCommit().client, async () => recheck.client, logger);
    expect(outcome).toMatchObject({
      outcome: "UNKNOWN_RESULT",
      attemptNumber: 1,
      errorCode: "COMMIT_RESULT_UNKNOWN",
    });
    expect(named(OPENED)).toHaveLength(1);
    expect(named(RESOLVED).map((record) => record.result)).not.toContain("SUCCESS");
    expect(xactLocks(recheck.statements)).toHaveLength(1);
    expect(commits(recheck.statements)).toEqual([]);
  });

  it("TC-TST-SEED-006-020 (b) another run completed the data, ROLLBACK acknowledged at exactly 8000 ms: UNKNOWN_RESULT, not NOOP", async () => {
    const recheck = scriptedClient({ xactLock: "grant", events: 1, rollbackAdvanceMs: 8000 });
    const outcome = await seedWith(lostCommit().client, async () => recheck.client);
    expect(outcome).toMatchObject({ outcome: "UNKNOWN_RESULT", attemptNumber: 1 });
    expect(commits(recheck.statements)).toEqual([]);
  });

  it("TC-TST-SEED-006-020 (c) uncommitted, ROLLBACK acknowledged at 8001 ms: UNKNOWN_RESULT, the seed is not run again", async () => {
    const recheck = scriptedClient({ xactLock: "grant", rollbackAdvanceMs: 8001 });
    let connects = 0;
    const outcome = await seedWith(lostCommit().client, async () => {
      connects += 1;
      return recheck.client;
    });
    expect(outcome).toMatchObject({ outcome: "UNKNOWN_RESULT", attemptNumber: 1 });
    expect(connects).toBe(1);
    expect(xactLocks(recheck.statements)).toHaveLength(1);
    expect(commits(recheck.statements)).toEqual([]);
  });

  it("TC-TST-SEED-006-020 (d) the re-check finds the Audit Events, ROLLBACK acknowledged at 7999 ms: CREATED from the re-check", async () => {
    const recheck = scriptedClient({
      xactLock: "grant",
      committedAudit: true,
      rollbackAdvanceMs: 7999,
    });
    const outcome = await seedWith(lostCommit().client, async () => recheck.client);
    expect(outcome).toMatchObject({
      outcome: "CREATED",
      auditEventIds: ["00000000-0000-4000-8000-0000000000c1"],
    });
  });
});
