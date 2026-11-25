// PR-L1-1c test harness: the hand-written goldens of the two cross-functional tables of migration 0010
// (app.notification_requests and app.consistency_review_cases; SPEC-100 §42, §43, §45.6, §7.2, §8, §10, §11;
// UCR-100-004; plan U-3, U-6) in the PostgreSQL 17 catalog notation (format_type, pg_get_expr,
// pg_get_constraintdef, pg_get_indexdef). They are written from the specification and the approved plan decisions,
// never derived from schema-contract.json or from the migration, so the contract, the Drizzle declaration and the
// live catalog are each checked against them. `declared` is the raw SQL the Drizzle declaration must carry (column
// references without the "app"."<table>" qualifier). No database and no production import: the unit test of the
// Drizzle declaration and the real PG17 test both use this file. The shape follows entry-ticket-qr-golden.ts
// (PR-L1-1b); its types are those of orders-payments-golden.ts (PR-L1-1a). Notification Request states are SPEC-030
// / SPEC-120 §7; the reason codes and notification types have no CHECK (plan U-3).

import type {
  GoldenColumn,
  GoldenConstraint,
  GoldenForeignKey,
  GoldenIndex,
  GoldenTable,
} from "./orders-payments-golden.ts";

const TSTZ = "timestamp with time zone";
const NOW = "transaction_timestamp()";
const EMPTY_JSONB = "'{}'::jsonb";

export const NOTIFICATION_REQUEST_STATES = [
  "PENDING",
  "SENT",
  "FAILED_RETRYABLE",
  "CANCELED",
] as const;
/** SPEC-100 §45.6: the states the Email Worker still has to process. */
export const NOTIFICATION_PENDING_STATES = ["PENDING", "FAILED_RETRYABLE"] as const;
export const AUTH_REASON = "AUTH_PROFILE_RELATION_INCONSISTENT";

export const NOTIFICATION_REQUESTS = "notification_requests";
export const CONSISTENCY_REVIEW_CASES = "consistency_review_cases";
/** Creation order of migration 0010. */
export const CROSS_FUNCTIONAL_TABLES = [NOTIFICATION_REQUESTS, CONSISTENCY_REVIEW_CASES] as const;
export const CROSS_FUNCTIONAL_SEQUENCES = [
  `${NOTIFICATION_REQUESTS}_id_seq`,
  `${CONSISTENCY_REVIEW_CASES}_id_seq`,
] as const;

export const NOTIFICATION_PENDING_INDEX = "ix_notification_requests_pending";
export const REVIEW_UNRESOLVED_INDEX = "ix_consistency_review_cases_unresolved";

/**
 * SPEC-100 §43: the ten target columns of a Case, with the parent table, its key column and the Drizzle export of
 * the parent. goods_order_items is keyed by order_item_id (SPEC-100 §39).
 */
export const REVIEW_TARGETS = [
  ["order_id", "orders", "id", "orders", "order"],
  ["checkout_attempt_id", "checkout_attempts", "id", "checkoutAttempts", "checkout_attempt"],
  ["payment_binding_id", "payment_bindings", "id", "paymentBindings", "payment_binding"],
  ["refund_record_id", "refund_records", "id", "refundRecords", "refund_record"],
  ["karaoke_slot_id", "karaoke_slots", "id", "karaokeSlots", "karaoke_slot"],
  ["karaoke_hold_id", "karaoke_holds", "id", "karaokeHolds", "karaoke_hold"],
  [
    "karaoke_reservation_id",
    "karaoke_reservations",
    "id",
    "karaokeReservations",
    "karaoke_reservation",
  ],
  ["entry_ticket_id", "entry_tickets", "id", "entryTickets", "entry_ticket"],
  ["karaoke_ticket_id", "karaoke_tickets", "id", "karaokeTickets", "karaoke_ticket"],
  [
    "goods_order_item_id",
    "goods_order_items",
    "order_item_id",
    "goodsOrderItems",
    "goods_order_item",
  ],
] as const;

const idColumn = (): GoldenColumn => ["id", "bigint", true, "a", "", null];
const publicRef = (): GoldenColumn => ["public_ref", "uuid", true, "", "", "gen_random_uuid()"];
const now = (name: string): GoldenColumn => [name, TSTZ, true, "", "", NOW];
const emptyJsonb = (name: string): GoldenColumn => [name, "jsonb", true, "", "", EMPTY_JSONB];
const col = (name: string, type: string, notNull = true): GoldenColumn => [
  name,
  type,
  notNull,
  "",
  "",
  null,
];

