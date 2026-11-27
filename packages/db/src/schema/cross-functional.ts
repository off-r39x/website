import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./app-schema.ts";
import { bytea, internalId, publicRef, timestamptz, timestamptzNow } from "./common.ts";
import { entryTickets } from "./entry-tickets.ts";
import { goodsOrderItems } from "./goods.ts";
import { businessProfiles } from "./identity.ts";
import { karaokeHolds, karaokeReservations, karaokeSlots, karaokeTickets } from "./karaoke.ts";
import { orders } from "./orders.ts";
import { checkoutAttempts, paymentBindings, refundRecords } from "./payments.ts";

// SPEC-100 §43.1 `app.idempotency_records` (Part X Cross-functional). These declarations exist for types and
// queries; the DDL source of truth is migrations/0005_idempotency_records.sql (SPEC-100 §57, DB-MIG-002).
// Only digests and references are stored (DB-IDM-001): there is no column for a raw key, body, URL or Email.

export const idempotencyRecords = app.table(
  "idempotency_records",
  {
    id: internalId(),
    principalProfileId: bigint("principal_profile_id", { mode: "bigint" }).notNull(),
    operationId: text("operation_id").notNull(),
    keyDigest: bytea("key_digest").notNull(),
    requestDigest: bytea("request_digest").notNull(),
    resultRefType: text("result_ref_type"),
    resultRefs: uuid("result_refs").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamptzNow("created_at"),
    expiresAt: timestamptzNow("expires_at").default(
      sql`transaction_timestamp() + interval '24 hours'`,
    ),
  },
  (t) => [
    primaryKey({ name: "pk_idempotency_records", columns: [t.id] }),
    foreignKey({
      name: "fk_idempotency_records_principal_profile",
      columns: [t.principalProfileId],
      foreignColumns: [businessProfiles.id],
    }).onDelete("restrict"),
    check("ck_idempotency_records_key_digest", sql`octet_length(${t.keyDigest}) = 32`),
    check("ck_idempotency_records_request_digest", sql`octet_length(${t.requestDigest}) = 32`),
    check(
      "ck_idempotency_records_expiry",
      sql`${t.expiresAt} = ${t.createdAt} + interval '24 hours'`,
    ),
    check(
      "ck_idempotency_records_result_ref",
      sql`(${t.resultRefType} IS NULL) = (cardinality(${t.resultRefs}) = 0)`,
    ),
    uniqueIndex("ux_idempotency_records_principal_operation_key").on(
      t.principalProfileId,
      t.operationId,
      t.keyDigest,
    ),
  ],
);

// SPEC-100 §42 `app.notification_requests` and §43 `app.consistency_review_cases` (Part X Cross-functional,
// UCR-100-004). These declarations exist for types and queries; the DDL source of truth is
// migrations/0010_cross_functional.sql (SPEC-100 §57, DB-MIG-002). Every constraint carries its explicit name
// (DB-ARC-007) and the SQL text equals the migration's. The Notification state has no default (DB-STA-001..002,
// EML-DB-001); notification_type and reason_code have no allowlist CHECK (plan U-3). auth_subject has no foreign key
// and no index (DB-XFN-004). Writes go through notification-requests.ts and consistency-review-cases.ts.

