// PR-L1-1b test harness: the hand-written goldens of the three Entry Ticket / QR / Check-in tables of migration
// 0009 (SPEC-100 §24-§26, §45.1, §45.3, §45.5, §7.2, §8, §10, §11; plan U-2..U-4) in the PostgreSQL 17 catalog
// notation (format_type, pg_get_expr, pg_get_constraintdef, pg_get_indexdef). They are written from the
// specification and the approved plan decisions, never derived from schema-contract.json or from the migration, so
// the contract, the Drizzle declaration and the live catalog are each checked against them. `declared` is the raw
// SQL the Drizzle declaration must carry (column references without the "app"."<table>" qualifier). No database and
// no production import: the unit test of the Drizzle declaration and the real PG17 test both use this file. The
// shape follows goods-fulfillment-golden.ts (PR-GK-3); its types are those of orders-payments-golden.ts (PR-L1-1a).
// Entry Ticket state names are those of SPEC-030 / SPEC-080 §6; QR purposes and lifecycle states are SPEC-100 §25.

import type {
  GoldenColumn,
  GoldenConstraint,
  GoldenForeignKey,
  GoldenIndex,
  GoldenTable,
} from "./orders-payments-golden.ts";

const TSTZ = "timestamp with time zone";
const NOW = "transaction_timestamp()";

export const ENTRY_TICKET_ORDER_PURPOSES = [
  "ENTRY_TICKET_PURCHASE",
  "ENTRY_GOODS_PURCHASE",
] as const;
export const ENTRY_TICKET_STATES = ["VALID", "USED", "CANCELED", "EXPIRED"] as const;
export const QR_TOKEN_PURPOSES = ["ENTRY", "KARAOKE"] as const;
export const QR_TOKEN_LIFECYCLE_STATES = ["ACTIVE", "REVOKED"] as const;
export const QR_FORMAT_VERSION = "r39x1";

export const ENTRY_TICKETS = "entry_tickets";
export const QR_TOKENS = "qr_tokens";
export const ENTRY_CHECKINS = "entry_checkins";
/** Creation order of migration 0009 (parents before children). */
export const ENTRY_TICKET_QR_TABLES = [ENTRY_TICKETS, QR_TOKENS, ENTRY_CHECKINS] as const;
export const ENTRY_TICKET_QR_SEQUENCES = [
  `${ENTRY_TICKETS}_id_seq`,
  `${QR_TOKENS}_id_seq`,
  `${ENTRY_CHECKINS}_id_seq`,
] as const;

export const OWNER_ISSUED_INDEX = "ix_entry_tickets_owner_issued";
export const ENTRY_ACTIVE_QR_INDEX = "ux_qr_tokens_entry_active";
export const KARAOKE_ACTIVE_QR_INDEX = "ux_qr_tokens_karaoke_active";

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

