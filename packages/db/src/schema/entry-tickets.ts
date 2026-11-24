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
} from "drizzle-orm/pg-core";
import { app } from "./app-schema.ts";
import { bytea, internalId, publicRef, timestamptz, timestamptzNow } from "./common.ts";
import { businessProfiles, roleAssignments } from "./identity.ts";
import { karaokeTickets } from "./karaoke.ts";
import { entrySalesAllocations, orderItems, orders } from "./orders.ts";

// SPEC-100 §24 `app.entry_tickets`, §25 `app.qr_tokens` and §26 `app.entry_checkins` (Part VII). These
// declarations exist for types and queries; the DDL source of truth is migrations/0009_entry_ticket_qr_checkin.sql
// (SPEC-100 §57, DB-MIG-002). Every constraint carries its explicit name (DB-ARC-007) and the SQL text equals the
// migration's. State, purpose and format version columns have no default (DB-STA-001..002). QR Tokens keep no
// plaintext column (DB-TQR-002): only the lookup digest and the encrypted envelope, both bytea. The QR Token's
// Karaoke Ticket reference makes this file depend on karaoke.ts.

export const entryTickets = app.table(
  "entry_tickets",
  {
    id: internalId(),
    publicRef: publicRef(),
    orderId: bigint("order_id", { mode: "bigint" }).notNull(),
    orderItemId: bigint("order_item_id", { mode: "bigint" }).notNull(),
    orderPurpose: text("order_purpose")
      .$type<"ENTRY_TICKET_PURCHASE" | "ENTRY_GOODS_PURCHASE">()
      .notNull(),
    ownerProfileId: bigint("owner_profile_id", { mode: "bigint" }).notNull(),
    issuanceOrdinal: integer("issuance_ordinal").notNull(),
    state: text("state").$type<"VALID" | "USED" | "CANCELED" | "EXPIRED">().notNull(),
    validFrom: timestamptz("valid_from"),
    validUntil: timestamptz("valid_until"),
    issuedAt: timestamptzNow("issued_at"),
    stateChangedAt: timestamptzNow("state_changed_at"),
  },
  (t) => [
    primaryKey({ name: "pk_entry_tickets", columns: [t.id] }),
    unique("uq_entry_tickets_public_ref").on(t.publicRef),
    // DB-TQR-001: one Ticket per (Order Item, issuance ordinal).
    unique("uq_entry_tickets_order_item_id_issuance_ordinal").on(t.orderItemId, t.issuanceOrdinal),
    foreignKey({
      name: "fk_entry_tickets_order_item",
      columns: [t.orderItemId, t.orderId, t.orderPurpose],
      foreignColumns: [orderItems.id, orderItems.orderId, orderItems.purpose],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_entry_tickets_order",
      columns: [t.orderId, t.ownerProfileId],
      foreignColumns: [orders.id, orders.customerProfileId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_entry_tickets_entry_sales_allocation",
      columns: [t.orderItemId],
      foreignColumns: [entrySalesAllocations.orderItemId],
    }).onDelete("restrict"),
    check(
      "ck_entry_tickets_order_purpose",
      sql`${t.orderPurpose} IN ('ENTRY_TICKET_PURCHASE','ENTRY_GOODS_PURCHASE')`,
    ),
    check("ck_entry_tickets_issuance_ordinal", sql`${t.issuanceOrdinal} > 0`),
    check("ck_entry_tickets_state", sql`${t.state} IN ('VALID','USED','CANCELED','EXPIRED')`),
    check(
      "ck_entry_tickets_valid_period",
      sql`${t.validFrom} IS NULL OR ${t.validUntil} IS NULL OR ${t.validFrom} < ${t.validUntil}`,
    ),
    // SPEC-100 §45.1: Customer -> Entry Ticket.
    index("ix_entry_tickets_owner_issued").on(t.ownerProfileId, t.issuedAt.desc()),
  ],
);

export const qrTokens = app.table(
  "qr_tokens",
  {
    id: internalId(),
    formatVersion: text("format_version").$type<"r39x1">().notNull(),
    purpose: text("purpose").$type<"ENTRY" | "KARAOKE">().notNull(),
    entryTicketId: bigint("entry_ticket_id", { mode: "bigint" }),
    karaokeTicketId: bigint("karaoke_ticket_id", { mode: "bigint" }),
    lifecycleState: text("lifecycle_state").$type<"ACTIVE" | "REVOKED">().notNull(),
    lookupDigest: bytea("lookup_digest").notNull(),
    protectedTokenMaterial: bytea("protected_token_material").notNull(),
    protectionKeyVersion: integer("protection_key_version").notNull(),
    issuedAt: timestamptzNow("issued_at"),
    revokedAt: timestamptz("revoked_at"),
  },
  (t) => [
    primaryKey({ name: "pk_qr_tokens", columns: [t.id] }),
    unique("uq_qr_tokens_lookup_digest").on(t.lookupDigest),
    foreignKey({
      name: "fk_qr_tokens_entry_ticket",
      columns: [t.entryTicketId],
      foreignColumns: [entryTickets.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_qr_tokens_karaoke_ticket",
      columns: [t.karaokeTicketId],
      foreignColumns: [karaokeTickets.id],
    }).onDelete("restrict"),
    check("ck_qr_tokens_format_version", sql`${t.formatVersion} = 'r39x1'`),
    check("ck_qr_tokens_purpose", sql`${t.purpose} IN ('ENTRY','KARAOKE')`),
    // TQR-TOK-006 / TQR-TOK-007: the Entry and Karaoke purposes stay apart.
    check(
      "ck_qr_tokens_purpose_target",
      sql`(${t.purpose} = 'ENTRY' AND ${t.entryTicketId} IS NOT NULL AND ${t.karaokeTicketId} IS NULL) OR (${t.purpose} = 'KARAOKE' AND ${t.entryTicketId} IS NULL AND ${t.karaokeTicketId} IS NOT NULL)`,
    ),
    check("ck_qr_tokens_lifecycle_state", sql`${t.lifecycleState} IN ('ACTIVE','REVOKED')`),
    check(
      "ck_qr_tokens_revoked_at",
      sql`(${t.lifecycleState} = 'REVOKED') = (${t.revokedAt} IS NOT NULL)`,
    ),
    check("ck_qr_tokens_lookup_digest_length", sql`octet_length(${t.lookupDigest}) = 32`),
    check("ck_qr_tokens_protection_key_version", sql`${t.protectionKeyVersion} > 0`),
    // SPEC-100 §25 / §45.5, TQR-TOK-013: at most one ACTIVE Token per Entry / Karaoke Ticket (SQL-only DDL in 0009).
    uniqueIndex("ux_qr_tokens_entry_active")
      .on(t.entryTicketId)
      .where(sql`${t.lifecycleState} = 'ACTIVE' AND ${t.entryTicketId} IS NOT NULL`),
    uniqueIndex("ux_qr_tokens_karaoke_active")
      .on(t.karaokeTicketId)
      .where(sql`${t.lifecycleState} = 'ACTIVE' AND ${t.karaokeTicketId} IS NOT NULL`),
  ],
);

export const entryCheckins = app.table(
  "entry_checkins",
  {
    id: internalId(),
    entryTicketId: bigint("entry_ticket_id", { mode: "bigint" }).notNull(),
    staffProfileId: bigint("staff_profile_id", { mode: "bigint" }).notNull(),
    staffRoleAssignmentId: bigint("staff_role_assignment_id", { mode: "bigint" }).notNull(),
    checkedInAt: timestamptzNow("checked_in_at"),
    createdAt: timestamptzNow("created_at"),
  },
  (t) => [
    primaryKey({ name: "pk_entry_checkins", columns: [t.id] }),
    // INV-010-05: at most one Entry Check-in per Ticket.
    unique("uq_entry_checkins_entry_ticket_id").on(t.entryTicketId),
    foreignKey({
      name: "fk_entry_checkins_entry_ticket",
      columns: [t.entryTicketId],
      foreignColumns: [entryTickets.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_entry_checkins_staff_profile",
      columns: [t.staffProfileId],
      foreignColumns: [businessProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_entry_checkins_staff_role_assignment",
      columns: [t.staffRoleAssignmentId],
      foreignColumns: [roleAssignments.id],
    }).onDelete("restrict"),
  ],
);
