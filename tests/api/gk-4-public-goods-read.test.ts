// PR-GK-4 C1. TC-API-010-001 (G4): HTTP contract of API-PUB-010 / 011 (SPEC-110 §26.2, API-PUB-GDS-001..004,
// with §26.1 API-PUB-READ-001 / 002 / 004 / 006) on createApp with the recording PublicContentStore
// (AppDependencies.publicContent) and the in-memory rate limit. No database: what the repository selects
// (every Goods of the Event, order, the period and stock flags) is TC-API-010-004 on a real PG17. Every
// refusal also asserts the store was not called (TST-GEN-002). Synthetic data only.
//
// In this release no Goods purchase Operation (API-PUR-GDS-001 / API-PUR-CART-001) is registered, so a Goods
// inside its sales period is SALES_STOPPED (API-PUB-GDS-003 (3), UCR-110-004). These expectations change by
// the specification when such a route is registered (PR-L1-2d).
import { describe, expect, it } from "vitest";
import {
  BAD,
  BASE,
  createRecordingPublicContentStore,
  errorOf,
  GOOD,
  GOODS_LONG_DESCRIPTION,
  GOODS_OPERATIONS,
  GOODS_REFS,
  type GoodsRowFixture,
  goodsDtoOf,
  goodsDtos,
  goodsRows,
  NONPUBLIC_MARKER,
  publicReadRig,
  type StoreMethod,
  UNKNOWN_GOODS_REF,
  WEB,
} from "../harness/api/public-read.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const completion = (records: Record<string, unknown>[]) =>
  records.filter((r) => r.event_name === "http.request.completed");

type Op = (typeof GOODS_OPERATIONS)[number];
const METHOD_OF: Record<Op["key"], StoreMethod> = { goods: "listGoods", goodsDetail: "readGoods" };
const EXPECTED_DATA: Record<Op["key"], () => unknown> = {
  goods: () => ({ items: goodsDtos() }),
  goodsDetail: () => goodsDtos()[0],
};
const LIST = `${BASE}/goods`;
const detail = (ref: string) => `${BASE}/goods/${ref}`;
const row = (index: number) => goodsRows()[index] as GoodsRowFixture;

