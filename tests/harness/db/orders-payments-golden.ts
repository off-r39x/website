// PR-L1-1a test harness: the hand-written goldens of the seven Order / payment tables of migration 0006
// (SPEC-100 §16-§18, §20-§23, §45.1-§45.3, §45.7, §9, §10; plan U-1..U-5) in the PostgreSQL 17 catalog notation
// (format_type, pg_get_expr, pg_get_constraintdef, pg_get_indexdef). They are written from the specification and
// the approved plan decisions, never derived from schema-contract.json or from the migration, so the contract, the
// Drizzle declaration and the live catalog are each checked against them. `declared` is the raw SQL the Drizzle
// declaration must carry (column references without the "app"."<table>" qualifier). No database and no production
// import: the unit test of the Drizzle declaration and the real PG17 test both use this file. State names are those
// of SPEC-030 (Order, Allocation) and SPEC-070 §17 / §37 (Webhook Receipt, Refund).

const TSTZ = "timestamp with time zone";
const NOW = "transaction_timestamp()";

export const ORDER_STATES = [
  "PREPARED",
  "AWAITING_PAYMENT",
  "CONFIRMED",
  "PAYMENT_FAILED",
  "CANCELED",
  "EXPIRED",
  "REVIEW_REQUIRED",
] as const;
export const ORDER_PURPOSES = [
  "ENTRY_TICKET_PURCHASE",
  "KARAOKE_PURCHASE",
  "GOODS_PURCHASE",
  "ENTRY_GOODS_PURCHASE",
] as const;
export const ENTRY_ALLOCATION_PURPOSES = ["ENTRY_TICKET_PURCHASE", "ENTRY_GOODS_PURCHASE"] as const;
export const ENTRY_ALLOCATION_STATES = ["HELD", "COMMITTED", "RELEASED"] as const;
export const CHECKOUT_CREATION_RESULTS = ["PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"] as const;
export const WEBHOOK_PROCESSING_STATES = [
  "RECEIVED",
  "PROCESSED",
  "IGNORED",
  "FAILED_RETRYABLE",
  "REVIEW_REQUIRED",
] as const;
export const REFUND_STATES = [
  "REQUESTED",
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "REVIEW_REQUIRED",
] as const;
/** SPEC-100 §23: the states in which a full refund occupies ux_refund_records_order_live_full. */
export const LIVE_FULL_REFUND_STATES = [
  "REQUESTED",
  "PENDING",
  "SUCCEEDED",
  "REVIEW_REQUIRED",
] as const;
/** SPEC-100 §16: the three states that require terminal_at. */
export const TERMINAL_FAILURE_STATES = ["PAYMENT_FAILED", "CANCELED", "EXPIRED"] as const;

export const ORDERS = "orders";
export const ORDER_ITEMS = "order_items";
export const ENTRY_ALLOCATIONS = "entry_sales_allocations";
export const CHECKOUT_ATTEMPTS = "checkout_attempts";
export const PAYMENT_BINDINGS = "payment_bindings";
export const WEBHOOK_RECEIPTS = "webhook_receipts";
export const REFUND_RECORDS = "refund_records";
/** Creation order of migration 0006 (parents before children). */
export const ORDER_PAYMENT_TABLES = [
  ORDERS,
  ORDER_ITEMS,
  ENTRY_ALLOCATIONS,
  CHECKOUT_ATTEMPTS,
  PAYMENT_BINDINGS,
  WEBHOOK_RECEIPTS,
  REFUND_RECORDS,
] as const;
export const ORDER_PAYMENT_SEQUENCES = ORDER_PAYMENT_TABLES.map((table) => `${table}_id_seq`);

export const ACTIVE_BINDING_INDEX = "ux_payment_bindings_order_active";
export const LIVE_FULL_REFUND_INDEX = "ux_refund_records_order_live_full";

/** SPEC-100 §21 / UCR-100-006: Session creation + 30 minutes, taken in UTC so the expression is IMMUTABLE. */
export const PAYMENT_DEADLINE_EXPRESSION =
  "(((checkout_session_created_at AT TIME ZONE 'UTC'::text) + '00:30:00'::interval) AT TIME ZONE 'UTC'::text)";
