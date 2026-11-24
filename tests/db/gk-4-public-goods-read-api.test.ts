// PR-GK-4 C1 (TC-API-010-005, G3+G4): API-PUB-010 / 011 from an HTTP request to a real PostgreSQL 17:
// createApp with createPublicContentRepository on the app_api_runtime role (verified TLS) and the in-memory
// rate limit. Every response body is compared whole and searched for Internal IDs and Inventory counters
// (TST-GEN-002, INV-010-08). Needs TEST_DATABASE_URL and TEST_DATABASE_CA; it fails (it does not skip)
// without them. Synthetic data only.
//
// In this release no Goods purchase Operation is registered, so a Goods inside its sales period is
// SALES_STOPPED (SPEC-110 §26.2 API-PUB-GDS-003 (3), UCR-110-004); the expectations below change by the
// specification when API-PUR-GDS-001 / API-PUR-CART-001 is registered.
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/api/app.ts";
import { createDatabase, createPublicContentRepository } from "../../packages/db/src/index.ts";
import { prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  dbNow,
  insertEvent,
  insertGoods,
  resetPublicContent,
  snapshot,
} from "../harness/db/public-content-rows.ts";
import { createTestRateLimit, peer } from "../harness/rate-limit/api.ts";

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const WEB = "https://web.example.test";
const API = "https://api.example.test";
const LIST = "/api/v1/public/goods";
const detail = (ref: string) => `/api/v1/public/goods/${ref}`;
const EVENT_REF = "00000000-0000-4000-8000-0000000000e1";
const EVENT_REF_2 = "00000000-0000-4000-8000-0000000000e2";
const ref = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

let admin: Client;
let runtime: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  admin = new Client({ connectionString: url });
  await admin.connect();
  await prepareFoundationDatabase(admin);
  const runtimeUrl = new URL(url as string);
  runtimeUrl.username = "app_api_runtime";
  runtimeUrl.password = "";
  runtimeUrl.search = "";
  runtime = createDatabase({
    connectionString: runtimeUrl.href,
    environment: "test",
    service: "api",
    ca: await readFile(caPath as string, "utf8"),
  });
});
afterAll(async () => {
  await runtime?.close();
  await admin?.end();
});

function makeApp(pool: Pool = runtime.pool) {
  const trs = createTestRateLimit();
  const app = createApp({
    webOrigin: WEB,
    ready: async () => true,
    rateLimit: trs.rateLimit,
    publicContent: createPublicContentRepository(pool),
    sponsorImageOrigins: ["https://logos.example.test"],
  });
  return {
    get: (path: string) => app.request(`${API}${path}`, {}, peer()),
  };
}
const dataOf = async (res: Response) => ((await res.json()) as { data: unknown }).data;
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; details: unknown } }).error;

async function seed(anchorMs: number): Promise<void> {
  await resetPublicContent(admin);
  const eventId = await insertEvent(admin, { ref: EVENT_REF });
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-01T00:00:00.000Z",
    ref: ref(0x62),
    name: "Synthetic goods suspended",
    description: "Synthetic goods description",
    unitAmount: "9007199254740993",
    control: "SUSPENDED",
    startsAt: iso(anchorMs - DAY),
    endsAt: iso(anchorMs + DAY),
    purchaseLimit: 2,
    inventory: { capacity: 7771, held: 0, committed: 0 },
  });
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-02T00:00:00.000Z",
    ref: ref(0x61),
    name: "Synthetic goods enabled",
    startsAt: iso(anchorMs - DAY),
    endsAt: iso(anchorMs + DAY),
    inventory: { capacity: 8881, held: 1, committed: 2 },
  });
  await insertGoods(admin, eventId, {
    createdAt: "2030-01-03T00:00:00.000Z",
    ref: ref(0x63),
    name: "Synthetic goods later",
    startsAt: iso(anchorMs + DAY),
    endsAt: iso(anchorMs + 2 * DAY),
    inventory: { capacity: 0 },
  });
}

const expected = (anchorMs: number) => [
  {
    goods_ref: ref(0x62),
    name: "Synthetic goods suspended",
    description: "Synthetic goods description",
    unit_price: { amount: "9007199254740993", currency: "JPY" },
    sales_starts_at: iso(anchorMs - DAY),
    sales_ends_at: iso(anchorMs + DAY),
    purchase_limit: 2,
    availability: "UNAVAILABLE",
    unavailable_reason: "SALES_STOPPED",
  },
  {
    goods_ref: ref(0x61),
    name: "Synthetic goods enabled",
    description: null,
    unit_price: { amount: "1000", currency: "JPY" },
    sales_starts_at: iso(anchorMs - DAY),
    sales_ends_at: iso(anchorMs + DAY),
    purchase_limit: 4,
    availability: "UNAVAILABLE",
    unavailable_reason: "SALES_STOPPED",
  },
  {
    goods_ref: ref(0x63),
    name: "Synthetic goods later",
    description: null,
    unit_price: { amount: "1000", currency: "JPY" },
    sales_starts_at: iso(anchorMs + DAY),
    sales_ends_at: iso(anchorMs + 2 * DAY),
    purchase_limit: 4,
    availability: "UNAVAILABLE",
    unavailable_reason: "SALES_NOT_STARTED",
  },
];

