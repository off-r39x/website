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
function scriptedClient(options: { xactLock: "timeout" | "grant"; commit?: "lost" | "ok" }) {
  const statements: string[] = [];
  let inserted = 0;
  const client = {
    on: () => client,
    end: async () => {},
    query: async (query: Query) => {
      const text = textOf(query);
      statements.push(text);
      if (/current_user/i.test(text)) return { rows: [{ role: "app_migrator" }] };
      if (XACT_LOCK.test(text)) {
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
