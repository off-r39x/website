// PR-L1-2a C1. The G1 (unit) part of TC-API-005-001 and TC-API-004-001: the per-item purchase eligibility
// shared by API-PUR-ELG-001 and the purchase start Operations (SPEC-110 API-PUR-ELG-001, API-PUR-CART-001,
// SPEC-030 §7.4-§7.6, §10.4, §11.2, SPEC-090 §9), and the Order Purpose (BR-ORD-013). Pure functions: the
// database reads the rows and compares the instants (statement_timestamp()), so the period and the Karaoke
// payment window arrive as booleans, as in the public sales state of PR-L2-3.
import {
  deriveOrderPurpose,
  evaluatePurchaseEligibility,
  KARAOKE_SLOT_STATES,
  type KaraokePurchaseTarget,
  type KaraokeSlotState,
  PURCHASE_REASONS,
  type PurchaseEligibility,
  type PurchaseEligibilityRequest,
  type PurchaseReason,
  type StockPurchaseTarget,
} from "@off-r39x/domain";
import { describe, expect, it } from "vitest";

const SPEC_110_REASONS = [
  "NOT_PUBLIC_OR_NOT_FOUND",
  "SALES_NOT_STARTED",
  "SALES_CLOSED",
  "SALES_STOPPED",
  "SOLD_OUT",
  "INSUFFICIENT_QUANTITY",
  "PURCHASE_LIMIT_EXCEEDED",
  "SLOT_UNAVAILABLE",
  "PAYMENT_WINDOW_TOO_SHORT",
] as const;

// A purchasable Entry / Goods target: 5 left (10 - 2 held - 3 committed), 4 left for the Profile (6 - 1 - 1).
const stock = (patch: Partial<StockPurchaseTarget> = {}): StockPurchaseTarget => ({
  salesNotStarted: false,
  salesClosed: false,
  saleControlState: "ENABLED",
  purchaseRouteMounted: true,
  capacity: 10,
  heldQuantity: 2,
  committedQuantity: 3,
  purchaseLimit: 6,
  ownHeldQuantity: 1,
  ownCommittedQuantity: 1,
  ...patch,
});

// A purchasable Karaoke Slot: AVAILABLE, enough payment window, 1 left for the Profile (2 - 0 - 1).
const slot = (patch: Partial<KaraokePurchaseTarget> = {}): KaraokePurchaseTarget => ({
  salesNotStarted: false,
  salesClosed: false,
  saleControlState: "ENABLED",
  purchaseRouteMounted: true,
  slotState: "AVAILABLE",
  paymentWindowTooShort: false,
  purchaseLimit: 2,
  ownActiveHoldCount: 0,
  ownConfirmedReservationCount: 1,
  ...patch,
});

const entry = (requestedQuantity: number, target: StockPurchaseTarget | null = stock()) =>
  evaluatePurchaseEligibility({ kind: "ENTRY", requestedQuantity, target });
const goods = (requestedQuantity: number, target: StockPurchaseTarget | null = stock()) =>
  evaluatePurchaseEligibility({ kind: "GOODS", requestedQuantity, target });
const karaoke = (target: KaraokePurchaseTarget | null = slot(), requestedQuantity = 1) =>
  evaluatePurchaseEligibility({ kind: "KARAOKE", requestedQuantity, target });

const ok = (max: number): PurchaseEligibility => ({
  purchasable: true,
  reasons: [],
  maxPurchasableQuantity: max,
});
const ng = (max: number, ...reasons: PurchaseReason[]): PurchaseEligibility => ({
  purchasable: false,
  reasons,
  maxPurchasableQuantity: max,
});

