import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { app } from "./app-schema.ts";
import { internalId, publicRef, timestamptz, timestamptzNow } from "./common.ts";
import { businessProfiles, roleAssignments } from "./identity.ts";
import { orderItems, orders } from "./orders.ts";
import { goods } from "./sales.ts";

// SPEC-100 §38 `app.goods_inventory` (Part IX Goods). Keyed by goods_id, so a Goods row has at most one
// inventory row (DB-GDS-001); there is no identity column and no created_at. These declarations exist
// for types and queries; the DDL source of truth is migrations/0003_public_content_sales.sql
// (SPEC-100 §57, DB-MIG-002). ck_goods_inventory_capacity is the last defence against overselling
// (DB-GDS-003, DI-030-006).

export const goodsInventory = app.table(
  "goods_inventory",
  {
    goodsId: bigint("goods_id", { mode: "bigint" }).notNull(),
    saleableCapacity: integer("saleable_capacity").notNull(),
    heldQuantity: integer("held_quantity").notNull().default(0),
    committedQuantity: integer("committed_quantity").notNull().default(0),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_goods_inventory", columns: [t.goodsId] }),
    foreignKey({
      name: "fk_goods_inventory_goods",
      columns: [t.goodsId],
      foreignColumns: [goods.id],
    }).onDelete("restrict"),
    check("ck_goods_inventory_saleable_capacity", sql`${t.saleableCapacity} >= 0`),
    check("ck_goods_inventory_held_quantity", sql`${t.heldQuantity} >= 0`),
    check("ck_goods_inventory_committed_quantity", sql`${t.committedQuantity} >= 0`),
    check(
      "ck_goods_inventory_capacity",
      sql`${t.heldQuantity}::bigint + ${t.committedQuantity} <= ${t.saleableCapacity}`,
    ),
  ],
);

// SPEC-100 §39 `app.goods_order_items`, §40 `app.goods_sales_allocations` and §41 `app.goods_handoffs` (Part IX
// Goods). The DDL source of truth is migrations/0008_goods_fulfillment.sql (SPEC-100 §57, DB-MIG-002); every
// constraint carries its explicit name (DB-ARC-007) and the SQL text equals the migration's. State names are
// SPEC-030's (DB-STA-001); the DB CHECK guards the allowed values and the repository guards transitions with
// conditional updates (DB-STA-002, DB-GDS-004, DB-GDS-005). No shipping column exists (SPEC-100 §15.3).