async function internalIds(): Promise<string[]> {
  const ids: string[] = [];
  for (const table of ["events", "goods"])
    for (const row of (await admin.query(`SELECT id::text AS id FROM app.${table}`)).rows)
      ids.push(String(row.id));
  return ids;
}
const leaks = async (text: string) => {
  for (const id of await internalIds()) expect(text).not.toContain(`"${id}"`);
  for (const value of ["7771", "8881", "held", "committed", "saleable", "sale_control_state"])
    expect(text).not.toContain(value);
};

describe("TC-API-010-005 API-PUB-010 on a real PG17 (API-PUB-GDS-001..003)", () => {
  it("returns every Goods of the Event (SUSPENDED and not yet on sale too) in created_at order with the sales state of this release, and no Internal ID or counter", async () => {
    const anchor = (await dbNow(admin)).getTime();
    await seed(anchor);
    const res = await makeApp().get(LIST);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect((JSON.parse(text) as { data: unknown }).data).toEqual({ items: expected(anchor) });
    await leaks(text);
  });

  it("no Event and no Goods are both 200 with items: []; two Events are 500 with no row", async () => {
    await resetPublicContent(admin);
    expect(await dataOf(await makeApp().get(LIST))).toEqual({ items: [] });
    await insertEvent(admin, { ref: EVENT_REF });
    expect(await dataOf(await makeApp().get(LIST))).toEqual({ items: [] });
    await seed((await dbNow(admin)).getTime());
    await insertEvent(admin, { ref: EVENT_REF_2 });
    const res = await makeApp().get(LIST);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("Synthetic goods");
  });

  it("a Goods without an Inventory row fails the list with 503 TEMPORARY_UNAVAILABLE (API-PUB-GDS-004), the other public reads still answer", async () => {
    await seed((await dbNow(admin)).getTime());
    const eventId = String(
      (await admin.query("SELECT id::text AS id FROM app.events")).rows[0]?.id,
    );
    await insertGoods(admin, eventId, {
      ref: ref(0x69),
      name: "Synthetic goods without inventory",
      startsAt: "2030-06-01T00:00:00.000Z",
      endsAt: "2030-06-30T00:00:00.000Z",
      inventory: null,
    });
    const app = makeApp();
    const res = await app.get(LIST);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("TEMPORARY_UNAVAILABLE");
    expect(text).not.toContain("Synthetic goods");
    expect((await app.get(detail(ref(0x69)))).status).toBe(503);
    expect((await app.get(detail(ref(0x61)))).status).toBe(200);
    expect((await app.get("/api/v1/public/entry-offerings")).status).toBe(200);
  });
});

describe("TC-API-010-005 API-PUB-011 on a real PG17 (API-PUB-GDS-001..003, SPEC-110 §9)", () => {
  it("each Goods of the list is returned alone with the same body, also for an upper-case ref", async () => {
    const anchor = (await dbNow(admin)).getTime();
    await seed(anchor);
    const app = makeApp();
    for (const goods of expected(anchor)) {
      const res = await app.get(detail(goods.goods_ref.toUpperCase()));
      expect(res.status, goods.goods_ref).toBe(200);
      const text = await res.text();
      expect((JSON.parse(text) as { data: unknown }).data).toEqual(goods);
      await leaks(text);
    }
  });

  it("an unknown ref and a ref with no Event are 404 RESOURCE_NOT_FOUND; a nil UUID is 400 before any read", async () => {
    await seed((await dbNow(admin)).getTime());
    const unknown = await makeApp().get(detail(ref(0x6f)));
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toMatchObject({ code: "RESOURCE_NOT_FOUND", details: null });
    const nil = await makeApp().get(detail("00000000-0000-0000-0000-000000000000"));
    expect(nil.status).toBe(400);
    expect((await errorOf(nil)).code).toBe("VALIDATION_FAILED");
    await resetPublicContent(admin);
    expect((await makeApp().get(detail(ref(0x61)))).status).toBe(404);
  });

  it("reads write nothing", async () => {
    await seed((await dbNow(admin)).getTime());
    const before = await snapshot(admin);
    const app = makeApp();
    await app.get(LIST);
    await app.get(detail(ref(0x61)));
    await app.get(detail(ref(0x6f)));
    expect(await snapshot(admin)).toEqual(before);
  });
});

describe("TC-API-010-005 database failure (SPEC-110 §51, API-PUB-READ-006)", () => {
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it("an unreachable database is 503 DATABASE_TEMPORARY_FAILURE for the list and the detail, never an empty list or a 404", async () => {
    const pool = new Pool({
      host: "127.0.0.1",
      port: await closedPort(),
      user: "app_api_runtime",
      database: "synthetic",
      connectionTimeoutMillis: 500,
    });
    pool.on("error", () => undefined);
    try {
      const app = makeApp(pool);
      for (const path of [LIST, detail(ref(0x61))]) {
        const res = await app.get(path);
        expect(res.status, path).toBe(503);
        expect((await errorOf(res)).code, path).toBe("DATABASE_TEMPORARY_FAILURE");
      }
    } finally {
      await pool.end();
    }
  });
});
