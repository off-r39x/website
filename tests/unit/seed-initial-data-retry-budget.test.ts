import { performance } from "node:perf_hooks";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedInitialData } from "../../packages/db/src/initial-data/seed.ts";
import { acquireMigrationLock } from "../../packages/db/src/migration-lock.ts";
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
  /** Consumed in order before `xactLock` applies: how long each xact lock takes, and its SQLSTATE. */
  xactLocks?: { advanceMs: number; code?: "40001" | "55P03" }[];
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
        return { rows: [] };
      }
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

async function seedWith(main: Client, connect: () => Promise<Client>) {
  const lock = await acquireMigrationLock(main);
  return await seedInitialData({
    lock,
    connect,
    readInput: () => JSON.stringify(buildInitialDataInput()),
    actorRef: SEED_ACTOR_REF,
  });
}

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
