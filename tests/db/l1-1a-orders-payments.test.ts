import { readFile } from "node:fs/promises";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../../packages/db/src/index.ts";
import { migrationIdentities } from "../../packages/db/src/migrations.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  ACTIVE_BINDING_INDEX,
  CHECKOUT_ATTEMPTS,
  CHECKOUT_CREATION_RESULTS,
  ENTRY_ALLOCATION_PURPOSES,
  ENTRY_ALLOCATION_STATES,
  ENTRY_ALLOCATIONS,
  GOLDEN_TABLES,
  LIVE_FULL_REFUND_INDEX,
  LIVE_FULL_REFUND_STATES,
  ORDER_ITEMS,
  ORDER_PAYMENT_SEQUENCES,
  ORDER_PAYMENT_TABLES,
  ORDER_PURPOSES,
  ORDER_STATES,
  ORDERS,
  PAYMENT_BINDINGS,
  REFUND_RECORDS,
  REFUND_STATES,
  SEPARATE_INDEX_NAMES,
  SPEC_COLUMN_COUNTS,
  SPEC_CONSTRAINT_COUNTS,
  SPEC_INDEX_COUNTS,
  TERMINAL_FAILURE_STATES,
  WEBHOOK_PROCESSING_STATES,
  WEBHOOK_RECEIPTS,
} from "../harness/db/orders-payments-golden.ts";
import {
  ALL_RUNTIME_ROLES,
  columnAclEntries,
  expectedColumnAclEntries,
  expectedTableAclOthers,
  expectRuntimePoolBehavior,
  grantedInsertStatement,
  PURCHASE_API_INSERT_COLUMNS,
  privilegeMismatches,
  tableAcl,
} from "../harness/db/purchase-runtime-grants.ts";

// PR-L1-1a C1: the seven Order / payment tables of migration 0006 (app.orders, app.order_items,
// app.entry_sales_allocations, app.checkout_attempts, app.payment_bindings, app.webhook_receipts and
// app.refund_records) on a real PostgreSQL 17 (SPEC-100 §16-§18, §20-§23, §45, §67 items 8, 12-15, 24; SPEC-170
// §22-§24, TST-DB-001, TST-DB-004, TST-CON-001). Constraints, generated columns, identity, foreign keys,
// concurrency and privileges are never proven by a fake (TST-GEN-004, DEV-TST-003). The catalog goldens come from
// tests/harness/db/orders-payments-golden.ts, written by hand from SPEC-100 and the plan, never derived from
// schema-contract.json or from the migration. Every violating row breaks exactly one constraint unless the case says
// otherwise, and every assertion checks the SQLSTATE and the constraint (or column) name together. All data is
// synthetic: no real Stripe ID, Email address or person.

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// An id no identity sequence of this test database reaches.
const ABSENT_ID = "9223372036854775807";
const SALES_START = "2030-01-01T00:00:00Z";
const SALES_END = "2030-01-02T00:00:00Z";
const AT = "2030-01-01T03:00:00Z";
const TSTZ = "timestamp with time zone";

type RuntimeRole = "app_api_runtime" | "app_email_runtime" | "app_reconciliation_runtime";
const RUNTIME_SERVICES = [
  ["app_api_runtime", "api"],
  ["app_email_runtime", "email-worker"],
  ["app_reconciliation_runtime", "reconciliation-worker"],
] as const;

let admin: Client;
const runtimes = new Map<RuntimeRole, ReturnType<typeof createDatabase>>();
const poolOf = (role: RuntimeRole): Pool => {
  const runtime = runtimes.get(role);
  if (!runtime) throw new Error(`runtime pool ${role} is not open`);
  return runtime.pool;
};