export const goodsOrderItems = app.table(
  "goods_order_items",
  {
    orderItemId: bigint("order_item_id", { mode: "bigint" }).notNull(),
    publicRef: publicRef(),
    orderId: bigint("order_id", { mode: "bigint" }).notNull(),
    orderPurpose: text("order_purpose")
      .$type<"GOODS_PURCHASE" | "ENTRY_GOODS_PURCHASE">()
      .notNull(),
    customerProfileId: bigint("customer_profile_id", { mode: "bigint" }).notNull(),
    goodsId: bigint("goods_id", { mode: "bigint" }).notNull(),
    state: text("state").$type<"PENDING_PAYMENT" | "FULFILLABLE" | "CANCELED">().notNull(),
    createdAt: timestamptzNow("created_at"),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_goods_order_items", columns: [t.orderItemId] }),
    unique("uq_goods_order_items_public_ref").on(t.publicRef),
    // Composite foreign key target of the Allocation's Goods (SPEC-100 §40).
    unique("uq_goods_order_items_order_item_id_goods_id").on(t.orderItemId, t.goodsId),
    foreignKey({
      name: "fk_goods_order_items_order_item",
      columns: [t.orderItemId, t.orderId, t.orderPurpose],
      foreignColumns: [orderItems.id, orderItems.orderId, orderItems.purpose],
    }).onDelete("restrict"),
    // DB-GDS-002 / BR-GDS-008: the item's customer is the Order's customer.
    foreignKey({
      name: "fk_goods_order_items_order_customer",
      columns: [t.orderId, t.customerProfileId],
      foreignColumns: [orders.id, orders.customerProfileId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_goods_order_items_goods",
      columns: [t.orderItemId, t.goodsId],
      foreignColumns: [orderItems.id, orderItems.goodsId],
    }).onDelete("restrict"),
    check(
      "ck_goods_order_items_order_purpose",
      sql`${t.orderPurpose} IN ('GOODS_PURCHASE','ENTRY_GOODS_PURCHASE')`,
    ),
    check(
      "ck_goods_order_items_state",
      sql`${t.state} IN ('PENDING_PAYMENT','FULFILLABLE','CANCELED')`,
    ),
    index("ix_goods_order_items_customer_created").on(t.customerProfileId, t.createdAt.desc()),
  ],
);

// SPEC-100 §40 defines no state / timestamp CHECK for the Goods Allocation (plan U-1), unlike §18 for Entry.
export const goodsSalesAllocations = app.table(
  "goods_sales_allocations",
  {
    id: internalId(),
    goodsOrderItemId: bigint("goods_order_item_id", { mode: "bigint" }).notNull(),
    goodsId: bigint("goods_id", { mode: "bigint" }).notNull(),
    quantity: integer("quantity").notNull(),
    state: text("state").$type<"HELD" | "COMMITTED" | "RELEASED">().notNull(),
    heldAt: timestamptzNow("held_at"),
    committedAt: timestamptz("committed_at"),
    releasedAt: timestamptz("released_at"),
  },
  (t) => [
    primaryKey({ name: "pk_goods_sales_allocations", columns: [t.id] }),
    unique("uq_goods_sales_allocations_goods_order_item_id").on(t.goodsOrderItemId),
    foreignKey({
      name: "fk_goods_sales_allocations_goods_order_item",
      columns: [t.goodsOrderItemId],
      foreignColumns: [goodsOrderItems.orderItemId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_goods_sales_allocations_goods",
      columns: [t.goodsOrderItemId, t.goodsId],
      foreignColumns: [goodsOrderItems.orderItemId, goodsOrderItems.goodsId],
    }).onDelete("restrict"),
    check("ck_goods_sales_allocations_quantity", sql`${t.quantity} > 0`),
    check("ck_goods_sales_allocations_state", sql`${t.state} IN ('HELD','COMMITTED','RELEASED')`),
    index("ix_goods_allocations_goods_state").on(t.goodsId, t.state),
  ],
);

// SPEC-100 §41: COMPLETED requires both actor columns and completed_at (plan U-2).
export const goodsHandoffs = app.table(
  "goods_handoffs",
  {
    id: internalId(),
    publicRef: publicRef(),
    goodsOrderItemId: bigint("goods_order_item_id", { mode: "bigint" }).notNull(),
    state: text("state").$type<"PENDING" | "COMPLETED" | "VOID">().notNull(),
    completedByProfileId: bigint("completed_by_profile_id", { mode: "bigint" }),
    completedRoleAssignmentId: bigint("completed_role_assignment_id", { mode: "bigint" }),
    completedAt: timestamptz("completed_at"),
    voidedAt: timestamptz("voided_at"),
    createdAt: timestamptzNow("created_at"),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_goods_handoffs", columns: [t.id] }),
    unique("uq_goods_handoffs_public_ref").on(t.publicRef),
    unique("uq_goods_handoffs_goods_order_item_id").on(t.goodsOrderItemId),
    foreignKey({
      name: "fk_goods_handoffs_goods_order_item",
      columns: [t.goodsOrderItemId],
      foreignColumns: [goodsOrderItems.orderItemId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_goods_handoffs_completed_by_profile",
      columns: [t.completedByProfileId],
      foreignColumns: [businessProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_goods_handoffs_completed_role_assignment",
      columns: [t.completedRoleAssignmentId],
      foreignColumns: [roleAssignments.id],
    }).onDelete("restrict"),
    check("ck_goods_handoffs_state", sql`${t.state} IN ('PENDING','COMPLETED','VOID')`),
    check(
      "ck_goods_handoffs_state_times",
      sql`(${t.state} = 'PENDING' AND ${t.completedAt} IS NULL AND ${t.voidedAt} IS NULL) OR (${t.state} = 'COMPLETED' AND ${t.completedByProfileId} IS NOT NULL AND ${t.completedRoleAssignmentId} IS NOT NULL AND ${t.completedAt} IS NOT NULL AND ${t.voidedAt} IS NULL) OR (${t.state} = 'VOID' AND ${t.voidedAt} IS NOT NULL AND ${t.completedAt} IS NULL)`,
    ),
    index("ix_goods_handoffs_pending").on(t.createdAt).where(sql`${t.state} = 'PENDING'`),
  ],
);
