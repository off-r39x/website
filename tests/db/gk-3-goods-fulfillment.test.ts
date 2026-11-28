import { readFile } from "node:fs/promises";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../../packages/db/src/index.ts";
import { migrationIdentities } from "../../packages/db/src/migrations.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  GOLDEN_TABLES,
  GOODS_ALLOCATION_STATES,
  GOODS_ALLOCATIONS,
  GOODS_FULFILLMENT_SEQUENCES,
  GOODS_FULFILLMENT_TABLES,
  GOODS_HANDOFF_STATES,
  GOODS_HANDOFFS,
  GOODS_ORDER_ITEM_PURPOSES,
  GOODS_ORDER_ITEM_STATES,
  GOODS_ORDER_ITEMS,
  SEPARATE_INDEX_NAMES,
  SPEC_COLUMN_COUNTS,
  SPEC_CONSTRAINT_COUNTS,
  SPEC_INDEX_COUNTS,
} from "../harness/db/goods-fulfillment-golden.ts";
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

// PR-GK-3 C1: the three Goods fulfillment tables of migration 0008 (app.goods_order_items,
// app.goods_sales_allocations and app.goods_handoffs) on a real PostgreSQL 17 (SPEC-100 §39-§41, §45.1, §45.6,
// §11, §12; SPEC-030 §16.2-§17; SPEC-170 §22-§24, TST-DB-001, TST-DB-004). Constraints, identity, foreign keys and
// privileges are never proven by a fake (TST-GEN-004, DEV-TST-003). The catalog goldens come from
// tests/harness/db/goods-fulfillment-golden.ts, written by hand from SPEC-100 and the approved plan (U-1..U-5),
// never derived from schema-contract.json or from the migration. Every violating row breaks exactly one constraint
// unless the case says otherwise, and every assertion checks the SQLSTATE and the constraint (or column) name
// together. Only tables and constraints exist: the Goods purchase, commit, release and handoff transactions are
// not implemented (simplified scope), so their conditional updates (DB-GDS-004, DB-GDS-005) are not tested here.
// All data is synthetic: no real Email address or person.

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const GK3_VERSION = "0008_goods_fulfillment";
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

async function insertRow(table: string, row: Row, key = "id"): Promise<string> {
  const [statement, values] = insertStatement(table, row, key);
  return (await admin.query(statement, values)).rows[0][key] as string;
}

function expectViolation(error: PgError | undefined, code: string, name: string, label: string) {
  expect(error, `${label}: must be rejected`).toBeDefined();
  expect(error?.code, `${label}: SQLSTATE`).toBe(code);
  // A NOT NULL violation names the column; every other class names the constraint.
  expect(code === "23502" ? error?.column : error?.constraint, `${label}: ${name}`).toBe(name);
}

// Two foreign keys refer to the same missing or deleted row in these cases. Which one reports first follows the
// order of their RI triggers and is not a contract, so either name is accepted; the statement is refused either way.
function expectEitherViolation(error: PgError | undefined, names: string[], label: string) {
  expect(error, `${label}: must be rejected`).toBeDefined();
  expect(error?.code, `${label}: SQLSTATE`).toBe("23503");
  expect(names, `${label}: ${error?.constraint}`).toContain(error?.constraint);
}

async function expectAccepted(table: string, row: Row, label: string) {
  expect(await tryInsert(table, row), `${label}: must be accepted`).toBeUndefined();
}

async function expectRejected(table: string, row: Row, code: string, name: string, label: string) {
  expectViolation(await tryInsert(table, row), code, name, label);
}

async function countRows(table: string): Promise<number> {
  return (await admin.query(`SELECT count(*)::int AS count FROM app.${table}`)).rows[0].count;
}

async function expectNothingCommitted() {
  for (const table of ["orders", "order_items", ...GOODS_FULFILLMENT_TABLES]) {
    expect(await countRows(table), `${table} rows`).toBe(0);
  }
}

// ---- synthetic row factories (valid by default; overrides break one rule at a time) --------------

let counter = 0;
const next = () => ++counter;
const uuid = () => `00000000-0000-4000-8000-${(0xb30000 + next()).toString(16).padStart(12, "0")}`;

async function insertParents() {
  const profile = await insertRow("business_profiles", { auth_subject: uuid() });
  const otherProfile = await insertRow("business_profiles", { auth_subject: uuid() });
  const staffProfile = await insertRow("business_profiles", { auth_subject: uuid() });
  const roleAssignment = await insertRow("role_assignments", {
    profile_id: staffProfile,
    role: "STAFF",
    state: "ACTIVE",
  });
  const event = await insertRow("events", { name: "合成イベント" });
  const offering = await insertRow("entry_ticket_offerings", {
    event_id: event,
    name: "合成入場券",
    unit_amount: 1000,
    currency: "JPY",
    sales_starts_at: SALES_START,
    sales_ends_at: SALES_END,
    sale_control_state: "ENABLED",
    sales_capacity: 100,
    purchase_limit: 4,
  });
  const goodsRow = (name: string): Row => ({
    event_id: event,
    name,
    unit_amount: 2000,
    currency: "JPY",
    sales_starts_at: SALES_START,
    sales_ends_at: SALES_END,
    sale_control_state: "SUSPENDED",
    purchase_limit: 3,
  });
  const goods = await insertRow("goods", goodsRow("合成グッズA"));
  const otherGoods = await insertRow("goods", goodsRow("合成グッズB"));
  return { profile, otherProfile, staffProfile, roleAssignment, offering, goods, otherGoods };
}