/** Every request the exhaustive checks evaluate: the boolean conditions crossed with quantity boundaries. */
function* allRequests(): Generator<PurchaseEligibilityRequest> {
  const flags = [false, true];
  const controls = ["ENABLED", "SUSPENDED"] as const;
  for (const salesNotStarted of flags)
    for (const salesClosed of flags)
      for (const saleControlState of controls)
        for (const purchaseRouteMounted of flags) {
          const sale = { salesNotStarted, salesClosed, saleControlState, purchaseRouteMounted };
          for (const kind of ["ENTRY", "GOODS"] as const) {
            yield { kind, requestedQuantity: 1, target: null };
            for (const capacity of [0, 4, 5, 6, 9, 20])
              for (const purchaseLimit of [1, 2, 3, 5, 8])
                for (const requestedQuantity of [1, 2, 3, 6])
                  yield {
                    kind,
                    requestedQuantity,
                    target: {
                      ...sale,
                      capacity,
                      heldQuantity: 2,
                      committedQuantity: 3,
                      purchaseLimit,
                      ownHeldQuantity: 1,
                      ownCommittedQuantity: 1,
                    },
                  };
          }
          yield { kind: "KARAOKE", requestedQuantity: 1, target: null };
          for (const slotState of ["AVAILABLE", "HELD", "SOLD", "SALES_STOPPED"] as const)
            for (const paymentWindowTooShort of flags)
              for (const purchaseLimit of [1, 2, 3])
                yield {
                  kind: "KARAOKE",
                  requestedQuantity: 1,
                  target: {
                    ...sale,
                    slotState,
                    paymentWindowTooShort,
                    purchaseLimit,
                    ownActiveHoldCount: 1,
                    ownConfirmedReservationCount: 1,
                  },
                };
        }
}

/** The reasons each condition of SPEC-110 API-PUR-ELG-001 adds, written out independently of the implementation. */
function expectedReasons(request: PurchaseEligibilityRequest): PurchaseReason[] {
  const { target } = request;
  if (target === null) return ["NOT_PUBLIC_OR_NOT_FOUND"];
  const reasons: PurchaseReason[] = [];
  if (target.salesNotStarted) reasons.push("SALES_NOT_STARTED");
  if (target.salesClosed) reasons.push("SALES_CLOSED");
  const slotStopped = "slotState" in target && target.slotState === "SALES_STOPPED";
  if (target.saleControlState === "SUSPENDED" || !target.purchaseRouteMounted || slotStopped)
    reasons.push("SALES_STOPPED");
  if ("capacity" in target) {
    const remaining = target.capacity - target.heldQuantity - target.committedQuantity;
    const accountRemaining =
      target.purchaseLimit - (target.ownHeldQuantity + target.ownCommittedQuantity);
    if (remaining <= 0) reasons.push("SOLD_OUT");
    else if (remaining < request.requestedQuantity) reasons.push("INSUFFICIENT_QUANTITY");
    if (accountRemaining < request.requestedQuantity) reasons.push("PURCHASE_LIMIT_EXCEEDED");
  } else {
    const accountRemaining =
      target.purchaseLimit - (target.ownActiveHoldCount + target.ownConfirmedReservationCount);
    if (accountRemaining < 1) reasons.push("PURCHASE_LIMIT_EXCEEDED");
    if (target.slotState === "HELD" || target.slotState === "SOLD")
      reasons.push("SLOT_UNAVAILABLE");
    if (target.paymentWindowTooShort) reasons.push("PAYMENT_WINDOW_TOO_SHORT");
  }
  return reasons;
}

describe("TC-API-005-101 evaluatePurchaseEligibility: the reasons of API-PUR-ELG-001, in its order and without duplicates", () => {
  it("PURCHASE_REASONS is the nine codes of SPEC-110 API-PUR-ELG-001 in the listed order", () => {
    expect([...PURCHASE_REASONS]).toEqual([...SPEC_110_REASONS]);
  });

  it("every applicable reason is listed (not only the first), as an ordered subsequence of PURCHASE_REASONS", () => {
    let count = 0;
    for (const request of allRequests()) {
      const result = evaluatePurchaseEligibility(request);
      expect(result.reasons, JSON.stringify(request)).toEqual(expectedReasons(request));
      const positions = result.reasons.map((reason) => PURCHASE_REASONS.indexOf(reason));
      expect(positions.every((p, i) => p >= 0 && (i === 0 || p > (positions[i - 1] ?? -1)))).toBe(
        true,
      );
      count += 1;
    }
    expect(count).toBeGreaterThan(1000);
  });

  it("purchasable is true exactly when reasons is empty, and then the requested quantity is within the max", () => {
    for (const request of allRequests()) {
      const result = evaluatePurchaseEligibility(request);
      const context = JSON.stringify(request);
      expect(result.purchasable, context).toBe(result.reasons.length === 0);
      expect(Number.isSafeInteger(result.maxPurchasableQuantity), context).toBe(true);
      expect(result.maxPurchasableQuantity, context).toBeGreaterThanOrEqual(0);
      if (result.purchasable)
        expect(request.requestedQuantity, context).toBeLessThanOrEqual(
          result.maxPurchasableQuantity,
        );
      else
        expect(request.requestedQuantity, context).toBeGreaterThan(result.maxPurchasableQuantity);
    }
  });

  it("lists several reasons together, e.g. a stopped and sold-out Offering beyond the Profile's limit", () => {
    expect(
      entry(5, stock({ saleControlState: "SUSPENDED", capacity: 5, purchaseLimit: 2 })),
    ).toEqual(ng(0, "SALES_STOPPED", "SOLD_OUT", "PURCHASE_LIMIT_EXCEEDED"));
    expect(
      karaoke(slot({ salesClosed: true, slotState: "SOLD", paymentWindowTooShort: true })),
    ).toEqual(ng(0, "SALES_CLOSED", "SLOT_UNAVAILABLE", "PAYMENT_WINDOW_TOO_SHORT"));
  });
});

