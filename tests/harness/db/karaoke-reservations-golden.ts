// PR-GK-2 test harness: the hand-written goldens of the four Karaoke reservation tables of migration 0007
// (SPEC-100 §30, §33, §34, §37, §45.1, §45.4, §45.5; plan U-1..U-5) in the PostgreSQL 17 catalog notation
// (format_type, pg_get_expr with IntervalStyle=postgres, pg_get_constraintdef, pg_get_indexdef). They are written
// from the specification and the approved plan decisions, never derived from schema-contract.json or from the
// migration, so the contract, the Drizzle declaration and the live catalog are each checked against them.
// `declared` is the raw SQL the Drizzle declaration must carry (column references without the "app"."<table>"
// qualifier). No database and no production import: the unit test of the Drizzle declaration and the real PG17
// test both use this file. State names are those of SPEC-030 / SPEC-090 (Karaoke Hold, Reservation, Ticket).

const TSTZ = "timestamp with time zone";
const NOW = "transaction_timestamp()";

export const KARAOKE_HOLD_STATES = ["ACTIVE", "COMMITTED", "RELEASED", "EXPIRED"] as const;
export const KARAOKE_RESERVATION_STATES = ["CONFIRMED", "CANCELED"] as const;
export const KARAOKE_TICKET_STATES = ["VALID", "USED", "CANCELED", "EXPIRED"] as const;

export const KARAOKE_HOLDS = "karaoke_holds";
export const KARAOKE_RESERVATIONS = "karaoke_reservations";
export const KARAOKE_TICKETS = "karaoke_tickets";
export const KARAOKE_CHECKINS = "karaoke_checkins";
/** Creation order of migration 0007 (parents before children). */
export const KARAOKE_RESERVATION_TABLES = [
  KARAOKE_HOLDS,
  KARAOKE_RESERVATIONS,
  KARAOKE_TICKETS,
  KARAOKE_CHECKINS,
] as const;
export const KARAOKE_RESERVATION_SEQUENCES = KARAOKE_RESERVATION_TABLES.map(
  (table) => `${table}_id_seq`,
);

export const ACTIVE_HOLD_INDEX = "ux_karaoke_holds_slot_active";
/** Plan U-1: the §33 composite UNIQUE named by its purpose (the column list would exceed 63 bytes). */
export const HOLD_RESERVATION_TARGET = "uq_karaoke_holds_reservation_target";

/** SPEC-100 §30 / UCR-100-006: acquisition + 45 minutes, taken in UTC so the expression is IMMUTABLE. */
export const HOLD_EXPIRY_EXPRESSION =
  "(((hold_acquired_at AT TIME ZONE 'UTC'::text) + '00:45:00'::interval) AT TIME ZONE 'UTC'::text)";
export const HOLD_EXPIRY_DECLARED =
  "((hold_acquired_at AT TIME ZONE 'UTC') + interval '45 minutes') AT TIME ZONE 'UTC'";

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
export interface GoldenUnique {
  name: string;
  columns: string[];
}
export interface GoldenTable {
  exportName: string;
  table: string;
  columns: GoldenColumn[];
  uniques: GoldenUnique[];
  constraints: GoldenConstraint[];
  foreignKeys: GoldenForeignKey[];
  indexes: GoldenIndex[];
}

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
const fk = (
  name: string,
  columns: string[],
  parentExport: string,
  parentTable: string,
  parentColumns: string[] = ["id"],
): GoldenForeignKey => ({ name, columns, parentExport, parentTable, parentColumns });
/** A UNIQUE constraint named uq_<table>_<columns>, unless an explicit name is given. */
const unique = (table: string, columns: string[], name?: string): GoldenUnique => ({
  name: name ?? `uq_${table}_${columns.join("_")}`,
  columns,
});

function table(
  exportName: string,
  name: string,
  columns: GoldenColumn[],
  rest: {
    uniques: GoldenUnique[];
    foreignKeys: GoldenForeignKey[];
    checks: GoldenConstraint[];
    indexes?: GoldenIndex[];
  },
): GoldenTable {
  return {
    exportName,
    table: name,
    columns,
    uniques: rest.uniques,
    constraints: [
      { name: `pk_${name}`, kind: "p", definition: "PRIMARY KEY (id)" },
      ...rest.uniques.map(
        (u): GoldenConstraint => ({
          name: u.name,
          kind: "u",
          definition: `UNIQUE (${u.columns.join(", ")})`,
        }),
      ),
      ...rest.foreignKeys.map(
        (f): GoldenConstraint => ({
          name: f.name,
          kind: "f",
          definition: `FOREIGN KEY (${f.columns.join(", ")}) REFERENCES app.${f.parentTable}(${f.parentColumns.join(", ")}) ON DELETE RESTRICT`,
        }),
      ),
      ...rest.checks,
    ],
    foreignKeys: rest.foreignKeys,
    indexes: [
      {
        name: `pk_${name}`,
        definition: `CREATE UNIQUE INDEX pk_${name} ON app.${name} USING btree (id)`,
      },
      ...rest.uniques.map(
        (u): GoldenIndex => ({
          name: u.name,
          definition: `CREATE UNIQUE INDEX ${u.name} ON app.${name} USING btree (${u.columns.join(", ")})`,
        }),
      ),
      ...(rest.indexes ?? []),
    ],
  };
}

