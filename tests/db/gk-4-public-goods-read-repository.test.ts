// PR-GK-4 C1 (TC-API-010-004, G3): listGoods / readGoods of createPublicContentRepository (@off-r39x/db) on a
// real PostgreSQL 17 as the runtime role app_api_runtime (verified TLS, own database per file). SPEC-110
// §26.2 API-PUB-GDS-001..004, SPEC-100 §15.3 / §38, DB-GDS-001: every Goods of the single Event is selected
// (SUSPENDED, out of period and sold out too) in created_at ASC, public_ref ASC order, the Event count comes
// from the same statement as the rows, the sales period is judged on the database clock in timestamptz,
// the remaining stock is a flag over the Inventory row (no counter leaves the repository) and a Goods
// without an Inventory row is still read with a null flag. Needs TEST_DATABASE_URL and TEST_DATABASE_CA; it
// fails (it does not skip) without them. Synthetic data only.
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPublicContentRepository } from "../../packages/db/src/index.ts";
import { withFixedStatementClock } from "../harness/db/fixed-statement-clock.ts";
import { prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  dbNow,
  insertEvent,
  insertGoods,
  resetPublicContent,
  snapshot,
} from "../harness/db/public-content-rows.ts";

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const EVENT_REF = "00000000-0000-4000-8000-0000000000e1";
const EVENT_REF_2 = "00000000-0000-4000-8000-0000000000e2";
const ref = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let admin: Client;
let runtimeHref: string;
let ca: string;
let runtime: ReturnType<typeof createDatabase>;
let repo: ReturnType<typeof createPublicContentRepository>;

beforeAll(async () => {
  admin = new Client({ connectionString: url });
  await admin.connect();
  await prepareFoundationDatabase(admin);
  const runtimeUrl = new URL(url as string);
  runtimeUrl.username = "app_api_runtime";
  runtimeUrl.password = "";
  runtimeUrl.search = "";
  runtimeHref = runtimeUrl.href;
  ca = await readFile(caPath as string, "utf8");
  runtime = createDatabase({
    connectionString: runtimeHref,
    environment: "test",
    service: "api",
    ca,
  });
  repo = createPublicContentRepository(runtime.pool);
});
afterAll(async () => {
  await runtime?.close();
  await admin?.end();
});

const oneEvent = async () => {
  await resetPublicContent(admin);
  return insertEvent(admin, { ref: EVENT_REF });
};

// Inserted so that insertion order, ref order and created_at order all differ.
async function seed(anchorMs: number): Promise<string> {
  const eventId = await oneEvent();
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-03T00:00:00.000Z",
    ref: ref(0x63),
    name: "Synthetic goods before the period",
    description: "Synthetic goods description",
    unitAmount: "9007199254740993",
    startsAt: iso(anchorMs + DAY),
    endsAt: iso(anchorMs + 2 * DAY),
    purchaseLimit: 3,
    inventory: { capacity: 7771, held: 1, committed: 2 },
  });
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-02T00:00:00.000Z",
    ref: ref(0x65),
    name: "Synthetic goods sold out",
    startsAt: iso(anchorMs - DAY),
    endsAt: iso(anchorMs + DAY),
    inventory: { capacity: 8881, held: 6662, committed: 2219 },
  });
  // Same created_at as 0x65: the tie is broken by public_ref ASC.
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-02T00:00:00.000Z",
    ref: ref(0x64),
    name: "Synthetic goods zero capacity",
    startsAt: iso(anchorMs - DAY),
    endsAt: iso(anchorMs + DAY),
    inventory: { capacity: 0 },
  });
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-01T00:00:00.000Z",
    ref: ref(0x66),
    name: "Synthetic goods suspended",
    unitAmount: "0",
    control: "SUSPENDED",
    startsAt: iso(anchorMs - DAY),
    endsAt: iso(anchorMs + DAY),
    inventory: { capacity: 7770, held: 0, committed: 0 },
  });
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-05T00:00:00.000Z",
    ref: ref(0x61),
    name: "Synthetic goods after the period",
    startsAt: iso(anchorMs - 2 * DAY),
    endsAt: iso(anchorMs - DAY),
    inventory: { capacity: 50 },
  });
  return eventId;
}