describe("TC-API-005-102 evaluatePurchaseEligibility: not public and not found are the same single first code with max 0", () => {
  it.each(["ENTRY", "GOODS", "KARAOKE"] as const)("%s without a public target", (kind) => {
    expect(evaluatePurchaseEligibility({ kind, requestedQuantity: 1, target: null })).toEqual(
      ng(0, "NOT_PUBLIC_OR_NOT_FOUND"),
    );
  });

  it("does not add the other reasons for any requested quantity that passes the per-kind validation (an invalid one is TC-API-005-108)", () => {
    expect(entry(2_147_483_647, null)).toEqual(ng(0, "NOT_PUBLIC_OR_NOT_FOUND"));
    expect(goods(1, null)).toEqual(ng(0, "NOT_PUBLIC_OR_NOT_FOUND"));
    expect(goods(2_147_483_647, null)).toEqual(ng(0, "NOT_PUBLIC_OR_NOT_FOUND"));
  });
});

describe("TC-API-005-103 evaluatePurchaseEligibility: the Sales Period and the Sale Control State (BR-SAL-003, BR-SAL-004, BR-TKT-001, BR-GDS-001)", () => {
  it.each([
    ["before the start", { salesNotStarted: true }, "SALES_NOT_STARTED"],
    ["at or after the end (the end is not included)", { salesClosed: true }, "SALES_CLOSED"],
    ["SUSPENDED", { saleControlState: "SUSPENDED" }, "SALES_STOPPED"],
  ] as const)(
    "%s: purchasable false and max 0 even with capacity and limit left",
    (_l, patch, reason) => {
      expect(entry(1, stock(patch))).toEqual(ng(0, reason));
      expect(goods(1, stock(patch))).toEqual(ng(0, reason));
      expect(karaoke(slot(patch))).toEqual(ng(0, reason));
    },
  );

  it("inside the period (both flags false, judged by the database) and ENABLED: purchasable", () => {
    expect(entry(1)).toEqual(ok(4));
    expect(goods(4)).toEqual(ok(4));
    expect(karaoke()).toEqual(ok(1));
  });

  it("a Sale Control State outside ENABLED / SUSPENDED is rejected, never treated like ENABLED (DEV-TS-010)", () => {
    const unknown = "PAUSED" as unknown as StockPurchaseTarget["saleControlState"];
    expect(() => entry(1, stock({ saleControlState: unknown }))).toThrow(
      /Unexpected value: PAUSED/,
    );
    expect(() => goods(1, stock({ saleControlState: unknown }))).toThrow(
      /Unexpected value: PAUSED/,
    );
    expect(() => karaoke(slot({ saleControlState: unknown }))).toThrow(/Unexpected value: PAUSED/);
  });
});

describe("TC-API-005-104 evaluatePurchaseEligibility: a kind without a mounted purchase Operation is SALES_STOPPED (UCR-110-004)", () => {
  it.each(["ENTRY", "GOODS"] as const)(
    "%s: SALES_STOPPED and max 0 although every sale condition holds",
    (kind) => {
      expect(
        evaluatePurchaseEligibility({
          kind,
          requestedQuantity: 1,
          target: stock({ purchaseRouteMounted: false }),
        }),
      ).toEqual(ng(0, "SALES_STOPPED"));
    },
  );

  it("KARAOKE: SALES_STOPPED and max 0 although the Slot is AVAILABLE and ENABLED", () => {
    expect(karaoke(slot({ purchaseRouteMounted: false }))).toEqual(ng(0, "SALES_STOPPED"));
  });

  it("the unmounted kind keeps one SALES_STOPPED when the Sale Control State is also SUSPENDED", () => {
    expect(entry(1, stock({ purchaseRouteMounted: false, saleControlState: "SUSPENDED" }))).toEqual(
      ng(0, "SALES_STOPPED"),
    );
  });

  it("other per-condition reasons stay listed after SALES_STOPPED", () => {
    expect(karaoke(slot({ purchaseRouteMounted: false, slotState: "HELD" }))).toEqual(
      ng(0, "SALES_STOPPED", "SLOT_UNAVAILABLE"),
    );
  });
});