// ---- SPEC-100 §30 karaoke_holds ---------------------------------------------------------------------
// Plan U-2: the state / timestamp CHECK is the four lines of §30 as written (ACTIVE: the three NULL; each other
// state: its own timestamp NOT NULL), nothing stricter.
const holdsTable = table(
  "karaokeHolds",
  KARAOKE_HOLDS,
  [
    idColumn(),
    publicRef(),
    col("order_id", "bigint"),
    col("order_item_id", "bigint"),
    ["order_purpose", "text", true, "", "", "'KARAOKE_PURCHASE'::text"],
    col("customer_profile_id", "bigint"),
    col("slot_id", "bigint"),
    col("state", "text"),
    now("hold_acquired_at"),
    ["hold_expires_at", TSTZ, false, "", "s", HOLD_EXPIRY_EXPRESSION],
    col("committed_at", TSTZ, false),
    col("released_at", TSTZ, false),
    col("expired_at", TSTZ, false),
    now("created_at"),
    now("updated_at"),
  ],
  {
    uniques: [
      unique(KARAOKE_HOLDS, ["public_ref"]),
      unique(KARAOKE_HOLDS, ["order_item_id"]),
      unique(
        KARAOKE_HOLDS,
        ["id", "order_id", "order_item_id", "customer_profile_id", "slot_id"],
        HOLD_RESERVATION_TARGET,
      ),
    ],
    foreignKeys: [
      fk(
        "fk_karaoke_holds_order_item",
        ["order_item_id", "order_id", "order_purpose", "slot_id"],
        "orderItems",
        "order_items",
        ["id", "order_id", "purpose", "karaoke_slot_id"],
      ),
      fk("fk_karaoke_holds_order", ["order_id", "customer_profile_id"], "orders", "orders", [
        "id",
        "customer_profile_id",
      ]),
    ],
    checks: [
      check(
        "ck_karaoke_holds_order_purpose",
        "(order_purpose = 'KARAOKE_PURCHASE'::text)",
        "order_purpose = 'KARAOKE_PURCHASE'",
      ),
      allowlist("ck_karaoke_holds_state", "state", KARAOKE_HOLD_STATES),
      check(
        "ck_karaoke_holds_state_times",
        "(((state = 'ACTIVE'::text) AND (committed_at IS NULL) AND (released_at IS NULL) AND (expired_at IS NULL))" +
          " OR ((state = 'COMMITTED'::text) AND (committed_at IS NOT NULL))" +
          " OR ((state = 'RELEASED'::text) AND (released_at IS NOT NULL))" +
          " OR ((state = 'EXPIRED'::text) AND (expired_at IS NOT NULL)))",
        "(state = 'ACTIVE' AND committed_at IS NULL AND released_at IS NULL AND expired_at IS NULL)" +
          " OR (state = 'COMMITTED' AND committed_at IS NOT NULL)" +
          " OR (state = 'RELEASED' AND released_at IS NOT NULL)" +
          " OR (state = 'EXPIRED' AND expired_at IS NOT NULL)",
      ),
    ],
    indexes: [
      {
        name: "ix_karaoke_holds_customer_active",
        definition:
          "CREATE INDEX ix_karaoke_holds_customer_active ON app.karaoke_holds USING btree (customer_profile_id, slot_id) WHERE (state = 'ACTIVE'::text)",
        declared: {
          columns: [
            ["customer_profile_id", "asc"],
            ["slot_id", "asc"],
          ],
          unique: false,
          where: "state = 'ACTIVE'",
        },
      },
      {
        name: ACTIVE_HOLD_INDEX,
        definition: `CREATE UNIQUE INDEX ${ACTIVE_HOLD_INDEX} ON app.karaoke_holds USING btree (slot_id) WHERE (state = 'ACTIVE'::text)`,
        declared: { columns: [["slot_id", "asc"]], unique: true, where: "state = 'ACTIVE'" },
      },
    ],
  },
);