describe.each(GOODS_OPERATIONS)(
  "TC-API-010-001 $operationId $path (SPEC-110 §26.2, API-PUB-READ-001 / 006)",
  ({ key, operationId, path }) => {
    const method = METHOD_OF[key];

    it("200 with exactly { data, meta: { request_id } }, Cache-Control no-store and one call of its own store method", async () => {
      const r = publicReadRig();
      const res = await r.get(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: EXPECTED_DATA[key](),
        meta: { request_id: res.headers.get("X-Request-Id") },
      });
      expect(res.headers.get("X-Request-Id")).toMatch(UUID_V4);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(r.store.calls).toEqual([method]);
    });

    it("POST, PUT, PATCH and DELETE are 405 METHOD_NOT_ALLOWED with Allow: GET, HEAD and never reach the store", async () => {
      for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = publicReadRig();
        const res = await r.send(path, {
          method: verb,
          headers: { Origin: WEB, "Content-Type": "application/json" },
          ...(verb === "DELETE" ? {} : { body: "{}" }),
        });
        expect(res.status, verb).toBe(405);
        expect(res.headers.get("Allow"), verb).toBe("GET, HEAD");
        expect((await errorOf(res)).code, verb).toBe("METHOD_NOT_ALLOWED");
        expect(r.store.calls, verb).toEqual([]);
      }
    });

    it.each([
      "?limit=10",
      "?cursor=x",
      "?sort=created_at",
      "?sale_control_state=ENABLED",
      "?x=1&x=2",
      "?=1",
    ])(
      "query %s is 400 VALIDATION_FAILED with details null and no store call (no cursor, no limit, no sort)",
      async (query) => {
        const r = publicReadRig();
        const res = await r.get(`${path}${query}`);
        expect(res.status).toBe(400);
        const error = await errorOf(res);
        expect(error.code).toBe("VALIDATION_FAILED");
        expect(error.details).toBeNull();
        expect(r.store.calls).toEqual([]);
      },
    );

    it("without the publicContent dependency the route fails closed: 503 TEMPORARY_UNAVAILABLE", async () => {
      const r = publicReadRig({ omitPublicContent: true });
      const res = await r.get(path);
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe("TEMPORARY_UNAVAILABLE");
    });

    it("FP.DB.INSIDE_STATEMENT is 503 DATABASE_TEMPORARY_FAILURE (retryable), not an empty success or a 404", async () => {
      const r = publicReadRig();
      r.store.inject("FP.DB.INSIDE_STATEMENT");
      const res = await r.get(path);
      expect(res.status).toBe(503);
      const text = await res.text();
      const body = JSON.parse(text) as { error: { code: string; retryable: boolean } };
      expect(body.error.code).toBe("DATABASE_TEMPORARY_FAILURE");
      expect(body.error.retryable).toBe(true);
      expect(text).not.toContain("items");
    });

    it("two or more Events (PUBLIC.MULTIPLE_EVENTS) are 500 INTERNAL_ERROR and no row is returned (API-PUB-READ-002)", async () => {
      const r = publicReadRig();
      r.store.inject("PUBLIC.MULTIPLE_EVENTS");
      const res = await r.get(path);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("INTERNAL_ERROR");
      expect(text).not.toContain("Synthetic");
    });

    it("an unclassified store failure (PUBLIC.STORE_THROWS) is 500 INTERNAL_ERROR without the failure text", async () => {
      const r = publicReadRig();
      r.store.inject("PUBLIC.STORE_THROWS");
      const res = await r.get(path);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("synthetic public store failure");
    });

    it("never verifies a token or reads a Principal, with or without Authorization and Cookie", async () => {
      for (const authorization of [`Bearer ${GOOD}`, `Bearer ${BAD}`, ""]) {
        const r = publicReadRig();
        const res = await r.get(path, {
          Authorization: authorization,
          Cookie: "session=synthetic",
        });
        expect(res.status, authorization).toBe(200);
        expect(r.verifications(), authorization).toBe(0);
        expect(r.principalReads(), authorization).toBe(0);
      }
    });

    it("is rate limited as public_read: one Stage 1 evaluation with the per-IP burst / sustained and the public_read global rule", async () => {
      const r = publicReadRig();
      expect((await r.get(path)).status).toBe(200);
      expect(r.trs.store.calls).toHaveLength(1);
      const [call] = r.trs.store.calls;
      expect(call?.mode).toBe("admit");
      expect(
        call?.rules
          .map((rule) => [rule.limit, rule.windowMs])
          .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
      ).toEqual([
        [20, 10_000],
        [120, 60_000],
        [10_000, 60_000],
      ]);
    });

    it("a rate limit store failure is 503 TEMPORARY_UNAVAILABLE and the public store is not called (SEC-ABU-019)", async () => {
      const r = publicReadRig();
      r.trs.faults.inject("FP.RATELIMIT.STORE_UNAVAILABLE");
      const res = await r.get(path);
      expect(res.status).toBe(503);
      expect(r.store.calls).toEqual([]);
      expect(completion(r.records)[0]).toMatchObject({
        operation_id: operationId,
        http_status: 503,
      });
    });

    it("the completion log carries the Operation ID and the route template, and not the raw reference", async () => {
      const r = publicReadRig();
      expect((await r.get(path)).status).toBe(200);
      expect(completion(r.records)).toHaveLength(1);
      expect(completion(r.records)[0]).toMatchObject({
        operation_id: operationId,
        http_route: key === "goodsDetail" ? `${BASE}/goods/:goods_ref` : path,
        http_method: "GET",
        http_status: 200,
      });
      expect(r.lines.join("\n")).not.toContain(GOODS_REFS[0]);
    });

    it("a row without an Inventory row (hasRemainingCapacity null) fails the whole Operation with 503 TEMPORARY_UNAVAILABLE and no row (API-PUB-GDS-004)", async () => {
      const r = publicReadRig();
      const broken = { ...row(3), hasRemainingCapacity: null };
      r.store.set({
        goodsList: { status: "ok", items: [row(0), broken, row(4)] },
        goods: { status: "found", goods: broken },
      });
      const res = await r.get(path);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("TEMPORARY_UNAVAILABLE");
      expect(text).not.toContain("Synthetic");
    });

    it("an instant the response cannot carry ('infinity') or a row the schema refuses is 503 TEMPORARY_UNAVAILABLE, never skipped or guessed", async () => {
      for (const bad of [
        { ...row(3), salesEndsAt: "infinity" },
        { ...row(3), currency: "jpy" },
        { ...row(3), purchaseLimit: 0 },
        { ...row(3), publicRef: "00000000-0000-0000-0000-000000000000" },
      ]) {
        const r = publicReadRig();
        r.store.set({
          goodsList: { status: "ok", items: [row(0), bad] },
          goods: { status: "found", goods: bad },
        });
        const res = await r.get(path);
        expect(res.status, JSON.stringify(bad)).toBe(503);
        expect((await errorOf(res)).code).toBe("TEMPORARY_UNAVAILABLE");
      }
    });

    it("a store row that carries Internal IDs, counters or admin times never reaches the response (the DTO is built field by field)", async () => {
      const r = publicReadRig();
      const extra = {
        ...row(3),
        id: `${NONPUBLIC_MARKER}-id`,
        eventId: `${NONPUBLIC_MARKER}-event`,
        saleableCapacity: 424242,
        heldQuantity: 434343,
        committedQuantity: 444444,
        createdAt: `${NONPUBLIC_MARKER}-created`,
      } as GoodsRowFixture;
      r.store.set({
        goodsList: { status: "ok", items: [extra] },
        goods: { status: "found", goods: extra },
      });
      const res = await r.get(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(NONPUBLIC_MARKER);
      for (const value of ["424242", "434343", "444444", "saleControlState", "sale_control_state"])
        expect(text).not.toContain(value);
    });
  },
);

