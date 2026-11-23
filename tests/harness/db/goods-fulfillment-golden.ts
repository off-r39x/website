// PR-GK-3 test harness: the hand-written goldens of the three Goods fulfillment tables of migration 0008
// (SPEC-100 §39-§41, §45.1, §45.6, §7.2, §8, §10, §11; plan U-1..U-5) in the PostgreSQL 17 catalog notation
// (format_type, pg_get_expr, pg_get_constraintdef, pg_get_indexdef). They are written from the specification and
// the approved plan decisions, never derived from schema-contract.json or from the migration, so the contract, the
// Drizzle declaration and the live catalog are each checked against them. `declared` is the raw SQL the Drizzle
// declaration must carry (column references without the "app"."<table>" qualifier). No database and no production
// import: the unit test of the Drizzle declaration and the real PG17 test both use this file. The shape follows
// orders-payments-golden.ts (PR-L1-1a); its types are reused and its small helpers are repeated here because
// goods_order_items is keyed by order_item_id, not id. State names are those of SPEC-030 §16.2, §16.3 and §17.1.

import type {
  GoldenColumn,
  GoldenConstraint,
  GoldenForeignKey,
  GoldenIndex,
  GoldenTable,
} from "./orders-payments-golden.ts";

const TSTZ = "timestamp with time zone";
const NOW = "transaction_timestamp()";

export const GOODS_ORDER_ITEM_PURPOSES = ["GOODS_PURCHASE", "ENTRY_GOODS_PURCHASE"] as const;
export const GOODS_ORDER_ITEM_STATES = ["PENDING_PAYMENT", "FULFILLABLE", "CANCELED"] as const;
export const GOODS_ALLOCATION_STATES = ["HELD", "COMMITTED", "RELEASED"] as const;
export const GOODS_HANDOFF_STATES = ["PENDING", "COMPLETED", "VOID"] as const;

export const GOODS_ORDER_ITEMS = "goods_order_items";
export const GOODS_ALLOCATIONS = "goods_sales_allocations";
export const GOODS_HANDOFFS = "goods_handoffs";
/** Creation order of migration 0008 (parents before children). */
export const GOODS_FULFILLMENT_TABLES = [
  GOODS_ORDER_ITEMS,
  GOODS_ALLOCATIONS,
  GOODS_HANDOFFS,
] as const;
/** goods_order_items has no identity column (its key is the base Order Item id, SPEC-100 §39). */
export const GOODS_FULFILLMENT_SEQUENCES = [
  `${GOODS_ALLOCATIONS}_id_seq`,
  `${GOODS_HANDOFFS}_id_seq`,
] as const;

export const PENDING_HANDOFF_INDEX = "ix_goods_handoffs_pending";

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