// ---- SPEC-100 §33 karaoke_reservations --------------------------------------------------------------
const reservationsTable = table(
  "karaokeReservations",
  KARAOKE_RESERVATIONS,
  [
    idColumn(),
    publicRef(),
    col("order_id", "bigint"),
    col("order_item_id", "bigint"),
    col("hold_id", "bigint"),
    col("customer_profile_id", "bigint"),
    col("slot_id", "bigint"),
    col("state", "text"),
    col("usage_start_snapshot", TSTZ),
    col("usage_end_snapshot", TSTZ),
    now("confirmed_at"),
    col("canceled_at", TSTZ, false),
    now("created_at"),
    now("updated_at"),
  ],
  {
    uniques: [
      unique(KARAOKE_RESERVATIONS, ["public_ref"]),
      unique(KARAOKE_RESERVATIONS, ["order_item_id"]),
      unique(KARAOKE_RESERVATIONS, ["slot_id"]),
      unique(KARAOKE_RESERVATIONS, ["hold_id"]),
      unique(KARAOKE_RESERVATIONS, ["id", "customer_profile_id"]),
    ],
    foreignKeys: [
      fk(
        "fk_karaoke_reservations_hold",
        ["hold_id", "order_id", "order_item_id", "customer_profile_id", "slot_id"],
        "karaokeHolds",
        KARAOKE_HOLDS,
        ["id", "order_id", "order_item_id", "customer_profile_id", "slot_id"],
      ),
    ],
    checks: [
      allowlist("ck_karaoke_reservations_state", "state", KARAOKE_RESERVATION_STATES),
      check(
        "ck_karaoke_reservations_usage_snapshot",
        "(usage_start_snapshot < usage_end_snapshot)",
        "usage_start_snapshot < usage_end_snapshot",
      ),
      check(
        "ck_karaoke_reservations_canceled_at",
        "((state = 'CANCELED'::text) = (canceled_at IS NOT NULL))",
        "(state = 'CANCELED') = (canceled_at IS NOT NULL)",
      ),
    ],
    indexes: [
      {
        name: "ix_karaoke_reservations_customer_time",
        definition:
          "CREATE INDEX ix_karaoke_reservations_customer_time ON app.karaoke_reservations USING btree (customer_profile_id, usage_start_snapshot DESC)",
        declared: {
          columns: [
            ["customer_profile_id", "asc"],
            ["usage_start_snapshot", "desc"],
          ],
          unique: false,
        },
      },
      {
        name: "ix_karaoke_reservations_state_time",
        definition:
          "CREATE INDEX ix_karaoke_reservations_state_time ON app.karaoke_reservations USING btree (state, usage_start_snapshot DESC)",
        declared: {
          columns: [
            ["state", "asc"],
            ["usage_start_snapshot", "desc"],
          ],
          unique: false,
        },
      },
    ],
  },
);

// ---- SPEC-100 §34 karaoke_tickets -------------------------------------------------------------------
// No created_at / updated_at: §34 lists issued_at and state_changed_at only.
const ticketsTable = table(
  "karaokeTickets",
  KARAOKE_TICKETS,
  [
    idColumn(),
    publicRef(),
    col("reservation_id", "bigint"),
    col("owner_profile_id", "bigint"),
    col("state", "text"),
    col("expires_at", TSTZ),
    now("issued_at"),
    now("state_changed_at"),
  ],
  {
    uniques: [unique(KARAOKE_TICKETS, ["public_ref"]), unique(KARAOKE_TICKETS, ["reservation_id"])],
    foreignKeys: [
      fk(
        "fk_karaoke_tickets_reservation",
        ["reservation_id", "owner_profile_id"],
        "karaokeReservations",
        KARAOKE_RESERVATIONS,
        ["id", "customer_profile_id"],
      ),
    ],
    checks: [allowlist("ck_karaoke_tickets_state", "state", KARAOKE_TICKET_STATES)],
  },
);

// ---- SPEC-100 §37 karaoke_checkins ------------------------------------------------------------------
const checkinsTable = table(
  "karaokeCheckins",
  KARAOKE_CHECKINS,
  [
    idColumn(),
    col("karaoke_ticket_id", "bigint"),
    col("staff_profile_id", "bigint"),
    col("staff_role_assignment_id", "bigint"),
    now("checked_in_at"),
    now("created_at"),
  ],
  {
    uniques: [unique(KARAOKE_CHECKINS, ["karaoke_ticket_id"])],
    foreignKeys: [
      fk(
        "fk_karaoke_checkins_karaoke_ticket",
        ["karaoke_ticket_id"],
        "karaokeTickets",
        KARAOKE_TICKETS,
      ),
      fk(
        "fk_karaoke_checkins_staff_profile",
        ["staff_profile_id"],
        "businessProfiles",
        "business_profiles",
      ),
      fk(
        "fk_karaoke_checkins_staff_role_assignment",
        ["staff_role_assignment_id"],
        "roleAssignments",
        "role_assignments",
      ),
    ],
    checks: [],
  },
);

export const GOLDEN_TABLES: readonly GoldenTable[] = [
  holdsTable,
  reservationsTable,
  ticketsTable,
  checkinsTable,
];

/**
 * Sizes counted by hand from SPEC-100 §30, §33, §34, §37 and the plan (guards against empty comparisons): columns,
 * constraints (PK + UNIQUE + FK + CHECK) and indexes (PK + UNIQUE + the §45 indexes) per table.
 */
export const SPEC_COLUMN_COUNTS = [15, 14, 8, 6];
export const SPEC_CONSTRAINT_COUNTS = [9, 10, 5, 5];
export const SPEC_INDEX_COUNTS = [6, 8, 3, 2];

/** The separately created indexes of 0007 (SPEC-100 §45.1, §45.4, §30), in name order. */
export const SEPARATE_INDEX_NAMES = GOLDEN_TABLES.flatMap((g) =>
  g.indexes.filter((i) => i.declared).map((i) => i.name),
).sort();