export const PAYMENT_DEADLINE_DECLARED =
  "((checkout_session_created_at AT TIME ZONE 'UTC') + interval '30 minutes') AT TIME ZONE 'UTC'";
/** SPEC-100 §9: line_total_amount = unit_amount * quantity, in bigint. */
export const LINE_TOTAL_EXPRESSION = "(unit_amount * (quantity)::bigint)";
export const LINE_TOTAL_DECLARED = "unit_amount * quantity::bigint";

/**
 * [name, format_type, attnotnull, attidentity, attgenerated, pg_get_expr(default or generation expression)] in
 * attnum order.
 */
export type GoldenColumn = [
  name: string,
  type: string,
  notNull: boolean,
  identity: string,
  generated: string,
  defaultExpr: string | null,
];
const idColumn = (): GoldenColumn => ["id", "bigint", true, "a", "", null];
const publicRef = (): GoldenColumn => ["public_ref", "uuid", true, "", "", "gen_random_uuid()"];
const now = (name: string): GoldenColumn => [name, TSTZ, true, "", "", NOW];
const col = (name: string, type: string, notNull = true): GoldenColumn => [
  name,
  type,
  notNull,
  "",
  "",
  null,
];

export interface GoldenConstraint {
  name: string;
  kind: "p" | "u" | "f" | "c";
  /** pg_get_constraintdef */
  definition: string;
  /** CHECK only: the raw SQL of the Drizzle declaration. */
  declared?: string;
}
export interface GoldenForeignKey {
  name: string;
  columns: string[];
  parentExport: string;
  parentTable: string;
  parentColumns: string[];
}
export interface GoldenIndex {
  name: string;
  /** pg_get_indexdef */
  definition: string;
  /** Separately created indexes only: [column, order], UNIQUE, and the raw SQL of a partial predicate. */
  declared?: { columns: [string, "asc" | "desc"][]; unique: boolean; where?: string };
}
export interface GoldenTable {
  exportName: string;
  table: string;
  columns: GoldenColumn[];
  constraints: GoldenConstraint[];
  foreignKeys: GoldenForeignKey[];
  indexes: GoldenIndex[];
}

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
const currencyCheck = (table: string): GoldenConstraint =>
  check(
    `ck_${table}_currency`,
    "((currency = upper(currency)) AND (currency ~ '^[A-Z]{3}$'::text))",
    "currency = upper(currency) AND currency ~ '^[A-Z]{3}$'",
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
    indexes?: GoldenIndex[];
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
    indexes: [pkIndex(name), ...rest.uniques.map((u) => uqIndex(name, u)), ...(rest.indexes ?? [])],
  };
}

// ---- SPEC-100 §16 orders ---------------------------------------------------------------------------
const ordersTable = table(
  "orders",
  ORDERS,
  [
    idColumn(),
    publicRef(),
    col("purchase_cause_key", "uuid"),
    col("customer_profile_id", "bigint"),
    col("purpose", "text"),
    col("state", "text"),
    col("currency", "text"),
    col("total_amount", "bigint"),
    col("confirmed_at", TSTZ, false),
    col("terminal_at", TSTZ, false),
    now("created_at"),
    now("updated_at"),
  ],
  {
    uniques: [
      ["public_ref"],
      ["purchase_cause_key"],
      ["id", "purpose"],
      ["id", "purpose", "currency"],
      ["id", "customer_profile_id"],
    ],
    foreignKeys: [
      fk(
        "fk_orders_customer_profile",
        ["customer_profile_id"],
        "businessProfiles",
        "business_profiles",
      ),
    ],
    checks: [
      allowlist("ck_orders_purpose", "purpose", ORDER_PURPOSES),
      allowlist("ck_orders_state", "state", ORDER_STATES),
      currencyCheck(ORDERS),
      check("ck_orders_total_amount", "(total_amount >= 0)", "total_amount >= 0"),
      check(
        "ck_orders_confirmed_at",
        "((state = 'CONFIRMED'::text) = (confirmed_at IS NOT NULL))",
        "(state = 'CONFIRMED') = (confirmed_at IS NOT NULL)",
      ),
      check(
        "ck_orders_terminal_at",
        `((state <> ALL (ARRAY[${list(TERMINAL_FAILURE_STATES)}])) OR (terminal_at IS NOT NULL))`,
        `state NOT IN (${declaredList(TERMINAL_FAILURE_STATES)}) OR terminal_at IS NOT NULL`,
      ),
    ],
    indexes: [
      {
        name: "ix_orders_admin_purpose_created",
        definition:
          "CREATE INDEX ix_orders_admin_purpose_created ON app.orders USING btree (purpose, created_at DESC)",
        declared: {
          columns: [
            ["purpose", "asc"],
            ["created_at", "desc"],
          ],
          unique: false,
        },
      },
      {
        name: "ix_orders_admin_state_created",
        definition:
          "CREATE INDEX ix_orders_admin_state_created ON app.orders USING btree (state, created_at DESC)",
        declared: {
          columns: [
            ["state", "asc"],
            ["created_at", "desc"],
          ],
          unique: false,
        },
      },
      {
        name: "ix_orders_customer_created",
        definition:
          "CREATE INDEX ix_orders_customer_created ON app.orders USING btree (customer_profile_id, created_at DESC)",
        declared: {
          columns: [
            ["customer_profile_id", "asc"],
            ["created_at", "desc"],
          ],
          unique: false,
        },
      },
    ],
  },
);

