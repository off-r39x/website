// PR-GK-4 C1. TC-API-010-002 (G1): the Goods response and Path schemas of @off-r39x/api-contract
// (SPEC-110 §26.2 API-PUB-GDS-002, §9 publicRefInput). TC-API-010-003 (G1): the Goods sales state
// (API-PUB-GDS-003, UCR-110-004), the purchase Operation table per kind and the Goods service
// (API-PUB-GDS-004). Pure functions and a stub store; no database, no clock. Synthetic data only.
import {
  goodsRefParamSchema,
  publicGoodsListSchema,
  publicGoodsSchema,
} from "@off-r39x/api-contract";
import {
  evaluatePublicEntryAvailability,
  evaluatePublicSaleAvailability,
  evaluatePurchaseEligibility,
  type PublicSaleAvailabilityInput,
  type PurchaseSaleConditions,
} from "@off-r39x/domain";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isEntryPurchaseMounted,
  isPurchaseMounted,
  PURCHASE_START_OPERATIONS,
} from "../../apps/api/src/api/routes/public.ts";
import { ROUTES } from "../../apps/api/src/api/routes.ts";
import {
  listGoods,
  type PublicContentStore,
  type PublicGoodsRecord,
  readGoods,
} from "../../apps/api/src/api/services/index.ts";

const GOODS = {
  goods_ref: "00000000-0000-4000-8000-000000000061",
  name: "Synthetic goods",
  description: null,
  unit_price: { amount: "1500", currency: "JPY" },
  sales_starts_at: "2030-06-01T00:00:00.000Z",
  sales_ends_at: "2030-06-30T00:00:00.000Z",
  purchase_limit: 3,
  availability: "UNAVAILABLE",
  unavailable_reason: "SALES_STOPPED",
} as const;