type Parents = Awaited<ReturnType<typeof insertParents>>;

/** A base Order and one of its Order Items (the Goods source by default). */
interface Line {
  orderId: string;
  itemId: string;
  purpose: string;
}

interface Seed extends Parents {
  newOrder: (purpose: string, o?: Row) => Promise<string>;
  newItem: (orderId: string, purpose: string, o?: Row) => Promise<string>;
  /** A new Order of the purpose with one Goods Order Item source (customer: profile unless overridden). */
  newLine: (purpose?: string, order?: Row) => Promise<Line>;
  goodsItem: (line: Line, o?: Row) => Row;
  /** A new line with its Goods Order Item; returns order_item_id. */
  newGoodsItem: (purpose?: string, o?: Row) => Promise<string>;
  allocation: (goodsItemId: string, o?: Row) => Row;
  handoff: (goodsItemId: string, o?: Row) => Row;
  completed: () => Row;
}

function factories(parents: Parents): Seed {
  let line = 0;
  const newOrder = (purpose: string, o: Row = {}) =>
    insertRow("orders", {
      purchase_cause_key: uuid(),
      customer_profile_id: parents.profile,
      purpose,
      state: "PREPARED",
      currency: "JPY",
      total_amount: 2000,
      ...o,
    });
  const newItem = (orderId: string, purpose: string, o: Row = {}) =>
    insertRow("order_items", {
      order_id: orderId,
      purpose,
      line_no: ++line,
      quantity: 1,
      unit_amount: 2000,
      currency: "JPY",
      item_name_snapshot: "合成明細",
      goods_id: parents.goods,
      ...o,
    });
  const newLine = async (purpose = "GOODS_PURCHASE", order: Row = {}): Promise<Line> => {
    const orderId = await newOrder(purpose, order);
    return { orderId, itemId: await newItem(orderId, purpose), purpose };
  };
  const goodsItem = (l: Line, o: Row = {}): Row => ({
    order_item_id: l.itemId,
    order_id: l.orderId,
    order_purpose: l.purpose,
    customer_profile_id: parents.profile,
    goods_id: parents.goods,
    state: "PENDING_PAYMENT",
    ...o,
  });
  return {
    ...parents,
    newOrder,
    newItem,
    newLine,
    goodsItem,
    newGoodsItem: async (purpose, o) =>
      insertRow(GOODS_ORDER_ITEMS, goodsItem(await newLine(purpose), o), "order_item_id"),
    allocation: (goodsItemId, o = {}) => ({
      goods_order_item_id: goodsItemId,
      goods_id: parents.goods,
      quantity: 1,
      state: "HELD",
      ...o,
    }),
    handoff: (goodsItemId, o = {}) => ({
      goods_order_item_id: goodsItemId,
      state: "PENDING",
      ...o,
    }),
    completed: () => ({
      state: "COMPLETED",
      completed_by_profile_id: parents.staffProfile,
      completed_role_assignment_id: parents.roleAssignment,
      completed_at: AT,
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

// ---- TC-DB-ARC-007-011 --------------------------------------------------------------------------

describe("TC-DB-ARC-007-011 migration 0008 and the catalog of the three Goods fulfillment tables (real PostgreSQL 17)", () => {
  it("TC-DB-ARC-007-011 the journal lists every migration once with its source hash, 0008 among them, and a second run changes nothing", async () => {
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
    expect(before.map((row) => row.version)).toContain(GK3_VERSION);
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
        "0006_orders_payments.sql",
      ].map(hashOf),
    ).toEqual([
      "8be0243f1a20c66feddef29f21f805be6fc4d6ca6b78e6994e520189de3cf8bd",
      "7cc76ebe922de728c6965bc4734583b99aaa13bd74119e03e5c244281001409f",
      "cdf90998b2fccab719bb67ca6b41ff1b3988f3c742694fc2433b1ace445398c4",
      "02be479e7f312644f8badef65d692fede56f2c12041b5c1a4dea0e3051aed3ea",
      "e8ab474227a561d8c764c6ec8c8f039571ec400869e5347f573af713555a585a",
      "7f0f9e9796e3b6c73e4870b866ff5b4190eee004181301adb46f0f19a7aac29b",
    ]);

    await admin.query("SET ROLE app_migrator");
    try {
      await runMigrations(admin);
    } finally {
      await admin.query("RESET ROLE");
    }
    expect(await read()).toEqual(before);
  });

  it("TC-DB-ARC-007-011 0008 only creates the three tables and the three section 45 indexes and revokes; it alters, grants and drops nothing", async () => {
    const identities = await migrationIdentities();
    const gk3 = identities.find((i) => i.name === `${GK3_VERSION}.sql`);
    expect(gk3, `${GK3_VERSION}.sql exists`).toBeDefined();
    const sqlText = (gk3?.sql ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const parents = ["business_profiles", "order_items", "orders", "role_assignments"];
    const referenced = [...new Set([...sqlText.matchAll(/\bapp\.([a-z_]+)/g)].map((m) => m[1]))];
    expect(referenced.sort()).toEqual([...GOODS_FULFILLMENT_TABLES, ...parents].sort());
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
      /\bUPDATE\b/i,
      /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION|EXTENSION|ROLE|SCHEMA|VIEW)\b/i,
      /\bOWNER\s+TO\b/i,
      /\bROW\s+LEVEL\s+SECURITY\b/i,
      /\bGENERATED\s+ALWAYS\s+AS\s*\(/i,
    ]) {
      expect(sqlText, `0008 must not contain ${forbidden}`).not.toMatch(forbidden);
    }
    expect([...sqlText.matchAll(/\bCREATE\s+TABLE\s+app\.([a-z_]+)/gi)].map((m) => m[1])).toEqual([
      ...GOODS_FULFILLMENT_TABLES,
    ]);
    expect(
      [...sqlText.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+([a-z_]+)/gi)].map((m) => m[1]).sort(),
    ).toEqual(SEPARATE_INDEX_NAMES);
    // The only predicate is that of the pending Handoff index.
    expect([...sqlText.matchAll(/\bWHERE\b/gi)]).toHaveLength(1);
    expect([...sqlText.matchAll(/\bREVOKE\s+ALL\b/gi)]).toHaveLength(1);
  });

  it("TC-DB-ARC-007-011 the hand-written goldens have the SPEC-100 sizes (27 columns, 22 constraints, 11 indexes)", () => {
    expect(GOLDEN_TABLES.map((g) => g.table)).toEqual([...GOODS_FULFILLMENT_TABLES]);
    expect(GOLDEN_TABLES.map((g) => g.columns.length)).toEqual(SPEC_COLUMN_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.constraints.length)).toEqual(SPEC_CONSTRAINT_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.indexes.length)).toEqual(SPEC_INDEX_COUNTS);
    expect(SPEC_COLUMN_COUNTS.reduce((a, b) => a + b)).toBe(27);
    expect(SPEC_CONSTRAINT_COUNTS.reduce((a, b) => a + b)).toBe(22);
    expect(SPEC_INDEX_COUNTS.reduce((a, b) => a + b)).toBe(11);
  });

  it("TC-DB-ARC-007-011 columns of the three tables equal the goldens in attnum order", async () => {
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

  it("TC-DB-ARC-007-011 constraints equal the goldens by name, kind and definition, all validated and not deferrable", async () => {
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
    expect(total).toBe(22);
  });

  it("TC-DB-ARC-007-011 exactly 11 valid indexes equal the goldens, with only the three section 45 indexes besides PK and UNIQUE", async () => {
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
    expect(total).toBe(11);
  });

  it("TC-DB-ARC-007-011 owner is app_migrator, row level security is off, there are two bigint identity sequences and every time column is timestamptz", async () => {
    const tables = (
      await admin.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) ORDER BY c.relname`,
        [[...GOODS_FULFILLMENT_TABLES]],
      )
    ).rows;
    expect(tables.map((t) => t.relname)).toEqual([...GOODS_FULFILLMENT_TABLES].sort());
    for (const table of tables) {
      expect(
        [table.owner, table.relrowsecurity, table.relforcerowsecurity, table.relkind],
        table.relname,
      ).toEqual(["app_migrator", false, false, "r"]);
    }
    // goods_order_items is keyed by the base Order Item id and owns no sequence (SPEC-100 §39).
    const sequences = (
      await admin.query(
        `SELECT c.relname, format_type(s.seqtypid, NULL) AS type, pg_get_userbyid(c.relowner) AS owner
           FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
           JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i'
          WHERE d.refobjid = ANY($1::regclass[]) ORDER BY c.relname`,
        [GOODS_FULFILLMENT_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    expect(sequences.map((s) => [s.relname, s.type, s.owner])).toEqual(
      [...GOODS_FULFILLMENT_SEQUENCES].sort().map((name) => [name, "bigint", "app_migrator"]),
    );
    // DB-TIM-001: no timestamp without time zone, and every *_at column is timestamptz.
    const timeColumns = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname LIKE '%\\_at' OR format_type(a.atttypid, a.atttypmod) LIKE 'timestamp%')`,
        [[...GOODS_FULFILLMENT_TABLES]],
      )
    ).rows;
    // 2 + 3 + 4 time columns (SPEC-100 §39-§41).
    expect(timeColumns.length).toBe(9);
    for (const column of timeColumns) expect(column.type, column.name).toBe(TSTZ);
  });

  it("TC-DB-ARC-007-011 the live catalog equals requiredCatalog, checked directly and not through readiness", async () => {
    const live = (await admin.query(catalogQuery)).rows[0].catalog;
    expect(live).toEqual(requiredCatalog);
    const liveTables = live.tables.map((row: unknown[]) => row[0]);
    for (const table of GOODS_FULFILLMENT_TABLES) expect(liveTables).toContain(table);
    const liveConstraints = live.constraints.map((row: unknown[]) => row[1]);
    for (const golden of GOLDEN_TABLES)
      for (const c of golden.constraints) expect(liveConstraints).toContain(c.name);
  });

  it("TC-DB-ARC-007-011 public_ref of Goods Order Items and Handoffs is a database generated v4 UUID unique by name; Allocation and Handoff ids are GENERATED ALWAYS", async () => {
    await withSeed(async (seed) => {
      const line = await seed.newLine();
      const item = (
        await admin.query(
          ...insertStatement(GOODS_ORDER_ITEMS, seed.goodsItem(line), "order_item_id, public_ref"),
        )
      ).rows[0];
      expect(item.public_ref).toMatch(UUID_V4);
      const otherLine = await seed.newLine();
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(otherLine, { public_ref: item.public_ref }),
        "23505",
        "uq_goods_order_items_public_ref",
        "duplicate Goods Order Item public_ref",
      );
      const handoff = (
        await admin.query(
          ...insertStatement(GOODS_HANDOFFS, seed.handoff(item.order_item_id), "public_ref"),
        )
      ).rows[0];
      expect(handoff.public_ref).toMatch(UUID_V4);
      const otherItem = await seed.newGoodsItem();
      await expectRejected(
        GOODS_HANDOFFS,
        seed.handoff(otherItem, { public_ref: handoff.public_ref }),
        "23505",
        "uq_goods_handoffs_public_ref",
        "duplicate Handoff public_ref",
      );
      // GENERATED ALWAYS: an explicit id without OVERRIDING SYSTEM VALUE is refused (428C9).
      for (const table of [GOODS_ALLOCATIONS, GOODS_HANDOFFS]) {
        expect(
          (await attempt(`INSERT INTO app.${table}(id) VALUES ($1)`, [ABSENT_ID]))?.code,
          `${table} explicit id`,
        ).toBe("428C9");
      }
    });
  });

  it("TC-DB-ARC-007-011 created_at, updated_at and held_at default to the transaction's transaction_timestamp()", async () => {
    await withSeed(async (seed) => {
      const started = (await admin.query("SELECT transaction_timestamp() AS t")).rows[0].t;
      const itemId = await seed.newGoodsItem();
      await insertRow(GOODS_ALLOCATIONS, seed.allocation(itemId));
      await insertRow(GOODS_HANDOFFS, seed.handoff(itemId));
      const times = [
        ...(
          await admin.query(
            "SELECT created_at, updated_at FROM app.goods_order_items WHERE order_item_id = $1",
            [itemId],
          )
        ).rows.flatMap((r) => [r.created_at, r.updated_at]),
        ...(
          await admin.query(
            "SELECT held_at FROM app.goods_sales_allocations WHERE goods_order_item_id = $1",
            [itemId],
          )
        ).rows.map((r) => r.held_at),
        ...(
          await admin.query(
            "SELECT created_at, updated_at FROM app.goods_handoffs WHERE goods_order_item_id = $1",
            [itemId],
          )
        ).rows.flatMap((r) => [r.created_at, r.updated_at]),
      ];
      expect(times).toHaveLength(5);
      for (const time of times) expect(time).toEqual(started);
    });
  });
});