// ---- SPEC-100 §17 order_items ------------------------------------------------------------------------
const SOURCE_DEFINITION =
  "(((purpose = 'ENTRY_TICKET_PURCHASE'::text) AND (entry_offering_id IS NOT NULL) AND (karaoke_slot_id IS NULL) AND (goods_id IS NULL))" +
  " OR ((purpose = 'KARAOKE_PURCHASE'::text) AND (entry_offering_id IS NULL) AND (karaoke_slot_id IS NOT NULL) AND (goods_id IS NULL) AND (quantity = 1))" +
  " OR ((purpose = 'GOODS_PURCHASE'::text) AND (entry_offering_id IS NULL) AND (karaoke_slot_id IS NULL) AND (goods_id IS NOT NULL))" +
  " OR ((purpose = 'ENTRY_GOODS_PURCHASE'::text) AND (karaoke_slot_id IS NULL) AND (((entry_offering_id IS NOT NULL) AND (goods_id IS NULL)) OR ((entry_offering_id IS NULL) AND (goods_id IS NOT NULL)))))";
const SOURCE_DECLARED =
  "(purpose = 'ENTRY_TICKET_PURCHASE' AND entry_offering_id IS NOT NULL AND karaoke_slot_id IS NULL AND goods_id IS NULL)" +
  " OR (purpose = 'KARAOKE_PURCHASE' AND entry_offering_id IS NULL AND karaoke_slot_id IS NOT NULL AND goods_id IS NULL AND quantity = 1)" +
  " OR (purpose = 'GOODS_PURCHASE' AND entry_offering_id IS NULL AND karaoke_slot_id IS NULL AND goods_id IS NOT NULL)" +
  " OR (purpose = 'ENTRY_GOODS_PURCHASE' AND karaoke_slot_id IS NULL AND ((entry_offering_id IS NOT NULL AND goods_id IS NULL) OR (entry_offering_id IS NULL AND goods_id IS NOT NULL)))";