describe("TC-API-010-001 API-PUB-010 Goods list (API-PUB-GDS-001..003)", () => {
  it("returns every Goods the store answers, in the store's order, with the sales state of this release (SALES_NOT_STARTED, SALES_CLOSED, then SALES_STOPPED for SUSPENDED, ENABLED in period and sold out)", async () => {
    const r = publicReadRig();
    const body = (await (await r.get(LIST)).json()) as { data: { items: unknown[] } };
    expect(body.data.items).toEqual([
      goodsDtoOf(row(0), "SALES_NOT_STARTED"),
      goodsDtoOf(row(1), "SALES_CLOSED"),
      goodsDtoOf(row(2), "SALES_STOPPED"),
      goodsDtoOf(row(3), "SALES_STOPPED"),
      goodsDtoOf(row(4), "SALES_STOPPED"),
    ]);
  });

  it("no Goods (or no Event) is 200 with items: []", async () => {
    const r = publicReadRig();
    r.store.set({ goodsList: { status: "ok", items: [] } });
    const res = await r.get(LIST);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ items: [] });
  });

  it("the description is returned whole in the list (null kept, not shortened, line breaks kept)", async () => {
    const r = publicReadRig();
    const body = (await (await r.get(LIST)).json()) as {
      data: { items: { description: string | null }[] };
    };
    expect(body.data.items.map((item) => item.description)).toEqual([
      null,
      GOODS_LONG_DESCRIPTION,
      "Synthetic",
      null,
      null,
    ]);
  });

  it("each item carries exactly the API-PUB-GDS-002 keys and a lossless bigint amount", async () => {
    const r = publicReadRig();
    const body = (await (await r.get(LIST)).json()) as {
      data: { items: Record<string, unknown>[] };
    };
    for (const item of body.data.items)
      expect(Object.keys(item).sort()).toEqual(
        [
          "availability",
          "description",
          "goods_ref",
          "name",
          "purchase_limit",
          "sales_ends_at",
          "sales_starts_at",
          "unavailable_reason",
          "unit_price",
        ].sort(),
      );
    expect(body.data.items[1]?.unit_price).toEqual({ amount: "9007199254740993", currency: "JPY" });
  });
});