// ---- TC-DB-STA-002-005 --------------------------------------------------------------------------

describe("TC-DB-STA-002-005 State and Purpose allowlist CHECK constraints of the Goods fulfillment tables keep the SPEC-030 names exactly (real PostgreSQL 17)", () => {
  it("TC-DB-STA-002-005 Goods Order Item: the 3 states and 2 purposes are accepted; near misses and other purposes are refused by name; state has no default", async () => {
    await withSeed(async (seed) => {
      for (const state of GOODS_ORDER_ITEM_STATES)
        await expectAccepted(
          GOODS_ORDER_ITEMS,
          seed.goodsItem(await seed.newLine(), { state }),
          `state ${state}`,
        );
      for (const purpose of GOODS_ORDER_ITEM_PURPOSES)
        await expectAccepted(
          GOODS_ORDER_ITEMS,
          seed.goodsItem(await seed.newLine(purpose)),
          `purpose ${purpose}`,
        );
      const line = await seed.newLine();
      for (const state of [
        ...GOODS_ORDER_ITEM_STATES.flatMap(nearMisses),
        "CANCELLED",
        "CONFIRMED",
        "",
      ])
        await expectRejected(
          GOODS_ORDER_ITEMS,
          seed.goodsItem(line, { state }),
          "23514",
          "ck_goods_order_items_state",
          `state ${JSON.stringify(state)}`,
        );
      // A purpose outside the two Goods purposes is refused by the CHECK before any foreign key is looked at.
      for (const purpose of [
        ...GOODS_ORDER_ITEM_PURPOSES.flatMap(nearMisses),
        "ENTRY_TICKET_PURCHASE",
        "KARAOKE_PURCHASE",
      ])
        await expectRejected(
          GOODS_ORDER_ITEMS,
          seed.goodsItem(line, { order_purpose: purpose }),
          "23514",
          "ck_goods_order_items_order_purpose",
          `purpose ${JSON.stringify(purpose)}`,
        );
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(line, { state: undefined }),
        "23502",
        "state",
        "omitted state",
      );
    });
  });

  it("TC-DB-STA-002-005 Allocation: HELD, COMMITTED and RELEASED are accepted; others are refused by name; state has no default", async () => {
    await withSeed(async (seed) => {
      for (const state of GOODS_ALLOCATION_STATES)
        await expectAccepted(
          GOODS_ALLOCATIONS,
          seed.allocation(await seed.newGoodsItem(), { state }),
          `state ${state}`,
        );
      const itemId = await seed.newGoodsItem();
      for (const state of [...GOODS_ALLOCATION_STATES.flatMap(nearMisses), "RESERVED", ""])
        await expectRejected(
          GOODS_ALLOCATIONS,
          seed.allocation(itemId, { state }),
          "23514",
          "ck_goods_sales_allocations_state",
          `state ${JSON.stringify(state)}`,
        );
      await expectRejected(
        GOODS_ALLOCATIONS,
        seed.allocation(itemId, { state: undefined }),
        "23502",
        "state",
        "omitted state",
      );
    });
  });

  it("TC-DB-STA-002-005 Handoff: PENDING, COMPLETED and VOID are accepted; others are refused by ck_goods_handoffs_state; state has no default", async () => {
    await withSeed(async (seed) => {
      const valid: Row[] = [{}, seed.completed(), { state: "VOID", voided_at: AT }];
      for (const row of valid)
        await expectAccepted(
          GOODS_HANDOFFS,
          seed.handoff(await seed.newGoodsItem(), row),
          `state ${String(row.state ?? "PENDING")}`,
        );
      const itemId = await seed.newGoodsItem();
      // A wrong name also matches no branch of ck_goods_handoffs_state_times; PostgreSQL checks the CHECK
      // constraints in name order, so the allowlist reports first.
      for (const state of [...GOODS_HANDOFF_STATES.flatMap(nearMisses), "DONE", "CANCELED", ""])
        await expectRejected(
          GOODS_HANDOFFS,
          seed.handoff(itemId, { state }),
          "23514",
          "ck_goods_handoffs_state",
          `state ${JSON.stringify(state)}`,
        );
      await expectRejected(
        GOODS_HANDOFFS,
        seed.handoff(itemId, { state: undefined }),
        "23502",
        "state",
        "omitted state",
      );
    });
  });
});