describe("TC-API-005-105 evaluatePurchaseEligibility: Entry / Goods quantity, max = min(remaining, limit - (own held + own committed)) (BR-SAL-006, BR-TKT-003, BR-TKT-004, BR-GDS-003)", () => {
  it.each(["ENTRY", "GOODS"] as const)(
    "%s: no remaining capacity is SOLD_OUT with max 0",
    (kind) => {
      for (const capacity of [5, 4]) {
        expect(
          evaluatePurchaseEligibility({ kind, requestedQuantity: 1, target: stock({ capacity }) }),
        ).toEqual(ng(0, "SOLD_OUT"));
      }
    },
  );

  it("0 < remaining < requested is INSUFFICIENT_QUANTITY with max = the remaining", () => {
    // remaining 2 (7 - 2 - 3), Profile 4 left
    expect(entry(3, stock({ capacity: 7 }))).toEqual(ng(2, "INSUFFICIENT_QUANTITY"));
    expect(entry(2, stock({ capacity: 7 }))).toEqual(ok(2));
  });

  it("requested > the Profile's remaining is PURCHASE_LIMIT_EXCEEDED, distinguished from a capacity shortage", () => {
    // Profile: 6 - (1 held + 1 committed) = 4; capacity 5 left
    expect(goods(5)).toEqual(ng(4, "PURCHASE_LIMIT_EXCEEDED"));
    expect(goods(4)).toEqual(ok(4));
    // both at once: 2 left (7 - 2 - 3) and 4 left for the Profile, 5 requested
    expect(goods(5, stock({ capacity: 7 }))).toEqual(
      ng(2, "INSUFFICIENT_QUANTITY", "PURCHASE_LIMIT_EXCEEDED"),
    );
  });

  it("both own held and own committed quantities consume the limit (the limit minus their sum)", () => {
    expect(
      entry(1, stock({ purchaseLimit: 3, ownHeldQuantity: 2, ownCommittedQuantity: 0 })),
    ).toEqual(ok(1));
    expect(
      entry(1, stock({ purchaseLimit: 3, ownHeldQuantity: 0, ownCommittedQuantity: 2 })),
    ).toEqual(ok(1));
    expect(
      entry(1, stock({ purchaseLimit: 3, ownHeldQuantity: 2, ownCommittedQuantity: 1 })),
    ).toEqual(ng(0, "PURCHASE_LIMIT_EXCEEDED"));
  });

  it("the max is the smaller of the remaining capacity and the Profile's remaining", () => {
    expect(entry(1, stock({ capacity: 7, purchaseLimit: 20 }))).toEqual(ok(2));
    expect(entry(1, stock({ capacity: 100, purchaseLimit: 5 }))).toEqual(ok(3));
  });

  it("requested = max is purchasable and max + 1 is not", () => {
    expect(entry(4)).toEqual(ok(4));
    expect(entry(5)).toEqual(ng(4, "PURCHASE_LIMIT_EXCEEDED"));
    expect(entry(5, stock({ purchaseLimit: 20 }))).toEqual(ok(5));
    expect(entry(6, stock({ purchaseLimit: 20 }))).toEqual(ng(5, "INSUFFICIENT_QUANTITY"));
  });

  it("consumption above the limit and counters above the capacity give max 0, never a negative max", () => {
    expect(
      entry(1, stock({ purchaseLimit: 1, ownHeldQuantity: 2, ownCommittedQuantity: 3 })),
    ).toEqual(ng(0, "PURCHASE_LIMIT_EXCEEDED"));
    expect(entry(1, stock({ capacity: 1 }))).toEqual(ng(0, "SOLD_OUT"));
  });
});