describe("TC-API-010-001 API-PUB-011 Goods detail (API-PUB-GDS-001..003, SPEC-110 §9)", () => {
  it("a SUSPENDED Goods is 200 with SALES_STOPPED (Goods has no Publication State)", async () => {
    const r = publicReadRig();
    r.store.set({ goods: { status: "found", goods: row(2) } });
    const res = await r.get(detail(GOODS_REFS[2]));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual(
      goodsDtoOf(row(2), "SALES_STOPPED"),
    );
  });

  it("an unknown goods_ref is 404 RESOURCE_NOT_FOUND (details null) with no Goods data", async () => {
    const r = publicReadRig();
    r.store.set({ goods: { status: "not_found" } });
    const res = await r.get(detail(UNKNOWN_GOODS_REF));
    expect(res.status).toBe(404);
    const error = await errorOf(res);
    expect(error.code).toBe("RESOURCE_NOT_FOUND");
    expect(error.details).toBeNull();
    expect(r.store.goodsRefs).toEqual([UNKNOWN_GOODS_REF]);
  });

  it("an upper- or mixed-case goods_ref is read as its lower-case canonical form", async () => {
    for (const value of [GOODS_REFS[0].toUpperCase(), "00000000-0000-4000-8000-00000000006A"]) {
      const r = publicReadRig();
      const res = await r.get(detail(value));
      expect(res.status, value).toBe(200);
      expect(r.store.goodsRefs, value).toEqual([value.toLowerCase()]);
    }
  });

  it.each([
    ["not a UUID", "goods-1"],
    ["the nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["the max UUID", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["the max UUID in upper case", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"],
    ["version digit 0", "00000000-0000-0000-8000-000000000061"],
    ["variant digit c", "00000000-0000-4000-c000-000000000061"],
    ["no hyphens", "00000000000040008000000000000061"],
    ["a URN prefix", "urn:uuid:00000000-0000-4000-8000-000000000061"],
    ["surrounding spaces", "%2000000000-0000-4000-8000-000000000061%20"],
  ])(
    "goods_ref %s is 400 VALIDATION_FAILED (details null) before any read",
    async (_label, value) => {
      const r = publicReadRig();
      const res = await r.get(detail(value));
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.details).toBeNull();
      expect(r.store.calls).toEqual([]);
    },
  );

  it("no Event is 404 (the store answers not_found) and two or more Events are 500", async () => {
    const r = publicReadRig();
    r.store.set({ goods: { status: "not_found" } });
    expect((await r.get(detail(GOODS_REFS[0]))).status).toBe(404);
    r.store.set({ goods: { status: "multiple_events" } });
    expect((await r.get(detail(GOODS_REFS[0]))).status).toBe(500);
  });
});

describe("TC-API-010-001 independence of the public Operations (API-PUB-READ-006)", () => {
  it("a failure of the Goods reads does not fail the other public reads, and theirs do not fail the Goods reads", async () => {
    const r = publicReadRig({ store: createRecordingPublicContentStore() });
    r.store.inject("FP.DB.INSIDE_STATEMENT", "listGoods");
    expect((await r.get(LIST)).status).toBe(503);
    expect((await r.get(`${BASE}/entry-offerings`)).status).toBe(200);
    r.store.inject("FP.DB.INSIDE_STATEMENT", "listEntryOfferings");
    expect((await r.get(LIST)).status).toBe(200);
    expect((await r.get(detail(GOODS_REFS[0]))).status).toBe(200);
  });
});