// ---- TC-DB-GDS-002-001 --------------------------------------------------------------------------

describe("TC-DB-GDS-002-001 a Goods Order Item belongs to its base item's Order, Purpose, customer and Goods (real PostgreSQL 17)", () => {
  it("TC-DB-GDS-002-001 the item's customer must be the Order's customer (fk_goods_order_items_order_customer)", async () => {
    await withSeed(async (seed) => {
      const line = await seed.newLine();
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(line, { customer_profile_id: seed.otherProfile }),
        "23503",
        "fk_goods_order_items_order_customer",
        "another customer",
      );
      await expectAccepted(GOODS_ORDER_ITEMS, seed.goodsItem(line), "the Order's customer");
      // DB-GDS-002 / BR-GDS-008: the Order's customer cannot be changed under its Goods Order Item.
      expectViolation(
        await attempt("UPDATE app.orders SET customer_profile_id = $2 WHERE id = $1", [
          line.orderId,
          seed.otherProfile,
        ]),
        "23503",
        "fk_goods_order_items_order_customer",
        "changing the Order's customer",
      );
      expectViolation(
        await attempt(
          "UPDATE app.goods_order_items SET customer_profile_id = $2 WHERE order_item_id = $1",
          [line.itemId, seed.otherProfile],
        ),
        "23503",
        "fk_goods_order_items_order_customer",
        "changing the item's customer",
      );
    });
  });

  it("TC-DB-GDS-002-001 the item's Order and Purpose must be the base item's (fk_goods_order_items_order_item)", async () => {
    await withSeed(async (seed) => {
      const line = await seed.newLine();
      const otherOrder = await seed.newOrder("GOODS_PURCHASE");
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(line, { order_id: otherOrder }),
        "23503",
        "fk_goods_order_items_order_item",
        "another Order of the same customer",
      );
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(line, { order_purpose: "ENTRY_GOODS_PURCHASE" }),
        "23503",
        "fk_goods_order_items_order_item",
        "purpose differs from the base item's",
      );
      const composite = await seed.newLine("ENTRY_GOODS_PURCHASE");
      await expectAccepted(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(composite),
        "Goods line of an Entry + Goods Order",
      );
    });
  });

  it("TC-DB-GDS-002-001 the item's Goods must be the base item's; an Entry line has no Goods (fk_goods_order_items_goods)", async () => {
    await withSeed(async (seed) => {
      const line = await seed.newLine();
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(line, { goods_id: seed.otherGoods }),
        "23503",
        "fk_goods_order_items_goods",
        "another Goods",
      );
      const composite = await seed.newOrder("ENTRY_GOODS_PURCHASE");
      const entryItem = await seed.newItem(composite, "ENTRY_GOODS_PURCHASE", {
        goods_id: null,
        entry_offering_id: seed.offering,
      });
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem({ orderId: composite, itemId: entryItem, purpose: "ENTRY_GOODS_PURCHASE" }),
        "23503",
        "fk_goods_order_items_goods",
        "Entry line of an Entry + Goods Order",
      );
      await expectAccepted(GOODS_ORDER_ITEMS, seed.goodsItem(line), "the base item's Goods");
      // The base item's Goods cannot be changed under its Goods Order Item.
      expectViolation(
        await attempt("UPDATE app.order_items SET goods_id = $2 WHERE id = $1", [
          line.itemId,
          seed.otherGoods,
        ]),
        "23503",
        "fk_goods_order_items_goods",
        "changing the base item's Goods",
      );
    });
  });

  it("TC-DB-GDS-002-001 one Goods Order Item per base item; the base item must exist; required columns are NOT NULL", async () => {
    await withSeed(async (seed) => {
      const line = await seed.newLine();
      await insertRow(GOODS_ORDER_ITEMS, seed.goodsItem(line), "order_item_id");
      await expectRejected(
        GOODS_ORDER_ITEMS,
        seed.goodsItem(line),
        "23505",
        "pk_goods_order_items",
        "second Goods Order Item of the base item",
      );
      expectEitherViolation(
        await tryInsert(GOODS_ORDER_ITEMS, seed.goodsItem({ ...line, itemId: ABSENT_ID })),
        ["fk_goods_order_items_order_item", "fk_goods_order_items_goods"],
        "absent base item",
      );
      const fresh = await seed.newLine();
      for (const column of [
        "order_item_id",
        "order_id",
        "order_purpose",
        "customer_profile_id",
        "goods_id",
      ])
        await expectRejected(
          GOODS_ORDER_ITEMS,
          seed.goodsItem(fresh, { [column]: null }),
          "23502",
          column,
          `NULL ${column}`,
        );
    });
  });
});

