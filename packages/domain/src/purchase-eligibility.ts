// SPEC-110 API-PUR-ELG-001 (SPEC-030 §7.4-§7.6, §10.4, BR-SAL-003/004/006, BR-TKT-001/003/004,
// BR-GDS-001/003, SPEC-090 §9.1-§9.2, BR-KRK-003/010, UCR-110-004): whether one item can be purchased now,
// why not, and how many. The same judgement serves the read-only eligibility Operation and the
// revalidation inside the purchase start Operations (BR-SAL-005). Pure: the database reads the rows and
// compares the instants with statement_timestamp(), so the period and the Karaoke payment window arrive as
// booleans (no instant is parsed or rounded here).

import { assertNever } from "./assert-never";
import type { KaraokeSlotState } from "./states";

/** SPEC-110 API-PUR-ELG-001 Reasons, in the order the Operation lists them. */
export const PURCHASE_REASONS = [
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
export type PurchaseReason = (typeof PURCHASE_REASONS)[number];

/** The sale conditions every kind has (Entry Offering, Goods, Karaoke Sales Configuration). */
export type PurchaseSaleConditions = {
  /** `statement_timestamp() < sales_starts_at`, judged by the database (the start is included). */
  salesNotStarted: boolean;
  /** `statement_timestamp() >= sales_ends_at`, judged by the database (the end is not included, BR-SAL-003). */
  salesClosed: boolean;
  saleControlState: "ENABLED" | "SUSPENDED";
  /** Whether a purchase Operation of the kind is in this release's route registry (UCR-110-004). */
  purchaseRouteMounted: boolean;
};

/** An Entry Ticket Offering, or a Goods with its Goods Inventory, with the Profile's own consumption. */
export type StockPurchaseTarget = PurchaseSaleConditions & {
  /** `sales_capacity` (Entry) or `saleable_capacity` (Goods Inventory). */
  capacity: number;
  /** Every Profile's `held_quantity`. */
  heldQuantity: number;
  /** Every Profile's `committed_quantity`. */
  committedQuantity: number;
  purchaseLimit: number;
  /**
   * The Profile's active temporary holds of this target: HELD Allocations only; released or expired holds
   * are not counted (SPEC-030 §7.5).
   */
  ownHeldQuantity: number;
  /**
   * The Profile's confirmed purchases of this target, including rights canceled or refunded later unless an
   * explicit recovery Operation restored the limit (SPEC-030 §7.5).
   */
  ownCommittedQuantity: number;
};

/** A Karaoke Slot; the period, control state and limit are the Karaoke Sales Configuration's. */
export type KaraokePurchaseTarget = PurchaseSaleConditions & {
  slotState: KaraokeSlotState;
  /** `statement_timestamp() >= usage_end - 30 minutes`, judged by the database (SPEC-090 §9.2 item 5). */
  paymentWindowTooShort: boolean;
  purchaseLimit: number;
  /** The Profile's ACTIVE Karaoke Holds only; released or expired Holds are not counted (BR-KRK-010). */
  ownActiveHoldCount: number;
  /**
   * The Profile's Karaoke Reservations that were confirmed, including those canceled later: a canceled
   * Reservation does not restore the limit (BR-KRK-010, SPEC-090 KRK-CAN-014, SPEC-030 §7.5).
   */
  ownConfirmedReservationCount: number;
};

/** One item; `target: null` is a target that is not public or does not exist (not distinguished). */
export type PurchaseEligibilityRequest =
  | { kind: "ENTRY" | "GOODS"; requestedQuantity: number; target: StockPurchaseTarget | null }
  | { kind: "KARAOKE"; requestedQuantity: number; target: KaraokePurchaseTarget | null };

export type PurchaseEligibility = {
  /** True exactly when `reasons` is empty; then `requestedQuantity <= maxPurchasableQuantity`. */
  purchasable: boolean;
  /** Every applicable reason, in the order of {@link PURCHASE_REASONS}, without duplicates. */
  reasons: PurchaseReason[];
  maxPurchasableQuantity: number;
};

/**
 * The eligibility of one item (SPEC-110 API-PUR-ELG-001). A target that is not public or not found gets
 * only NOT_PUBLIC_OR_NOT_FOUND. Otherwise every applicable reason is listed in the Operation's order. The
 * max is 0 while the item cannot be purchased now (outside the period, stopped, or a kind without a mounted
 * purchase Operation); otherwise it is min(remaining capacity, purchase limit - (own held + own committed))
 * for Entry / Goods, and 0 or 1 for Karaoke. Out-of-range quantities are caller defects (RangeError), not
 * business outcomes: the request body and the database constraints exclude them.
 */
export function evaluatePurchaseEligibility(
  request: PurchaseEligibilityRequest,
): PurchaseEligibility {
  const { requestedQuantity } = request;
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1)
    throw new RangeError("requestedQuantity must be a positive safe integer");
  if (request.kind === "KARAOKE") {
    if (requestedQuantity !== 1) throw new RangeError("a Karaoke requestedQuantity must be 1");
    return request.target === null ? notPublicOrNotFound() : evaluateKaraoke(request.target);
  }
  return request.target === null
    ? notPublicOrNotFound()
    : evaluateStock(request.target, requestedQuantity);
}

