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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./app-schema.ts";
import { internalId, publicRef, timestamptz, timestamptzNow } from "./common.ts";
import { businessProfiles, roleAssignments } from "./identity.ts";
import { orderItems, orders } from "./orders.ts";
import { events } from "./public-content.ts";
import { karaokeSalesConfigurations } from "./sales.ts";

// SPEC-100 §27 `app.karaoke_exclusive_scopes` and §28 `app.karaoke_slots`. These declarations exist for
// types and queries; the DDL source of truth is migrations/0004_karaoke_scopes_slots.sql (SPEC-100 §57,
// DB-MIG-002). Every constraint carries its explicit name (DB-ARC-007) and the SQL text equals the
// migration's. The Scope overlap exclusion `ex_karaoke_slots_scope_occupancy` (SPEC-100 §28.1) exists only
// in that migration (SQL-only DDL): it is deliberately not declared here, so it is never generated twice.

export const karaokeExclusiveScopes = app.table(
  "karaoke_exclusive_scopes",
  {
    id: internalId(),
    publicRef: publicRef(),
    eventId: bigint("event_id", { mode: "bigint" }).notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamptzNow("created_at"),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_karaoke_exclusive_scopes", columns: [t.id] }),
    unique("uq_karaoke_exclusive_scopes_public_ref").on(t.publicRef),
    foreignKey({
      name: "fk_karaoke_exclusive_scopes_event",
      columns: [t.eventId],
      foreignColumns: [events.id],
    }).onDelete("restrict"),
  ],
);