const pk = (table: string): GoldenConstraint => ({
  name: `pk_${table}`,
  kind: "p",
  definition: "PRIMARY KEY (id)",
});
const uq = (table: string, columns: string[]): GoldenConstraint => ({
  name: `uq_${table}_${columns.join("_")}`,
  kind: "u",
  definition: `UNIQUE (${columns.join(", ")})`,
});
const check = (name: string, definition: string, declared: string): GoldenConstraint => ({
  name,
  kind: "c",
  definition: `CHECK (${definition})`,
  declared,
});
const list = (values: readonly string[]) => values.map((v) => `'${v}'::text`).join(", ");
const declaredList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");
const allowlist = (name: string, column: string, values: readonly string[]): GoldenConstraint =>
  check(
    name,
    `(${column} = ANY (ARRAY[${list(values)}]))`,
    `${column} IN (${declaredList(values)})`,
  );
const pkIndex = (table: string): GoldenIndex => ({
  name: `pk_${table}`,
  definition: `CREATE UNIQUE INDEX pk_${table} ON app.${table} USING btree (id)`,
});
const uqIndex = (table: string, columns: string[]): GoldenIndex => ({
  name: `uq_${table}_${columns.join("_")}`,
  definition: `CREATE UNIQUE INDEX uq_${table}_${columns.join("_")} ON app.${table} USING btree (${columns.join(", ")})`,
});
const fkConstraint = (fk: GoldenForeignKey): GoldenConstraint => ({
  name: fk.name,
  kind: "f",
  definition: `FOREIGN KEY (${fk.columns.join(", ")}) REFERENCES app.${fk.parentTable}(${fk.parentColumns.join(", ")}) ON DELETE RESTRICT`,
});
const fk = (
  name: string,
  columns: string[],
  parentExport: string,
  parentTable: string,
  parentColumns: string[] = ["id"],
): GoldenForeignKey => ({ name, columns, parentExport, parentTable, parentColumns });

function table(
  exportName: string,
  name: string,
  columns: GoldenColumn[],
  rest: {
    uniques: string[][];
    foreignKeys: GoldenForeignKey[];
    checks: GoldenConstraint[];
    indexes: GoldenIndex[];
  },
): GoldenTable {
  return {
    exportName,
    table: name,
    columns,
    constraints: [
      pk(name),
      ...rest.uniques.map((u) => uq(name, u)),
      ...rest.foreignKeys.map(fkConstraint),
      ...rest.checks,
    ],
    foreignKeys: rest.foreignKeys,
    indexes: [pkIndex(name), ...rest.uniques.map((u) => uqIndex(name, u)), ...rest.indexes],
  };
}

// ---- SPEC-100 §42 notification_requests --------------------------------------------------------------
// DB-XFN-001: one row per Business Cause (UNIQUE business_cause_key); a retry updates that row. §42 CHECK: a source
// Order or Reservation exists. EML-DB-001: state keeps the four SPEC-030 states only, and has no default (the
// repository always writes PENDING; plan U-6). Plan U-3: notification_type has no CHECK. DB-TIM-002: created_at and
// updated_at default to transaction_timestamp(). Plan U-6: every foreign key is ON DELETE RESTRICT.
const notificationRequestsTable = table(
  "notificationRequests",
  NOTIFICATION_REQUESTS,
  [
    idColumn(),
    col("business_cause_key", "uuid"),
    col("notification_type", "text"),
    col("recipient_profile_id", "bigint"),
    col("source_order_id", "bigint", false),
    col("source_reservation_id", "bigint", false),
    col("state", "text"),
    emptyJsonb("render_context"),
    now("created_at"),
    col("sent_at", TSTZ, false),
    now("updated_at"),
  ],
  {
    uniques: [["business_cause_key"]],
    foreignKeys: [
      fk(
        "fk_notification_requests_recipient_profile",
        ["recipient_profile_id"],
        "businessProfiles",
        "business_profiles",
      ),
      fk("fk_notification_requests_source_order", ["source_order_id"], "orders", "orders"),
      fk(
        "fk_notification_requests_source_reservation",
        ["source_reservation_id"],
        "karaokeReservations",
        "karaoke_reservations",
      ),
    ],
    checks: [
      allowlist("ck_notification_requests_state", "state", NOTIFICATION_REQUEST_STATES),
      check(
        "ck_notification_requests_source",
        "((source_order_id IS NOT NULL) OR (source_reservation_id IS NOT NULL))",
        "source_order_id IS NOT NULL OR source_reservation_id IS NOT NULL",
      ),
    ],
    indexes: [
      {
        name: NOTIFICATION_PENDING_INDEX,
        definition: `CREATE INDEX ${NOTIFICATION_PENDING_INDEX} ON app.${NOTIFICATION_REQUESTS} USING btree (created_at) WHERE (state = ANY (ARRAY[${list(NOTIFICATION_PENDING_STATES)}]))`,
        declared: {
          columns: [["created_at", "asc"]],
          unique: false,
          where: `state IN (${declaredList(NOTIFICATION_PENDING_STATES)})`,
        },
      },
    ],
  },
);

