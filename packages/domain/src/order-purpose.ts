// SPEC-030 §11.2, BR-ORD-013 (SPEC-110 API-PUR-CART-001 "Purpose"): the Order Purpose is decided on the
// server from the Order Items when the Order is created.

import type { OrderPurpose } from "./states";

export type OrderItemKind = "ENTRY" | "GOODS" | "KARAOKE";

/**
 * Entry only: ENTRY_TICKET_PURCHASE; Goods only: GOODS_PURCHASE; both: ENTRY_GOODS_PURCHASE; exactly one
 * Karaoke item: KARAOKE_PURCHASE. No item, several Karaoke items, or Karaoke with anything else is a
 * composition BR-ORD-013 forbids; the request validation rejects it first, so reaching it is a caller
 * defect (RangeError), not a business outcome.
 */
export function deriveOrderPurpose(kinds: readonly OrderItemKind[]): OrderPurpose {
  if (kinds.length === 0) throw new RangeError("an Order needs at least one Order Item");
  if (kinds.includes("KARAOKE")) {
    if (kinds.length !== 1)
      throw new RangeError("a Karaoke Order has exactly one Order Item and is never composite");
    return "KARAOKE_PURCHASE";
  }
  const entry = kinds.includes("ENTRY");
  const goods = kinds.includes("GOODS");
  if (entry && goods) return "ENTRY_GOODS_PURCHASE";
  return entry ? "ENTRY_TICKET_PURCHASE" : "GOODS_PURCHASE";
}