const orderItemsTable = table(
  "orderItems",
  ORDER_ITEMS,
  [
    idColumn(),
    col("order_id", "bigint"),
    col("purpose", "text"),
    col("line_no", "integer"),
    col("quantity", "integer"),
    col("unit_amount", "bigint"),
    col("currency", "text"),
    ["line_total_amount", "bigint", false, "", "s", LINE_TOTAL_EXPRESSION],
    col("item_name_snapshot", "text"),
    col("entry_offering_id", "bigint", false),
    col("karaoke_slot_id", "bigint", false),
    col("goods_id", "bigint", false),
    now("created_at"),
  ],
  {
    uniques: [
      ["order_id", "line_no"],
      ["id", "order_id"],
      ["id", "purpose"],
      ["id", "order_id", "purpose"],
      ["id", "order_id", "purpose", "karaoke_slot_id"],
      ["id", "entry_offering_id"],
      ["id", "goods_id"],
    ],
    foreignKeys: [
      fk("fk_order_items_order", ["order_id", "purpose", "currency"], "orders", ORDERS, [
        "id",
        "purpose",
        "currency",
      ]),
      fk(
        "fk_order_items_entry_offering",
        ["entry_offering_id"],
        "entryTicketOfferings",
        "entry_ticket_offerings",
      ),
      fk("fk_order_items_karaoke_slot", ["karaoke_slot_id"], "karaokeSlots", "karaoke_slots"),
      fk("fk_order_items_goods", ["goods_id"], "goods", "goods"),
    ],
    checks: [
      check("ck_order_items_line_no", "(line_no > 0)", "line_no > 0"),
      check("ck_order_items_quantity", "(quantity > 0)", "quantity > 0"),
      check("ck_order_items_unit_amount", "(unit_amount >= 0)", "unit_amount >= 0"),
      currencyCheck(ORDER_ITEMS),
      check("ck_order_items_source", SOURCE_DEFINITION, SOURCE_DECLARED),
    ],
  },
);

// ---- SPEC-100 §18 entry_sales_allocations ------------------------------------------------------------
const entryAllocationsTable = table(
  "entrySalesAllocations",
  ENTRY_ALLOCATIONS,
  [
    idColumn(),
    col("order_item_id", "bigint"),
    col("order_id", "bigint"),
    col("purpose", "text"),
    col("offering_id", "bigint"),
    col("quantity", "integer"),
    col("state", "text"),
    now("held_at"),
    col("committed_at", TSTZ, false),
    col("released_at", TSTZ, false),
  ],
  {
    uniques: [["order_item_id"]],
    foreignKeys: [
      fk(
        "fk_entry_sales_allocations_order_item",
        ["order_item_id", "order_id", "purpose"],
        "orderItems",
        ORDER_ITEMS,
        ["id", "order_id", "purpose"],
      ),
      fk(
        "fk_entry_sales_allocations_offering",
        ["order_item_id", "offering_id"],
        "orderItems",
        ORDER_ITEMS,
        ["id", "entry_offering_id"],
      ),
    ],
    checks: [
      allowlist("ck_entry_sales_allocations_purpose", "purpose", ENTRY_ALLOCATION_PURPOSES),
      check("ck_entry_sales_allocations_quantity", "(quantity > 0)", "quantity > 0"),
      allowlist("ck_entry_sales_allocations_state", "state", ENTRY_ALLOCATION_STATES),
      check(
        "ck_entry_sales_allocations_state_times",
        "(((state = 'HELD'::text) AND (committed_at IS NULL) AND (released_at IS NULL))" +
          " OR ((state = 'COMMITTED'::text) AND (committed_at IS NOT NULL) AND (released_at IS NULL))" +
          " OR ((state = 'RELEASED'::text) AND (released_at IS NOT NULL) AND (committed_at IS NULL)))",
        "(state = 'HELD' AND committed_at IS NULL AND released_at IS NULL)" +
          " OR (state = 'COMMITTED' AND committed_at IS NOT NULL AND released_at IS NULL)" +
          " OR (state = 'RELEASED' AND released_at IS NOT NULL AND committed_at IS NULL)",
      ),
    ],
    indexes: [
      {
        name: "ix_entry_allocations_offering_state",
        definition:
          "CREATE INDEX ix_entry_allocations_offering_state ON app.entry_sales_allocations USING btree (offering_id, state)",
        declared: {
          columns: [
            ["offering_id", "asc"],
            ["state", "asc"],
          ],
          unique: false,
        },
      },
    ],
  },
);

