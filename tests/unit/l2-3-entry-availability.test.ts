// PR-L2-3 C1. TC-API-009-003 (G1): the public sales state of an Entry Offering (SPEC-110 §26.1 API-PUB-005
// "販売状態", SPEC-030 §7.6 / §10.4, BR-SAL-003, BR-SAL-004, SPEC-100 §8.4) and whether an Entry purchase
// Operation is registered (UCR-110-004: no purchase route => SALES_STOPPED). Pure functions: no clock, no
// database, no timestamp parsing. PR #85 second review: the judgement time is the SQL statement's
// statement_timestamp(), compared with the period in timestamptz by the same statement, so the domain
// function takes the two booleans `salesNotStarted` (statement time < start) and `salesClosed`
// (statement time >= end) instead of three timestamps rounded to milliseconds.
import { evaluatePublicEntryAvailability } from "@off-r39x/domain";
import type { RouteRegistration } from "@off-r39x/security";
import { describe, expect, it } from "vitest";
import { isEntryPurchaseMounted } from "../../apps/api/src/api/routes/public.ts";
import { ROUTES } from "../../apps/api/src/api/routes.ts";

type Input = Parameters<typeof evaluatePublicEntryAvailability>[0];
const base = (patch: Partial<Input> = {}): Input => ({
  salesNotStarted: false,
  salesClosed: false,
  saleControlState: "ENABLED",
  hasRemainingCapacity: true,
  purchaseRouteMounted: true,
  ...patch,
});
const AVAILABLE = { availability: "AVAILABLE", reason: null };
const unavailable = (reason: string) => ({ availability: "UNAVAILABLE", reason });

describe("TC-API-009-003 evaluatePublicEntryAvailability: the period flags decide, [start, end) is judged by the database (BR-SAL-003, SPEC-100 §8.4)", () => {
  it.each([
    [
      "before the start (salesNotStarted)",
      { salesNotStarted: true },
      unavailable("SALES_NOT_STARTED"),
    ],
    ["inside the period (both false)", {}, AVAILABLE],
    ["at or after the end (salesClosed)", { salesClosed: true }, unavailable("SALES_CLOSED")],
  ] as const)("%s", (_label, patch, expected) => {
    expect(evaluatePublicEntryAvailability(base(patch))).toEqual(expected);
  });

  it("does not parse or compare any time: a sub-millisecond period (start .000900, end .000900) is whatever the flags say", () => {
    // The function has no timestamp input at all (the old one took now / salesStartsAt / salesEndsAt).
    const input = base() as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      [
        "hasRemainingCapacity",
        "purchaseRouteMounted",
        "saleControlState",
        "salesClosed",
        "salesNotStarted",
      ].sort(),
    );
    expect(evaluatePublicEntryAvailability(base({ salesNotStarted: true }))).toEqual(
      unavailable("SALES_NOT_STARTED"),
    );
    expect(evaluatePublicEntryAvailability(base({ salesClosed: false }))).toEqual(AVAILABLE);
  });

  it("does not throw on any combination of flags (the RangeError of the timestamp parsing is gone)", () => {
    for (const salesNotStarted of [true, false])
      for (const salesClosed of [true, false])
        expect(() =>
          evaluatePublicEntryAvailability(base({ salesNotStarted, salesClosed })),
        ).not.toThrow();
  });
});