describe("TC-API-010-004 listGoods (API-PUB-010, API-PUB-GDS-001, API-PUB-GDS-003, SPEC-100 §15.3 / §38)", () => {
  it("returns every Goods of the Event (SUSPENDED, out-of-period and sold-out ones too) in created_at ASC, public_ref ASC order with hasRemainingCapacity from saleable_capacity - held - committed > 0", async () => {
    await seed((await dbNow(admin)).getTime());
    const result = await repo.listGoods();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(
      result.items.map((row) => [row.publicRef, row.hasRemainingCapacity, row.saleControlState]),
    ).toEqual([
      [ref(0x66), true, "SUSPENDED"],
      [ref(0x64), false, "ENABLED"],
      [ref(0x65), false, "ENABLED"],
      [ref(0x63), true, "ENABLED"],
      [ref(0x61), true, "ENABLED"],
    ]);
  });

  it("maps the other columns: unit_amount as a lossless decimal string, description null kept, times as UTC ISO with milliseconds, purchase limit", async () => {
    const anchor = (await dbNow(admin)).getTime();
    await seed(anchor);
    const result = await repo.listGoods();
    if (result.status !== "ok") throw new Error(`unexpected ${result.status}`);
    const before = result.items.find((row) => row.publicRef === ref(0x63));
    expect(before).toEqual({
      publicRef: ref(0x63),
      name: "Synthetic goods before the period",
      description: "Synthetic goods description",
      unitAmount: "9007199254740993",
      currency: "JPY",
      salesStartsAt: iso(anchor + DAY),
      salesEndsAt: iso(anchor + 2 * DAY),
      saleControlState: "ENABLED",
      purchaseLimit: 3,
      hasRemainingCapacity: true,
      salesNotStarted: true,
      salesClosed: false,
    });
    expect(result.items.find((row) => row.publicRef === ref(0x65))?.description).toBeNull();
    expect(result.items.find((row) => row.publicRef === ref(0x66))?.unitAmount).toBe("0");
    expect(before?.salesStartsAt).toMatch(ISO_MS);
  });

  it("returns no counter or capacity value: the result has no held / committed / capacity key and none of their numbers", async () => {
    await seed((await dbNow(admin)).getTime());
    const text = JSON.stringify(await repo.listGoods());
    expect(text).not.toMatch(/held|committed|saleable|quantity|"id"|createdAt|updatedAt/i);
    for (const value of ["7771", "7770", "8881", "6662", "2219"]) expect(text).not.toContain(value);
  });

  it("salesNotStarted is statement_timestamp() < sales_starts_at and salesClosed is statement_timestamp() >= sales_ends_at, decided by the database", async () => {
    await seed((await dbNow(admin)).getTime());
    const result = await repo.listGoods();
    if (result.status !== "ok") throw new Error(`unexpected ${result.status}`);
    expect(
      result.items.map((row) => [row.publicRef, row.salesNotStarted, row.salesClosed]),
    ).toEqual([
      [ref(0x66), false, false],
      [ref(0x64), false, false],
      [ref(0x65), false, false],
      [ref(0x63), true, false], // future start
      [ref(0x61), false, true], // past end
    ]);
    expect(result).not.toHaveProperty("now");
  });

  it("the period is compared in timestamptz: a start one microsecond ahead is not started, an end passed by a microsecond is closed (no millisecond rounding)", async () => {
    const eventId = await oneEvent();
    await insertGoods(admin, eventId, {
      createdAt: "2030-01-01T00:00:00.000Z",
      ref: ref(0x67),
      name: "Synthetic goods microsecond future",
      startsAt: "2999-01-01T00:00:00.000001Z",
      endsAt: "2999-01-02T00:00:00.000900Z",
      inventory: { capacity: 10 },
    });
    await insertGoods(admin, eventId, {
      createdAt: "2030-01-02T00:00:00.000Z",
      ref: ref(0x68),
      name: "Synthetic goods microsecond past",
      startsAt: "2000-01-01T00:00:00.000900Z",
      endsAt: "2000-01-02T00:00:00.000100Z",
      inventory: { capacity: 10 },
    });
    const result = await repo.listGoods();
    if (result.status !== "ok") throw new Error(`unexpected ${result.status}`);
    expect(
      result.items.map((row) => [row.publicRef, row.salesNotStarted, row.salesClosed]),
    ).toEqual([
      [ref(0x67), true, false],
      [ref(0x68), false, true],
    ]);
  });

  it("the start is included and the end is not, judged against the statement's own statement_timestamp() to the microsecond (fixed statement clock; no millisecond rounding)", async () => {
    // The statement judges at CLOCK (sub-millisecond digits, so that rounding or truncating to milliseconds
    // moves CLOCK and CLOCK + 1 microsecond to the same value and changes an answer below).
    const CLOCK = "2030-06-15T12:00:00.000500Z";
    const AT = CLOCK;
    const AFTER = "2030-06-15T12:00:00.000501Z";
    const BEFORE = "2030-06-15T12:00:00.000499Z";
    const eventId = await oneEvent();
    const rows = [
      // [ref, startsAt, endsAt, expected salesNotStarted, expected salesClosed]
      [ref(0x6b), AT, AFTER, false, false], // starts exactly now: started (start included); ends 1 µs later
      [ref(0x6c), AFTER, "2030-06-16T00:00:00.000000Z", true, false], // starts 1 µs later: not started
      [ref(0x6d), BEFORE, "2030-06-16T00:00:00.000000Z", false, false], // started 1 µs ago
      [ref(0x6e), "2030-06-14T00:00:00.000000Z", AT, false, true], // ends exactly now: closed (end excluded)
      [ref(0x6f), "2030-06-14T00:00:00.000000Z", BEFORE, false, true], // ended 1 µs ago: closed
    ] as const;
    for (const [index, [goodsRef, startsAt, endsAt]] of rows.entries())
      await insertGoods(admin, eventId, {
        createdAt: `2030-01-0${index + 1}T00:00:00.000Z`,
        ref: goodsRef,
        name: `Synthetic goods boundary ${index}`,
        startsAt,
        endsAt,
        inventory: { capacity: 10 },
      });
    await withFixedStatementClock(
      { admin, runtimeUrl: runtimeHref, ca, instant: CLOCK },
      async (pool) => {
        const clocked = createPublicContentRepository(pool);
        const list = await clocked.listGoods();
        if (list.status !== "ok") throw new Error(`unexpected ${list.status}`);
        expect(
          list.items.map((row) => [row.publicRef, row.salesNotStarted, row.salesClosed]),
        ).toEqual(rows.map(([goodsRef, , , notStarted, closed]) => [goodsRef, notStarted, closed]));
        for (const [goodsRef, , , notStarted, closed] of rows) {
          const detail = await clocked.readGoods(goodsRef);
          if (detail.status !== "found") throw new Error(`unexpected ${detail.status}`);
          expect([detail.goods.salesNotStarted, detail.goods.salesClosed], goodsRef).toEqual([
            notStarted,
            closed,
          ]);
        }
      },
    );
  });

  it("a Goods without an Inventory row is still read with hasRemainingCapacity null (never skipped, never guessed; API-PUB-GDS-004)", async () => {
    const eventId = await oneEvent();
    await insertGoods(admin, eventId, {
      ref: ref(0x69),
      name: "Synthetic goods without inventory",
      startsAt: "2030-06-01T00:00:00.000Z",
      endsAt: "2030-06-30T00:00:00.000Z",
      inventory: null,
    });
    const result = await repo.listGoods();
    if (result.status !== "ok") throw new Error(`unexpected ${result.status}`);
    expect(result.items.map((row) => [row.publicRef, row.hasRemainingCapacity])).toEqual([
      [ref(0x69), null],
    ]);
  });

  it("no Goods is ok with no items; no Event is ok with no items; two Events are multiple_events with no row", async () => {
    await resetPublicContent(admin);
    expect(await repo.listGoods()).toEqual({ status: "ok", items: [] });
    await oneEvent();
    expect(await repo.listGoods()).toEqual({ status: "ok", items: [] });
    await seed((await dbNow(admin)).getTime());
    await insertEvent(admin, { ref: EVENT_REF_2 });
    const result = await repo.listGoods();
    expect(result).toEqual({ status: "multiple_events" });
    expect(JSON.stringify(result)).not.toContain("Synthetic goods");
  });
});