export const karaokeSlots = app.table(
  "karaoke_slots",
  {
    id: internalId(),
    publicRef: publicRef(),
    exclusiveScopeId: bigint("exclusive_scope_id", { mode: "bigint" }).notNull(),
    salesConfigurationId: bigint("sales_configuration_id", { mode: "bigint" }).notNull(),
    state: text("state").$type<"AVAILABLE" | "HELD" | "SOLD" | "SALES_STOPPED">().notNull(),
    usageStart: timestamptz("usage_start").notNull(),
    usageEnd: timestamptz("usage_end").notNull(),
    cycleEnd: timestamptz("cycle_end").notNull(),
    generationCauseKey: uuid("generation_cause_key").notNull(),
    generationCandidateNo: integer("generation_candidate_no").notNull(),
    createdAt: timestamptzNow("created_at"),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_karaoke_slots", columns: [t.id] }),
    unique("uq_karaoke_slots_public_ref").on(t.publicRef),
    unique("uq_karaoke_slots_scope_times").on(
      t.exclusiveScopeId,
      t.usageStart,
      t.usageEnd,
      t.cycleEnd,
    ),
    unique("uq_karaoke_slots_generation_candidate").on(
      t.generationCauseKey,
      t.exclusiveScopeId,
      t.generationCandidateNo,
    ),
    foreignKey({
      name: "fk_karaoke_slots_exclusive_scope",
      columns: [t.exclusiveScopeId],
      foreignColumns: [karaokeExclusiveScopes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_karaoke_slots_sales_configuration",
      columns: [t.salesConfigurationId],
      foreignColumns: [karaokeSalesConfigurations.id],
    }).onDelete("restrict"),
    check("ck_karaoke_slots_state", sql`${t.state} IN ('AVAILABLE','HELD','SOLD','SALES_STOPPED')`),
    check("ck_karaoke_slots_usage_period", sql`${t.usageStart} < ${t.usageEnd}`),
    check("ck_karaoke_slots_cycle_end", sql`${t.usageEnd} <= ${t.cycleEnd}`),
    check("ck_karaoke_slots_generation_candidate_no", sql`${t.generationCandidateNo} >= 0`),
    index("ix_karaoke_slots_usage_start").on(t.usageStart),
    index("ix_karaoke_slots_scope_usage").on(t.exclusiveScopeId, t.usageStart),
  ],
);

// SPEC-100 §30 `app.karaoke_holds`, §33 `app.karaoke_reservations`, §34 `app.karaoke_tickets` and §37
// `app.karaoke_checkins`. The DDL source of truth is migrations/0007_karaoke_reservations.sql (SPEC-100 §57,
// DB-MIG-002); these declarations exist for types and queries, carry the same explicit names (DB-ARC-007) and the
// same SQL text. The parent tables of orders.ts and identity.ts are referenced only inside the lazily evaluated
// constraint callbacks, so the orders.ts <-> karaoke.ts import cycle is safe.

export const karaokeHolds = app.table(
  "karaoke_holds",
  {
    id: internalId(),
    publicRef: publicRef(),
    orderId: bigint("order_id", { mode: "bigint" }).notNull(),
    orderItemId: bigint("order_item_id", { mode: "bigint" }).notNull(),
    orderPurpose: text("order_purpose")
      .$type<"KARAOKE_PURCHASE">()
      .notNull()
      .default("KARAOKE_PURCHASE"),
    customerProfileId: bigint("customer_profile_id", { mode: "bigint" }).notNull(),
    slotId: bigint("slot_id", { mode: "bigint" }).notNull(),
    state: text("state").$type<"ACTIVE" | "COMMITTED" | "RELEASED" | "EXPIRED">().notNull(),
    holdAcquiredAt: timestamptzNow("hold_acquired_at"),
    // DB-KRK-006 / UCR-100-006: acquisition + 45 minutes, taken in UTC so the expression is IMMUTABLE.
    holdExpiresAt: timestamptz("hold_expires_at").generatedAlwaysAs(
      sql`((hold_acquired_at AT TIME ZONE 'UTC') + interval '45 minutes') AT TIME ZONE 'UTC'`,
    ),
    committedAt: timestamptz("committed_at"),
    releasedAt: timestamptz("released_at"),
    expiredAt: timestamptz("expired_at"),
    createdAt: timestamptzNow("created_at"),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_karaoke_holds", columns: [t.id] }),
    unique("uq_karaoke_holds_public_ref").on(t.publicRef),
    unique("uq_karaoke_holds_order_item_id").on(t.orderItemId),
    unique("uq_karaoke_holds_reservation_target").on(
      t.id,
      t.orderId,
      t.orderItemId,
      t.customerProfileId,
      t.slotId,
    ),
    foreignKey({
      name: "fk_karaoke_holds_order_item",
      columns: [t.orderItemId, t.orderId, t.orderPurpose, t.slotId],
      foreignColumns: [
        orderItems.id,
        orderItems.orderId,
        orderItems.purpose,
        orderItems.karaokeSlotId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_karaoke_holds_order",
      columns: [t.orderId, t.customerProfileId],
      foreignColumns: [orders.id, orders.customerProfileId],
    }).onDelete("restrict"),
    check("ck_karaoke_holds_order_purpose", sql`${t.orderPurpose} = 'KARAOKE_PURCHASE'`),
    check("ck_karaoke_holds_state", sql`${t.state} IN ('ACTIVE','COMMITTED','RELEASED','EXPIRED')`),
    check(
      "ck_karaoke_holds_state_times",
      sql`(${t.state} = 'ACTIVE' AND ${t.committedAt} IS NULL AND ${t.releasedAt} IS NULL AND ${t.expiredAt} IS NULL) OR (${t.state} = 'COMMITTED' AND ${t.committedAt} IS NOT NULL) OR (${t.state} = 'RELEASED' AND ${t.releasedAt} IS NOT NULL) OR (${t.state} = 'EXPIRED' AND ${t.expiredAt} IS NOT NULL)`,
    ),
    uniqueIndex("ux_karaoke_holds_slot_active").on(t.slotId).where(sql`${t.state} = 'ACTIVE'`),
    index("ix_karaoke_holds_customer_active")
      .on(t.customerProfileId, t.slotId)
      .where(sql`${t.state} = 'ACTIVE'`),
  ],
);

export const karaokeReservations = app.table(
  "karaoke_reservations",
  {
    id: internalId(),
    publicRef: publicRef(),
    orderId: bigint("order_id", { mode: "bigint" }).notNull(),
    orderItemId: bigint("order_item_id", { mode: "bigint" }).notNull(),
    holdId: bigint("hold_id", { mode: "bigint" }).notNull(),
    customerProfileId: bigint("customer_profile_id", { mode: "bigint" }).notNull(),
    slotId: bigint("slot_id", { mode: "bigint" }).notNull(),
    state: text("state").$type<"CONFIRMED" | "CANCELED">().notNull(),
    usageStartSnapshot: timestamptz("usage_start_snapshot").notNull(),
    usageEndSnapshot: timestamptz("usage_end_snapshot").notNull(),
    confirmedAt: timestamptzNow("confirmed_at"),
    canceledAt: timestamptz("canceled_at"),
    createdAt: timestamptzNow("created_at"),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_karaoke_reservations", columns: [t.id] }),
    unique("uq_karaoke_reservations_public_ref").on(t.publicRef),
    unique("uq_karaoke_reservations_order_item_id").on(t.orderItemId),
    unique("uq_karaoke_reservations_slot_id").on(t.slotId),
    unique("uq_karaoke_reservations_hold_id").on(t.holdId),
    unique("uq_karaoke_reservations_id_customer_profile_id").on(t.id, t.customerProfileId),
    foreignKey({
      name: "fk_karaoke_reservations_hold",
      columns: [t.holdId, t.orderId, t.orderItemId, t.customerProfileId, t.slotId],
      foreignColumns: [
        karaokeHolds.id,
        karaokeHolds.orderId,
        karaokeHolds.orderItemId,
        karaokeHolds.customerProfileId,
        karaokeHolds.slotId,
      ],
    }).onDelete("restrict"),
    check("ck_karaoke_reservations_state", sql`${t.state} IN ('CONFIRMED','CANCELED')`),
    check(
      "ck_karaoke_reservations_usage_snapshot",
      sql`${t.usageStartSnapshot} < ${t.usageEndSnapshot}`,
    ),
    check(
      "ck_karaoke_reservations_canceled_at",
      sql`(${t.state} = 'CANCELED') = (${t.canceledAt} IS NOT NULL)`,
    ),
    index("ix_karaoke_reservations_customer_time").on(
      t.customerProfileId,
      t.usageStartSnapshot.desc(),
    ),
    index("ix_karaoke_reservations_state_time").on(t.state, t.usageStartSnapshot.desc()),
  ],
);

export const karaokeTickets = app.table(
  "karaoke_tickets",
  {
    id: internalId(),
    publicRef: publicRef(),
    reservationId: bigint("reservation_id", { mode: "bigint" }).notNull(),
    ownerProfileId: bigint("owner_profile_id", { mode: "bigint" }).notNull(),
    state: text("state").$type<"VALID" | "USED" | "CANCELED" | "EXPIRED">().notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    issuedAt: timestamptzNow("issued_at"),
    stateChangedAt: timestamptzNow("state_changed_at"),
  },
  (t) => [
    primaryKey({ name: "pk_karaoke_tickets", columns: [t.id] }),
    unique("uq_karaoke_tickets_public_ref").on(t.publicRef),
    unique("uq_karaoke_tickets_reservation_id").on(t.reservationId),
    foreignKey({
      name: "fk_karaoke_tickets_reservation",
      columns: [t.reservationId, t.ownerProfileId],
      foreignColumns: [karaokeReservations.id, karaokeReservations.customerProfileId],
    }).onDelete("restrict"),
    check("ck_karaoke_tickets_state", sql`${t.state} IN ('VALID','USED','CANCELED','EXPIRED')`),
  ],
);

export const karaokeCheckins = app.table(
  "karaoke_checkins",
  {
    id: internalId(),
    karaokeTicketId: bigint("karaoke_ticket_id", { mode: "bigint" }).notNull(),
    staffProfileId: bigint("staff_profile_id", { mode: "bigint" }).notNull(),
    staffRoleAssignmentId: bigint("staff_role_assignment_id", { mode: "bigint" }).notNull(),
    checkedInAt: timestamptzNow("checked_in_at"),
    createdAt: timestamptzNow("created_at"),
  },
  (t) => [
    primaryKey({ name: "pk_karaoke_checkins", columns: [t.id] }),
    unique("uq_karaoke_checkins_karaoke_ticket_id").on(t.karaokeTicketId),
    foreignKey({
      name: "fk_karaoke_checkins_karaoke_ticket",
      columns: [t.karaokeTicketId],
      foreignColumns: [karaokeTickets.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_karaoke_checkins_staff_profile",
      columns: [t.staffProfileId],
      foreignColumns: [businessProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_karaoke_checkins_staff_role_assignment",
      columns: [t.staffRoleAssignmentId],
      foreignColumns: [roleAssignments.id],
    }).onDelete("restrict"),
  ],
);