// ---- SPEC-100 §24 entry_tickets ----------------------------------------------------------------------
// DB-TQR-001 / §67 item 11: one Ticket per (Order Item, issuance ordinal). The three foreign keys of §24 keep the
// Ticket's Order and Purpose equal to its item's, its owner equal to the Order's Customer (TQR-TKT-004) and refuse a
// Ticket of an item without an Entry Allocation (a Goods line of a composite Order). Plan U-2: ON DELETE RESTRICT.
// Plan U-3: state and order_purpose have no default. Plan U-4: no state / timestamp CHECK beyond §24.
const entryTicketsTable = table(
  "entryTickets",
  ENTRY_TICKETS,
  [
    idColumn(),
    publicRef(),
    col("order_id", "bigint"),
    col("order_item_id", "bigint"),
    col("order_purpose", "text"),
    col("owner_profile_id", "bigint"),
    col("issuance_ordinal", "integer"),
    col("state", "text"),
    col("valid_from", TSTZ, false),
    col("valid_until", TSTZ, false),
    now("issued_at"),
    now("state_changed_at"),
  ],
  {
    uniques: [["public_ref"], ["order_item_id", "issuance_ordinal"]],
    foreignKeys: [
      fk(
        "fk_entry_tickets_order_item",
        ["order_item_id", "order_id", "order_purpose"],
        "orderItems",
        "order_items",
        ["id", "order_id", "purpose"],
      ),
      fk("fk_entry_tickets_order", ["order_id", "owner_profile_id"], "orders", "orders", [
        "id",
        "customer_profile_id",
      ]),
      fk(
        "fk_entry_tickets_entry_sales_allocation",
        ["order_item_id"],
        "entrySalesAllocations",
        "entry_sales_allocations",
        ["order_item_id"],
      ),
    ],
    checks: [
      allowlist("ck_entry_tickets_order_purpose", "order_purpose", ENTRY_TICKET_ORDER_PURPOSES),
      check("ck_entry_tickets_issuance_ordinal", "(issuance_ordinal > 0)", "issuance_ordinal > 0"),
      allowlist("ck_entry_tickets_state", "state", ENTRY_TICKET_STATES),
      check(
        "ck_entry_tickets_valid_period",
        "((valid_from IS NULL) OR (valid_until IS NULL) OR (valid_from < valid_until))",
        "valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until",
      ),
    ],
    indexes: [
      {
        name: OWNER_ISSUED_INDEX,
        definition: `CREATE INDEX ${OWNER_ISSUED_INDEX} ON app.entry_tickets USING btree (owner_profile_id, issued_at DESC)`,
        declared: {
          columns: [
            ["owner_profile_id", "asc"],
            ["issued_at", "desc"],
          ],
          unique: false,
        },
      },
    ],
  },
);

// ---- SPEC-100 §25 qr_tokens --------------------------------------------------------------------------
// A controlled polymorphic relation: exactly one of the two Ticket references, matching the purpose (TQR-TOK-006,
// TQR-TOK-007). DB-TQR-002: no plaintext column; the token exists only as an HMAC digest (32 bytes, SPEC-140 §54)
// and an application-encrypted envelope. TQR-TOK-013 / §67 item 16: at most one ACTIVE Token per Ticket (the two
// partial UNIQUE indexes of §25); REVOKED Tokens stay as history (DB-TQR-003). Plan U-3: no defaults on
// format_version, purpose and lifecycle_state.
const qrTokensTable = table(
  "qrTokens",
  QR_TOKENS,
  [
    idColumn(),
    col("format_version", "text"),
    col("purpose", "text"),
    col("entry_ticket_id", "bigint", false),
    col("karaoke_ticket_id", "bigint", false),
    col("lifecycle_state", "text"),
    col("lookup_digest", "bytea"),
    col("protected_token_material", "bytea"),
    col("protection_key_version", "integer"),
    now("issued_at"),
    col("revoked_at", TSTZ, false),
  ],
  {
    uniques: [["lookup_digest"]],
    foreignKeys: [
      fk("fk_qr_tokens_entry_ticket", ["entry_ticket_id"], "entryTickets", ENTRY_TICKETS),
      fk("fk_qr_tokens_karaoke_ticket", ["karaoke_ticket_id"], "karaokeTickets", "karaoke_tickets"),
    ],
    checks: [
      check(
        "ck_qr_tokens_format_version",
        `(format_version = '${QR_FORMAT_VERSION}'::text)`,
        `format_version = '${QR_FORMAT_VERSION}'`,
      ),
      allowlist("ck_qr_tokens_purpose", "purpose", QR_TOKEN_PURPOSES),
      check(
        "ck_qr_tokens_purpose_target",
        "(((purpose = 'ENTRY'::text) AND (entry_ticket_id IS NOT NULL) AND (karaoke_ticket_id IS NULL))" +
          " OR ((purpose = 'KARAOKE'::text) AND (entry_ticket_id IS NULL) AND (karaoke_ticket_id IS NOT NULL)))",
        "(purpose = 'ENTRY' AND entry_ticket_id IS NOT NULL AND karaoke_ticket_id IS NULL)" +
          " OR (purpose = 'KARAOKE' AND entry_ticket_id IS NULL AND karaoke_ticket_id IS NOT NULL)",
      ),
      allowlist("ck_qr_tokens_lifecycle_state", "lifecycle_state", QR_TOKEN_LIFECYCLE_STATES),
      check(
        "ck_qr_tokens_revoked_at",
        "((lifecycle_state = 'REVOKED'::text) = (revoked_at IS NOT NULL))",
        "(lifecycle_state = 'REVOKED') = (revoked_at IS NOT NULL)",
      ),
      check(
        "ck_qr_tokens_lookup_digest_length",
        "(octet_length(lookup_digest) = 32)",
        "octet_length(lookup_digest) = 32",
      ),
      check(
        "ck_qr_tokens_protection_key_version",
        "(protection_key_version > 0)",
        "protection_key_version > 0",
      ),
    ],
    indexes: [
      {
        name: ENTRY_ACTIVE_QR_INDEX,
        definition: `CREATE UNIQUE INDEX ${ENTRY_ACTIVE_QR_INDEX} ON app.qr_tokens USING btree (entry_ticket_id) WHERE ((lifecycle_state = 'ACTIVE'::text) AND (entry_ticket_id IS NOT NULL))`,
        declared: {
          columns: [["entry_ticket_id", "asc"]],
          unique: true,
          where: "lifecycle_state = 'ACTIVE' AND entry_ticket_id IS NOT NULL",
        },
      },
      {
        name: KARAOKE_ACTIVE_QR_INDEX,
        definition: `CREATE UNIQUE INDEX ${KARAOKE_ACTIVE_QR_INDEX} ON app.qr_tokens USING btree (karaoke_ticket_id) WHERE ((lifecycle_state = 'ACTIVE'::text) AND (karaoke_ticket_id IS NOT NULL))`,
        declared: {
          columns: [["karaoke_ticket_id", "asc"]],
          unique: true,
          where: "lifecycle_state = 'ACTIVE' AND karaoke_ticket_id IS NOT NULL",
        },
      },
    ],
  },
);