// ---- SPEC-100 §20 checkout_attempts ------------------------------------------------------------------
const checkoutAttemptsTable = table(
  "checkoutAttempts",
  CHECKOUT_ATTEMPTS,
  [
    idColumn(),
    publicRef(),
    col("order_id", "bigint"),
    col("attempt_no", "integer"),
    col("stripe_idempotency_key", "text"),
    col("creation_result", "text"),
    col("provider_request_started_at", TSTZ, false),
    col("provider_response_at", TSTZ, false),
    col("last_error_code", "text", false),
    now("created_at"),
    now("updated_at"),
  ],
  {
    uniques: [
      ["public_ref"],
      ["stripe_idempotency_key"],
      ["order_id", "attempt_no"],
      ["id", "order_id"],
    ],
    foreignKeys: [fk("fk_checkout_attempts_order", ["order_id"], "orders", ORDERS)],
    checks: [
      check("ck_checkout_attempts_attempt_no", "(attempt_no > 0)", "attempt_no > 0"),
      allowlist(
        "ck_checkout_attempts_creation_result",
        "creation_result",
        CHECKOUT_CREATION_RESULTS,
      ),
    ],
    indexes: [
      {
        // Plan U-3: named by SPEC-100 §45.2 although uq_checkout_attempts_order_id_attempt_no has the same columns.
        name: "ix_checkout_attempts_order_attempt",
        definition:
          "CREATE INDEX ix_checkout_attempts_order_attempt ON app.checkout_attempts USING btree (order_id, attempt_no DESC)",
        declared: {
          columns: [
            ["order_id", "asc"],
            ["attempt_no", "desc"],
          ],
          unique: false,
        },
      },
    ],
  },
);

// ---- SPEC-100 §21 payment_bindings -------------------------------------------------------------------
const paymentBindingsTable = table(
  "paymentBindings",
  PAYMENT_BINDINGS,
  [
    idColumn(),
    col("order_id", "bigint"),
    col("checkout_attempt_id", "bigint"),
    col("stripe_checkout_session_id", "text"),
    col("stripe_payment_intent_id", "text", false),
    col("stripe_charge_id", "text", false),
    col("checkout_session_created_at", TSTZ),
    ["payment_deadline_at", TSTZ, false, "", "s", PAYMENT_DEADLINE_EXPRESSION],
    col("payment_completed_at", TSTZ, false),
    col("amount_total", "bigint"),
    col("currency", "text"),
    ["is_active", "boolean", true, "", "", "true"],
    now("bound_at"),
    col("deactivated_at", TSTZ, false),
    col("stripe_receipt_url", "text", false),
  ],
  {
    uniques: [
      ["checkout_attempt_id"],
      ["stripe_checkout_session_id"],
      ["stripe_payment_intent_id"],
      ["stripe_charge_id"],
    ],
    foreignKeys: [
      fk("fk_payment_bindings_order", ["order_id"], "orders", ORDERS),
      fk(
        "fk_payment_bindings_checkout_attempt",
        ["checkout_attempt_id", "order_id"],
        "checkoutAttempts",
        CHECKOUT_ATTEMPTS,
        ["id", "order_id"],
      ),
    ],
    checks: [
      check("ck_payment_bindings_amount_total", "(amount_total >= 0)", "amount_total >= 0"),
      currencyCheck(PAYMENT_BINDINGS),
      check(
        "ck_payment_bindings_active",
        "(is_active = (deactivated_at IS NULL))",
        "is_active = (deactivated_at IS NULL)",
      ),
    ],
    indexes: [
      {
        name: "ix_payment_bindings_order_bound",
        definition:
          "CREATE INDEX ix_payment_bindings_order_bound ON app.payment_bindings USING btree (order_id, bound_at DESC)",
        declared: {
          columns: [
            ["order_id", "asc"],
            ["bound_at", "desc"],
          ],
          unique: false,
        },
      },
      {
        name: ACTIVE_BINDING_INDEX,
        definition: `CREATE UNIQUE INDEX ${ACTIVE_BINDING_INDEX} ON app.payment_bindings USING btree (order_id) WHERE is_active`,
        declared: { columns: [["order_id", "asc"]], unique: true, where: "is_active" },
      },
    ],
  },
);