// ---- SPEC-100 §43 consistency_review_cases ---------------------------------------------------------
// DB-XFN-002: one Case per incident (UNIQUE dedupe_key). DB-XFN-003: the ten target foreign keys are RESTRICT, so a
// resolved Case never lets the history it points at be deleted. DB-XFN-004 / UCR-100-004: auth_subject has no
// foreign key and no index, and is set exactly for AUTH_PROFILE_RELATION_INCONSISTENT. §43 CHECK: a target or
// auth_subject is set. REL-REC-009: resolved_at IS NULL is the unresolved predicate (the §43 partial index).
// Plan U-3: reason_code has no CHECK.
const consistencyReviewCasesTable = table(
  "consistencyReviewCases",
  CONSISTENCY_REVIEW_CASES,
  [
    idColumn(),
    publicRef(),
    col("dedupe_key", "text"),
    col("reason_code", "text"),
    ...REVIEW_TARGETS.map(([column]) => col(column, "bigint", false)),
    col("auth_subject", "uuid", false),
    emptyJsonb("details"),
    now("opened_at"),
    col("resolved_at", TSTZ, false),
    col("resolution_note", "text", false),
  ],
  {
    uniques: [["public_ref"], ["dedupe_key"]],
    foreignKeys: REVIEW_TARGETS.map(([column, parentTable, parentColumn, parentExport, stem]) =>
      fk(`fk_consistency_review_cases_${stem}`, [column], parentExport, parentTable, [
        parentColumn,
      ]),
    ),
    checks: [
      check(
        "ck_consistency_review_cases_target",
        `(${[...REVIEW_TARGETS.map(([column]) => column), "auth_subject"].map((c) => `(${c} IS NOT NULL)`).join(" OR ")})`,
        [...REVIEW_TARGETS.map(([column]) => column), "auth_subject"]
          .map((c) => `${c} IS NOT NULL`)
          .join(" OR "),
      ),
      check(
        "ck_consistency_review_cases_auth_subject",
        `((auth_subject IS NOT NULL) = (reason_code = '${AUTH_REASON}'::text))`,
        `(auth_subject IS NOT NULL) = (reason_code = '${AUTH_REASON}')`,
      ),
    ],
    indexes: [
      {
        name: REVIEW_UNRESOLVED_INDEX,
        definition: `CREATE INDEX ${REVIEW_UNRESOLVED_INDEX} ON app.${CONSISTENCY_REVIEW_CASES} USING btree (opened_at) WHERE (resolved_at IS NULL)`,
        declared: {
          columns: [["opened_at", "asc"]],
          unique: false,
          where: "resolved_at IS NULL",
        },
      },
    ],
  },
);

export const GOLDEN_TABLES: readonly GoldenTable[] = [
  notificationRequestsTable,
  consistencyReviewCasesTable,
];

/**
 * Sizes counted by hand from SPEC-100 §42, §43 and the plan (guards against empty comparisons): columns,
 * constraints (PK + UNIQUE + FK + CHECK) and indexes (PK + UNIQUE + the §43 / §45.6 indexes) per table.
 */
export const SPEC_COLUMN_COUNTS = [11, 19];
export const SPEC_CONSTRAINT_COUNTS = [7, 15];
export const SPEC_INDEX_COUNTS = [3, 4];

/** The separately created indexes of 0010 (SPEC-100 §43, §45.6), in name order. */
export const SEPARATE_INDEX_NAMES = GOLDEN_TABLES.flatMap((g) =>
  g.indexes.filter((i) => i.declared).map((i) => i.name),
).sort();