// ---- TC-DB-GDS-004-001 --------------------------------------------------------------------------

describe("TC-DB-GDS-004-001 Goods Sales Allocation: three states, one per Goods Order Item, the item's Goods and a positive quantity (real PostgreSQL 17)", () => {
  it("TC-DB-GDS-004-001 one Allocation per Goods Order Item; its Goods must be the item's; the item must exist", async () => {
    await withSeed(async (seed) => {
      const itemId = await seed.newGoodsItem();
      await insertRow(GOODS_ALLOCATIONS, seed.allocation(itemId));
      await expectRejected(
        GOODS_ALLOCATIONS,
        seed.allocation(itemId),
        "23505",
        "uq_goods_sales_allocations_goods_order_item_id",
        "second Allocation of the item",
      );
      const freshItem = await seed.newGoodsItem();
      await expectRejected(
        GOODS_ALLOCATIONS,
        seed.allocation(freshItem, { goods_id: seed.otherGoods }),
        "23503",
        "fk_goods_sales_allocations_goods",
        "another Goods",
      );
      // A base Order Item without its Goods Order Item cannot carry an Allocation.
      const bare = await seed.newLine();
      expectEitherViolation(
        await tryInsert(GOODS_ALLOCATIONS, seed.allocation(bare.itemId)),
        ["fk_goods_sales_allocations_goods_order_item", "fk_goods_sales_allocations_goods"],
        "base item without a Goods Order Item",
      );
      await expectAccepted(GOODS_ALLOCATIONS, seed.allocation(freshItem), "the item's Goods");
      // The Allocation's Goods cannot be changed away from the item's.
      expectViolation(
        await attempt(
          "UPDATE app.goods_sales_allocations SET goods_id = $2 WHERE goods_order_item_id = $1",
          [freshItem, seed.otherGoods],
        ),
        "23503",
        "fk_goods_sales_allocations_goods",
        "changing the Allocation's Goods",
      );
      // Changing the item's Goods breaks both the item's own Goods key and the Allocation's, so either name is
      // accepted; the UPDATE is refused either way.
      expectEitherViolation(
        await attempt("UPDATE app.goods_order_items SET goods_id = $2 WHERE order_item_id = $1", [
          freshItem,
          seed.otherGoods,
        ]),
        ["fk_goods_order_items_goods", "fk_goods_sales_allocations_goods"],
        "changing the Goods Order Item's Goods under its Allocation",
      );
    });
  });

  it("TC-DB-GDS-004-001 quantity must be positive, and quantity, goods_id and held_at are NOT NULL", async () => {
    await withSeed(async (seed) => {
      const itemId = await seed.newGoodsItem();
      for (const quantity of [0, -1])
        await expectRejected(
          GOODS_ALLOCATIONS,
          seed.allocation(itemId, { quantity }),
          "23514",
          "ck_goods_sales_allocations_quantity",
          `quantity ${quantity}`,
        );
      for (const column of ["goods_order_item_id", "goods_id", "quantity", "held_at"])
        await expectRejected(
          GOODS_ALLOCATIONS,
          seed.allocation(itemId, { [column]: null }),
          "23502",
          column,
          `NULL ${column}`,
        );
      await expectAccepted(
        GOODS_ALLOCATIONS,
        seed.allocation(itemId, { quantity: 3 }),
        "quantity 3",
      );
    });
  });
});

