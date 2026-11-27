// SPEC-110 §26.1 API-PUB-005 "販売状態" and §26.2 API-PUB-GDS-003 (SPEC-030 §7.6 / §10.4, BR-SAL-003,
// BR-SAL-004, SPEC-100 §8.4): the public sales state of an Entry Ticket Offering and of a Goods. Both
// Operations use the same judgement order and reason vocabulary. Pure: the two period comparisons are
// inputs (made by the database). The sale conditions and the Sale Control State rule are those of the
// purchase eligibility (API-PUR-ELG-001, ./purchase-eligibility): the public state is its first reason
// without the per-user and quantity conditions, with the remaining stock read as a flag (no counter).

import { assertNever } from "./assert-never";
import type { PurchaseSaleConditions } from "./purchase-eligibility";

export type PublicEntryUnavailableReason =
  | "SALES_NOT_STARTED"
  | "SALES_CLOSED"
  | "SALES_STOPPED"
  | "SOLD_OUT";
export type PublicEntryAvailability =
  | { availability: "AVAILABLE"; reason: null }
  | { availability: "UNAVAILABLE"; reason: PublicEntryUnavailableReason };

export type PublicEntryAvailabilityInput = PurchaseSaleConditions & {
  /**
   * Entry: `sales_capacity - held_quantity - committed_quantity > 0`. Goods: the same over the Goods
   * Inventory (`saleable_capacity - held_quantity - committed_quantity > 0`).
   */
  hasRemainingCapacity: boolean;
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
  if (controlStopsSale(input.saleControlState) || !input.purchaseRouteMounted)
    return { availability: "UNAVAILABLE", reason: "SALES_STOPPED" };
  if (!input.hasRemainingCapacity) return { availability: "UNAVAILABLE", reason: "SOLD_OUT" };
  return { availability: "AVAILABLE", reason: null };
}

/**
 * Whether the Sale Control State stops new sales (SPEC-030 §7.6, BR-SAL-004), stated for every state as in
 * the purchase eligibility (DEV-TS-010): a state added later fails the compilation here instead of being
 * shown like ENABLED. The database admits only ENABLED and SUSPENDED (CHECK constraint).
 */
function controlStopsSale(state: PublicSaleAvailabilityInput["saleControlState"]): boolean {
  switch (state) {
    case "ENABLED":
      return false;
    case "SUSPENDED":
      return true;
    default:
      return assertNever(state);
  }
}

/** API-PUB-005: the Entry Ticket Offering name of {@link evaluatePublicSaleAvailability}. */
export const evaluatePublicEntryAvailability: (
  input: PublicEntryAvailabilityInput,
) => PublicEntryAvailability = evaluatePublicSaleAvailability;
