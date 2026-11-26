import { defineAuditChange } from "../audit-events.ts";

// The initial data targets (SPEC-100 section 13.5 DB-SEED-001..004, SPEC-180 INF-SEED-003, UCR-180-001 and
// UCR-180-007). Table and column names are constants here; no identifier is ever built from the input.
// Karaoke Slots are not an input row: they are generated from the windows (slots.ts) for the Scopes
// created in the same run, and their columns are listed in SLOT_COLUMNS.

/** One input column. `required` columns must be present and non-null; the others default to NULL. */
export type InputColumn =
  | {
      readonly name: string;
      readonly kind: "text";
      readonly required: boolean;
      /** Only the Event name has a CHECK (char_length > 0); other text may be empty. */
      readonly nonEmpty?: boolean;
    }
  | { readonly name: string; readonly kind: "timestamp"; readonly required: boolean }
  | {
      readonly name: string;
      readonly kind: "integer";
      readonly required: boolean;
      readonly min: number;
      readonly max: number;
      readonly sqlType: "bigint" | "integer";
    }
  | { readonly name: string; readonly kind: "currency"; readonly required: boolean };

export type FixedColumn = { readonly name: string; readonly sql: string };

export type RowTargetKey =
  | "event"
  | "entry_ticket_offerings"
  | "goods"
  | "karaoke_sales_configuration"
  | "karaoke_exclusive_scopes";

export type InitialDataTarget = {
  readonly key: RowTargetKey;
  readonly table:
    | "app.events"
    | "app.entry_ticket_offerings"
    | "app.goods"
    | "app.karaoke_sales_configurations"
    | "app.karaoke_exclusive_scopes";
  /** Every target but the Event belongs to the Event (`event_id`). */
  readonly parent: "none" | "event";
  readonly auditTargetType:
    | "PUBLIC_CONTENT"
    | "ENTRY_TICKET_OFFERING"
    | "GOODS"
    | "KARAOKE_SALES_CONFIGURATION"
    | "KARAOKE_EXCLUSIVE_SCOPE";
  readonly afterState: "SUSPENDED" | null;
  /** Input columns, in table column order. */
  readonly columns: readonly InputColumn[];
  /** [earlier, later] pairs that must satisfy earlier < later when both are present. */
  readonly periods: readonly (readonly [string, string])[];
  /** Columns the command always sets itself (DB-SEED-001 fixed values, DB-SEED-004). */
  readonly fixed: readonly FixedColumn[];
};

const text = (name: string, required = false, nonEmpty = false): InputColumn => ({
  name,
  kind: "text",
  required,
  nonEmpty,
});
const timestamp = (name: string, required = false): InputColumn => ({
  name,
  kind: "timestamp",
  required,
});
const INT4_MAX = 2147483647;
const amount: InputColumn = {
  name: "unit_amount",
  kind: "integer",
  required: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  sqlType: "bigint",
};
const purchaseLimit: InputColumn = {
  name: "purchase_limit",
  kind: "integer",
  required: true,
  min: 1,
  max: INT4_MAX,
  sqlType: "integer",
};
const currency: InputColumn = { name: "currency", kind: "currency", required: true };
const SALES_PERIOD = ["sales_starts_at", "sales_ends_at"] as const;
const SUSPENDED: FixedColumn = { name: "sale_control_state", sql: "'SUSPENDED'" };

export const EVENT_TARGET: InitialDataTarget = {
  key: "event",
  table: "app.events",
  parent: "none",
  auditTargetType: "PUBLIC_CONTENT",
  afterState: null,
  columns: [
    text("name", true, true),
    text("summary"),
    timestamp("starts_at"),
    timestamp("ends_at"),
    text("venue_name"),
    text("venue_details"),
    text("access_information"),
    text("participant_notices"),
  ],
  periods: [["starts_at", "ends_at"]],
  fixed: [{ name: "business_timezone", sql: "'Asia/Tokyo'" }],
};

export const OFFERING_TARGET: InitialDataTarget = {
  key: "entry_ticket_offerings",
  table: "app.entry_ticket_offerings",
  parent: "event",
  auditTargetType: "ENTRY_TICKET_OFFERING",
  afterState: "SUSPENDED",
  columns: [
    text("name", true),
    text("description"),
    amount,
    currency,
    timestamp("sales_starts_at", true),
    timestamp("sales_ends_at", true),
    {
      name: "sales_capacity",
      kind: "integer",
      required: true,
      min: 0,
      max: INT4_MAX,
      sqlType: "integer",
    },
    purchaseLimit,
    timestamp("checkin_opens_at"),
    timestamp("checkin_closes_at"),
  ],
  periods: [SALES_PERIOD, ["checkin_opens_at", "checkin_closes_at"]],
  fixed: [SUSPENDED, { name: "held_quantity", sql: "0" }, { name: "committed_quantity", sql: "0" }],
};