describe("TC-API-009-003 evaluatePublicEntryAvailability: reasons in the order SALES_NOT_STARTED, SALES_CLOSED, SALES_STOPPED, SOLD_OUT (SPEC-110 §26.1 API-PUB-005)", () => {
  it("SUSPENDED inside the period is SALES_STOPPED (BR-SAL-004)", () => {
    expect(evaluatePublicEntryAvailability(base({ saleControlState: "SUSPENDED" }))).toEqual(
      unavailable("SALES_STOPPED"),
    );
  });

  it("no Entry purchase route registered inside the period is SALES_STOPPED (UCR-110-004), also with ENABLED and capacity left", () => {
    expect(evaluatePublicEntryAvailability(base({ purchaseRouteMounted: false }))).toEqual(
      unavailable("SALES_STOPPED"),
    );
  });

  it("no remaining capacity (held + committed = capacity, or capacity 0) inside the period is SOLD_OUT", () => {
    expect(evaluatePublicEntryAvailability(base({ hasRemainingCapacity: false }))).toEqual(
      unavailable("SOLD_OUT"),
    );
  });

  it("ENABLED, route registered, capacity left, inside the period is AVAILABLE with a null reason", () => {
    expect(evaluatePublicEntryAvailability(base())).toEqual(AVAILABLE);
  });

  const everyOther = [
    {
      saleControlState: "SUSPENDED" as const,
      hasRemainingCapacity: false,
      purchaseRouteMounted: false,
    },
    {
      saleControlState: "SUSPENDED" as const,
      hasRemainingCapacity: true,
      purchaseRouteMounted: true,
    },
    {
      saleControlState: "ENABLED" as const,
      hasRemainingCapacity: false,
      purchaseRouteMounted: false,
    },
    {
      saleControlState: "ENABLED" as const,
      hasRemainingCapacity: false,
      purchaseRouteMounted: true,
    },
  ];
  it.each(everyOther)(
    "before the start the reason is SALES_NOT_STARTED whatever the rest is (%j)",
    (rest) => {
      expect(evaluatePublicEntryAvailability(base({ salesNotStarted: true, ...rest }))).toEqual(
        unavailable("SALES_NOT_STARTED"),
      );
    },
  );
  it.each(everyOther)(
    "at and after the end the reason is SALES_CLOSED whatever the rest is (%j)",
    (rest) => {
      expect(evaluatePublicEntryAvailability(base({ salesClosed: true, ...rest }))).toEqual(
        unavailable("SALES_CLOSED"),
      );
    },
  );

  it("inside the period SALES_STOPPED comes before SOLD_OUT: SUSPENDED and no capacity is SALES_STOPPED; no route and no capacity is SALES_STOPPED", () => {
    expect(
      evaluatePublicEntryAvailability(
        base({ saleControlState: "SUSPENDED", hasRemainingCapacity: false }),
      ),
    ).toEqual(unavailable("SALES_STOPPED"));
    expect(
      evaluatePublicEntryAvailability(
        base({ purchaseRouteMounted: false, hasRemainingCapacity: false }),
      ),
    ).toEqual(unavailable("SALES_STOPPED"));
    expect(
      evaluatePublicEntryAvailability(
        base({
          saleControlState: "SUSPENDED",
          purchaseRouteMounted: false,
          hasRemainingCapacity: false,
        }),
      ),
    ).toEqual(unavailable("SALES_STOPPED"));
  });

  it("only the four reasons exist, and a reason is null exactly when AVAILABLE", () => {
    const seen = new Set<string | null>();
    for (const [salesNotStarted, salesClosed] of [
      [true, false],
      [false, false],
      [false, true],
    ] as const)
      for (const saleControlState of ["ENABLED", "SUSPENDED"] as const)
        for (const hasRemainingCapacity of [true, false])
          for (const purchaseRouteMounted of [true, false]) {
            const result = evaluatePublicEntryAvailability(
              base({
                salesNotStarted,
                salesClosed,
                saleControlState,
                hasRemainingCapacity,
                purchaseRouteMounted,
              }),
            );
            seen.add(result.reason);
            expect(result.availability === "AVAILABLE", JSON.stringify(result)).toBe(
              result.reason === null,
            );
          }
    expect([...seen].sort()).toEqual(
      [null, "SALES_CLOSED", "SALES_NOT_STARTED", "SALES_STOPPED", "SOLD_OUT"].sort(),
    );
  });

  it("the sales-not-started flag wins over salesClosed (the order is NOT_STARTED, CLOSED, STOPPED, SOLD_OUT)", () => {
    expect(
      evaluatePublicEntryAvailability(base({ salesNotStarted: true, salesClosed: true })),
    ).toEqual(unavailable("SALES_NOT_STARTED"));
  });

  it("is a pure function of its input: the same input gives equal results and the input is not changed", () => {
    const input = base({ saleControlState: "SUSPENDED" });
    const copy = structuredClone(input);
    expect(evaluatePublicEntryAvailability(input)).toEqual(evaluatePublicEntryAvailability(input));
    expect(input).toEqual(copy);
  });
});

describe("TC-API-009-003 isEntryPurchaseMounted (UCR-110-004: API-PUR-ENTRY-001 / API-PUR-CART-001 in the route registry)", () => {
  const route = (operationId: string | null, path = "/x"): RouteRegistration =>
    ({
      method: "POST",
      path,
      operationId,
      rateLimitClass: "purchase_checkout",
    }) as RouteRegistration;

  it("is false for the registry of this release (no Entry purchase Operation is registered yet)", () => {
    expect(isEntryPurchaseMounted(ROUTES)).toBe(false);
    expect(isEntryPurchaseMounted([])).toBe(false);
  });

  it("is true when API-PUR-ENTRY-001 is registered, and when API-PUR-CART-001 is registered", () => {
    expect(isEntryPurchaseMounted([...ROUTES, route("API-PUR-ENTRY-001")])).toBe(true);
    expect(isEntryPurchaseMounted([...ROUTES, route("API-PUR-CART-001")])).toBe(true);
    expect(isEntryPurchaseMounted([route("API-PUR-ENTRY-001"), route("API-PUR-CART-001")])).toBe(
      true,
    );
  });

  it("is false for other purchase Operations (Goods, Karaoke, eligibility) and for routes without an Operation ID", () => {
    expect(
      isEntryPurchaseMounted([
        route("API-PUR-GDS-001"),
        route("API-PUR-KRK-001"),
        route("API-PUR-ELG-001"),
        route(null),
      ]),
    ).toBe(false);
  });
});