// ---- SPEC-100 §22 webhook_receipts -------------------------------------------------------------------
const webhookReceiptsTable = table(
  "webhookReceipts",
  WEBHOOK_RECEIPTS,
  [
    idColumn(),
    col("stripe_event_id", "text"),
    col("event_type", "text"),
    col("stripe_object_id", "text", false),
    col("stripe_account_id", "text", false),
    col("livemode", "boolean"),
    col("processing_state", "text"),
    col("payload_sha256", "bytea"),
    col("canonical_snapshot", "jsonb"),
    now("received_at"),
    col("processed_at", TSTZ, false),
    col("last_error_code", "text", false),
    now("updated_at"),
  ],
  {
    uniques: [["stripe_event_id"]],
    foreignKeys: [],
    checks: [
      allowlist(
        "ck_webhook_receipts_processing_state",
        "processing_state",
        WEBHOOK_PROCESSING_STATES,
      ),
      check(
        "ck_webhook_receipts_payload_sha256",
        "(octet_length(payload_sha256) = 32)",
        "octet_length(payload_sha256) = 32",
      ),
    ],
    indexes: [
      {
        name: "ix_webhook_receipts_retry",
        definition: `CREATE INDEX ix_webhook_receipts_retry ON app.webhook_receipts USING btree (received_at) WHERE (processing_state = ANY (ARRAY[${list(["FAILED_RETRYABLE", "REVIEW_REQUIRED"])}]))`,
        declared: {
          columns: [["received_at", "asc"]],
          unique: false,
          where: "processing_state IN ('FAILED_RETRYABLE','REVIEW_REQUIRED')",
        },
      },
    ],
  },
);

// ---- SPEC-100 §23 refund_records ---------------------------------------------------------------------
const refundRecordsTable = table(
  "refundRecords",
  REFUND_RECORDS,
  [
    idColumn(),
    col("order_id", "bigint"),
    col("business_cause_key", "uuid"),
    col("stripe_idempotency_key", "text"),
    col("stripe_refund_id", "text", false),
    col("state", "text"),
    col("requested_amount", "bigint"),
    col("currency", "text"),
    col("is_full_refund", "boolean"),
    col("requested_by_profile_id", "bigint"),
    now("requested_at"),
    col("provider_updated_at", TSTZ, false),
    col("succeeded_at", TSTZ, false),
    col("failed_at", TSTZ, false),
    now("updated_at"),
  ],
  {
    uniques: [["business_cause_key"], ["stripe_idempotency_key"], ["stripe_refund_id"]],
    foreignKeys: [
      fk("fk_refund_records_order", ["order_id"], "orders", ORDERS),
      fk(
        "fk_refund_records_requested_by_profile",
        ["requested_by_profile_id"],
        "businessProfiles",
        "business_profiles",
      ),
    ],
    checks: [
      allowlist("ck_refund_records_state", "state", REFUND_STATES),
      check("ck_refund_records_requested_amount", "(requested_amount > 0)", "requested_amount > 0"),
      currencyCheck(REFUND_RECORDS),
    ],
    indexes: [
      {
        name: LIVE_FULL_REFUND_INDEX,
        definition: `CREATE UNIQUE INDEX ${LIVE_FULL_REFUND_INDEX} ON app.refund_records USING btree (order_id) WHERE (is_full_refund AND (state = ANY (ARRAY[${list(LIVE_FULL_REFUND_STATES)}])))`,
        declared: {
          columns: [["order_id", "asc"]],
          unique: true,
          where: `is_full_refund AND state IN (${declaredList(LIVE_FULL_REFUND_STATES)})`,
        },
      },
    ],
  },
);

export const GOLDEN_TABLES: readonly GoldenTable[] = [
  ordersTable,
  orderItemsTable,
  entryAllocationsTable,
  checkoutAttemptsTable,
  paymentBindingsTable,
  webhookReceiptsTable,
  refundRecordsTable,
];

/**
 * Sizes counted by hand from SPEC-100 §16-§18 and §20-§23 and the plan (guards against empty comparisons):
 * columns, constraints (PK + UNIQUE + FK + CHECK) and indexes (PK + UNIQUE + the §45 indexes) per table.
 */
export const SPEC_COLUMN_COUNTS = [12, 13, 10, 11, 15, 13, 15];
export const SPEC_CONSTRAINT_COUNTS = [13, 17, 8, 8, 10, 4, 9];
export const SPEC_INDEX_COUNTS = [9, 8, 3, 6, 7, 3, 5];

/** The separately created indexes of 0006 (SPEC-100 §45.1-§45.3, §45.7, §21-§23), in name order. */
export const SEPARATE_INDEX_NAMES = GOLDEN_TABLES.flatMap((g) =>
  g.indexes.filter((i) => i.declared).map((i) => i.name),
).sort();