const pk = (table: string, column: string): GoldenConstraint => ({
  name: `pk_${table}`,
  kind: "p",
  definition: `PRIMARY KEY (${column})`,
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
const pkIndex = (table: string, column: string): GoldenIndex => ({
  name: `pk_${table}`,
  definition: `CREATE UNIQUE INDEX pk_${table} ON app.${table} USING btree (${column})`,
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
  key: string,
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
      pk(name, key),
      ...rest.uniques.map((u) => uq(name, u)),
      ...rest.foreignKeys.map(fkConstraint),
      ...rest.checks,
    ],
    foreignKeys: rest.foreignKeys,
    indexes: [pkIndex(name, key), ...rest.uniques.map((u) => uqIndex(name, u)), ...rest.indexes],
  };
}

// ---- SPEC-100 §39 goods_order_items ------------------------------------------------------------------
// The 1:1 fulfillment extension of a base Order Item. The three composite foreign keys keep the item's Order,
// Purpose, customer (DB-GDS-002) and Goods equal to the base item's and Order's. uq_..._order_item_id_goods_id is
// the target of the Allocation's Goods foreign key (§40).
const goodsOrderItemsTable = table(
  "goodsOrderItems",
  GOODS_ORDER_ITEMS,
  "order_item_id",
  [
    col("order_item_id", "bigint"),
    publicRef(),
    col("order_id", "bigint"),
    col("order_purpose", "text"),
    col("customer_profile_id", "bigint"),
    col("goods_id", "bigint"),
    col("state", "text"),
    now("created_at"),
    now("updated_at"),
  ],
  {
    uniques: [["public_ref"], ["order_item_id", "goods_id"]],
    foreignKeys: [
      fk(
        "fk_goods_order_items_order_item",
        ["order_item_id", "order_id", "order_purpose"],
        "orderItems",
        "order_items",
        ["id", "order_id", "purpose"],
      ),
      fk(
        "fk_goods_order_items_order_customer",
        ["order_id", "customer_profile_id"],
        "orders",
        "orders",
        ["id", "customer_profile_id"],
      ),
      fk("fk_goods_order_items_goods", ["order_item_id", "goods_id"], "orderItems", "order_items", [
        "id",
        "goods_id",
      ]),
    ],
    checks: [
      allowlist("ck_goods_order_items_order_purpose", "order_purpose", GOODS_ORDER_ITEM_PURPOSES),
      allowlist("ck_goods_order_items_state", "state", GOODS_ORDER_ITEM_STATES),
    ],
    indexes: [
      {
        name: "ix_goods_order_items_customer_created",
        definition:
          "CREATE INDEX ix_goods_order_items_customer_created ON app.goods_order_items USING btree (customer_profile_id, created_at DESC)",
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

// ---- SPEC-100 §40 goods_sales_allocations ------------------------------------------------------------
// One Allocation per Goods Order Item. Plan U-1: only the three-state allowlist (§40 has no state / timestamp CHECK,
// unlike §18). Plan U-3: held_at defaults to transaction_timestamp(). Plan U-4: both foreign keys of §40.
const goodsAllocationsTable = table(
  "goodsSalesAllocations",
  GOODS_ALLOCATIONS,
  "id",
  [
    idColumn(),
    col("goods_order_item_id", "bigint"),
    col("goods_id", "bigint"),
    col("quantity", "integer"),
    col("state", "text"),
    now("held_at"),
    col("committed_at", TSTZ, false),
    col("released_at", TSTZ, false),
  ],
  {
    uniques: [["goods_order_item_id"]],
    foreignKeys: [
      fk(
        "fk_goods_sales_allocations_goods_order_item",
        ["goods_order_item_id"],
        "goodsOrderItems",
        GOODS_ORDER_ITEMS,
        ["order_item_id"],
      ),
      fk(
        "fk_goods_sales_allocations_goods",
        ["goods_order_item_id", "goods_id"],
        "goodsOrderItems",
        GOODS_ORDER_ITEMS,
        ["order_item_id", "goods_id"],
      ),
    ],
    checks: [
      check("ck_goods_sales_allocations_quantity", "(quantity > 0)", "quantity > 0"),
      allowlist("ck_goods_sales_allocations_state", "state", GOODS_ALLOCATION_STATES),
    ],
    indexes: [
      {
        name: "ix_goods_allocations_goods_state",
        definition:
          "CREATE INDEX ix_goods_allocations_goods_state ON app.goods_sales_allocations USING btree (goods_id, state)",
        declared: {
          columns: [
            ["goods_id", "asc"],
            ["state", "asc"],
          ],
          unique: false,
        },
      },
    ],
  },
);

// ---- SPEC-100 §41 goods_handoffs ---------------------------------------------------------------------
// One Handoff per Goods Order Item. Plan U-2: COMPLETED requires both actor columns and completed_at; PENDING and
// VOID constrain only the timestamps §41 names.
const goodsHandoffsTable = table(
  "goodsHandoffs",
  GOODS_HANDOFFS,
  "id",
  [
    idColumn(),
    publicRef(),
    col("goods_order_item_id", "bigint"),
    col("state", "text"),
    col("completed_by_profile_id", "bigint", false),
    col("completed_role_assignment_id", "bigint", false),
    col("completed_at", TSTZ, false),
    col("voided_at", TSTZ, false),
    now("created_at"),
    now("updated_at"),
  ],
  {
    uniques: [["public_ref"], ["goods_order_item_id"]],
    foreignKeys: [
      fk(
        "fk_goods_handoffs_goods_order_item",
        ["goods_order_item_id"],
        "goodsOrderItems",
        GOODS_ORDER_ITEMS,
        ["order_item_id"],
      ),
      fk(
        "fk_goods_handoffs_completed_by_profile",
        ["completed_by_profile_id"],
        "businessProfiles",
        "business_profiles",
      ),
      fk(
        "fk_goods_handoffs_completed_role_assignment",
        ["completed_role_assignment_id"],
        "roleAssignments",
        "role_assignments",
      ),
    ],
    checks: [
      allowlist("ck_goods_handoffs_state", "state", GOODS_HANDOFF_STATES),
      check(
        "ck_goods_handoffs_state_times",
        "(((state = 'PENDING'::text) AND (completed_at IS NULL) AND (voided_at IS NULL))" +
          " OR ((state = 'COMPLETED'::text) AND (completed_by_profile_id IS NOT NULL)" +
          " AND (completed_role_assignment_id IS NOT NULL) AND (completed_at IS NOT NULL) AND (voided_at IS NULL))" +
          " OR ((state = 'VOID'::text) AND (voided_at IS NOT NULL) AND (completed_at IS NULL)))",
        "(state = 'PENDING' AND completed_at IS NULL AND voided_at IS NULL)" +
          " OR (state = 'COMPLETED' AND completed_by_profile_id IS NOT NULL" +
          " AND completed_role_assignment_id IS NOT NULL AND completed_at IS NOT NULL AND voided_at IS NULL)" +
          " OR (state = 'VOID' AND voided_at IS NOT NULL AND completed_at IS NULL)",
      ),
    ],
    indexes: [
      {
        name: PENDING_HANDOFF_INDEX,
        definition: `CREATE INDEX ${PENDING_HANDOFF_INDEX} ON app.goods_handoffs USING btree (created_at) WHERE (state = 'PENDING'::text)`,
        declared: { columns: [["created_at", "asc"]], unique: false, where: "state = 'PENDING'" },
      },
    ],
  },
);

export const GOLDEN_TABLES: readonly GoldenTable[] = [
  goodsOrderItemsTable,
  goodsAllocationsTable,
  goodsHandoffsTable,
];

/**
 * Sizes counted by hand from SPEC-100 §39-§41 and the plan (guards against empty comparisons): columns,
 * constraints (PK + UNIQUE + FK + CHECK) and indexes (PK + UNIQUE + the §45 indexes) per table.
 */
export const SPEC_COLUMN_COUNTS = [9, 8, 10];
export const SPEC_CONSTRAINT_COUNTS = [8, 6, 8];
export const SPEC_INDEX_COUNTS = [4, 3, 4];

/** The separately created indexes of 0008 (SPEC-100 §45.1, §45.6), in name order. */
export const SEPARATE_INDEX_NAMES = GOLDEN_TABLES.flatMap((g) =>
  g.indexes.filter((i) => i.declared).map((i) => i.name),
).sort();