export const notificationRequests = app.table(
  "notification_requests",
  {
    id: internalId(),
    businessCauseKey: uuid("business_cause_key").notNull(),
    notificationType: text("notification_type").notNull(),
    recipientProfileId: bigint("recipient_profile_id", { mode: "bigint" }).notNull(),
    sourceOrderId: bigint("source_order_id", { mode: "bigint" }),
    sourceReservationId: bigint("source_reservation_id", { mode: "bigint" }),
    state: text("state").$type<"PENDING" | "SENT" | "FAILED_RETRYABLE" | "CANCELED">().notNull(),
    renderContext: jsonb("render_context").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamptzNow("created_at"),
    sentAt: timestamptz("sent_at"),
    updatedAt: timestamptzNow("updated_at"),
  },
  (t) => [
    primaryKey({ name: "pk_notification_requests", columns: [t.id] }),
    // DB-XFN-001: one row per Business Cause (SPEC-120 §8.2-§8.3).
    unique("uq_notification_requests_business_cause_key").on(t.businessCauseKey),
    foreignKey({
      name: "fk_notification_requests_recipient_profile",
      columns: [t.recipientProfileId],
      foreignColumns: [businessProfiles.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_notification_requests_source_order",
      columns: [t.sourceOrderId],
      foreignColumns: [orders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_notification_requests_source_reservation",
      columns: [t.sourceReservationId],
      foreignColumns: [karaokeReservations.id],
    }).onDelete("restrict"),
    check(
      "ck_notification_requests_state",
      sql`${t.state} IN ('PENDING','SENT','FAILED_RETRYABLE','CANCELED')`,
    ),
    check(
      "ck_notification_requests_source",
      sql`${t.sourceOrderId} IS NOT NULL OR ${t.sourceReservationId} IS NOT NULL`,
    ),
    // SPEC-100 §45.6 (SQL-only DDL in 0010).
    index("ix_notification_requests_pending")
      .on(t.createdAt)
      .where(sql`${t.state} IN ('PENDING','FAILED_RETRYABLE')`),
  ],
);

export const consistencyReviewCases = app.table(
  "consistency_review_cases",
  {
    id: internalId(),
    publicRef: publicRef(),
    dedupeKey: text("dedupe_key").notNull(),
    reasonCode: text("reason_code").notNull(),
    orderId: bigint("order_id", { mode: "bigint" }),
    checkoutAttemptId: bigint("checkout_attempt_id", { mode: "bigint" }),
    paymentBindingId: bigint("payment_binding_id", { mode: "bigint" }),
    refundRecordId: bigint("refund_record_id", { mode: "bigint" }),
    karaokeSlotId: bigint("karaoke_slot_id", { mode: "bigint" }),
    karaokeHoldId: bigint("karaoke_hold_id", { mode: "bigint" }),
    karaokeReservationId: bigint("karaoke_reservation_id", { mode: "bigint" }),
    entryTicketId: bigint("entry_ticket_id", { mode: "bigint" }),
    karaokeTicketId: bigint("karaoke_ticket_id", { mode: "bigint" }),
    goodsOrderItemId: bigint("goods_order_item_id", { mode: "bigint" }),
    authSubject: uuid("auth_subject"),
    details: jsonb("details").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
    openedAt: timestamptzNow("opened_at"),
    resolvedAt: timestamptz("resolved_at"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    primaryKey({ name: "pk_consistency_review_cases", columns: [t.id] }),
    unique("uq_consistency_review_cases_public_ref").on(t.publicRef),
    // DB-XFN-002: one Case per incident.
    unique("uq_consistency_review_cases_dedupe_key").on(t.dedupeKey),
    // DB-XFN-003: the history a Case points at is kept, resolved or not.
    foreignKey({
      name: "fk_consistency_review_cases_order",
      columns: [t.orderId],
      foreignColumns: [orders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_checkout_attempt",
      columns: [t.checkoutAttemptId],
      foreignColumns: [checkoutAttempts.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_payment_binding",
      columns: [t.paymentBindingId],
      foreignColumns: [paymentBindings.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_refund_record",
      columns: [t.refundRecordId],
      foreignColumns: [refundRecords.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_karaoke_slot",
      columns: [t.karaokeSlotId],
      foreignColumns: [karaokeSlots.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_karaoke_hold",
      columns: [t.karaokeHoldId],
      foreignColumns: [karaokeHolds.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_karaoke_reservation",
      columns: [t.karaokeReservationId],
      foreignColumns: [karaokeReservations.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_entry_ticket",
      columns: [t.entryTicketId],
      foreignColumns: [entryTickets.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_karaoke_ticket",
      columns: [t.karaokeTicketId],
      foreignColumns: [karaokeTickets.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_consistency_review_cases_goods_order_item",
      columns: [t.goodsOrderItemId],
      foreignColumns: [goodsOrderItems.orderItemId],
    }).onDelete("restrict"),
    check(
      "ck_consistency_review_cases_target",
      sql`${t.orderId} IS NOT NULL OR ${t.checkoutAttemptId} IS NOT NULL OR ${t.paymentBindingId} IS NOT NULL OR ${t.refundRecordId} IS NOT NULL OR ${t.karaokeSlotId} IS NOT NULL OR ${t.karaokeHoldId} IS NOT NULL OR ${t.karaokeReservationId} IS NOT NULL OR ${t.entryTicketId} IS NOT NULL OR ${t.karaokeTicketId} IS NOT NULL OR ${t.goodsOrderItemId} IS NOT NULL OR ${t.authSubject} IS NOT NULL`,
    ),
    // UCR-100-004: auth_subject is set exactly for AUTH_PROFILE_RELATION_INCONSISTENT.
    check(
      "ck_consistency_review_cases_auth_subject",
      sql`(${t.authSubject} IS NOT NULL) = (${t.reasonCode} = 'AUTH_PROFILE_RELATION_INCONSISTENT')`,
    ),
    // SPEC-100 §43, REL-REC-009 (SQL-only DDL in 0010).
    index("ix_consistency_review_cases_unresolved")
      .on(t.openedAt)
      .where(sql`${t.resolvedAt} IS NULL`),
  ],
);