// ---- SPEC-100 §26 entry_checkins ---------------------------------------------------------------------
// INV-010-05 / §67 item 18: at most one Entry Check-in per Ticket (the secondary defence of §26 step 5). The same
// shape as karaoke_checkins (0007). Plan U-2: the two Staff foreign keys are ON DELETE RESTRICT too.
const entryCheckinsTable = table(
  "entryCheckins",
  ENTRY_CHECKINS,
  [
    idColumn(),
    col("entry_ticket_id", "bigint"),
    col("staff_profile_id", "bigint"),
    col("staff_role_assignment_id", "bigint"),
    now("checked_in_at"),
    now("created_at"),
  ],
  {
    uniques: [["entry_ticket_id"]],
    foreignKeys: [
      fk("fk_entry_checkins_entry_ticket", ["entry_ticket_id"], "entryTickets", ENTRY_TICKETS),
      fk(
        "fk_entry_checkins_staff_profile",
        ["staff_profile_id"],
        "businessProfiles",
        "business_profiles",
      ),
      fk(
        "fk_entry_checkins_staff_role_assignment",
        ["staff_role_assignment_id"],
        "roleAssignments",
        "role_assignments",
      ),
    ],
    checks: [],
    indexes: [],
  },
);

export const GOLDEN_TABLES: readonly GoldenTable[] = [
  entryTicketsTable,
  qrTokensTable,
  entryCheckinsTable,
];

/**
 * Sizes counted by hand from SPEC-100 §24-§26 and the plan (guards against empty comparisons): columns,
 * constraints (PK + UNIQUE + FK + CHECK) and indexes (PK + UNIQUE + the §45 indexes) per table.
 */
export const SPEC_COLUMN_COUNTS = [12, 11, 6];
export const SPEC_CONSTRAINT_COUNTS = [10, 11, 5];
export const SPEC_INDEX_COUNTS = [4, 4, 2];

/** The separately created indexes of 0009 (SPEC-100 §45.1, §25 / §45.5), in name order. */
export const SEPARATE_INDEX_NAMES = GOLDEN_TABLES.flatMap((g) =>
  g.indexes.filter((i) => i.declared).map((i) => i.name),
).sort();