// ---- TC-DB-GDS-005-001 --------------------------------------------------------------------------

describe("TC-DB-GDS-005-001 Goods Handoff: one per Goods Order Item, and the state agrees with its timestamps and actor (real PostgreSQL 17)", () => {
  it("TC-DB-GDS-005-001 one Handoff per Goods Order Item; the item must exist", async () => {
    await withSeed(async (seed) => {
      const itemId = await seed.newGoodsItem();
      await insertRow(GOODS_HANDOFFS, seed.handoff(itemId));
      for (const row of [{}, seed.completed(), { state: "VOID", voided_at: AT }])
        await expectRejected(
          GOODS_HANDOFFS,
          seed.handoff(itemId, row),
          "23505",
          "uq_goods_handoffs_goods_order_item_id",
          `second Handoff ${String(row.state ?? "PENDING")}`,
        );
      const bare = await seed.newLine();
      await expectRejected(
        GOODS_HANDOFFS,
        seed.handoff(bare.itemId),
        "23503",
        "fk_goods_handoffs_goods_order_item",
        "base item without a Goods Order Item",
      );
    });
  });

  it("TC-DB-GDS-005-001 each state requires exactly the timestamps and actor of SPEC-100 section 41", async () => {
    await withSeed(async (seed) => {
      const done = seed.completed();
      const cases: [string, Row][] = [
        ["PENDING with completed_at", { completed_at: AT }],
        ["PENDING with voided_at", { voided_at: AT }],
        ["COMPLETED without completed_by_profile_id", { ...done, completed_by_profile_id: null }],
        [
          "COMPLETED without completed_role_assignment_id",
          { ...done, completed_role_assignment_id: null },
        ],
        ["COMPLETED without completed_at", { ...done, completed_at: null }],
        ["COMPLETED with voided_at", { ...done, voided_at: AT }],
        ["VOID without voided_at", { state: "VOID" }],
        ["VOID with completed_at", { state: "VOID", voided_at: AT, completed_at: AT }],
      ];
      const itemId = await seed.newGoodsItem();
      for (const [label, row] of cases)
        await expectRejected(
          GOODS_HANDOFFS,
          seed.handoff(itemId, row),
          "23514",
          "ck_goods_handoffs_state_times",
          label,
        );
      // Plan U-2: SPEC-100 section 41 names only the timestamps for PENDING and VOID, so the actor columns are
      // not constrained in those states.
      await expectAccepted(
        GOODS_HANDOFFS,
        seed.handoff(await seed.newGoodsItem(), {
          completed_by_profile_id: seed.staffProfile,
          completed_role_assignment_id: seed.roleAssignment,
        }),
        "PENDING with actor columns",
      );
      await expectAccepted(
        GOODS_HANDOFFS,
        seed.handoff(await seed.newGoodsItem(), {
          state: "VOID",
          voided_at: AT,
          completed_by_profile_id: seed.staffProfile,
        }),
        "VOID with an actor column",
      );
    });
  });

  it("TC-DB-GDS-005-001 PENDING -> COMPLETED succeeds only with the actor and completed_at in the same UPDATE; PENDING -> VOID only with voided_at", async () => {
    await withSeed(async (seed) => {
      const itemId = await seed.newGoodsItem();
      const id = await insertRow(GOODS_HANDOFFS, seed.handoff(itemId));
      expectViolation(
        await attempt(
          "UPDATE app.goods_handoffs SET state = 'COMPLETED', completed_at = $2 WHERE id = $1",
          [id, AT],
        ),
        "23514",
        "ck_goods_handoffs_state_times",
        "COMPLETED without the actor",
      );
      expectViolation(
        await attempt("UPDATE app.goods_handoffs SET state = 'VOID' WHERE id = $1", [id]),
        "23514",
        "ck_goods_handoffs_state_times",
        "VOID without voided_at",
      );
      expect(
        await attempt(
          `UPDATE app.goods_handoffs SET state = 'COMPLETED', completed_at = $2,
                  completed_by_profile_id = $3, completed_role_assignment_id = $4 WHERE id = $1`,
          [id, AT, seed.staffProfile, seed.roleAssignment],
        ),
      ).toBeUndefined();
      // A COMPLETED Handoff cannot be made VOID by setting voided_at (it keeps completed_at).
      expectViolation(
        await attempt(
          "UPDATE app.goods_handoffs SET state = 'VOID', voided_at = $2 WHERE id = $1",
          [id, AT],
        ),
        "23514",
        "ck_goods_handoffs_state_times",
        "COMPLETED -> VOID keeping completed_at",
      );
    });
  });

  it("TC-DB-GDS-005-001 the completing Profile and Role Assignment must exist", async () => {
    await withSeed(async (seed) => {
      const itemId = await seed.newGoodsItem();
      await expectRejected(
        GOODS_HANDOFFS,
        seed.handoff(itemId, { ...seed.completed(), completed_by_profile_id: ABSENT_ID }),
        "23503",
        "fk_goods_handoffs_completed_by_profile",
        "absent completing Profile",
      );
      await expectRejected(
        GOODS_HANDOFFS,
        seed.handoff(itemId, { ...seed.completed(), completed_role_assignment_id: ABSENT_ID }),
        "23503",
        "fk_goods_handoffs_completed_role_assignment",
        "absent completing Role Assignment",
      );
      await expectAccepted(GOODS_HANDOFFS, seed.handoff(itemId, seed.completed()), "COMPLETED");
    });
  });
});