describe("TC-API-005-106 evaluatePurchaseEligibility: Karaoke Slot, payment window and limit (BR-KRK-003, BR-KRK-010, KRK-AVL-001, SPEC-090 §9.2)", () => {
  it.each([
    ["HELD", ng(0, "SLOT_UNAVAILABLE")],
    ["SOLD", ng(0, "SLOT_UNAVAILABLE")],
    ["SALES_STOPPED", ng(0, "SALES_STOPPED")],
    ["AVAILABLE", ok(1)],
  ] as const)("Slot %s", (slotState: KaraokeSlotState, expected) => {
    expect(karaoke(slot({ slotState }))).toEqual(expected);
  });

  it("now >= usage_end - 30 minutes (judged by the database) is PAYMENT_WINDOW_TOO_SHORT with max 0", () => {
    expect(karaoke(slot({ paymentWindowTooShort: true }))).toEqual(
      ng(0, "PAYMENT_WINDOW_TOO_SHORT"),
    );
  });

  it("confirmed Reservations and ACTIVE Holds of the Profile both consume the limit", () => {
    expect(
      karaoke(slot({ purchaseLimit: 2, ownActiveHoldCount: 1, ownConfirmedReservationCount: 1 })),
    ).toEqual(ng(0, "PURCHASE_LIMIT_EXCEEDED"));
    expect(
      karaoke(slot({ purchaseLimit: 2, ownActiveHoldCount: 2, ownConfirmedReservationCount: 0 })),
    ).toEqual(ng(0, "PURCHASE_LIMIT_EXCEEDED"));
    expect(
      karaoke(slot({ purchaseLimit: 5, ownActiveHoldCount: 0, ownConfirmedReservationCount: 0 })),
    ).toEqual(ok(1));
  });

  it("every canonical Slot State has a stated outcome: only AVAILABLE is purchasable (DEV-TS-010)", () => {
    const purchasable = KARAOKE_SLOT_STATES.filter(
      (slotState) => karaoke(slot({ slotState })).purchasable,
    );
    expect(purchasable).toEqual(["AVAILABLE"]);
    for (const slotState of KARAOKE_SLOT_STATES) {
      const result = karaoke(slot({ slotState }));
      expect(result.purchasable, slotState).toBe(result.maxPurchasableQuantity === 1);
    }
  });

  it("a Slot State outside the canonical set is rejected, never treated as purchasable", () => {
    const unknown = "RESERVED" as unknown as KaraokeSlotState;
    expect(() => karaoke(slot({ slotState: unknown }))).toThrow(/Unexpected value: RESERVED/);
  });

  it("the max is 0 or 1", () => {
    for (const request of allRequests())
      if (request.kind === "KARAOKE")
        expect([0, 1]).toContain(evaluatePurchaseEligibility(request).maxPurchasableQuantity);
  });

  it.each([0, 2, 1.5])(
    "a requested quantity other than 1 (%s) is a caller defect: RangeError",
    (quantity) => {
      expect(() => karaoke(slot(), quantity)).toThrow(RangeError);
    },
  );
});

describe("TC-API-005-107 evaluatePurchaseEligibility: the release scope (UCR-RELSCOPE-001, TST-SEED-001 (3))", () => {
  it("seeded Goods (SUSPENDED, inventory 0) are SALES_STOPPED with max 0", () => {
    const seeded = stock({
      saleControlState: "SUSPENDED",
      capacity: 0,
      heldQuantity: 0,
      committedQuantity: 0,
    });
    expect(goods(1, seeded)).toEqual(ng(0, "SALES_STOPPED", "SOLD_OUT"));
  });

  it("a seeded Karaoke Slot (AVAILABLE, configuration SUSPENDED, purchase Operation not mounted) is SALES_STOPPED", () => {
    expect(karaoke(slot({ saleControlState: "SUSPENDED", purchaseRouteMounted: false }))).toEqual(
      ng(0, "SALES_STOPPED"),
    );
  });

  it("Goods are judged by the ordinary rules: ENABLED Goods with stock behind a mounted Cart are purchasable (no hidden rejection)", () => {
    expect(goods(1)).toEqual(ok(4));
  });
});