/** SPEC-100 section 15.3; the Inventory row of each Goods is GOODS_INVENTORY_FIXED (DB-GDS-001). */
export const GOODS_TARGET: InitialDataTarget = {
  key: "goods",
  table: "app.goods",
  parent: "event",
  auditTargetType: "GOODS",
  afterState: "SUSPENDED",
  columns: [
    text("name", true),
    text("description"),
    amount,
    currency,
    timestamp("sales_starts_at", true),
    timestamp("sales_ends_at", true),
    purchaseLimit,
  ],
  periods: [SALES_PERIOD],
  fixed: [SUSPENDED],
};

/**
 * `app.goods_inventory` of a created Goods (DB-SEED-004: no stock). The Inventory has no Public
 * Reference: these field names go into the Goods' own Audit Event (OBS-AUD-014).
 */
export const GOODS_INVENTORY_FIXED: readonly FixedColumn[] = [
  { name: "saleable_capacity", sql: "0" },
  { name: "held_quantity", sql: "0" },
  { name: "committed_quantity", sql: "0" },
];

/** SPEC-100 section 15.2. The standard 15 + 5 minutes are fixed, never input. */
export const KARAOKE_SALES_CONFIGURATION_TARGET: InitialDataTarget = {
  key: "karaoke_sales_configuration",
  table: "app.karaoke_sales_configurations",
  parent: "event",
  auditTargetType: "KARAOKE_SALES_CONFIGURATION",
  afterState: "SUSPENDED",
  columns: [
    text("name", true),
    amount,
    currency,
    timestamp("sales_starts_at", true),
    timestamp("sales_ends_at", true),
    purchaseLimit,
  ],
  periods: [SALES_PERIOD],
  fixed: [
    SUSPENDED,
    { name: "standard_usage_minutes", sql: "15" },
    { name: "standard_maintenance_minutes", sql: "5" },
  ],
};

/** SPEC-100 section 27. `sort_order` is required: the DB DEFAULT is not relied on (DB-SEED-003). */
export const KARAOKE_SCOPE_TARGET: InitialDataTarget = {
  key: "karaoke_exclusive_scopes",
  table: "app.karaoke_exclusive_scopes",
  parent: "event",
  auditTargetType: "KARAOKE_EXCLUSIVE_SCOPE",
  afterState: null,
  columns: [
    text("name", true),
    {
      name: "sort_order",
      kind: "integer",
      required: true,
      min: -2147483648,
      max: INT4_MAX,
      sqlType: "integer",
    },
  ],
  periods: [],
  fixed: [],
};

/**
 * The `app.karaoke_slots` columns that carry a value of the Slot itself, in table order: the field
 * names of its Audit Event. The Scope and Sales Configuration references are not listed, like the
 * `event_id` of the other targets.
 */
export const SLOT_COLUMNS = [
  "state",
  "usage_start",
  "usage_end",
  "cycle_end",
  "generation_cause_key",
  "generation_candidate_no",
] as const;

const ROW_TARGETS = [
  EVENT_TARGET,
  OFFERING_TARGET,
  GOODS_TARGET,
  KARAOKE_SALES_CONFIGURATION_TARGET,
  KARAOKE_SCOPE_TARGET,
];

/** The one Audit change spec for PROVISION.INITIAL_DATA_SEED (SPEC-160 section 35, OBS-AUD-014). */
export const INITIAL_DATA_AUDIT_CHANGE = defineAuditChange({
  operationIds: ["PROVISION.INITIAL_DATA_SEED"],
  states: ["SUSPENDED", "AVAILABLE"],
  fields: [
    ...ROW_TARGETS.flatMap((target) => [
      ...target.columns.map((column) => column.name),
      ...target.fixed.map((column) => column.name),
    ]),
    ...GOODS_INVENTORY_FIXED.map((column) => column.name),
    ...SLOT_COLUMNS,
  ].filter((name, index, all) => all.indexOf(name) === index),
  summary: {},
});