function notPublicOrNotFound(): PurchaseEligibility {
  return { purchasable: false, reasons: ["NOT_PUBLIC_OR_NOT_FOUND"], maxPurchasableQuantity: 0 };
}

/** SALES_NOT_STARTED, SALES_CLOSED and SALES_STOPPED: the reasons that make the item unpurchasable now. */
function saleReasons(target: PurchaseSaleConditions, slotStopped: boolean): PurchaseReason[] {
  const reasons: PurchaseReason[] = [];
  if (target.salesNotStarted) reasons.push("SALES_NOT_STARTED");
  if (target.salesClosed) reasons.push("SALES_CLOSED");
  if (controlStopsSale(target.saleControlState) || !target.purchaseRouteMounted || slotStopped)
    reasons.push("SALES_STOPPED");
  return reasons;
}

/**
 * Whether the Sale Control State stops new purchases (SPEC-030 §7.6, BR-SAL-004), stated for every state
 * (DEV-TS-010): a state added later fails the compilation here instead of passing like ENABLED.
 */
function controlStopsSale(state: PurchaseSaleConditions["saleControlState"]): boolean {
  switch (state) {
    case "ENABLED":
      return false;
    case "SUSPENDED":
      return true;
    default:
      return assertNever(state);
  }
}

function requireCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative safe integer`);
}

/** A purchase limit is positive (SPEC-100: CHECK `purchase_limit > 0` on all three sales tables). */
function requirePurchaseLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("purchaseLimit must be a positive safe integer");
}

function evaluateStock(target: StockPurchaseTarget, requested: number): PurchaseEligibility {
  requireCount(target.capacity, "capacity");
  requireCount(target.heldQuantity, "heldQuantity");
  requireCount(target.committedQuantity, "committedQuantity");
  requirePurchaseLimit(target.purchaseLimit);
  requireCount(target.ownHeldQuantity, "ownHeldQuantity");
  requireCount(target.ownCommittedQuantity, "ownCommittedQuantity");

  const reasons = saleReasons(target, false);
  const notNow = reasons.length > 0;
  const remaining = target.capacity - target.heldQuantity - target.committedQuantity;
  const accountRemaining =
    target.purchaseLimit - (target.ownHeldQuantity + target.ownCommittedQuantity);
  if (remaining <= 0) reasons.push("SOLD_OUT");
  else if (remaining < requested) reasons.push("INSUFFICIENT_QUANTITY");
  if (accountRemaining < requested) reasons.push("PURCHASE_LIMIT_EXCEEDED");

  const max = notNow ? 0 : Math.max(0, Math.min(remaining, accountRemaining));
  return { purchasable: reasons.length === 0, reasons, maxPurchasableQuantity: max };
}

/**
 * How a Karaoke Slot State bears on a new purchase (SPEC-090 §9.1, KRK-AVL-001), stated for every state
 * (DEV-TS-010): a state added later fails the compilation here instead of falling through.
 */
function slotDisposition(state: KaraokeSlotState): "CANDIDATE" | "TAKEN" | "STOPPED" {
  switch (state) {
    case "AVAILABLE":
      return "CANDIDATE";
    case "HELD":
    case "SOLD":
      return "TAKEN";
    case "SALES_STOPPED":
      // A per-Slot sales stop is shown as SALES_STOPPED, as in the public availability (SPEC-110 §27).
      return "STOPPED";
    default:
      return assertNever(state);
  }
}

function evaluateKaraoke(target: KaraokePurchaseTarget): PurchaseEligibility {
  requirePurchaseLimit(target.purchaseLimit);
  requireCount(target.ownActiveHoldCount, "ownActiveHoldCount");
  requireCount(target.ownConfirmedReservationCount, "ownConfirmedReservationCount");

  const slot = slotDisposition(target.slotState);
  const reasons = saleReasons(target, slot === "STOPPED");
  const notNow = reasons.length > 0;
  const accountRemaining =
    target.purchaseLimit - (target.ownActiveHoldCount + target.ownConfirmedReservationCount);
  if (accountRemaining < 1) reasons.push("PURCHASE_LIMIT_EXCEEDED");
  if (slot === "TAKEN") reasons.push("SLOT_UNAVAILABLE");
  if (target.paymentWindowTooShort) reasons.push("PAYMENT_WINDOW_TOO_SHORT");

  const candidate = !notNow && slot === "CANDIDATE" && !target.paymentWindowTooShort;
  const max = candidate && accountRemaining >= 1 ? 1 : 0;
  return { purchasable: reasons.length === 0, reasons, maxPurchasableQuantity: max };
}