describe("TC-API-010-002 publicGoodsSchema / publicGoodsListSchema (API-PUB-GDS-002)", () => {
  it("accepts the documented shape, description null or text, AVAILABLE with a null reason and each reason with UNAVAILABLE", () => {
    expect(publicGoodsSchema.safeParse(GOODS).success).toBe(true);
    expect(publicGoodsSchema.safeParse({ ...GOODS, description: "x".repeat(500) }).success).toBe(
      true,
    );
    expect(
      publicGoodsSchema.safeParse({ ...GOODS, availability: "AVAILABLE", unavailable_reason: null })
        .success,
    ).toBe(true);
    for (const reason of ["SALES_NOT_STARTED", "SALES_CLOSED", "SALES_STOPPED", "SOLD_OUT"])
      expect(publicGoodsSchema.safeParse({ ...GOODS, unavailable_reason: reason }).success).toBe(
        true,
      );
    expect(publicGoodsListSchema.safeParse({ items: [] }).success).toBe(true);
    expect(publicGoodsListSchema.safeParse({ items: [GOODS, GOODS] }).success).toBe(true);
  });

  it("refuses an inconsistent availability, an unknown reason, a missing or an extra key (counters, sale_control_state, Internal ID)", () => {
    for (const bad of [
      { ...GOODS, availability: "AVAILABLE" },
      { ...GOODS, unavailable_reason: null },
      { ...GOODS, unavailable_reason: "INSUFFICIENT_QUANTITY" },
      { ...GOODS, unavailable_reason: "HELD" },
      { ...GOODS, saleable_capacity: 10 },
      { ...GOODS, remaining: 1 },
      { ...GOODS, sale_control_state: "SUSPENDED" },
      { ...GOODS, id: "1" },
      (({ description: _d, ...rest }) => rest)(GOODS),
    ])
      expect(publicGoodsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(publicGoodsListSchema.safeParse({ items: [GOODS], next_cursor: null }).success).toBe(
      false,
    );
  });

  it("refuses a value the database could not have produced or the contract cannot carry", () => {
    for (const bad of [
      { ...GOODS, goods_ref: "00000000-0000-0000-0000-000000000000" },
      { ...GOODS, goods_ref: "00000000-0000-4000-8000-00000000006A" },
      { ...GOODS, purchase_limit: 0 },
      { ...GOODS, purchase_limit: 2147483648 },
      { ...GOODS, purchase_limit: 1.5 },
      { ...GOODS, unit_price: { amount: "-1", currency: "JPY" } },
      { ...GOODS, unit_price: { amount: 1500, currency: "JPY" } },
      { ...GOODS, unit_price: { amount: "1500", currency: "jpy" } },
      { ...GOODS, sales_ends_at: "infinity" },
      { ...GOODS, sales_starts_at: "2030-06-01T00:00:00.000001Z" },
    ])
      expect(publicGoodsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("TC-API-010-002 goodsRefParamSchema (API-PUB-011 Path, SPEC-110 §9 publicRefInput)", () => {
  it("keeps a lower-case canonical UUID and lower-cases an upper- or mixed-case one", () => {
    expect(goodsRefParamSchema.parse(GOODS.goods_ref)).toBe(GOODS.goods_ref);
    expect(goodsRefParamSchema.parse(GOODS.goods_ref.toUpperCase())).toBe(GOODS.goods_ref);
    expect(goodsRefParamSchema.parse("00000000-0000-4000-8000-00000000006A")).toBe(
      "00000000-0000-4000-8000-00000000006a",
    );
  });

  it("refuses a value that is not a canonical UUID after lower-casing", () => {
    for (const bad of [
      "",
      " 00000000-0000-4000-8000-000000000061",
      "00000000-0000-4000-8000-000000000061 ",
      "00000000-0000-4000-8000-00000000006",
      "00000000-0000-4000-8000-0000000000611",
      "00000000000040008000000000000061",
      "00000000-0000-4000-8000-00000000006g",
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "00000000-0000-0000-8000-000000000061",
      "00000000-0000-4000-c000-000000000061",
      "{00000000-0000-4000-8000-000000000061}",
      "urn:uuid:00000000-0000-4000-8000-000000000061",
      null,
      undefined,
      61,
    ])
      expect(goodsRefParamSchema.safeParse(bad).success, String(bad)).toBe(false);
  });
});

const INPUT: PublicSaleAvailabilityInput = {
  salesNotStarted: false,
  salesClosed: false,
  saleControlState: "ENABLED",
  hasRemainingCapacity: true,
  purchaseRouteMounted: true,
};

describe("TC-API-010-003 evaluatePublicSaleAvailability (API-PUB-GDS-003, BR-SAL-003, BR-SAL-004, UCR-110-004)", () => {
  it("follows the API-PUR-ELG-001 order: not started, closed, stopped, sold out, else AVAILABLE", () => {
    expect(evaluatePublicSaleAvailability(INPUT)).toEqual({
      availability: "AVAILABLE",
      reason: null,
    });
    expect(
      evaluatePublicSaleAvailability({
        salesNotStarted: true,
        salesClosed: true,
        saleControlState: "SUSPENDED",
        hasRemainingCapacity: false,
        purchaseRouteMounted: false,
      }),
    ).toEqual({ availability: "UNAVAILABLE", reason: "SALES_NOT_STARTED" });
    expect(
      evaluatePublicSaleAvailability({
        ...INPUT,
        salesClosed: true,
        saleControlState: "SUSPENDED",
        hasRemainingCapacity: false,
      }),
    ).toEqual({ availability: "UNAVAILABLE", reason: "SALES_CLOSED" });
    expect(
      evaluatePublicSaleAvailability({
        ...INPUT,
        saleControlState: "SUSPENDED",
        hasRemainingCapacity: false,
      }),
    ).toEqual({ availability: "UNAVAILABLE", reason: "SALES_STOPPED" });
    expect(
      evaluatePublicSaleAvailability({
        ...INPUT,
        purchaseRouteMounted: false,
        hasRemainingCapacity: false,
      }),
    ).toEqual({ availability: "UNAVAILABLE", reason: "SALES_STOPPED" });
    expect(evaluatePublicSaleAvailability({ ...INPUT, hasRemainingCapacity: false })).toEqual({
      availability: "UNAVAILABLE",
      reason: "SOLD_OUT",
    });
  });

  it("is the same rule as the Entry one (API-PUB-005) for every input", () => {
    const flags = [true, false];
    for (const salesNotStarted of flags)
      for (const salesClosed of flags)
        for (const saleControlState of ["ENABLED", "SUSPENDED"] as const)
          for (const hasRemainingCapacity of flags)
            for (const purchaseRouteMounted of flags) {
              const input = {
                salesNotStarted,
                salesClosed,
                saleControlState,
                hasRemainingCapacity,
                purchaseRouteMounted,
              };
              expect(evaluatePublicSaleAvailability(input)).toEqual(
                evaluatePublicEntryAvailability(input),
              );
            }
  });

  it("takes the sale conditions of the purchase eligibility (API-PUR-ELG-001) plus the remaining-stock flag", () => {
    expectTypeOf<PublicSaleAvailabilityInput>().toEqualTypeOf<
      PurchaseSaleConditions & { hasRemainingCapacity: boolean }
    >();
  });

  it("is the first reason of the purchase eligibility without the per-user conditions, for every input and both stock kinds", () => {
    const flags = [true, false];
    for (const kind of ["ENTRY", "GOODS"] as const)
      for (const salesNotStarted of flags)
        for (const salesClosed of flags)
          for (const saleControlState of ["ENABLED", "SUSPENDED"] as const)
            for (const hasRemainingCapacity of flags)
              for (const purchaseRouteMounted of flags) {
                const conditions = {
                  salesNotStarted,
                  salesClosed,
                  saleControlState,
                  purchaseRouteMounted,
                };
                // One unit requested against one unit of stock (or none) and an unused limit of one: the
                // per-user and quantity reasons (INSUFFICIENT_QUANTITY, PURCHASE_LIMIT_EXCEEDED) never apply.
                const eligibility = evaluatePurchaseEligibility({
                  kind,
                  requestedQuantity: 1,
                  target: {
                    ...conditions,
                    capacity: hasRemainingCapacity ? 1 : 0,
                    heldQuantity: 0,
                    committedQuantity: 0,
                    purchaseLimit: 1,
                    ownHeldQuantity: 0,
                    ownCommittedQuantity: 0,
                  },
                });
                const label = JSON.stringify({ kind, ...conditions, hasRemainingCapacity });
                const first = eligibility.reasons[0] ?? null;
                expect(
                  evaluatePublicSaleAvailability({ ...conditions, hasRemainingCapacity }),
                  label,
                ).toEqual(
                  first === null
                    ? { availability: "AVAILABLE", reason: null }
                    : { availability: "UNAVAILABLE", reason: first },
                );
                expect(eligibility.purchasable, label).toBe(first === null);
              }
  });

  it("states every Sale Control State, as the purchase eligibility does (DEV-TS-010): an unknown state throws instead of passing like ENABLED", () => {
    // Unreachable from the database (CHECK sale_control_state IN ('ENABLED','SUSPENDED')); a state added
    // later must fail here rather than be shown as purchasable.
    const unknown = "PAUSED" as unknown as PublicSaleAvailabilityInput["saleControlState"];
    expect(() => evaluatePublicSaleAvailability({ ...INPUT, saleControlState: unknown })).toThrow(
      /Unexpected value: PAUSED/,
    );
  });
});

describe("TC-API-010-003 isPurchaseMounted (UCR-110-004: the purchase Operations of each kind in the route registry)", () => {
  // A registry entry with an arbitrary (possibly unregistered) Operation ID, as isPurchaseMounted reads it.
  const route = (operationId: string | null) =>
    ({ operationId }) as unknown as Parameters<typeof isPurchaseMounted>[0][number];

  it("lists the purchase start Operations of API-PUR-ELG-001 per kind", () => {
    expect(PURCHASE_START_OPERATIONS).toEqual({
      ENTRY: ["API-PUR-ENTRY-001", "API-PUR-CART-001"],
      GOODS: ["API-PUR-GDS-001", "API-PUR-CART-001"],
      KARAOKE: ["API-PUR-KRK-001"],
    });
  });

  it("no purchase Operation is registered in this release: every kind is unmounted", () => {
    for (const kind of ["ENTRY", "GOODS", "KARAOKE"] as const)
      expect(isPurchaseMounted(ROUTES, kind), kind).toBe(false);
    expect(isEntryPurchaseMounted(ROUTES)).toBe(false);
  });

  it("GOODS is mounted by API-PUR-GDS-001 or API-PUR-CART-001 only (not by the Entry or Karaoke route, eligibility or a null Operation ID)", () => {
    expect(isPurchaseMounted([route("API-PUR-GDS-001")], "GOODS")).toBe(true);
    expect(isPurchaseMounted([route("API-PUR-CART-001")], "GOODS")).toBe(true);
    for (const other of [
      "API-PUR-ENTRY-001",
      "API-PUR-KRK-001",
      "API-PUR-ELG-001",
      "API-PUB-010",
      "API-PUB-011",
      null,
    ])
      expect(isPurchaseMounted([route(other)], "GOODS"), String(other)).toBe(false);
    expect(isPurchaseMounted([route("API-PUR-GDS-001")], "ENTRY")).toBe(false);
    expect(isPurchaseMounted([route("API-PUR-CART-001")], "KARAOKE")).toBe(false);
  });
});

const record = (overrides: Partial<PublicGoodsRecord> = {}): PublicGoodsRecord => ({
  publicRef: GOODS.goods_ref,
  name: "Synthetic goods",
  description: null,
  unitAmount: "1500",
  currency: "JPY",
  salesStartsAt: "2030-06-01T00:00:00.000Z",
  salesEndsAt: "2030-06-30T00:00:00.000Z",
  saleControlState: "ENABLED",
  purchaseLimit: 3,
  hasRemainingCapacity: true,
  salesNotStarted: false,
  salesClosed: false,
  ...overrides,
});
const storeOf = (items: PublicGoodsRecord[]): PublicContentStore =>
  ({
    listGoods: async () => ({ status: "ok", items }),
    readGoods: async () =>
      items[0] ? { status: "found", goods: items[0] } : { status: "not_found" },
  }) as unknown as PublicContentStore;

describe("TC-API-010-003 listGoods / readGoods service (API-PUB-GDS-003, API-PUB-GDS-004)", () => {
  it("with a Goods purchase Operation mounted, an ENABLED Goods in period with stock is AVAILABLE and one without stock is SOLD_OUT; the capacity flag does not leave the service", async () => {
    const result = await listGoods(storeOf([record(), record({ hasRemainingCapacity: false })]), {
      purchaseRouteMounted: true,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.map((item) => [item.availability, item.reason])).toEqual([
      ["AVAILABLE", null],
      ["UNAVAILABLE", "SOLD_OUT"],
    ]);
    for (const item of result.data) expect(item).not.toHaveProperty("hasRemainingCapacity");
  });

  it("without a Goods purchase Operation (this release) the same Goods are SALES_STOPPED", async () => {
    const result = await listGoods(storeOf([record(), record({ hasRemainingCapacity: false })]), {
      purchaseRouteMounted: false,
    });
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.data.map((item) => item.reason)).toEqual(["SALES_STOPPED", "SALES_STOPPED"]);
  });

  it("a Goods without an Inventory row (null flag) makes the whole Operation invalid_row, even when it is not the first and even when the sales state would not need the stock", async () => {
    for (const broken of [
      record({ hasRemainingCapacity: null }),
      record({ hasRemainingCapacity: null, salesClosed: true }),
      record({ hasRemainingCapacity: null, saleControlState: "SUSPENDED" }),
    ]) {
      expect(await listGoods(storeOf([record(), broken]), { purchaseRouteMounted: true })).toEqual({
        kind: "invalid_row",
      });
      expect(
        await readGoods(storeOf([broken]), GOODS.goods_ref, { purchaseRouteMounted: true }),
      ).toEqual({ kind: "invalid_row" });
    }
  });

  it("an unreadable instant ('infinity') is invalid_row, not a guessed state", async () => {
    expect(
      await listGoods(storeOf([record({ salesEndsAt: "infinity" })]), {
        purchaseRouteMounted: false,
      }),
    ).toEqual({ kind: "invalid_row" });
  });

  it("maps the store statuses: not_found, multiple_events (inconsistent) and unavailable (database_unavailable)", async () => {
    const store = (status: string) =>
      ({
        listGoods: async () => ({ status }),
        readGoods: async () => ({ status }),
      }) as unknown as PublicContentStore;
    const options = { purchaseRouteMounted: false };
    expect(await readGoods(store("not_found"), GOODS.goods_ref, options)).toEqual({
      kind: "not_found",
    });
    expect(await listGoods(store("multiple_events"), options)).toEqual({ kind: "inconsistent" });
    expect(await readGoods(store("multiple_events"), GOODS.goods_ref, options)).toEqual({
      kind: "inconsistent",
    });
    expect(await listGoods(store("unavailable"), options)).toEqual({
      kind: "database_unavailable",
    });
    expect(await readGoods(store("unavailable"), GOODS.goods_ref, options)).toEqual({
      kind: "database_unavailable",
    });
  });
});