// ---- TC-DB-FK-002-005 ---------------------------------------------------------------------------

describe("TC-DB-FK-002-005 the Goods fulfillment foreign keys restrict deletes and never cascade (real PostgreSQL 17)", () => {
  it("TC-DB-FK-002-005 all eight foreign keys are ON DELETE RESTRICT and ON UPDATE NO ACTION", async () => {
    const rows = (
      await admin.query(
        `SELECT conname, confdeltype, confupdtype FROM pg_constraint
          WHERE contype = 'f' AND conrelid = ANY($1::regclass[]) ORDER BY conname`,
        [GOODS_FULFILLMENT_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    const expected = GOLDEN_TABLES.flatMap((g) => g.foreignKeys.map((f) => f.name)).sort();
    expect(expected).toHaveLength(8);
    expect(rows.map((r) => [r.conname, r.confdeltype, r.confupdtype])).toEqual(
      expected.map((name) => [name, "r", "a"]),
    );
  });

  it("TC-DB-FK-002-005 deleting a parent that has Goods fulfillment history is refused with 23503 by name, and nothing is lost", async () => {
    await withSeed(async (seed) => {
      const withAllocation = await seed.newGoodsItem();
      await insertRow(GOODS_ALLOCATIONS, seed.allocation(withAllocation));
      const withHandoff = await seed.newGoodsItem();
      await insertRow(GOODS_HANDOFFS, seed.handoff(withHandoff, seed.completed()));
      const before = await Promise.all(GOODS_FULFILLMENT_TABLES.map((t) => countRows(t)));

      expectViolation(
        await attempt("DELETE FROM app.goods_order_items WHERE order_item_id = $1", [withHandoff]),
        "23503",
        "fk_goods_handoffs_goods_order_item",
        "Goods Order Item with a Handoff",
      );
      expectViolation(
        await attempt("DELETE FROM app.role_assignments WHERE id = $1", [seed.roleAssignment]),
        "23503",
        "fk_goods_handoffs_completed_role_assignment",
        "Role Assignment that completed a Handoff",
      );
      const doubles: [string, string, string, string[]][] = [
        [
          "Goods Order Item with an Allocation",
          "DELETE FROM app.goods_order_items WHERE order_item_id = $1",
          withAllocation,
          ["fk_goods_sales_allocations_goods_order_item", "fk_goods_sales_allocations_goods"],
        ],
        [
          "base Order Item with a Goods Order Item",
          "DELETE FROM app.order_items WHERE id = $1",
          withAllocation,
          ["fk_goods_order_items_order_item", "fk_goods_order_items_goods"],
        ],
        [
          "Order with a Goods Order Item",
          "DELETE FROM app.orders WHERE id = (SELECT order_id FROM app.goods_order_items WHERE order_item_id = $1)",
          withAllocation,
          ["fk_order_items_order", "fk_goods_order_items_order_customer"],
        ],
        [
          "Profile that completed a Handoff",
          "DELETE FROM app.business_profiles WHERE id = $1",
          seed.staffProfile,
          ["fk_goods_handoffs_completed_by_profile", "fk_role_assignments_profile"],
        ],
      ];
      for (const [label, statement, id, names] of doubles)
        expectEitherViolation(await attempt(statement, [id]), names, label);
      expect(await Promise.all(GOODS_FULFILLMENT_TABLES.map((t) => countRows(t)))).toEqual(before);
    });
  });
});

// ---- TC-SEC-DB-001-005 --------------------------------------------------------------------------

// PR-L1-2c0 (0011) grants these privileges to app_api_runtime; the expectation changes with the grant, not with the
// implementation. The expected sets are the hand-written ones of tests/harness/db/purchase-runtime-grants.ts, never
// read from the live database. goods_handoffs stays closed to every runtime role.
describe("TC-SEC-DB-001-005 app_api_runtime has the 0011 grants on goods_order_items and goods_sales_allocations and nothing else; the other runtime roles and PUBLIC have no privilege on the three Goods fulfillment tables (SEC-DB-001..003, real PostgreSQL 17)", () => {
  const tables = GOLDEN_TABLES.map((g) => ({
    table: g.table,
    columns: g.columns.map((column) => column[0]),
  }));
  const names = tables.map((entry) => entry.table);

  it("TC-SEC-DB-001-005 has_table_privilege, has_any_column_privilege and has_column_privilege of the four runtime roles and PUBLIC equal the plan on every table and column (no difference)", async () => {
    expect(names.length).toBeGreaterThan(0);
    expect(await privilegeMismatches(admin, tables)).toEqual([]);
  });

  it("TC-SEC-DB-001-005 the column ACLs hold only the app_api_runtime INSERT columns of the plan, the table ACLs name app_migrator and the plan's SELECT grant only, and no role may use the two identity sequences", async () => {
    expect(await columnAclEntries(admin, names)).toEqual(expectedColumnAclEntries(names));
    for (const table of names) {
      const acl = await tableAcl(admin, table);
      expect(acl.ownerPresent, `${table}: owner ACL`).toBe(true);
      expect(acl.others, table).toEqual(expectedTableAclOthers(table));
    }
    for (const sequence of GOODS_FULFILLMENT_SEQUENCES)
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

  it("TC-SEC-DB-001-005 the runtime pools: SELECT succeeds only where granted; every other SELECT, INSERT, UPDATE, DELETE and TRUNCATE (and an INSERT naming an ungranted column) is refused with 42501", async () => {
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
