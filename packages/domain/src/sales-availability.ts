// SPEC-110 §26.1 API-PUB-005 "販売状態" (SPEC-030 §7.6 / §10.4, BR-SAL-003, BR-SAL-004, SPEC-100 §8.4):
// the public sales state of an Entry Ticket Offering. Pure: the two period comparisons are inputs (made by the database).

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
  /** `sales_capacity - held_quantity - committed_quantity > 0`. */
  hasRemainingCapacity: boolean;
  /** Whether an Entry purchase Operation (API-PUR-ENTRY-001 / API-PUR-CART-001) is in the route registry. */
  purchaseRouteMounted: boolean;
};

/**
 * The first applicable reason, in the order of API-PUR-ELG-001 (without the per-user conditions):
 * SALES_NOT_STARTED (now < start), SALES_CLOSED (now >= end; the end is not included, BR-SAL-003),
 * SALES_STOPPED (SUSPENDED, or no Entry purchase Operation in the release: UCR-110-004), SOLD_OUT (no
 * remaining capacity). Otherwise AVAILABLE with a null reason. The two time comparisons are made by the
 * database in the statement that read the row (API-PUB-005), so no instant is parsed or rounded here.
 */
export function evaluatePublicEntryAvailability(
  input: PublicEntryAvailabilityInput,
): PublicEntryAvailability {
  if (input.salesNotStarted) return { availability: "UNAVAILABLE", reason: "SALES_NOT_STARTED" };
  if (input.salesClosed) return { availability: "UNAVAILABLE", reason: "SALES_CLOSED" };
  if (input.saleControlState === "SUSPENDED" || !input.purchaseRouteMounted)
    return { availability: "UNAVAILABLE", reason: "SALES_STOPPED" };
  if (!input.hasRemainingCapacity) return { availability: "UNAVAILABLE", reason: "SOLD_OUT" };
  return { availability: "AVAILABLE", reason: null };
}