describe("TC-API-010-004 readGoods (API-PUB-011, API-PUB-GDS-001, API-PUB-GDS-003)", () => {
  it("finds the Goods of that ref with the same row shape as the list", async () => {
    await seed((await dbNow(admin)).getTime());
    const list = await repo.listGoods();
    if (list.status !== "ok") throw new Error(`unexpected ${list.status}`);
    for (const row of list.items)
      expect(await repo.readGoods(row.publicRef)).toEqual({ status: "found", goods: row });
  });

  it("a SUSPENDED Goods is found (Goods has no Publication State)", async () => {
    await seed((await dbNow(admin)).getTime());
    const result = await repo.readGoods(ref(0x66));
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.goods.saleControlState).toBe("SUSPENDED");
  });

  it("an unknown ref is not_found; no Event is not_found; two Events are multiple_events with no row", async () => {
    await seed((await dbNow(admin)).getTime());
    expect(await repo.readGoods(ref(0x6f))).toEqual({ status: "not_found" });
    await insertEvent(admin, { ref: EVENT_REF_2 });
    const multiple = await repo.readGoods(ref(0x63));
    expect(multiple).toEqual({ status: "multiple_events" });
    expect(JSON.stringify(multiple)).not.toContain("Synthetic goods");
    await resetPublicContent(admin);
    expect(await repo.readGoods(ref(0x63))).toEqual({ status: "not_found" });
  });

  it("a Goods without an Inventory row is found with hasRemainingCapacity null", async () => {
    const eventId = await oneEvent();
    await insertGoods(admin, eventId, {
      ref: ref(0x69),
      name: "Synthetic goods without inventory",
      startsAt: "2030-06-01T00:00:00.000Z",
      endsAt: "2030-06-30T00:00:00.000Z",
      inventory: null,
    });
    const result = await repo.readGoods(ref(0x69));
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.goods.hasRemainingCapacity).toBeNull();
  });

  it("the ref is a bound parameter: a value with SQL text is not_found and changes nothing", async () => {
    await seed((await dbNow(admin)).getTime());
    const before = await snapshot(admin);
    // Not a UUID: the ::uuid cast refuses it in the database (the API never sends one: the Path is
    // validated before the read). The point here is that nothing is executed from the value.
    await expect(repo.readGoods("'; DELETE FROM app.goods; --")).rejects.toBeDefined();
    expect(await snapshot(admin)).toEqual(before);
  });
});

describe("TC-API-010-004 read only and unavailable classification (SPEC-100 §55, SPEC-110 §50/§51)", () => {
  it("listGoods and readGoods write nothing", async () => {
    await seed((await dbNow(admin)).getTime());
    const before = await snapshot(admin);
    await repo.listGoods();
    await repo.readGoods(ref(0x63));
    await repo.readGoods(ref(0x6f));
    expect(await snapshot(admin)).toEqual(before);
  });

  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it("an unreachable database is { status: 'unavailable' } for both reads, not thrown and not an empty result", async () => {
    const pool = new Pool({
      host: "127.0.0.1",
      port: await closedPort(),
      user: "app_api_runtime",
      database: "synthetic",
      connectionTimeoutMillis: 500,
    });
    pool.on("error", () => undefined);
    try {
      const unreachable = createPublicContentRepository(pool);
      expect(await unreachable.listGoods()).toEqual({ status: "unavailable" });
      expect(await unreachable.readGoods(ref(0x63))).toEqual({ status: "unavailable" });
    } finally {
      await pool.end();
    }
  });
});