beforeAll(async () => {
  admin = new Client({ connectionString: url });
  await admin.connect();
  // TST-DB-002: the session that runs most cases is UTC and READ COMMITTED, checked before setup.
  expect((await admin.query("SHOW TimeZone")).rows[0].TimeZone).toBe("UTC");
  expect((await admin.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe(
    "read committed",
  );
  await prepareFoundationDatabase(admin);
  await installSyntheticDirectory(admin);
  const ca = await readFile(caPath as string, "utf8");
  for (const [role, service] of RUNTIME_SERVICES) {
    const runtimeUrl = new URL(url as string);
    runtimeUrl.username = role;
    runtimeUrl.password = "";
    runtimeUrl.search = "";
    runtimes.set(
      role,
      createDatabase({ connectionString: runtimeUrl.href, environment: "test", service, ca }),
    );
  }
});

afterAll(async () => {
  for (const runtime of runtimes.values()) await runtime.close();
  await admin?.end();
});

// ---- helpers: one transaction per scenario, one savepoint per attempt ---------------------------

interface PgError {
  code?: string;
  constraint?: string;
  column?: string;
}
type Row = Record<string, unknown>;
const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function inRolledBackTransaction<T>(run: () => Promise<T>): Promise<T> {
  await admin.query("BEGIN");
  try {
    return await run();
  } finally {
    await admin.query("ROLLBACK");
  }
}

// A failed statement never poisons the next one: it is undone to its own savepoint.
async function attempt(statement: string, values: unknown[] = []): Promise<PgError | undefined> {
  await admin.query("SAVEPOINT attempt");
  try {
    await admin.query(statement, values);
    await admin.query("RELEASE SAVEPOINT attempt");
    return undefined;
  } catch (error) {
    await admin.query("ROLLBACK TO SAVEPOINT attempt");
    return error as PgError;
  }
}

// Table and column names come from fixed test literals; every value is a bind parameter. An
// undefined value omits the column so that its DEFAULT or NOT NULL behaviour is exercised.
function insertStatement(table: string, row: Row, returning?: string): [string, unknown[]] {
  const columns = Object.keys(row).filter((column) => row[column] !== undefined);
  return [
    `INSERT INTO app.${table}(${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})${returning ? ` RETURNING ${returning}` : ""}`,
    columns.map((column) => row[column]),
  ];
}

const tryInsert = (table: string, row: Row) => attempt(...insertStatement(table, row));

async function insertRow(table: string, row: Row): Promise<string> {
  const [statement, values] = insertStatement(table, row, "id");
  return (await admin.query(statement, values)).rows[0].id as string;
}

function expectViolation(error: PgError | undefined, code: string, name: string, label: string) {
  expect(error, `${label}: must be rejected`).toBeDefined();
  expect(error?.code, `${label}: SQLSTATE`).toBe(code);
  // A NOT NULL violation names the column; every other class names the constraint.
  expect(code === "23502" ? error?.column : error?.constraint, `${label}: ${name}`).toBe(name);
}

async function expectAccepted(table: string, row: Row, label: string) {
  expect(await tryInsert(table, row), `${label}: must be accepted`).toBeUndefined();
}

async function expectRejected(table: string, row: Row, code: string, name: string, label: string) {
  expectViolation(await tryInsert(table, row), code, name, label);
}

async function countRows(table: string, where = "true", values: unknown[] = []): Promise<number> {
  return (
    await admin.query(`SELECT count(*)::int AS count FROM app.${table} WHERE ${where}`, values)
  ).rows[0].count;
}

async function expectNothingCommitted() {
  for (const table of ORDER_PAYMENT_TABLES) {
    expect(await countRows(table), `${table} rows`).toBe(0);
  }
}

// ---- synthetic row factories (valid by default; overrides break one rule at a time) --------------

let counter = 0;
const next = () => ++counter;
const uuid = () => `00000000-0000-4000-8000-${(0xa10000 + next()).toString(16).padStart(12, "0")}`;
// Synthetic, obviously fake Stripe-shaped identifiers (no real object).
const fakeStripe = (prefix: string) => `${prefix}_synthetic_l1a_${next()}`;
const sha256 = () => Buffer.alloc(32, next() % 256);

/** The timestamps a state needs to satisfy ck_orders_confirmed_at and ck_orders_terminal_at. */
function orderTimes(state: string): Row {
  return {
    confirmed_at: state === "CONFIRMED" ? AT : undefined,
    terminal_at: (TERMINAL_FAILURE_STATES as readonly string[]).includes(state) ? AT : undefined,
  };
}

interface Seed {
  profile: string;
  otherProfile: string;
  offering: string;
  otherOffering: string;
  slot: string;
  goods: string;
  order: (purpose: string, o?: Row) => Row;
  newOrder: (purpose: string, o?: Row) => Promise<string>;
  item: (orderId: string, purpose: string, o?: Row) => Row;
  newItem: (orderId: string, purpose: string, o?: Row) => Promise<string>;
  allocation: (itemId: string, orderId: string, o?: Row) => Row;
  attemptRow: (orderId: string, o?: Row) => Row;
  newAttempt: (orderId: string, o?: Row) => Promise<string>;
  binding: (orderId: string, attemptId: string, o?: Row) => Row;
  receipt: (o?: Row) => Row;
  refund: (orderId: string, o?: Row) => Row;
}

/** The source column a valid item of each purpose carries (ENTRY_GOODS_PURCHASE: the Entry source). */
function sourceOf(purpose: string, s: Pick<Seed, "offering" | "slot" | "goods">): Row {
  switch (purpose) {
    case "ENTRY_TICKET_PURCHASE":
    case "ENTRY_GOODS_PURCHASE":
      return { entry_offering_id: s.offering };
    case "KARAOKE_PURCHASE":
      return { karaoke_slot_id: s.slot };
    case "GOODS_PURCHASE":
      return { goods_id: s.goods };
    default:
      return {};
  }
}

async function insertParents() {
  const profile = await insertRow("business_profiles", { auth_subject: uuid() });
  const otherProfile = await insertRow("business_profiles", { auth_subject: uuid() });
  const event = await insertRow("events", { name: "合成イベント" });
  const offeringRow = (name: string): Row => ({
    event_id: event,
    name,
    unit_amount: 1000,
    currency: "JPY",
    sales_starts_at: SALES_START,
    sales_ends_at: SALES_END,
    sale_control_state: "ENABLED",
    sales_capacity: 100,
    purchase_limit: 4,
  });
  const offering = await insertRow("entry_ticket_offerings", offeringRow("合成入場券A"));
  const otherOffering = await insertRow("entry_ticket_offerings", offeringRow("合成入場券B"));
  const config = await insertRow("karaoke_sales_configurations", {
    event_id: event,
    name: "合成カラオケ",
    unit_amount: 500,
    currency: "JPY",
    sales_starts_at: SALES_START,
    sales_ends_at: SALES_END,
    sale_control_state: "ENABLED",
    purchase_limit: 2,
  });
  const scope = await insertRow("karaoke_exclusive_scopes", {
    event_id: event,
    name: "合成スコープ",
  });
  const slot = await insertRow("karaoke_slots", {
    exclusive_scope_id: scope,
    sales_configuration_id: config,
    state: "AVAILABLE",
    usage_start: "2030-01-01T01:00:00Z",
    usage_end: "2030-01-01T01:15:00Z",
    cycle_end: "2030-01-01T01:20:00Z",
    generation_cause_key: uuid(),
    generation_candidate_no: 0,
  });
  const goods = await insertRow("goods", {
    event_id: event,
    name: "合成グッズ",
    unit_amount: 2000,
    currency: "JPY",
    sales_starts_at: SALES_START,
    sales_ends_at: SALES_END,
    sale_control_state: "ENABLED",
    purchase_limit: 3,
  });
  return { profile, otherProfile, event, offering, otherOffering, config, scope, slot, goods };
}

function factories(parents: Awaited<ReturnType<typeof insertParents>>): Seed {
  const order = (purpose: string, o: Row = {}): Row => {
    const state = (o.state as string | undefined) ?? "PREPARED";
    return {
      purchase_cause_key: uuid(),
      customer_profile_id: parents.profile,
      purpose,
      state,
      currency: "JPY",
      total_amount: 1000,
      ...orderTimes(state),
      ...o,
    };
  };
  let line = 0;
  const item = (orderId: string, purpose: string, o: Row = {}): Row => ({
    order_id: orderId,
    purpose,
    line_no: ++line,
    quantity: 1,
    unit_amount: 1000,
    currency: "JPY",
    item_name_snapshot: "合成明細",
    ...sourceOf(purpose, parents),
    ...o,
  });
  const attemptRow = (orderId: string, o: Row = {}): Row => ({
    order_id: orderId,
    attempt_no: next(),
    stripe_idempotency_key: `synthetic-idem-${next()}`,
    creation_result: "PENDING",
    ...o,
  });
  return {
    ...parents,
    order,
    newOrder: (purpose, o) => insertRow(ORDERS, order(purpose, o)),
    item,
    newItem: (orderId, purpose, o) => insertRow(ORDER_ITEMS, item(orderId, purpose, o)),
    allocation: (itemId, orderId, o = {}) => ({
      order_item_id: itemId,
      order_id: orderId,
      purpose: "ENTRY_TICKET_PURCHASE",
      offering_id: parents.offering,
      quantity: 1,
      state: "HELD",
      ...o,
    }),
    attemptRow,
    newAttempt: (orderId, o) => insertRow(CHECKOUT_ATTEMPTS, attemptRow(orderId, o)),
    binding: (orderId, attemptId, o = {}) => ({
      order_id: orderId,
      checkout_attempt_id: attemptId,
      stripe_checkout_session_id: fakeStripe("cs_test"),
      checkout_session_created_at: AT,
      amount_total: 1000,
      currency: "JPY",
      ...o,
    }),
    receipt: (o = {}) => ({
      stripe_event_id: fakeStripe("evt_test"),
      event_type: "checkout.session.completed",
      livemode: false,
      processing_state: "RECEIVED",
      payload_sha256: sha256(),
      canonical_snapshot: JSON.stringify({ synthetic: true }),
      ...o,
    }),
    refund: (orderId, o = {}) => ({
      order_id: orderId,
      business_cause_key: uuid(),
      stripe_idempotency_key: `synthetic-refund-${next()}`,
      state: "REQUESTED",
      requested_amount: 1000,
      currency: "JPY",
      is_full_refund: true,
      requested_by_profile_id: parents.otherProfile,
      ...o,
    }),
  };
}

// Parents and the scenario's rows, inside a transaction that the scenario rolls back.
async function withSeed<T>(run: (seed: Seed) => Promise<T>): Promise<T> {
  const result = await inRolledBackTransaction(async () => run(factories(await insertParents())));
  await expectNothingCommitted();
  return result;
}

const nearMisses = (value: string) => [value.toLowerCase(), ` ${value}`, `${value} `, `${value}_X`];

// ---- TC-DB-ARC-007-007 --------------------------------------------------------------------------

describe("TC-DB-ARC-007-007 migration 0006 and the catalog of the seven Order / payment tables (real PostgreSQL 17)", () => {
  it("TC-DB-ARC-007-007 the journal lists 0001 to 0006 exactly once each with the source hashes, and a second run changes nothing", async () => {
    const identities = await migrationIdentities();
    const read = async () =>
      (await admin.query("SELECT version, source_hash FROM app.schema_migrations ORDER BY version"))
        .rows;
    const before = await read();
    expect(before.map((row) => row.version).slice(0, 6)).toEqual([
      "0001_foundation",
      "0002_audit_events",
      "0003_public_content_sales",
      "0004_karaoke_scopes_slots",
      "0005_idempotency_records",
      "0006_orders_payments",
    ]);
    expect(new Set(before.map((row) => row.version)).size).toBe(before.length);
    expect(before.map((row) => [row.version, row.source_hash])).toEqual(
      identities.map((identity) => [identity.version, identity.hash]),
    );
    // Pinned from the committed history: an applied migration is never edited (DB-MIG-003).
    const hashOf = (name: string) => identities.find((i) => i.name === name)?.hash;
    expect(
      [
        "0001_foundation.sql",
        "0002_audit_events.sql",
        "0003_public_content_sales.sql",
        "0004_karaoke_scopes_slots.sql",
        "0005_idempotency_records.sql",
      ].map(hashOf),
    ).toEqual([
      "8be0243f1a20c66feddef29f21f805be6fc4d6ca6b78e6994e520189de3cf8bd",
      "7cc76ebe922de728c6965bc4734583b99aaa13bd74119e03e5c244281001409f",
      "cdf90998b2fccab719bb67ca6b41ff1b3988f3c742694fc2433b1ace445398c4",
      "02be479e7f312644f8badef65d692fede56f2c12041b5c1a4dea0e3051aed3ea",
      "e8ab474227a561d8c764c6ec8c8f039571ec400869e5347f573af713555a585a",
    ]);

    await admin.query("SET ROLE app_migrator");
    try {
      await runMigrations(admin);
    } finally {
      await admin.query("RESET ROLE");
    }
    expect(await read()).toEqual(before);
  });

  it("TC-DB-ARC-007-007 0006 only creates the seven tables and the nine section 45 indexes and revokes; it alters, grants and drops nothing", async () => {
    const identities = await migrationIdentities();
    const sixth = identities.find((i) => i.name === "0006_orders_payments.sql");
    expect(sixth, "0006_orders_payments.sql exists").toBeDefined();
    const sqlText = (sixth?.sql ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const parents = ["business_profiles", "entry_ticket_offerings", "goods", "karaoke_slots"];
    const referenced = [...new Set([...sqlText.matchAll(/\bapp\.([a-z_]+)/g)].map((m) => m[1]))];
    expect(referenced.sort()).toEqual([...ORDER_PAYMENT_TABLES, ...parents].sort());
    // The four existing tables appear only as foreign key targets: no existing object changes.
    expect(
      sqlText.replace(new RegExp(`\\bREFERENCES\\s+app\\.(${parents.join("|")})\\b`, "g"), ""),
    ).not.toMatch(new RegExp(`\\bapp\\.(${parents.join("|")})\\b`));
    for (const forbidden of [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bALTER\b/i,
      /\bGRANT\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION|EXTENSION|ROLE|SCHEMA|VIEW)\b/i,
      /\bOWNER\s+TO\b/i,
      /\bROW\s+LEVEL\s+SECURITY\b/i,
    ]) {
      expect(sqlText, `0006 must not contain ${forbidden}`).not.toMatch(forbidden);
    }
    expect([...sqlText.matchAll(/\bCREATE\s+TABLE\s+app\.([a-z_]+)/gi)].map((m) => m[1])).toEqual([
      ...ORDER_PAYMENT_TABLES,
    ]);
    expect(
      [...sqlText.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+([a-z_]+)/gi)].map((m) => m[1]).sort(),
    ).toEqual(SEPARATE_INDEX_NAMES);
    // The three predicates are those of the two partial unique indexes and the Webhook retry index.
    expect([...sqlText.matchAll(/\bWHERE\b/gi)]).toHaveLength(3);
    expect([...sqlText.matchAll(/\bREVOKE\s+ALL\b/gi)]).toHaveLength(1);
  });

  it("TC-DB-ARC-007-007 the hand-written goldens have the SPEC-100 sizes (89 columns, 69 constraints, 41 indexes)", () => {
    expect(GOLDEN_TABLES.map((g) => g.table)).toEqual([...ORDER_PAYMENT_TABLES]);
    expect(GOLDEN_TABLES.map((g) => g.columns.length)).toEqual(SPEC_COLUMN_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.constraints.length)).toEqual(SPEC_CONSTRAINT_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.indexes.length)).toEqual(SPEC_INDEX_COUNTS);
  });

  it("TC-DB-ARC-007-007 columns of the seven tables equal the goldens in attnum order, including the two generated columns", async () => {
    for (const golden of GOLDEN_TABLES) {
      const rows = (
        await admin.query(
          `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
                  a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS default_expr
             FROM pg_attribute a
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum`,
          [`app.${golden.table}`],
        )
      ).rows;
      expect(
        rows.map((r) => [
          r.attname,
          r.type,
          r.attnotnull,
          r.attidentity,
          r.attgenerated,
          r.default_expr,
        ]),
        golden.table,
      ).toEqual(golden.columns);
    }
  });

  it("TC-DB-ARC-007-007 constraints equal the goldens by name, kind and definition, all validated and not deferrable", async () => {
    let total = 0;
    for (const golden of GOLDEN_TABLES) {
      const rows = (
        await admin.query(
          `SELECT conname, contype, pg_get_constraintdef(oid) AS definition, convalidated, condeferrable, condeferred
             FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
          [`app.${golden.table}`],
        )
      ).rows;
      total += rows.length;
      expect(
        rows.map((r) => [r.conname, r.contype, r.definition]),
        golden.table,
      ).toEqual([...golden.constraints].sort(byName).map((c) => [c.name, c.kind, c.definition]));
      for (const row of rows) {
        expect([row.convalidated, row.condeferrable, row.condeferred], row.conname).toEqual([
          true,
          false,
          false,
        ]);
      }
    }
    expect(total).toBe(69);
  });

  it("TC-DB-ARC-007-007 exactly 41 valid indexes equal the goldens, with only the nine section 45 indexes besides PK and UNIQUE", async () => {
    let total = 0;
    for (const golden of GOLDEN_TABLES) {
      const rows = (
        await admin.query(
          `SELECT x.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
                  i.indisvalid, i.indisready, i.indislive
             FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
            WHERE i.indrelid = $1::regclass ORDER BY x.relname`,
          [`app.${golden.table}`],
        )
      ).rows;
      total += rows.length;
      expect(
        rows.map((r) => [r.name, r.definition]),
        golden.table,
      ).toEqual([...golden.indexes].sort(byName).map((i) => [i.name, i.definition]));
      expect(rows.every((r) => r.indisvalid && r.indisready && r.indislive)).toBe(true);
    }
    expect(total).toBe(41);
  });

  it("TC-DB-ARC-007-007 owner is app_migrator, row level security is off, there are seven bigint identity sequences and every time column is timestamptz", async () => {
    const tables = (
      await admin.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) ORDER BY c.relname`,
        [[...ORDER_PAYMENT_TABLES]],
      )
    ).rows;
    expect(tables.map((t) => t.relname)).toEqual([...ORDER_PAYMENT_TABLES].sort());
    for (const table of tables) {
      expect(
        [table.owner, table.relrowsecurity, table.relforcerowsecurity, table.relkind],
        table.relname,
      ).toEqual(["app_migrator", false, false, "r"]);
    }
    const sequences = (
      await admin.query(
        `SELECT c.relname, format_type(s.seqtypid, NULL) AS type, pg_get_userbyid(c.relowner) AS owner
           FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) ORDER BY c.relname`,
        [ORDER_PAYMENT_SEQUENCES],
      )
    ).rows;
    expect(sequences.map((s) => [s.relname, s.type, s.owner])).toEqual(
      [...ORDER_PAYMENT_SEQUENCES].sort().map((name) => [name, "bigint", "app_migrator"]),
    );
    // DB-TIM-001: no timestamp without time zone, and every *_at column is timestamptz.
    const timeColumns = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname LIKE '%\\_at' OR format_type(a.atttypid, a.atttypmod) LIKE 'timestamp%')`,
        [[...ORDER_PAYMENT_TABLES]],
      )
    ).rows;
    // 4 + 1 + 3 + 4 + 5 + 3 + 5 time columns (SPEC-100 §16-§18, §20-§23).
    expect(timeColumns.length).toBe(25);
    for (const column of timeColumns) expect(column.type, column.name).toBe(TSTZ);
  });

  it("TC-DB-ARC-007-007 the live catalog equals requiredCatalog, checked directly and not through readiness", async () => {
    const live = (await admin.query(catalogQuery)).rows[0].catalog;
    expect(live).toEqual(requiredCatalog);
    const liveTables = live.tables.map((row: unknown[]) => row[0]);
    for (const table of ORDER_PAYMENT_TABLES) expect(liveTables).toContain(table);
    const liveConstraints = live.constraints.map((row: unknown[]) => row[1]);
    for (const golden of GOLDEN_TABLES)
      for (const c of golden.constraints) expect(liveConstraints).toContain(c.name);
  });

  it("TC-DB-ARC-007-007 public_ref of orders and checkout_attempts is a database generated v4 UUID unique by name; ids are GENERATED ALWAYS on all seven tables", async () => {
    await withSeed(async (seed) => {
      const order = (
        await admin.query(
          ...insertStatement(ORDERS, seed.order("GOODS_PURCHASE"), "id, public_ref"),
        )
      ).rows[0];
      expect(order.public_ref).toMatch(UUID_V4);
      expectViolation(
        await tryInsert(ORDERS, seed.order("GOODS_PURCHASE", { public_ref: order.public_ref })),
        "23505",
        "uq_orders_public_ref",
        "duplicate Order public_ref",
      );
      const attemptRow = (
        await admin.query(
          ...insertStatement(CHECKOUT_ATTEMPTS, seed.attemptRow(order.id), "public_ref"),
        )
      ).rows[0];
      expect(attemptRow.public_ref).toMatch(UUID_V4);
      expectViolation(
        await tryInsert(
          CHECKOUT_ATTEMPTS,
          seed.attemptRow(order.id, { public_ref: attemptRow.public_ref }),
        ),
        "23505",
        "uq_checkout_attempts_public_ref",
        "duplicate Checkout Attempt public_ref",
      );
      // GENERATED ALWAYS: an explicit id without OVERRIDING SYSTEM VALUE is refused (428C9).
      for (const table of ORDER_PAYMENT_TABLES) {
        expect(
          (await attempt(`INSERT INTO app.${table}(id) VALUES ($1)`, [ABSENT_ID]))?.code,
          `${table} explicit id`,
        ).toBe("428C9");
      }
      expectViolation(
        await attempt(
          `INSERT INTO app.orders(id, purchase_cause_key, customer_profile_id, purpose, state, currency, total_amount)
           OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, 'GOODS_PURCHASE', 'PREPARED', 'JPY', 0)`,
          [order.id, uuid(), seed.profile],
        ),
        "23505",
        "pk_orders",
        "duplicate Order id",
      );
    });
  });
});

// ---- TC-DB-STA-002-003 --------------------------------------------------------------------------

describe("TC-DB-STA-002-003 State and Purpose allowlist CHECK constraints keep the SPEC-030 / SPEC-070 names exactly (real PostgreSQL 17)", () => {
  it("TC-DB-STA-002-003 Order: the 7 states and 4 purposes are accepted; near misses are refused by name; state and purpose have no default", async () => {
    await withSeed(async (seed) => {
      for (const state of ORDER_STATES)
        await expectAccepted(ORDERS, seed.order("GOODS_PURCHASE", { state }), `state ${state}`);
      for (const purpose of ORDER_PURPOSES)
        await expectAccepted(ORDERS, seed.order(purpose), `purpose ${purpose}`);
      for (const state of [...ORDER_STATES.flatMap(nearMisses), "CANCELLED", "PENDING", ""])
        await expectRejected(
          ORDERS,
          seed.order("GOODS_PURCHASE", { state, confirmed_at: undefined, terminal_at: undefined }),
          "23514",
          "ck_orders_state",
          `state ${JSON.stringify(state)}`,
        );
      for (const purpose of [...ORDER_PURPOSES.flatMap(nearMisses), "CART_PURCHASE"])
        await expectRejected(
          ORDERS,
          seed.order(purpose),
          "23514",
          "ck_orders_purpose",
          `purpose ${JSON.stringify(purpose)}`,
        );
      await expectRejected(
        ORDERS,
        seed.order("GOODS_PURCHASE", { state: undefined }),
        "23502",
        "state",
        "omitted state",
      );
      await expectRejected(
        ORDERS,
        seed.order(undefined as unknown as string),
        "23502",
        "purpose",
        "omitted purpose",
      );
    });
  });

  it("TC-DB-STA-002-003 Allocation: HELD, COMMITTED, RELEASED and the two Entry purposes are accepted; others are refused by name", async () => {
    await withSeed(async (seed) => {
      const accept: [string, Row][] = [
        ["HELD", {}],
        ["COMMITTED", { committed_at: AT }],
        ["RELEASED", { released_at: AT }],
      ];
      for (const purpose of ENTRY_ALLOCATION_PURPOSES) {
        for (const [state, times] of accept) {
          const orderId = await seed.newOrder(purpose);
          const itemId = await seed.newItem(orderId, purpose);
          await expectAccepted(
            ENTRY_ALLOCATIONS,
            seed.allocation(itemId, orderId, { purpose, state, ...times }),
            `${purpose} ${state}`,
          );
        }
      }
      expect(accept.map(([state]) => state)).toEqual([...ENTRY_ALLOCATION_STATES]);
      const orderId = await seed.newOrder("ENTRY_TICKET_PURCHASE");
      const itemId = await seed.newItem(orderId, "ENTRY_TICKET_PURCHASE");
      for (const state of [...ENTRY_ALLOCATION_STATES.flatMap(nearMisses), "ACTIVE", "EXPIRED"])
        await expectRejected(
          ENTRY_ALLOCATIONS,
          seed.allocation(itemId, orderId, { state }),
          "23514",
          "ck_entry_sales_allocations_state",
          `state ${JSON.stringify(state)}`,
        );
      // A non-Entry purpose is refused by the CHECK, which PostgreSQL evaluates before the foreign keys.
      for (const purpose of ["GOODS_PURCHASE", "KARAOKE_PURCHASE", "entry_ticket_purchase"])
        await expectRejected(
          ENTRY_ALLOCATIONS,
          seed.allocation(itemId, orderId, { purpose }),
          "23514",
          "ck_entry_sales_allocations_purpose",
          `purpose ${purpose}`,
        );
      await expectRejected(
        ENTRY_ALLOCATIONS,
        seed.allocation(itemId, orderId, { state: undefined }),
        "23502",
        "state",
        "omitted state",
      );
    });
  });

  it("TC-DB-STA-002-003 Checkout creation_result, Webhook processing_state and Refund state accept exactly their values and have no default", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      for (const value of CHECKOUT_CREATION_RESULTS)
        await expectAccepted(
          CHECKOUT_ATTEMPTS,
          seed.attemptRow(orderId, { creation_result: value }),
          value,
        );
      for (const value of [...CHECKOUT_CREATION_RESULTS.flatMap(nearMisses), "SUCCESS", "TIMEOUT"])
        await expectRejected(
          CHECKOUT_ATTEMPTS,
          seed.attemptRow(orderId, { creation_result: value }),
          "23514",
          "ck_checkout_attempts_creation_result",
          `creation_result ${JSON.stringify(value)}`,
        );
      await expectRejected(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(orderId, { creation_result: undefined }),
        "23502",
        "creation_result",
        "omitted creation_result",
      );

      for (const value of WEBHOOK_PROCESSING_STATES)
        await expectAccepted(WEBHOOK_RECEIPTS, seed.receipt({ processing_state: value }), value);
      for (const value of [...WEBHOOK_PROCESSING_STATES.flatMap(nearMisses), "FAILED", "DUPLICATE"])
        await expectRejected(
          WEBHOOK_RECEIPTS,
          seed.receipt({ processing_state: value }),
          "23514",
          "ck_webhook_receipts_processing_state",
          `processing_state ${JSON.stringify(value)}`,
        );
      await expectRejected(
        WEBHOOK_RECEIPTS,
        seed.receipt({ processing_state: undefined }),
        "23502",
        "processing_state",
        "omitted processing_state",
      );

      // Partial refunds, so that the live full refund index never interferes with the allowlist.
      for (const value of REFUND_STATES)
        await expectAccepted(
          REFUND_RECORDS,
          seed.refund(orderId, { state: value, is_full_refund: false }),
          value,
        );
      for (const value of [...REFUND_STATES.flatMap(nearMisses), "CANCELED", "REFUNDED"])
        await expectRejected(
          REFUND_RECORDS,
          seed.refund(orderId, { state: value, is_full_refund: false }),
          "23514",
          "ck_refund_records_state",
          `refund state ${JSON.stringify(value)}`,
        );
      await expectRejected(
        REFUND_RECORDS,
        seed.refund(orderId, { state: undefined }),
        "23502",
        "state",
        "omitted refund state",
      );
    });
  });
});

// ---- TC-DB-ORD-001-001 --------------------------------------------------------------------------

describe("TC-DB-ORD-001-001 Order timestamps follow the state, and the purchase cause, customer and snapshot are kept (real PostgreSQL 17)", () => {
  it("TC-DB-ORD-001-001 CONFIRMED requires confirmed_at and every other state forbids it (both directions of SPEC-100 section 16)", async () => {
    await withSeed(async (seed) => {
      await expectRejected(
        ORDERS,
        seed.order("GOODS_PURCHASE", { state: "CONFIRMED", confirmed_at: undefined }),
        "23514",
        "ck_orders_confirmed_at",
        "CONFIRMED without confirmed_at",
      );
      for (const state of ORDER_STATES.filter((s) => s !== "CONFIRMED"))
        await expectRejected(
          ORDERS,
          seed.order("GOODS_PURCHASE", { state, confirmed_at: AT }),
          "23514",
          "ck_orders_confirmed_at",
          `${state} with confirmed_at`,
        );
    });
  });

  it("TC-DB-ORD-001-001 PAYMENT_FAILED, CANCELED and EXPIRED require terminal_at; the other four states are not constrained by it (plan U-2)", async () => {
    await withSeed(async (seed) => {
      for (const state of TERMINAL_FAILURE_STATES)
        await expectRejected(
          ORDERS,
          seed.order("GOODS_PURCHASE", { state, terminal_at: undefined }),
          "23514",
          "ck_orders_terminal_at",
          `${state} without terminal_at`,
        );
      for (const state of ["PREPARED", "AWAITING_PAYMENT", "CONFIRMED", "REVIEW_REQUIRED"]) {
        await expectAccepted(
          ORDERS,
          seed.order("GOODS_PURCHASE", { state, terminal_at: undefined }),
          `${state} without terminal_at`,
        );
        await expectAccepted(
          ORDERS,
          seed.order("GOODS_PURCHASE", { state, terminal_at: AT }),
          `${state} with terminal_at`,
        );
      }
    });
  });

  it("TC-DB-ORD-001-001 a state UPDATE is refused unless the same statement sets the matching timestamp", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      expectViolation(
        await attempt("UPDATE app.orders SET state = 'CONFIRMED' WHERE id = $1", [orderId]),
        "23514",
        "ck_orders_confirmed_at",
        "PREPARED -> CONFIRMED without confirmed_at",
      );
      expectViolation(
        await attempt("UPDATE app.orders SET state = 'EXPIRED' WHERE id = $1", [orderId]),
        "23514",
        "ck_orders_terminal_at",
        "PREPARED -> EXPIRED without terminal_at",
      );
      expect(
        await attempt(
          "UPDATE app.orders SET state = 'AWAITING_PAYMENT', updated_at = transaction_timestamp() WHERE id = $1",
          [orderId],
        ),
      ).toBeUndefined();
      expect(
        await attempt(
          "UPDATE app.orders SET state = 'CONFIRMED', confirmed_at = $2 WHERE id = $1",
          [orderId, AT],
        ),
      ).toBeUndefined();
      expect(
        (await admin.query("SELECT state FROM app.orders WHERE id = $1", [orderId])).rows[0].state,
      ).toBe("CONFIRMED");
    });
  });

  it("TC-DB-ORD-001-001 purchase_cause_key is unique by name, and the required columns are NOT NULL", async () => {
    await withSeed(async (seed) => {
      const key = uuid();
      await insertRow(ORDERS, seed.order("GOODS_PURCHASE", { purchase_cause_key: key }));
      await expectRejected(
        ORDERS,
        seed.order("ENTRY_TICKET_PURCHASE", { purchase_cause_key: key }),
        "23505",
        "uq_orders_purchase_cause_key",
        "repeated purchase_cause_key",
      );
      for (const column of [
        "purchase_cause_key",
        "customer_profile_id",
        "currency",
        "total_amount",
      ])
        await expectRejected(
          ORDERS,
          seed.order("GOODS_PURCHASE", { [column]: undefined }),
          "23502",
          column,
          `omitted ${column}`,
        );
    });
  });

  it("TC-DB-ORD-001-001 created_at, updated_at and the time defaults are the transaction's transaction_timestamp() on every table", async () => {
    await withSeed(async (seed) => {
      const started = (await admin.query("SELECT transaction_timestamp() AS t")).rows[0].t as Date;
      await admin.query("SELECT pg_sleep(0.01)");
      const orderId = await seed.newOrder("ENTRY_TICKET_PURCHASE");
      const itemId = await seed.newItem(orderId, "ENTRY_TICKET_PURCHASE");
      await insertRow(ENTRY_ALLOCATIONS, seed.allocation(itemId, orderId));
      const attemptId = await seed.newAttempt(orderId);
      await insertRow(PAYMENT_BINDINGS, seed.binding(orderId, attemptId));
      await insertRow(WEBHOOK_RECEIPTS, seed.receipt());
      await insertRow(REFUND_RECORDS, seed.refund(orderId));
      const defaulted: [string, string[]][] = [
        [ORDERS, ["created_at", "updated_at"]],
        [ORDER_ITEMS, ["created_at"]],
        [ENTRY_ALLOCATIONS, ["held_at"]],
        [CHECKOUT_ATTEMPTS, ["created_at", "updated_at"]],
        [PAYMENT_BINDINGS, ["bound_at"]],
        [WEBHOOK_RECEIPTS, ["received_at", "updated_at"]],
        [REFUND_RECORDS, ["requested_at", "updated_at"]],
      ];
      for (const [table, columns] of defaulted) {
        const row = (await admin.query(`SELECT ${columns.join(", ")} FROM app.${table}`)).rows[0];
        for (const column of columns)
          expect((row[column] as Date).getTime(), `${table}.${column}`).toBe(started.getTime());
      }
      expect(
        (await admin.query("SELECT is_active FROM app.payment_bindings")).rows[0].is_active,
      ).toBe(true);
    });
  });
});

// ---- TC-DB-ORD-002-001 --------------------------------------------------------------------------

describe("TC-DB-ORD-002-001 the Order Item purpose and purchase source are exclusive, and a Karaoke item has quantity 1 (real PostgreSQL 17)", () => {
  // Every combination of (Entry Offering, Karaoke Slot, Goods) being set, for each of the four purposes.
  const COMBINATIONS: [entry: boolean, slot: boolean, goods: boolean][] = [];
  for (const entry of [false, true])
    for (const slot of [false, true])
      for (const goods of [false, true]) COMBINATIONS.push([entry, slot, goods]);
  const ALLOWED: Record<string, string[]> = {
    ENTRY_TICKET_PURCHASE: ["100"],
    KARAOKE_PURCHASE: ["010"],
    GOODS_PURCHASE: ["001"],
    ENTRY_GOODS_PURCHASE: ["100", "001"],
  };
  const key = ([e, s, g]: [boolean, boolean, boolean]) => `${+e}${+s}${+g}`;

  it("TC-DB-ORD-002-001 all 32 purpose x source combinations: exactly the five SPEC-100 section 17 shapes are accepted, the rest is refused by ck_order_items_source", async () => {
    await withSeed(async (seed) => {
      let accepted = 0;
      for (const purpose of ORDER_PURPOSES) {
        const orderId = await seed.newOrder(purpose);
        for (const combination of COMBINATIONS) {
          const [entry, slot, goods] = combination;
          const row = seed.item(orderId, purpose, {
            entry_offering_id: entry ? seed.offering : null,
            karaoke_slot_id: slot ? seed.slot : null,
            goods_id: goods ? seed.goods : null,
          });
          const label = `${purpose} entry=${entry} slot=${slot} goods=${goods}`;
          if (ALLOWED[purpose]?.includes(key(combination))) {
            await expectAccepted(ORDER_ITEMS, row, label);
            accepted += 1;
          } else await expectRejected(ORDER_ITEMS, row, "23514", "ck_order_items_source", label);
        }
      }
      expect(accepted).toBe(5);
    });
  });

  it("TC-DB-ORD-002-001 a Karaoke item with quantity 2 is refused by the source CHECK; Entry and Goods items take any positive quantity", async () => {
    await withSeed(async (seed) => {
      const karaoke = await seed.newOrder("KARAOKE_PURCHASE");
      await expectRejected(
        ORDER_ITEMS,
        seed.item(karaoke, "KARAOKE_PURCHASE", { quantity: 2 }),
        "23514",
        "ck_order_items_source",
        "Karaoke quantity 2",
      );
      await expectAccepted(
        ORDER_ITEMS,
        seed.item(karaoke, "KARAOKE_PURCHASE", { quantity: 1 }),
        "Karaoke quantity 1",
      );
      for (const purpose of ["ENTRY_TICKET_PURCHASE", "GOODS_PURCHASE", "ENTRY_GOODS_PURCHASE"]) {
        const orderId = await seed.newOrder(purpose);
        await expectAccepted(
          ORDER_ITEMS,
          seed.item(orderId, purpose, { quantity: 4 }),
          `${purpose} quantity 4`,
        );
      }
    });
  });

  it("TC-DB-ORD-002-001 line_no and quantity must be positive, line_no is unique per Order, and the source rows must exist", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      await expectRejected(
        ORDER_ITEMS,
        seed.item(orderId, "GOODS_PURCHASE", { line_no: 0 }),
        "23514",
        "ck_order_items_line_no",
        "line_no 0",
      );
      await expectRejected(
        ORDER_ITEMS,
        seed.item(orderId, "GOODS_PURCHASE", { quantity: 0 }),
        "23514",
        "ck_order_items_quantity",
        "quantity 0",
      );
      await expectRejected(
        ORDER_ITEMS,
        seed.item(orderId, "GOODS_PURCHASE", { quantity: -1 }),
        "23514",
        "ck_order_items_quantity",
        "quantity -1",
      );
      await insertRow(ORDER_ITEMS, seed.item(orderId, "GOODS_PURCHASE", { line_no: 1 }));
      await expectRejected(
        ORDER_ITEMS,
        seed.item(orderId, "GOODS_PURCHASE", { line_no: 1 }),
        "23505",
        "uq_order_items_order_id_line_no",
        "repeated line_no",
      );
      const other = await seed.newOrder("GOODS_PURCHASE");
      await expectAccepted(
        ORDER_ITEMS,
        seed.item(other, "GOODS_PURCHASE", { line_no: 1 }),
        "line_no 1 of another Order",
      );
      const absent: [string, string, string][] = [
        ["ENTRY_TICKET_PURCHASE", "entry_offering_id", "fk_order_items_entry_offering"],
        ["KARAOKE_PURCHASE", "karaoke_slot_id", "fk_order_items_karaoke_slot"],
        ["GOODS_PURCHASE", "goods_id", "fk_order_items_goods"],
      ];
      for (const [purpose, column, name] of absent) {
        const target = await seed.newOrder(purpose);
        await expectRejected(
          ORDER_ITEMS,
          seed.item(target, purpose, { [column]: ABSENT_ID }),
          "23503",
          name,
          `absent ${column}`,
        );
      }
      for (const column of ["item_name_snapshot", "unit_amount", "currency", "line_no", "quantity"])
        await expectRejected(
          ORDER_ITEMS,
          seed.item(orderId, "GOODS_PURCHASE", { [column]: undefined }),
          "23502",
          column,
          `omitted ${column}`,
        );
    });
  });
});

// ---- TC-DB-ORD-003-001 --------------------------------------------------------------------------

describe("TC-DB-ORD-003-001 the composite foreign key keeps each item's purpose and currency equal to its Order's, and line totals are generated (real PostgreSQL 17)", () => {
  it("TC-DB-ORD-003-001 an item whose purpose or currency differs from its Order's, or whose Order is absent, is refused with 23503 fk_order_items_order", async () => {
    await withSeed(async (seed) => {
      const entryOrder = await seed.newOrder("ENTRY_TICKET_PURCHASE");
      // Valid on its own (a Goods source), but the Order is an Entry Order.
      await expectRejected(
        ORDER_ITEMS,
        seed.item(entryOrder, "GOODS_PURCHASE"),
        "23503",
        "fk_order_items_order",
        "purpose differs from the Order's",
      );
      await expectRejected(
        ORDER_ITEMS,
        seed.item(entryOrder, "ENTRY_TICKET_PURCHASE", { currency: "USD" }),
        "23503",
        "fk_order_items_order",
        "currency differs from the Order's",
      );
      await expectRejected(
        ORDER_ITEMS,
        seed.item(ABSENT_ID, "ENTRY_TICKET_PURCHASE"),
        "23503",
        "fk_order_items_order",
        "absent Order",
      );
      // The composite Purpose takes both an Entry item and a Goods item.
      const composite = await seed.newOrder("ENTRY_GOODS_PURCHASE");
      await expectAccepted(
        ORDER_ITEMS,
        seed.item(composite, "ENTRY_GOODS_PURCHASE"),
        "composite Entry item",
      );
      await expectAccepted(
        ORDER_ITEMS,
        seed.item(composite, "ENTRY_GOODS_PURCHASE", {
          entry_offering_id: null,
          goods_id: seed.goods,
        }),
        "composite Goods item",
      );
    });
  });

  it("TC-DB-ORD-003-001 once an Order has an item, its purpose and currency cannot be changed (DB-ORD-001): the UPDATE is refused with 23503", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      await seed.newItem(orderId, "GOODS_PURCHASE");
      expectViolation(
        await attempt("UPDATE app.orders SET currency = 'USD' WHERE id = $1", [orderId]),
        "23503",
        "fk_order_items_order",
        "currency change",
      );
      expectViolation(
        await attempt("UPDATE app.orders SET purpose = 'ENTRY_GOODS_PURCHASE' WHERE id = $1", [
          orderId,
        ]),
        "23503",
        "fk_order_items_order",
        "purpose change",
      );
      const row = (
        await admin.query("SELECT purpose, currency FROM app.orders WHERE id = $1", [orderId])
      ).rows[0];
      expect([row.purpose, row.currency]).toEqual(["GOODS_PURCHASE", "JPY"]);
    });
  });

  it("TC-DB-ORD-003-001 line_total_amount is unit_amount * quantity in bigint, cannot be written, follows an UPDATE and refuses a bigint overflow (22003)", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      const [statement, values] = insertStatement(
        ORDER_ITEMS,
        seed.item(orderId, "GOODS_PURCHASE", { unit_amount: "3000000000", quantity: 3 }),
        "id, line_total_amount",
      );
      const created = (await admin.query(statement, values)).rows[0];
      expect(created.line_total_amount).toBe("9000000000");
      expect(
        (
          await tryInsert(
            ORDER_ITEMS,
            seed.item(orderId, "GOODS_PURCHASE", { line_total_amount: 1 }),
          )
        )?.code,
        "explicit line_total_amount",
      ).toBe("428C9");
      expect(
        (
          await attempt("UPDATE app.order_items SET line_total_amount = 1 WHERE id = $1", [
            created.id,
          ])
        )?.code,
        "UPDATE line_total_amount",
      ).toBe("428C9");
      await admin.query("UPDATE app.order_items SET quantity = 4 WHERE id = $1", [created.id]);
      expect(
        (
          await admin.query("SELECT line_total_amount FROM app.order_items WHERE id = $1", [
            created.id,
          ])
        ).rows[0].line_total_amount,
      ).toBe("12000000000");
      expect(
        (
          await tryInsert(
            ORDER_ITEMS,
            seed.item(orderId, "GOODS_PURCHASE", {
              unit_amount: "4611686018427387904",
              quantity: 2,
            }),
          )
        )?.code,
        "overflow",
      ).toBe("22003");
    });
  });
});

// ---- TC-DB-ENT-001-001 --------------------------------------------------------------------------

describe("TC-DB-ENT-001-001 Entry Sales Allocation: three states with their timestamps, one per item, and the item's Order and Offering (real PostgreSQL 17)", () => {
  it("TC-DB-ENT-001-001 each state requires exactly its own timestamp", async () => {
    await withSeed(async (seed) => {
      const cases: [string, Row][] = [
        ["HELD", { committed_at: AT }],
        ["HELD", { released_at: AT }],
        ["COMMITTED", {}],
        ["COMMITTED", { committed_at: AT, released_at: AT }],
        ["RELEASED", {}],
        ["RELEASED", { released_at: AT, committed_at: AT }],
      ];
      for (const [state, times] of cases) {
        const orderId = await seed.newOrder("ENTRY_TICKET_PURCHASE");
        const itemId = await seed.newItem(orderId, "ENTRY_TICKET_PURCHASE");
        await expectRejected(
          ENTRY_ALLOCATIONS,
          seed.allocation(itemId, orderId, { state, ...times }),
          "23514",
          "ck_entry_sales_allocations_state_times",
          `${state} ${JSON.stringify(times)}`,
        );
      }
    });
  });

  it("TC-DB-ENT-001-001 HELD -> COMMITTED and HELD -> RELEASED succeed only with the matching timestamp in the same UPDATE", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("ENTRY_TICKET_PURCHASE");
      const itemId = await seed.newItem(orderId, "ENTRY_TICKET_PURCHASE");
      const id = await insertRow(ENTRY_ALLOCATIONS, seed.allocation(itemId, orderId));
      expectViolation(
        await attempt("UPDATE app.entry_sales_allocations SET state = 'COMMITTED' WHERE id = $1", [
          id,
        ]),
        "23514",
        "ck_entry_sales_allocations_state_times",
        "COMMITTED without committed_at",
      );
      expectViolation(
        await attempt("UPDATE app.entry_sales_allocations SET state = 'RELEASED' WHERE id = $1", [
          id,
        ]),
        "23514",
        "ck_entry_sales_allocations_state_times",
        "RELEASED without released_at",
      );
      expect(
        await attempt(
          "UPDATE app.entry_sales_allocations SET state = 'COMMITTED', committed_at = $2 WHERE id = $1",
          [id, AT],
        ),
      ).toBeUndefined();
      expectViolation(
        await attempt(
          "UPDATE app.entry_sales_allocations SET state = 'RELEASED', released_at = $2 WHERE id = $1",
          [id, AT],
        ),
        "23514",
        "ck_entry_sales_allocations_state_times",
        "COMMITTED -> RELEASED keeping committed_at",
      );
    });
  });

  it("TC-DB-ENT-001-001 one Allocation per item; its Order, purpose and Offering must be the item's; quantity is positive", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("ENTRY_TICKET_PURCHASE");
      const itemId = await seed.newItem(orderId, "ENTRY_TICKET_PURCHASE");
      await insertRow(ENTRY_ALLOCATIONS, seed.allocation(itemId, orderId));
      await expectRejected(
        ENTRY_ALLOCATIONS,
        seed.allocation(itemId, orderId),
        "23505",
        "uq_entry_sales_allocations_order_item_id",
        "second Allocation of the item",
      );
      const freshItem = await seed.newItem(orderId, "ENTRY_TICKET_PURCHASE");
      await expectRejected(
        ENTRY_ALLOCATIONS,
        seed.allocation(freshItem, orderId, { quantity: 0 }),
        "23514",
        "ck_entry_sales_allocations_quantity",
        "quantity 0",
      );
      const otherOrder = await seed.newOrder("ENTRY_TICKET_PURCHASE");
      await expectRejected(
        ENTRY_ALLOCATIONS,
        seed.allocation(freshItem, otherOrder),
        "23503",
        "fk_entry_sales_allocations_order_item",
        "another Order",
      );
      await expectRejected(
        ENTRY_ALLOCATIONS,
        seed.allocation(freshItem, orderId, { purpose: "ENTRY_GOODS_PURCHASE" }),
        "23503",
        "fk_entry_sales_allocations_order_item",
        "purpose differs from the item's",
      );
      await expectRejected(
        ENTRY_ALLOCATIONS,
        seed.allocation(freshItem, orderId, { offering_id: seed.otherOffering }),
        "23503",
        "fk_entry_sales_allocations_offering",
        "another Offering",
      );
      // A Goods item of a composite Order has no Entry Offering, so it cannot carry an Entry Allocation.
      const composite = await seed.newOrder("ENTRY_GOODS_PURCHASE");
      const goodsItem = await seed.newItem(composite, "ENTRY_GOODS_PURCHASE", {
        entry_offering_id: null,
        goods_id: seed.goods,
      });
      await expectRejected(
        ENTRY_ALLOCATIONS,
        seed.allocation(goodsItem, composite, { purpose: "ENTRY_GOODS_PURCHASE" }),
        "23503",
        "fk_entry_sales_allocations_offering",
        "Goods item of a composite Order",
      );
      const entryItem = await seed.newItem(composite, "ENTRY_GOODS_PURCHASE");
      await expectAccepted(
        ENTRY_ALLOCATIONS,
        seed.allocation(entryItem, composite, { purpose: "ENTRY_GOODS_PURCHASE" }),
        "Entry item of a composite Order",
      );
      // The item's Offering cannot be changed under its Allocation.
      expectViolation(
        await attempt("UPDATE app.order_items SET entry_offering_id = $2 WHERE id = $1", [
          itemId,
          seed.otherOffering,
        ]),
        "23503",
        "fk_entry_sales_allocations_offering",
        "changing the item's Offering",
      );
    });
  });
});

// ---- TC-DB-PAY-001-001 --------------------------------------------------------------------------

describe("TC-DB-PAY-001-001 Checkout Attempt numbering and the Stripe idempotency key are unique (real PostgreSQL 17)", () => {
  it("TC-DB-PAY-001-001 attempt_no is positive and unique per Order; the Stripe idempotency key is unique across Orders; the Order must exist", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      const otherOrder = await seed.newOrder("GOODS_PURCHASE");
      await expectRejected(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(orderId, { attempt_no: 0 }),
        "23514",
        "ck_checkout_attempts_attempt_no",
        "attempt_no 0",
      );
      await insertRow(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(orderId, { attempt_no: 1, stripe_idempotency_key: "synthetic-idem-fixed" }),
      );
      await expectRejected(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(orderId, { attempt_no: 1 }),
        "23505",
        "uq_checkout_attempts_order_id_attempt_no",
        "repeated attempt_no",
      );
      await expectAccepted(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(otherOrder, { attempt_no: 1 }),
        "attempt 1 of another Order",
      );
      await expectRejected(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(otherOrder, { stripe_idempotency_key: "synthetic-idem-fixed" }),
        "23505",
        "uq_checkout_attempts_stripe_idempotency_key",
        "repeated Stripe idempotency key",
      );
      await expectRejected(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(ABSENT_ID),
        "23503",
        "fk_checkout_attempts_order",
        "absent Order",
      );
      await expectRejected(
        CHECKOUT_ATTEMPTS,
        seed.attemptRow(orderId, { stripe_idempotency_key: undefined }),
        "23502",
        "stripe_idempotency_key",
        "omitted key",
      );
    });
  });
});

// ---- TC-DB-PAY-002-001 --------------------------------------------------------------------------

describe("TC-DB-PAY-002-001 a Stripe Checkout Session, PaymentIntent or Charge binds to one Order only, through its own Checkout Attempt (real PostgreSQL 17)", () => {
  it("TC-DB-PAY-002-001 the Session, PaymentIntent and Charge IDs are each unique across Orders, while several unset ones are allowed", async () => {
    await withSeed(async (seed) => {
      const a = await seed.newOrder("GOODS_PURCHASE");
      const b = await seed.newOrder("GOODS_PURCHASE");
      const ids = {
        stripe_checkout_session_id: "cs_test_synthetic_fixed",
        stripe_payment_intent_id: "pi_test_synthetic_fixed",
        stripe_charge_id: "ch_test_synthetic_fixed",
      };
      await insertRow(PAYMENT_BINDINGS, seed.binding(a, await seed.newAttempt(a), ids));
      const cases: [string, string][] = [
        ["stripe_checkout_session_id", "uq_payment_bindings_stripe_checkout_session_id"],
        ["stripe_payment_intent_id", "uq_payment_bindings_stripe_payment_intent_id"],
        ["stripe_charge_id", "uq_payment_bindings_stripe_charge_id"],
      ];
      for (const [column, name] of cases)
        await expectRejected(
          PAYMENT_BINDINGS,
          seed.binding(b, await seed.newAttempt(b), { [column]: ids[column as keyof typeof ids] }),
          "23505",
          name,
          `${column} reused by another Order`,
        );
      // NULL PaymentIntent / Charge before payment do not collide with each other (a deactivated binding, so the
      // active Checkout index is not involved).
      for (let i = 0; i < 2; i += 1)
        await expectAccepted(
          PAYMENT_BINDINGS,
          seed.binding(b, await seed.newAttempt(b), { is_active: false, deactivated_at: AT }),
          `unset PaymentIntent ${i}`,
        );
    });
  });

  it("TC-DB-PAY-002-001 a Checkout Attempt binds once, and only to its own Order (composite foreign key)", async () => {
    await withSeed(async (seed) => {
      const a = await seed.newOrder("GOODS_PURCHASE");
      const b = await seed.newOrder("GOODS_PURCHASE");
      const attemptOfA = await seed.newAttempt(a);
      await expectRejected(
        PAYMENT_BINDINGS,
        seed.binding(b, attemptOfA),
        "23503",
        "fk_payment_bindings_checkout_attempt",
        "Attempt of another Order",
      );
      await expectRejected(
        PAYMENT_BINDINGS,
        seed.binding(a, ABSENT_ID),
        "23503",
        "fk_payment_bindings_checkout_attempt",
        "absent Attempt",
      );
      await insertRow(
        PAYMENT_BINDINGS,
        seed.binding(a, attemptOfA, { is_active: false, deactivated_at: AT }),
      );
      await expectRejected(
        PAYMENT_BINDINGS,
        seed.binding(a, attemptOfA, { is_active: false, deactivated_at: AT }),
        "23505",
        "uq_payment_bindings_checkout_attempt_id",
        "second binding of the Attempt",
      );
      for (const column of [
        "stripe_checkout_session_id",
        "checkout_session_created_at",
        "amount_total",
        "currency",
      ])
        await expectRejected(
          PAYMENT_BINDINGS,
          seed.binding(a, await seed.newAttempt(a), { [column]: undefined }),
          "23502",
          column,
          `omitted ${column}`,
        );
    });
  });
});

// ---- TC-DB-PAY-003-001 / -002 -------------------------------------------------------------------

describe("TC-DB-PAY-003-001 at most one active Checkout per Order (ux_payment_bindings_order_active), and is_active agrees with deactivated_at (real PostgreSQL 17)", () => {
  it("TC-DB-PAY-003-001 a second active binding of the same Order is refused by name; deactivating the first makes room; inactive bindings are not limited", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      const first = await insertRow(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId)),
      );
      await expectRejected(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId)),
        "23505",
        ACTIVE_BINDING_INDEX,
        "second active binding",
      );
      const other = await seed.newOrder("GOODS_PURCHASE");
      await expectAccepted(
        PAYMENT_BINDINGS,
        seed.binding(other, await seed.newAttempt(other)),
        "active binding of another Order",
      );
      await admin.query(
        "UPDATE app.payment_bindings SET is_active = false, deactivated_at = $2 WHERE id = $1",
        [first, AT],
      );
      await expectAccepted(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId)),
        "new active binding after deactivation",
      );
      await expectAccepted(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId), {
          is_active: false,
          deactivated_at: AT,
        }),
        "another inactive binding",
      );
      expect(await countRows(PAYMENT_BINDINGS, "order_id = $1 AND is_active", [orderId])).toBe(1);
      // Re-activating the old binding while another is active is refused by the same index.
      expectViolation(
        await attempt(
          "UPDATE app.payment_bindings SET is_active = true, deactivated_at = NULL WHERE id = $1",
          [first],
        ),
        "23505",
        ACTIVE_BINDING_INDEX,
        "re-activating the first binding",
      );
    });
  });

  it("TC-DB-PAY-003-001 is_active true with deactivated_at, or false without it, is refused by ck_payment_bindings_active", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      await expectRejected(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId), { deactivated_at: AT }),
        "23514",
        "ck_payment_bindings_active",
        "active with deactivated_at",
      );
      await expectRejected(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId), { is_active: false }),
        "23514",
        "ck_payment_bindings_active",
        "inactive without deactivated_at",
      );
      const id = await insertRow(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId)),
      );
      expectViolation(
        await attempt("UPDATE app.payment_bindings SET is_active = false WHERE id = $1", [id]),
        "23514",
        "ck_payment_bindings_active",
        "deactivating without deactivated_at",
      );
    });
  });
});

describe("TC-DB-PAY-003-002 the payment deadline is fixed at Session creation + 30 minutes as a generated column (SPEC-100 section 21, UCR-100-006, real PostgreSQL 17)", () => {
  it("TC-DB-PAY-003-002 payment_deadline_at equals checkout_session_created_at + 30 minutes to the microsecond under any session TimeZone, including across a DST change", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      const created = [
        "2030-01-01T03:00:00.123456Z",
        // America/New_York moves to daylight saving time at 2030-03-10T07:00:00Z.
        "2030-03-10T06:45:00.000001Z",
        // Europe/Berlin returns to standard time at 2030-10-27T01:00:00Z.
        "2030-10-27T00:59:59.999999Z",
      ];
      for (const zone of ["UTC", "Asia/Tokyo", "America/New_York", "Europe/Berlin"]) {
        await admin.query(`SET LOCAL TimeZone = '${zone}'`);
        for (const at of created) {
          const [statement, values] = insertStatement(
            PAYMENT_BINDINGS,
            seed.binding(orderId, await seed.newAttempt(orderId), {
              checkout_session_created_at: at,
              is_active: false,
              deactivated_at: at,
            }),
            "id",
          );
          const id = (await admin.query(statement, values)).rows[0].id;
          const row = (
            await admin.query(
              `SELECT extract(epoch FROM payment_deadline_at - checkout_session_created_at) AS seconds,
                      payment_deadline_at = checkout_session_created_at + interval '30 minutes' AS exact,
                      to_char(payment_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS utc
                 FROM app.payment_bindings WHERE id = $1`,
              [id],
            )
          ).rows[0];
          expect([Number(row.seconds), row.exact], `${zone} ${at}`).toEqual([1800, true]);
          const expected = new Date(Date.parse(at) + 30 * 60_000)
            .toISOString()
            .replace(/\.\d+Z$/, "");
          expect(row.utc.startsWith(expected), `${zone} ${at}: ${row.utc}`).toBe(true);
          expect(row.utc.slice(-6), `${zone} ${at} microseconds`).toBe(at.slice(20, 26));
        }
      }
      await admin.query("SET LOCAL TimeZone = 'UTC'");
    });
  });

  it("TC-DB-PAY-003-002 payment_deadline_at cannot be written (428C9) and follows an UPDATE of checkout_session_created_at", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      expect(
        (
          await tryInsert(
            PAYMENT_BINDINGS,
            seed.binding(orderId, await seed.newAttempt(orderId), { payment_deadline_at: AT }),
          )
        )?.code,
        "explicit deadline",
      ).toBe("428C9");
      const id = await insertRow(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId)),
      );
      expect(
        (
          await attempt("UPDATE app.payment_bindings SET payment_deadline_at = $2 WHERE id = $1", [
            id,
            AT,
          ])
        )?.code,
        "UPDATE deadline",
      ).toBe("428C9");
      await admin.query(
        "UPDATE app.payment_bindings SET checkout_session_created_at = '2030-02-01T10:00:00Z' WHERE id = $1",
        [id],
      );
      const row = (
        await admin.query("SELECT payment_deadline_at FROM app.payment_bindings WHERE id = $1", [
          id,
        ])
      ).rows[0];
      expect((row.payment_deadline_at as Date).toISOString()).toBe("2030-02-01T10:30:00.000Z");
    });
  });
});

// ---- TC-DB-PAY-005-001 --------------------------------------------------------------------------

describe("TC-DB-PAY-005-001 one Webhook Receipt per Stripe Event ID, with a 32 byte payload digest and a minimal snapshot (real PostgreSQL 17)", () => {
  it("TC-DB-PAY-005-001 a redelivered Event ID is refused by name, whatever the state of the first receipt", async () => {
    await withSeed(async (seed) => {
      for (const state of WEBHOOK_PROCESSING_STATES) {
        const eventId = fakeStripe("evt_test");
        await insertRow(
          WEBHOOK_RECEIPTS,
          seed.receipt({ stripe_event_id: eventId, processing_state: state }),
        );
        await expectRejected(
          WEBHOOK_RECEIPTS,
          seed.receipt({ stripe_event_id: eventId }),
          "23505",
          "uq_webhook_receipts_stripe_event_id",
          `redelivery after ${state}`,
        );
      }
    });
  });

  it("TC-DB-PAY-005-001 payload_sha256 must be exactly 32 bytes; livemode, event_type, the digest and the snapshot are required", async () => {
    await withSeed(async (seed) => {
      for (const length of [0, 31, 33, 64])
        await expectRejected(
          WEBHOOK_RECEIPTS,
          seed.receipt({ payload_sha256: Buffer.alloc(length, 1) }),
          "23514",
          "ck_webhook_receipts_payload_sha256",
          `${length} bytes`,
        );
      for (const column of [
        "stripe_event_id",
        "event_type",
        "livemode",
        "payload_sha256",
        "canonical_snapshot",
      ])
        await expectRejected(
          WEBHOOK_RECEIPTS,
          seed.receipt({ [column]: undefined }),
          "23502",
          column,
          `omitted ${column}`,
        );
      await expectAccepted(
        WEBHOOK_RECEIPTS,
        seed.receipt({ stripe_object_id: null, stripe_account_id: null }),
        "no object or account",
      );
    });
  });
});

// ---- TC-DB-PAY-006-001 --------------------------------------------------------------------------

describe("TC-DB-PAY-006-001 at most one live or succeeded full refund per Order (ux_refund_records_order_live_full), and one record per Business Cause (real PostgreSQL 17)", () => {
  it("TC-DB-PAY-006-001 any live full refund blocks a second full refund of the Order, in all 4 x 4 state pairs", async () => {
    await withSeed(async (seed) => {
      for (const first of LIVE_FULL_REFUND_STATES) {
        for (const second of LIVE_FULL_REFUND_STATES) {
          const orderId = await seed.newOrder("GOODS_PURCHASE");
          await insertRow(REFUND_RECORDS, seed.refund(orderId, { state: first }));
          await expectRejected(
            REFUND_RECORDS,
            seed.refund(orderId, { state: second }),
            "23505",
            LIVE_FULL_REFUND_INDEX,
            `${first} then ${second}`,
          );
        }
      }
    });
  });

  it("TC-DB-PAY-006-001 after a FAILED full refund a new Business Cause may refund in full; partial refunds and other Orders are not limited", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      await insertRow(REFUND_RECORDS, seed.refund(orderId, { state: "FAILED" }));
      await insertRow(REFUND_RECORDS, seed.refund(orderId, { state: "FAILED" }));
      await expectAccepted(
        REFUND_RECORDS,
        seed.refund(orderId, { state: "REQUESTED" }),
        "full refund after FAILED ones",
      );
      await expectAccepted(
        REFUND_RECORDS,
        seed.refund(orderId, { is_full_refund: false, state: "SUCCEEDED" }),
        "partial refund beside a live full one",
      );
      await expectAccepted(
        REFUND_RECORDS,
        seed.refund(orderId, { is_full_refund: false, state: "PENDING" }),
        "second partial refund",
      );
      const other = await seed.newOrder("GOODS_PURCHASE");
      await expectAccepted(REFUND_RECORDS, seed.refund(other), "full refund of another Order");
      // A FAILED record cannot be moved back into a live state while another live full refund exists.
      const failed = (
        await admin.query(
          "SELECT id FROM app.refund_records WHERE order_id = $1 AND state = 'FAILED' LIMIT 1",
          [orderId],
        )
      ).rows[0].id;
      expectViolation(
        await attempt("UPDATE app.refund_records SET state = 'PENDING' WHERE id = $1", [failed]),
        "23505",
        LIVE_FULL_REFUND_INDEX,
        "FAILED -> PENDING beside a live full refund",
      );
      // A SUCCEEDED full refund blocks any later full refund.
      const done = await seed.newOrder("GOODS_PURCHASE");
      await insertRow(REFUND_RECORDS, seed.refund(done, { state: "SUCCEEDED", succeeded_at: AT }));
      await expectRejected(
        REFUND_RECORDS,
        seed.refund(done),
        "23505",
        LIVE_FULL_REFUND_INDEX,
        "full refund after SUCCEEDED",
      );
    });
  });

  it("TC-DB-PAY-006-001 the Business Cause, the Stripe idempotency key and the Stripe Refund ID are unique; the amount is positive; Order and requester must exist", async () => {
    await withSeed(async (seed) => {
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      const fixed = {
        business_cause_key: uuid(),
        stripe_idempotency_key: "synthetic-refund-fixed",
        stripe_refund_id: "re_test_synthetic_fixed",
      };
      await insertRow(REFUND_RECORDS, seed.refund(orderId, { ...fixed, is_full_refund: false }));
      const cases: [keyof typeof fixed, string][] = [
        ["business_cause_key", "uq_refund_records_business_cause_key"],
        ["stripe_idempotency_key", "uq_refund_records_stripe_idempotency_key"],
        ["stripe_refund_id", "uq_refund_records_stripe_refund_id"],
      ];
      for (const [column, name] of cases)
        await expectRejected(
          REFUND_RECORDS,
          seed.refund(orderId, { is_full_refund: false, [column]: fixed[column] }),
          "23505",
          name,
          `repeated ${column}`,
        );
      await expectAccepted(
        REFUND_RECORDS,
        seed.refund(orderId, { is_full_refund: false, stripe_refund_id: null }),
        "unset Refund ID",
      );
      await expectAccepted(
        REFUND_RECORDS,
        seed.refund(orderId, { is_full_refund: false, stripe_refund_id: null }),
        "second unset Refund ID",
      );
      for (const amount of [0, -1])
        await expectRejected(
          REFUND_RECORDS,
          seed.refund(orderId, { is_full_refund: false, requested_amount: amount }),
          "23514",
          "ck_refund_records_requested_amount",
          `amount ${amount}`,
        );
      await expectRejected(
        REFUND_RECORDS,
        seed.refund(ABSENT_ID),
        "23503",
        "fk_refund_records_order",
        "absent Order",
      );
      await expectRejected(
        REFUND_RECORDS,
        seed.refund(orderId, { is_full_refund: false, requested_by_profile_id: ABSENT_ID }),
        "23503",
        "fk_refund_records_requested_by_profile",
        "absent requester",
      );
      await expectRejected(
        REFUND_RECORDS,
        seed.refund(orderId, { is_full_refund: undefined }),
        "23502",
        "is_full_refund",
        "omitted is_full_refund",
      );
    });
  });
});

// ---- TC-CON-001-002 / -003 ----------------------------------------------------------------------

describe("TC-CON-001-002 two connections cannot both create an active Checkout or a live full refund for one Order (real PostgreSQL 17)", () => {
  const LOCK_WAIT_DEADLINE_MS = 5_000;
  const RACE_CASE_TIMEOUT_MS = 20_000;

  async function waitUntilBlockedOnLock(pid: number, second: Promise<unknown>) {
    // Barrier: Y's INSERT waits for X's uncommitted index entry (a Lock wait). Polling a database
    // condition, never a fixed sleep (TST-CON-001); if Y's INSERT finishes first, fail at once.
    let settled = false;
    void second.finally(() => {
      settled = true;
    });
    const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
    for (;;) {
      if (settled) throw new Error("connection Y's INSERT finished without waiting on X's lock");
      const waiting = (
        await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [pid],
        )
      ).rowCount;
      if (waiting) return;
      if (Date.now() > deadline) throw new Error("connection Y never waited on a lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function race(outcomeOfX: "COMMIT" | "ROLLBACK", table: string, rowX: Row, rowY: Row) {
    const x = new Client({ connectionString: url });
    const y = new Client({ connectionString: url });
    await x.connect();
    await y.connect();
    try {
      for (const [label, client] of [
        ["X", x],
        ["Y", y],
      ] as const) {
        expect((await client.query("SHOW TimeZone")).rows[0].TimeZone, label).toBe("UTC");
        expect(
          (await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation,
          label,
        ).toBe("read committed");
      }
      await x.query("BEGIN");
      await x.query(...insertStatement(table, rowX));
      await y.query("SET statement_timeout = '10s'");
      await y.query("BEGIN");
      const yPid = (await y.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const second = y.query(...insertStatement(table, rowY)).then(
        () => undefined,
        (error: PgError) => error,
      );
      await waitUntilBlockedOnLock(yPid, second);
      await x.query(outcomeOfX);
      const failure = await second;
      await y.query("ROLLBACK");
      return failure;
    } finally {
      await x.end();
      await y.end();
    }
  }

  // Committed fixture rows (removed again by the administrator, children first: fixture cleanup).
  async function withCommittedOrder<T>(run: (seed: Seed, orderId: string) => Promise<T>) {
    const seed = factories(await insertParents());
    const orderId = await seed.newOrder("GOODS_PURCHASE");
    try {
      return await run(seed, orderId);
    } finally {
      for (const table of [PAYMENT_BINDINGS, REFUND_RECORDS, CHECKOUT_ATTEMPTS, ORDERS])
        await admin.query(`DELETE FROM app.${table}`);
      await admin.query("DELETE FROM app.karaoke_slots");
      await admin.query("DELETE FROM app.karaoke_exclusive_scopes");
      await admin.query("DELETE FROM app.karaoke_sales_configurations");
      await admin.query("DELETE FROM app.goods");
      await admin.query("DELETE FROM app.entry_ticket_offerings");
      await admin.query("DELETE FROM app.events");
      await admin.query("DELETE FROM app.business_profiles");
    }
  }

  for (const outcome of ["COMMIT", "ROLLBACK"] as const) {
    it(
      `TC-CON-001-002 active Checkout: Y waits for X and is ${outcome === "COMMIT" ? "refused with 23505 ux_payment_bindings_order_active" : "accepted"} after X ${outcome}`,
      async () => {
        await withCommittedOrder(async (seed, orderId) => {
          const rowX = seed.binding(orderId, await seed.newAttempt(orderId));
          const rowY = seed.binding(orderId, await seed.newAttempt(orderId));
          const failure = await race(outcome, PAYMENT_BINDINGS, rowX, rowY);
          if (outcome === "COMMIT") {
            expectViolation(failure, "23505", ACTIVE_BINDING_INDEX, "Y after X COMMIT");
            expect(await countRows(PAYMENT_BINDINGS, "order_id = $1", [orderId])).toBe(1);
          } else {
            expect(failure, "Y after X ROLLBACK").toBeUndefined();
            expect(await countRows(PAYMENT_BINDINGS, "order_id = $1", [orderId])).toBe(0);
          }
        });
        await expectNothingCommitted();
      },
      RACE_CASE_TIMEOUT_MS,
    );

    it(
      `TC-CON-001-003 live full refund: Y waits for X and is ${outcome === "COMMIT" ? "refused with 23505 ux_refund_records_order_live_full" : "accepted"} after X ${outcome}`,
      async () => {
        await withCommittedOrder(async (seed, orderId) => {
          const failure = await race(
            outcome,
            REFUND_RECORDS,
            seed.refund(orderId),
            seed.refund(orderId),
          );
          if (outcome === "COMMIT") {
            expectViolation(failure, "23505", LIVE_FULL_REFUND_INDEX, "Y after X COMMIT");
            expect(await countRows(REFUND_RECORDS, "order_id = $1", [orderId])).toBe(1);
          } else {
            expect(failure, "Y after X ROLLBACK").toBeUndefined();
            expect(await countRows(REFUND_RECORDS, "order_id = $1", [orderId])).toBe(0);
          }
        });
        await expectNothingCommitted();
      },
      RACE_CASE_TIMEOUT_MS,
    );
  }
});

// ---- TC-DB-MNY-001-001 --------------------------------------------------------------------------

describe("TC-DB-MNY-001-001 amounts are non-negative integers and currencies are three upper-case letters on the four money tables (real PostgreSQL 17)", () => {
  it("TC-DB-MNY-001-001 0 is accepted and -1 refused for total_amount, unit_amount and amount_total; requested_amount must be positive", async () => {
    await withSeed(async (seed) => {
      await expectAccepted(ORDERS, seed.order("GOODS_PURCHASE", { total_amount: 0 }), "total 0");
      await expectRejected(
        ORDERS,
        seed.order("GOODS_PURCHASE", { total_amount: -1 }),
        "23514",
        "ck_orders_total_amount",
        "total -1",
      );
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      await expectAccepted(
        ORDER_ITEMS,
        seed.item(orderId, "GOODS_PURCHASE", { unit_amount: 0 }),
        "unit 0",
      );
      await expectRejected(
        ORDER_ITEMS,
        seed.item(orderId, "GOODS_PURCHASE", { unit_amount: -1 }),
        "23514",
        "ck_order_items_unit_amount",
        "unit -1",
      );
      await expectAccepted(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId), { amount_total: 0 }),
        "amount_total 0",
      );
      await expectRejected(
        PAYMENT_BINDINGS,
        seed.binding(orderId, await seed.newAttempt(orderId), {
          amount_total: -1,
          is_active: false,
          deactivated_at: AT,
        }),
        "23514",
        "ck_payment_bindings_amount_total",
        "amount_total -1",
      );
      // A fractional amount is not an integer: bigint input refuses it (22P02), so no float is ever stored.
      expect(
        (await tryInsert(ORDERS, seed.order("GOODS_PURCHASE", { total_amount: "10.5" })))?.code,
      ).toBe("22P02");
    });
  });

  it("TC-DB-MNY-001-001 currency must be three upper-case letters on orders, order_items, payment_bindings and refund_records", async () => {
    await withSeed(async (seed) => {
      const bad = ["jpy", "Jpy", "JP", "JPYY", "J1Y", " JPY", ""];
      const orderId = await seed.newOrder("GOODS_PURCHASE");
      for (const currency of bad) {
        const label = `currency ${JSON.stringify(currency)}`;
        await expectRejected(
          ORDERS,
          seed.order("GOODS_PURCHASE", { currency }),
          "23514",
          "ck_orders_currency",
          `Order ${label}`,
        );
        // The item CHECK runs before the composite foreign key, so the CHECK names the violation.
        await expectRejected(
          ORDER_ITEMS,
          seed.item(orderId, "GOODS_PURCHASE", { currency }),
          "23514",
          "ck_order_items_currency",
          `item ${label}`,
        );
        await expectRejected(
          PAYMENT_BINDINGS,
          seed.binding(orderId, await seed.newAttempt(orderId), {
            currency,
            is_active: false,
            deactivated_at: AT,
          }),
          "23514",
          "ck_payment_bindings_currency",
          `binding ${label}`,
        );
        await expectRejected(
          REFUND_RECORDS,
          seed.refund(orderId, { currency, is_full_refund: false }),
          "23514",
          "ck_refund_records_currency",
          `refund ${label}`,
        );
      }
      await expectAccepted(ORDERS, seed.order("GOODS_PURCHASE", { currency: "USD" }), "USD");
    });
  });
});

// ---- TC-DB-FK-002-003 ---------------------------------------------------------------------------

describe("TC-DB-FK-002-003 the Order / payment foreign keys restrict deletes and never cascade (real PostgreSQL 17)", () => {
  it("TC-DB-FK-002-003 all twelve foreign keys are ON DELETE RESTRICT and ON UPDATE NO ACTION", async () => {
    const rows = (
      await admin.query(
        `SELECT conname, confdeltype, confupdtype FROM pg_constraint
          WHERE contype = 'f' AND conrelid = ANY($1::regclass[]) ORDER BY conname`,
        [ORDER_PAYMENT_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    const expected = GOLDEN_TABLES.flatMap((g) => g.foreignKeys.map((f) => f.name)).sort();
    expect(expected).toHaveLength(12);
    expect(rows.map((r) => [r.conname, r.confdeltype, r.confupdtype])).toEqual(
      expected.map((name) => [name, "r", "a"]),
    );
  });

  it("TC-DB-FK-002-003 deleting a parent that has Order / payment history is refused with 23503 by name, and nothing is lost", async () => {
    await withSeed(async (seed) => {
      const entryOrder = await seed.newOrder("ENTRY_TICKET_PURCHASE");
      const entryItem = await seed.newItem(entryOrder, "ENTRY_TICKET_PURCHASE");
      await insertRow(ENTRY_ALLOCATIONS, seed.allocation(entryItem, entryOrder));
      const karaokeOrder = await seed.newOrder("KARAOKE_PURCHASE");
      await seed.newItem(karaokeOrder, "KARAOKE_PURCHASE");
      const goodsOrder = await seed.newOrder("GOODS_PURCHASE");
      await seed.newItem(goodsOrder, "GOODS_PURCHASE");
      const payOrder = await seed.newOrder("GOODS_PURCHASE");
      const attemptId = await seed.newAttempt(payOrder);
      await insertRow(PAYMENT_BINDINGS, seed.binding(payOrder, attemptId));
      const lonelyAttemptOrder = await seed.newOrder("GOODS_PURCHASE");
      await seed.newAttempt(lonelyAttemptOrder);
      const refundOrder = await seed.newOrder("GOODS_PURCHASE");
      await insertRow(REFUND_RECORDS, seed.refund(refundOrder));
      const requesterOnly = await insertRow("business_profiles", { auth_subject: uuid() });
      const requesterOrder = await seed.newOrder("GOODS_PURCHASE", {
        customer_profile_id: seed.otherProfile,
      });
      await insertRow(
        REFUND_RECORDS,
        seed.refund(requesterOrder, { requested_by_profile_id: requesterOnly }),
      );
      const before = await Promise.all(ORDER_PAYMENT_TABLES.map((t) => countRows(t)));

      const cases: [string, string, string, string][] = [
        [
          "Order with an item",
          "DELETE FROM app.orders WHERE id = $1",
          goodsOrder,
          "fk_order_items_order",
        ],
        [
          "Offering with an item",
          "DELETE FROM app.entry_ticket_offerings WHERE id = $1",
          seed.offering,
          "fk_order_items_entry_offering",
        ],
        [
          "Slot with an item",
          "DELETE FROM app.karaoke_slots WHERE id = $1",
          seed.slot,
          "fk_order_items_karaoke_slot",
        ],
        [
          "Goods with an item",
          "DELETE FROM app.goods WHERE id = $1",
          seed.goods,
          "fk_order_items_goods",
        ],
        [
          "Attempt with a binding",
          "DELETE FROM app.checkout_attempts WHERE id = $1",
          attemptId,
          "fk_payment_bindings_checkout_attempt",
        ],
        [
          "Order with only an Attempt",
          "DELETE FROM app.orders WHERE id = $1",
          lonelyAttemptOrder,
          "fk_checkout_attempts_order",
        ],
        [
          "Order with only a refund",
          "DELETE FROM app.orders WHERE id = $1",
          refundOrder,
          "fk_refund_records_order",
        ],
        [
          "Profile that only requested a refund",
          "DELETE FROM app.business_profiles WHERE id = $1",
          requesterOnly,
          "fk_refund_records_requested_by_profile",
        ],
        [
          "customer Profile",
          "DELETE FROM app.business_profiles WHERE id = $1",
          seed.profile,
          "fk_orders_customer_profile",
        ],
      ];
      for (const [label, statement, id, name] of cases)
        expectViolation(await attempt(statement, [id]), "23503", name, label);
      // Two foreign keys refer to the deleted row in these cases. Which one reports first follows the order of
      // their RI triggers and is not a contract, so either name is accepted; the delete is refused either way.
      const doubles: [string, string, string, string[]][] = [
        [
          "Order item with an Allocation",
          "DELETE FROM app.order_items WHERE id = $1",
          entryItem,
          ["fk_entry_sales_allocations_offering", "fk_entry_sales_allocations_order_item"],
        ],
        [
          "Order with an Attempt and a binding",
          "DELETE FROM app.orders WHERE id = $1",
          payOrder,
          ["fk_checkout_attempts_order", "fk_payment_bindings_order"],
        ],
      ];
      for (const [label, statement, id, names] of doubles) {
        const error = await attempt(statement, [id]);
        expect(error?.code, `${label}: SQLSTATE`).toBe("23503");
        expect(names, `${label}: ${error?.constraint}`).toContain(error?.constraint);
      }
      expect(await Promise.all(ORDER_PAYMENT_TABLES.map((t) => countRows(t)))).toEqual(before);
    });
  });
});

// ---- TC-SEC-DB-001-003 --------------------------------------------------------------------------

// PR-L1-2c0 (0011) grants these privileges to app_api_runtime; the expectation changes with the grant, not with the
// implementation. The expected sets are the hand-written ones of tests/harness/db/purchase-runtime-grants.ts, never
// read from the live database. checkout_attempts, payment_bindings, webhook_receipts and refund_records stay closed to every runtime role.
describe("TC-SEC-DB-001-003 app_api_runtime has the 0011 grants on orders, order_items and entry_sales_allocations and nothing else; the other runtime roles and PUBLIC have no privilege on the seven Order / payment tables (SEC-DB-001..003, real PostgreSQL 17)", () => {
  const tables = GOLDEN_TABLES.map((g) => ({
    table: g.table,
    columns: g.columns.map((column) => column[0]),
  }));
  const names = tables.map((entry) => entry.table);

  it("TC-SEC-DB-001-003 has_table_privilege, has_any_column_privilege and has_column_privilege of the four runtime roles and PUBLIC equal the plan on every table and column (no difference)", async () => {
    expect(names.length).toBeGreaterThan(0);
    expect(await privilegeMismatches(admin, tables)).toEqual([]);
  });

  it("TC-SEC-DB-001-003 the column ACLs hold only the app_api_runtime INSERT columns of the plan, the table ACLs name app_migrator and the plan's SELECT grant only, and no role may use the seven identity sequences", async () => {
    expect(await columnAclEntries(admin, names)).toEqual(expectedColumnAclEntries(names));
    for (const table of names) {
      const acl = await tableAcl(admin, table);
      expect(acl.ownerPresent, `${table}: owner ACL`).toBe(true);
      expect(acl.others, table).toEqual(expectedTableAclOthers(table));
    }
    for (const sequence of ORDER_PAYMENT_SEQUENCES)
      for (const role of ALL_RUNTIME_ROLES)
        expect(
          (
            await admin.query(
              "SELECT has_sequence_privilege($1, $2, 'USAGE,SELECT,UPDATE') AS allowed",
              [role, `app.${sequence}`],
            )
          ).rows[0].allowed,
          `${role} ${sequence}`,
        ).toBe(false);
  });

  it("TC-SEC-DB-001-003 the runtime pools: SELECT succeeds only where granted; every other SELECT, INSERT, UPDATE, DELETE and TRUNCATE (and an INSERT naming an ungranted column) is refused with 42501", async () => {
    await expectRuntimePoolBehavior(
      (role) => poolOf(role as RuntimeRole),
      GOLDEN_TABLES.map((g) => ({ table: g.table, updateColumn: g.columns[1]?.[0] as string })),
    );
    // Positive control: the granted columns alone pass the privilege check and stop at the first NOT NULL (23502).
    for (const table of names.filter((name) => name in PURCHASE_API_INSERT_COLUMNS))
      await expect(
        poolOf("app_api_runtime").query(grantedInsertStatement(table)),
        table,
      ).rejects.toMatchObject({
        code: "23502",
      });
  });
});
