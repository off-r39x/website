// SPEC-110 §26.1 API-PUB-005 "販売状態" and §26.2 API-PUB-GDS-003 (SPEC-030 §7.6 / §10.4, BR-SAL-003,
// BR-SAL-004, SPEC-100 §8.4): the public sales state of an Entry Ticket Offering and of a Goods. Both
// Operations use the same judgement order and reason vocabulary. Pure: the two period comparisons are
// inputs (made by the database).

export type PublicEntryUnavailableReason =
  | "SALES_NOT_STARTED"
  | "SALES_CLOSED"
  | "SALES_STOPPED"
  | "SOLD_OUT";
export type PublicEntryAvailability =
  | { availability: "AVAILABLE"; reason: null }
  | { availability: "UNAVAILABLE"; reason: PublicEntryUnavailableReason };

export type PublicEntryAvailabilityInput = {
  /** `statement_timestamp() < sales_starts_at`, judged by the database on timestamptz (microseconds kept). */
  salesNotStarted: boolean;
  /** `statement_timestamp() >= sales_ends_at`, judged by the database on timestamptz (the end is not included). */
  salesClosed: boolean;
  saleControlState: "ENABLED" | "SUSPENDED";
  /**
   * Entry: `sales_capacity - held_quantity - committed_quantity > 0`. Goods: the same over the Goods
   * Inventory (`saleable_capacity - held_quantity - committed_quantity > 0`).
   */
  hasRemainingCapacity: boolean;
  /**
   * Whether a purchase Operation of the kind is in the route registry (Entry: API-PUR-ENTRY-001 /
   * API-PUR-CART-001; Goods: API-PUR-GDS-001 / API-PUR-CART-001).
   */
  purchaseRouteMounted: boolean;
};

/** The same reasons and shape for Goods (SPEC-110 §26.2 API-PUB-GDS-003). */
export type PublicSaleUnavailableReason = PublicEntryUnavailableReason;
export type PublicSaleAvailability = PublicEntryAvailability;
export type PublicSaleAvailabilityInput = PublicEntryAvailabilityInput;

/**
 * The first applicable reason, in the order of API-PUR-ELG-001 (without the per-user conditions):
 * SALES_NOT_STARTED (now < start), SALES_CLOSED (now >= end; the end is not included, BR-SAL-003),
 * SALES_STOPPED (SUSPENDED, or no purchase Operation of the kind in the release: UCR-110-004), SOLD_OUT
 * (no remaining capacity). Otherwise AVAILABLE with a null reason. The two time comparisons are made by the
 * database in the statement that read the row (API-PUB-005, API-PUB-GDS-003), so no instant is parsed or
 * rounded here.
 */
export function evaluatePublicSaleAvailability(
  input: PublicSaleAvailabilityInput,
): PublicSaleAvailability {
  if (input.salesNotStarted) return { availability: "UNAVAILABLE", reason: "SALES_NOT_STARTED" };
  if (input.salesClosed) return { availability: "UNAVAILABLE", reason: "SALES_CLOSED" };
  if (input.saleControlState === "SUSPENDED" || !input.purchaseRouteMounted)
    return { availability: "UNAVAILABLE", reason: "SALES_STOPPED" };
  if (!input.hasRemainingCapacity) return { availability: "UNAVAILABLE", reason: "SOLD_OUT" };
  return { availability: "AVAILABLE", reason: null };
}

/** API-PUB-005: the Entry Ticket Offering name of {@link evaluatePublicSaleAvailability}. */
export const evaluatePublicEntryAvailability: (
  input: PublicEntryAvailabilityInput,
) => PublicEntryAvailability = evaluatePublicSaleAvailability;