describe("TC-API-005-108 evaluatePurchaseEligibility: caller defects are RangeError, and the function is pure", () => {
  it.each([
    ["requestedQuantity 0", { requestedQuantity: 0 }],
    ["requestedQuantity -1", { requestedQuantity: -1 }],
    ["requestedQuantity 1.5", { requestedQuantity: 1.5 }],
    ["requestedQuantity NaN", { requestedQuantity: Number.NaN }],
    ["requestedQuantity beyond the safe integers", { requestedQuantity: 2 ** 53 }],
  ] as const)("%s", (_label, patch) => {
    expect(() => evaluatePurchaseEligibility({ kind: "ENTRY", target: stock(), ...patch })).toThrow(
      RangeError,
    );
  });

  it.each([
    "capacity",
    "heldQuantity",
    "committedQuantity",
    "purchaseLimit",
    "ownHeldQuantity",
    "ownCommittedQuantity",
  ] as const)("a negative or fractional %s", (field) => {
    expect(() => goods(1, stock({ [field]: -1 } as Partial<StockPurchaseTarget>))).toThrow(
      RangeError,
    );
    expect(() => goods(1, stock({ [field]: 0.5 } as Partial<StockPurchaseTarget>))).toThrow(
      RangeError,
    );
  });

  it.each(["purchaseLimit", "ownActiveHoldCount", "ownConfirmedReservationCount"] as const)(
    "a negative or fractional Karaoke %s",
    (field) => {
      expect(() => karaoke(slot({ [field]: -1 } as Partial<KaraokePurchaseTarget>))).toThrow(
        RangeError,
      );
      expect(() => karaoke(slot({ [field]: 0.5 } as Partial<KaraokePurchaseTarget>))).toThrow(
        RangeError,
      );
    },
  );

  it("a purchase limit of 0 is a RangeError for Entry, Goods and Karaoke (SPEC-100: CHECK purchase_limit > 0)", () => {
    expect(() => entry(1, stock({ purchaseLimit: 0 }))).toThrow(RangeError);
    expect(() => goods(1, stock({ purchaseLimit: 0 }))).toThrow(RangeError);
    expect(() => karaoke(slot({ purchaseLimit: 0 }))).toThrow(RangeError);
    expect(
      entry(1, stock({ purchaseLimit: 1, ownHeldQuantity: 0, ownCommittedQuantity: 0 })),
    ).toEqual(ok(1));
  });

  it("a requested quantity is validated even for a target that is not public or not found", () => {
    expect(() => entry(0, null)).toThrow(RangeError);
  });

  it("does not modify its input and returns equal results for equal inputs", () => {
    const request: PurchaseEligibilityRequest = {
      kind: "ENTRY",
      requestedQuantity: 9,
      target: stock({ saleControlState: "SUSPENDED" }),
    };
    const snapshot = structuredClone(request);
    const first = evaluatePurchaseEligibility(request);
    expect(request).toEqual(snapshot);
    expect(evaluatePurchaseEligibility(request)).toEqual(first);
    first.reasons.push("SOLD_OUT");
    expect(evaluatePurchaseEligibility(request)).not.toEqual(first);
  });
});

describe("TC-API-004-101 deriveOrderPurpose: the Order Purpose from the Order Items (BR-ORD-013, SPEC-030 §11.2)", () => {
  it.each([
    [["ENTRY"], "ENTRY_TICKET_PURCHASE"],
    [["ENTRY", "ENTRY"], "ENTRY_TICKET_PURCHASE"],
    [["GOODS"], "GOODS_PURCHASE"],
    [["GOODS", "GOODS", "GOODS"], "GOODS_PURCHASE"],
    [["ENTRY", "GOODS"], "ENTRY_GOODS_PURCHASE"],
    [["GOODS", "ENTRY", "GOODS"], "ENTRY_GOODS_PURCHASE"],
    [["KARAOKE"], "KARAOKE_PURCHASE"],
  ] as const)("%j -> %s", (kinds, purpose) => {
    expect(deriveOrderPurpose(kinds)).toBe(purpose);
  });

  it.each([
    ["no item", []],
    ["two Karaoke items", ["KARAOKE", "KARAOKE"]],
    ["Karaoke with Entry", ["KARAOKE", "ENTRY"]],
    ["Karaoke with Goods", ["GOODS", "KARAOKE"]],
    ["Karaoke with Entry and Goods", ["ENTRY", "GOODS", "KARAOKE"]],
  ] as const)("%s is a composition BR-ORD-013 forbids: RangeError", (_label, kinds) => {
    expect(() => deriveOrderPurpose(kinds)).toThrow(RangeError);
  });

  it("does not depend on the item order", () => {
    expect(deriveOrderPurpose(["GOODS", "ENTRY"])).toBe(deriveOrderPurpose(["ENTRY", "GOODS"]));
  });
});
