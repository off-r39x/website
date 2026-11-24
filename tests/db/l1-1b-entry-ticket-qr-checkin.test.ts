import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../../packages/db/src/index.ts";
import { migrationIdentities } from "../../packages/db/src/migrations.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import {
  ENTRY_ACTIVE_QR_INDEX,
  ENTRY_CHECKINS,
  ENTRY_TICKET_ORDER_PURPOSES,
  ENTRY_TICKET_QR_SEQUENCES,
  ENTRY_TICKET_QR_TABLES,
  ENTRY_TICKET_STATES,
  ENTRY_TICKETS,
  GOLDEN_TABLES,
  KARAOKE_ACTIVE_QR_INDEX,
  QR_FORMAT_VERSION,
  QR_TOKEN_LIFECYCLE_STATES,
  QR_TOKEN_PURPOSES,
  QR_TOKENS,
  SEPARATE_INDEX_NAMES,
  SPEC_COLUMN_COUNTS,
  SPEC_CONSTRAINT_COUNTS,
  SPEC_INDEX_COUNTS,
} from "../harness/db/entry-ticket-qr-golden.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";

// PR-L1-1b C1: the three Entry Ticket / QR Token / Entry Check-in tables of migration 0009 (app.entry_tickets,
// app.qr_tokens and app.entry_checkins) on a real PostgreSQL 17 (SPEC-100 §24-§26, §45.1, §45.3, §45.5, §11, §12,
// §67 items 11, 16-18; SPEC-080 §6, §8-§13, §25; SPEC-170 §22-§24, TST-DB-001, TST-DB-004, TST-CON-001).
// Constraints, identity, foreign keys, concurrency and privileges are never proven by a fake (TST-GEN-004,
// DEV-TST-003). The catalog goldens come from tests/harness/db/entry-ticket-qr-golden.ts, written by hand from
// SPEC-100 and the approved plan (U-2..U-4), never derived from schema-contract.json or from the migration. Every
// violating row breaks exactly one constraint unless the case says otherwise, and every assertion checks the
// SQLSTATE and the constraint (or column) name together. CHECK constraints are tested by PostgreSQL in name order,
// which the cases that must break two CHECKs rely on. Only tables and constraints exist: Ticket issuance, QR
// provisioning, lookup and rotation, and the check-in transaction (SPEC-100 §26 steps 1-6, DB-TQR-005, DB-TQR-006)
// are not implemented, so their row locks and conditional updates are not tested here. All data is synthetic: no
// real Email address, person or QR token (the digests and envelopes are hashes of fixed test labels).

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const L1B_VERSION = "0009_entry_ticket_qr_checkin";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// An id no identity sequence of this test database reaches.
const ABSENT_ID = "9223372036854775807";
const SALES_START = "2030-01-01T00:00:00Z";
const SALES_END = "2030-01-02T00:00:00Z";
const AT = "2030-01-01T03:00:00Z";
const VALID_FROM = "2030-01-01T09:00:00Z";
const VALID_UNTIL = "2030-01-01T18:00:00Z";
const USAGE_START = "2030-01-01T05:00:00Z";
const USAGE_END = "2030-01-01T05:15:00Z";
const TSTZ = "timestamp with time zone";
/** The existing tables 0009 refers to (REFERENCES targets only). */
const PARENT_TABLES = [
  "business_profiles",
  "entry_sales_allocations",
  "karaoke_tickets",
  "order_items",
  "orders",
  "role_assignments",
];

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

// Like attempt, but a successful statement is undone too, so one-per-parent UNIQUEs never interfere with the
// next probe of the same parent.
async function probe(statement: string, values: unknown[] = []): Promise<PgError | undefined> {
  await admin.query("SAVEPOINT probe");
  try {
    await admin.query(statement, values);
    return undefined;
  } catch (error) {
    return error as PgError;
  } finally {
    await admin.query("ROLLBACK TO SAVEPOINT probe");
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
const probeInsert = (table: string, row: Row) => probe(...insertStatement(table, row));
/** An INSERT that supplies id itself (OVERRIDING SYSTEM VALUE), for the PK duplicate cases. */
function tryInsertWithId(table: string, id: string, row: Row) {
  const [statement, values] = insertStatement(table, { id, ...row });
  return attempt(statement.replace(") VALUES (", ") OVERRIDING SYSTEM VALUE VALUES ("), values);
}

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
  expect(await probeInsert(table, row), `${label}: must be accepted`).toBeUndefined();
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
  for (const table of [...ENTRY_TICKET_QR_TABLES, "karaoke_tickets", "order_items", "orders"]) {
    expect(await countRows(table), `${table} rows`).toBe(0);
  }
}

// ---- synthetic row factories (valid by default; overrides break one rule at a time) --------------

let counter = 0;
const next = () => ++counter;
const uuid = () => `00000000-0000-4000-8000-${(0xb40000 + next()).toString(16).padStart(12, "0")}`;
/** 32 synthetic bytes: the SHA-256 of a fixed test label, never an HMAC of a real token. */
const bytes32 = (label = `digest-${next()}`) =>
  createHash("sha256").update(`l1-1b synthetic ${label}`).digest();

async function insertParents() {
  const profile = await insertRow("business_profiles", { auth_subject: uuid() });
  const otherProfile = await insertRow("business_profiles", { auth_subject: uuid() });
  const staff = await insertRow("business_profiles", { auth_subject: uuid() });
  const staffRole = await insertRow("role_assignments", {
    profile_id: staff,
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
  const goods = await insertRow("goods", {
    event_id: event,
    name: "合成グッズ",
    unit_amount: 2000,
    currency: "JPY",
    sales_starts_at: SALES_START,
    sales_ends_at: SALES_END,
    sale_control_state: "SUSPENDED",
    purchase_limit: 3,
  });
  const karaokeConfig = await insertRow("karaoke_sales_configurations", {
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
  const slotRow = (start: string, end: string, cycleEnd: string, candidate: number): Row => ({
    exclusive_scope_id: scope,
    sales_configuration_id: karaokeConfig,
    state: "AVAILABLE",
    usage_start: start,
    usage_end: end,
    cycle_end: cycleEnd,
    generation_cause_key: uuid(),
    generation_candidate_no: candidate,
  });
  const slots = [
    await insertRow("karaoke_slots", slotRow(USAGE_START, USAGE_END, "2030-01-01T05:20:00Z", 0)),
    await insertRow(
      "karaoke_slots",
      slotRow("2030-01-01T05:20:00Z", "2030-01-01T05:35:00Z", "2030-01-01T05:40:00Z", 1),
    ),
  ];
  return { profile, otherProfile, staff, staffRole, offering, goods, slots };
}

type Parents = Awaited<ReturnType<typeof insertParents>>;

/** An Entry source: an Order, one Entry Order Item and (unless omitted) its COMMITTED Entry Allocation. */
interface EntryLine {
  order: string;
  item: string;
  purpose: string;
  customer: string;
}

interface Seed extends Parents {
  /** A new Order with one Entry item of `quantity` (default 2) and its COMMITTED Allocation. */
  entryLine: (o?: {
    purpose?: string;
    customer?: string;
    quantity?: number;
    allocation?: boolean;
  }) => Promise<EntryLine>;
  /** An ENTRY_GOODS_PURCHASE Order with an allocated Entry item and a Goods item (no Entry Allocation). */
  compositeLine: () => Promise<{ entry: EntryLine; goodsItem: string }>;
  ticket: (line: EntryLine, o?: Row) => Row;
  /** entryLine + VALID Ticket ordinal 1. */
  newTicket: (o?: Row) => Promise<string>;
  /** A Karaoke Order, COMMITTED Hold, CONFIRMED Reservation and VALID Karaoke Ticket on slot `index`. */
  newKaraokeTicket: (index?: number) => Promise<string>;
  entryQr: (ticketId: string, o?: Row) => Row;
  karaokeQr: (ticketId: string, o?: Row) => Row;
  checkin: (ticketId: string, o?: Row) => Row;
}

function factories(parents: Parents): Seed {
  const entryLine: Seed["entryLine"] = async (o = {}) => {
    const purpose = o.purpose ?? "ENTRY_TICKET_PURCHASE";
    const customer = o.customer ?? parents.profile;
    const quantity = o.quantity ?? 2;
    const order = await insertRow("orders", {
      purchase_cause_key: uuid(),
      customer_profile_id: customer,
      purpose,
      state: "PREPARED",
      currency: "JPY",
      total_amount: 1000 * quantity,
    });
    const item = await insertRow("order_items", {
      order_id: order,
      purpose,
      line_no: 1,
      quantity,
      unit_amount: 1000,
      currency: "JPY",
      item_name_snapshot: "合成入場券",
      entry_offering_id: parents.offering,
    });
    if (o.allocation !== false) {
      await insertRow("entry_sales_allocations", {
        order_item_id: item,
        order_id: order,
        purpose,
        offering_id: parents.offering,
        quantity,
        state: "COMMITTED",
        committed_at: AT,
      });
    }
    return { order, item, purpose, customer };
  };
  const ticket = (line: EntryLine, o: Row = {}): Row => ({
    order_id: line.order,
    order_item_id: line.item,
    order_purpose: line.purpose,
    owner_profile_id: line.customer,
    issuance_ordinal: 1,
    state: "VALID",
    ...o,
  });
  const qr = (purpose: string, target: Row, o: Row): Row => ({
    format_version: QR_FORMAT_VERSION,
    purpose,
    ...target,
    lifecycle_state: "ACTIVE",
    lookup_digest: bytes32(),
    protected_token_material: bytes32(`envelope-${next()}`),
    protection_key_version: 1,
    ...o,
  });
  return {
    ...parents,
    entryLine,
    compositeLine: async () => {
      const entry = await entryLine({ purpose: "ENTRY_GOODS_PURCHASE", quantity: 1 });
      const goodsItem = await insertRow("order_items", {
        order_id: entry.order,
        purpose: "ENTRY_GOODS_PURCHASE",
        line_no: 2,
        quantity: 1,
        unit_amount: 2000,
        currency: "JPY",
        item_name_snapshot: "合成グッズ",
        goods_id: parents.goods,
      });
      return { entry, goodsItem };
    },
    ticket,
    newTicket: async (o) => insertRow(ENTRY_TICKETS, ticket(await entryLine(), o)),
    newKaraokeTicket: async (index = 0) => {
      const slot = parents.slots[index] as string;
      const order = await insertRow("orders", {
        purchase_cause_key: uuid(),
        customer_profile_id: parents.profile,
        purpose: "KARAOKE_PURCHASE",
        state: "PREPARED",
        currency: "JPY",
        total_amount: 500,
      });
      const item = await insertRow("order_items", {
        order_id: order,
        purpose: "KARAOKE_PURCHASE",
        line_no: 1,
        quantity: 1,
        unit_amount: 500,
        currency: "JPY",
        item_name_snapshot: "合成カラオケ枠",
        karaoke_slot_id: slot,
      });
      const chain = { order_id: order, order_item_id: item, customer_profile_id: parents.profile };
      const hold = await insertRow("karaoke_holds", {
        ...chain,
        slot_id: slot,
        state: "COMMITTED",
        committed_at: AT,
      });
      const reservation = await insertRow("karaoke_reservations", {
        ...chain,
        hold_id: hold,
        slot_id: slot,
        state: "CONFIRMED",
        usage_start_snapshot: USAGE_START,
        usage_end_snapshot: USAGE_END,
      });
      return insertRow("karaoke_tickets", {
        reservation_id: reservation,
        owner_profile_id: parents.profile,
        state: "VALID",
        expires_at: USAGE_END,
      });
    },
    entryQr: (ticketId, o = {}) => qr("ENTRY", { entry_ticket_id: ticketId }, o),
    karaokeQr: (ticketId, o = {}) => qr("KARAOKE", { karaoke_ticket_id: ticketId }, o),
    checkin: (ticketId, o = {}) => ({
      entry_ticket_id: ticketId,
      staff_profile_id: parents.staff,
      staff_role_assignment_id: parents.staffRole,
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
const REVOKED: Row = { lifecycle_state: "REVOKED", revoked_at: AT };

// ---- TC-DB-ARC-007-013 --------------------------------------------------------------------------

describe("TC-DB-ARC-007-013 migration 0009 and the catalog of the three Entry Ticket / QR / Check-in tables (real PostgreSQL 17)", () => {
  it("TC-DB-ARC-007-013 the journal lists every migration once with its source hash, 0009 among them, and a second run changes nothing", async () => {
    const identities = await migrationIdentities();
    const read = async () =>
      (await admin.query("SELECT version, source_hash FROM app.schema_migrations ORDER BY version"))
        .rows;
    const before = await read();
    const pinned = [
      ["0001_foundation", "8be0243f1a20c66feddef29f21f805be6fc4d6ca6b78e6994e520189de3cf8bd"],
      ["0002_audit_events", "7cc76ebe922de728c6965bc4734583b99aaa13bd74119e03e5c244281001409f"],
      [
        "0003_public_content_sales",
        "cdf90998b2fccab719bb67ca6b41ff1b3988f3c742694fc2433b1ace445398c4",
      ],
      [
        "0004_karaoke_scopes_slots",
        "02be479e7f312644f8badef65d692fede56f2c12041b5c1a4dea0e3051aed3ea",
      ],
      [
        "0005_idempotency_records",
        "e8ab474227a561d8c764c6ec8c8f039571ec400869e5347f573af713555a585a",
      ],
      ["0006_orders_payments", "7f0f9e9796e3b6c73e4870b866ff5b4190eee004181301adb46f0f19a7aac29b"],
      [
        "0007_karaoke_reservations",
        "d05833125a0b669588f8aabc1bb5d868e6ce487ef3c8b0843f9d895ca614bdf6",
      ],
      [
        "0008_goods_fulfillment",
        "7dac485ba488d81281637956e1e7219ee28b921767353ca26dc097c7e4cd747b",
      ],
    ];
    expect(before.map((row) => row.version).slice(0, 8)).toEqual(
      pinned.map(([version]) => version),
    );
    expect(before.map((row) => row.version)).toContain(L1B_VERSION);
    expect(new Set(before.map((row) => row.version)).size).toBe(before.length);
    expect(before.map((row) => [row.version, row.source_hash])).toEqual(
      identities.map((identity) => [identity.version, identity.hash]),
    );
    // Pinned from the committed history: an applied migration is never edited (DB-MIG-003).
    expect(before.slice(0, 8).map((row) => [row.version, row.source_hash])).toEqual(pinned);

    await admin.query("SET ROLE app_migrator");
    try {
      await runMigrations(admin);
    } finally {
      await admin.query("RESET ROLE");
    }
    expect(await read()).toEqual(before);
  });

  it("TC-DB-ARC-007-013 0009 only creates the three tables, the three section 25 / 45 indexes and revokes; it alters, grants and drops nothing", async () => {
    const identities = await migrationIdentities();
    const l1b = identities.find((i) => i.name === `${L1B_VERSION}.sql`);
    expect(l1b, `${L1B_VERSION}.sql exists`).toBeDefined();
    const sqlText = (l1b?.sql ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const referenced = [...new Set([...sqlText.matchAll(/\bapp\.([a-z_]+)/g)].map((m) => m[1]))];
    expect(referenced.sort()).toEqual([...ENTRY_TICKET_QR_TABLES, ...PARENT_TABLES].sort());
    // The existing tables appear only as foreign key targets: no existing object changes.
    expect(
      sqlText.replace(
        new RegExp(`\\bREFERENCES\\s+app\\.(${PARENT_TABLES.join("|")})\\b`, "g"),
        "",
      ),
    ).not.toMatch(new RegExp(`\\bapp\\.(${PARENT_TABLES.join("|")})\\b`));
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
      expect(sqlText, `0009 must not contain ${forbidden}`).not.toMatch(forbidden);
    }
    expect([...sqlText.matchAll(/\bCREATE\s+TABLE\s+app\.([a-z_]+)/gi)].map((m) => m[1])).toEqual([
      ...ENTRY_TICKET_QR_TABLES,
    ]);
    expect(
      [...sqlText.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+([a-z_]+)/gi)].map((m) => m[1]).sort(),
    ).toEqual(SEPARATE_INDEX_NAMES);
    // The only predicates are those of the two active-token indexes.
    expect([...sqlText.matchAll(/\bWHERE\b/gi)]).toHaveLength(2);
    expect([...sqlText.matchAll(/\bREVOKE\s+ALL\b/gi)]).toHaveLength(1);
  });

  it("TC-DB-ARC-007-013 the hand-written goldens have the SPEC-100 sizes (29 columns, 26 constraints, 10 indexes)", () => {
    expect(GOLDEN_TABLES.map((g) => g.table)).toEqual([...ENTRY_TICKET_QR_TABLES]);
    expect(GOLDEN_TABLES.map((g) => g.columns.length)).toEqual(SPEC_COLUMN_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.constraints.length)).toEqual(SPEC_CONSTRAINT_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.indexes.length)).toEqual(SPEC_INDEX_COUNTS);
    expect(SPEC_COLUMN_COUNTS.reduce((a, b) => a + b)).toBe(29);
    expect(SPEC_CONSTRAINT_COUNTS.reduce((a, b) => a + b)).toBe(26);
    expect(SPEC_INDEX_COUNTS.reduce((a, b) => a + b)).toBe(10);
    // Plan §3.5: every name fits the 63-byte identifier limit, so no name is shortened.
    for (const golden of GOLDEN_TABLES)
      for (const name of [...golden.constraints, ...golden.indexes].map((x) => x.name))
        expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
  });

  it("TC-DB-ARC-007-013 columns of the three tables equal the goldens in attnum order", async () => {
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

  it("TC-DB-ARC-007-013 constraints equal the goldens by name, kind and definition, all validated and not deferrable", async () => {
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
    expect(total).toBe(26);
  });

  it("TC-DB-ARC-007-013 exactly 10 valid indexes equal the goldens, with only the three section 25 / 45 indexes besides PK and UNIQUE", async () => {
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
    expect(total).toBe(10);
    // SPEC-100 §50.3 and §51: the owner-safe Ticket lookup and the QR lookup are served by a UNIQUE B-tree on
    // public_ref and on lookup_digest, and §45.3: no separate index on order_item_id (the UNIQUE prefix serves it).
    const leading = (
      await admin.query(
        `SELECT c.relname AS table_name, a.attname AS column_name, i.indisunique, i.indnkeyatts
           FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = ANY($1::regclass[]) ORDER BY 1, 2`,
        [[`app.${ENTRY_TICKETS}`, `app.${QR_TOKENS}`]],
      )
    ).rows.map((r) => [r.table_name, r.column_name, r.indisunique, r.indnkeyatts]);
    expect(leading).toContainEqual([ENTRY_TICKETS, "public_ref", true, 1]);
    expect(leading).toContainEqual([QR_TOKENS, "lookup_digest", true, 1]);
    expect(leading).toContainEqual([ENTRY_TICKETS, "order_item_id", true, 2]);
    expect(leading.filter((r) => r[0] === ENTRY_TICKETS && r[1] === "order_item_id")).toHaveLength(
      1,
    );
  });

  it("TC-DB-ARC-007-013 owner is app_migrator, row level security is off, there are three bigint identity sequences and every time column is timestamptz", async () => {
    const tables = (
      await admin.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) ORDER BY c.relname`,
        [[...ENTRY_TICKET_QR_TABLES]],
      )
    ).rows;
    expect(tables.map((t) => t.relname)).toEqual([...ENTRY_TICKET_QR_TABLES].sort());
    for (const table of tables) {
      expect(
        [table.owner, table.relrowsecurity, table.relforcerowsecurity, table.relkind],
        table.relname,
      ).toEqual(["app_migrator", false, false, "r"]);
    }
    const sequences = (
      await admin.query(
        `SELECT c.relname, format_type(s.seqtypid, NULL) AS type, pg_get_userbyid(c.relowner) AS owner
           FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
           JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i'
          WHERE d.refobjid = ANY($1::regclass[]) ORDER BY c.relname`,
        [ENTRY_TICKET_QR_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    expect(sequences.map((s) => [s.relname, s.type, s.owner])).toEqual(
      [...ENTRY_TICKET_QR_SEQUENCES].sort().map((name) => [name, "bigint", "app_migrator"]),
    );
    // DB-TIM-001: no timestamp without time zone, and every *_at / valid_* time column is timestamptz.
    const timeColumns = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname LIKE '%\\_at' OR a.attname LIKE 'valid\\_%' OR format_type(a.atttypid, a.atttypmod) LIKE 'timestamp%')`,
        [[...ENTRY_TICKET_QR_TABLES]],
      )
    ).rows;
    // 4 + 2 + 2 time columns (SPEC-100 §24-§26).
    expect(timeColumns.length).toBe(8);
    for (const column of timeColumns) expect(column.type, column.name).toBe(TSTZ);
  });

  it("TC-DB-ARC-007-013 the live catalog equals requiredCatalog, checked directly and not through readiness", async () => {
    const live = (await admin.query(catalogQuery)).rows[0].catalog;
    expect(live).toEqual(requiredCatalog);
    const liveTables = live.tables.map((row: unknown[]) => row[0]);
    for (const table of ENTRY_TICKET_QR_TABLES) expect(liveTables).toContain(table);
    const liveConstraints = live.constraints.map((row: unknown[]) => row[1]);
    for (const golden of GOLDEN_TABLES)
      for (const c of golden.constraints) expect(liveConstraints).toContain(c.name);
  });

  it("TC-DB-ARC-007-013 a duplicate id given with OVERRIDING SYSTEM VALUE is refused with 23505 pk_* on all three tables; ids are GENERATED ALWAYS", async () => {
    await withSeed(async (seed) => {
      const ticketId = await seed.newTicket();
      const qrId = await insertRow(QR_TOKENS, seed.entryQr(ticketId));
      const checkinId = await insertRow(ENTRY_CHECKINS, seed.checkin(ticketId));
      expectViolation(
        await tryInsertWithId(ENTRY_TICKETS, ticketId, seed.ticket(await seed.entryLine())),
        "23505",
        "pk_entry_tickets",
        "duplicate Entry Ticket id",
      );
      expectViolation(
        await tryInsertWithId(QR_TOKENS, qrId, seed.entryQr(await seed.newTicket())),
        "23505",
        "pk_qr_tokens",
        "duplicate QR Token id",
      );
      expectViolation(
        await tryInsertWithId(ENTRY_CHECKINS, checkinId, seed.checkin(await seed.newTicket())),
        "23505",
        "pk_entry_checkins",
        "duplicate Entry Check-in id",
      );
      // GENERATED ALWAYS: an explicit id without OVERRIDING SYSTEM VALUE is refused (428C9).
      for (const table of ENTRY_TICKET_QR_TABLES) {
        expect(
          (await attempt(`INSERT INTO app.${table}(id) VALUES ($1)`, [ABSENT_ID]))?.code,
          `${table} explicit id`,
        ).toBe("428C9");
      }
    });
  });

  it("TC-DB-ARC-007-013 public_ref of Entry Tickets is a database generated v4 UUID unique by name, and the time columns default to the transaction's transaction_timestamp()", async () => {
    await withSeed(async (seed) => {
      const started = (await admin.query("SELECT transaction_timestamp() AS t")).rows[0].t;
      const ticket = (
        await admin.query(
          ...insertStatement(
            ENTRY_TICKETS,
            seed.ticket(await seed.entryLine()),
            "id, public_ref, issued_at, state_changed_at, valid_from, valid_until",
          ),
        )
      ).rows[0];
      expect(ticket.public_ref).toMatch(UUID_V4);
      expect([ticket.valid_from, ticket.valid_until]).toEqual([null, null]);
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(await seed.entryLine(), { public_ref: ticket.public_ref }),
        "23505",
        "uq_entry_tickets_public_ref",
        "duplicate Entry Ticket public_ref",
      );
      const qr = (
        await admin.query(
          ...insertStatement(QR_TOKENS, seed.entryQr(ticket.id), "issued_at, revoked_at"),
        )
      ).rows[0];
      const checkin = (
        await admin.query(
          ...insertStatement(ENTRY_CHECKINS, seed.checkin(ticket.id), "checked_in_at, created_at"),
        )
      ).rows[0];
      expect(qr.revoked_at).toBeNull();
      const times = [
        ticket.issued_at,
        ticket.state_changed_at,
        qr.issued_at,
        checkin.checked_in_at,
        checkin.created_at,
      ];
      for (const time of times) expect(time).toEqual(started);
    });
  });
});

// ---- TC-DB-STA-002-006 --------------------------------------------------------------------------

describe("TC-DB-STA-002-006 Entry Ticket and QR Token allowlist CHECK constraints keep the SPEC-030 / SPEC-100 names exactly (real PostgreSQL 17)", () => {
  it("TC-DB-STA-002-006 Entry Ticket: the 4 states are accepted; near misses are refused by name; state has no default", async () => {
    await withSeed(async (seed) => {
      const line = await seed.entryLine();
      for (const state of ENTRY_TICKET_STATES)
        await expectAccepted(ENTRY_TICKETS, seed.ticket(line, { state }), `state ${state}`);
      for (const state of [...ENTRY_TICKET_STATES.flatMap(nearMisses), "ACTIVE", "REVOKED", ""])
        await expectRejected(
          ENTRY_TICKETS,
          seed.ticket(line, { state }),
          "23514",
          "ck_entry_tickets_state",
          `state ${JSON.stringify(state)}`,
        );
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(line, { state: undefined }),
        "23502",
        "state",
        "state omitted",
      );
    });
  });

  it("TC-DB-STA-002-006 Entry Ticket: both Entry purposes are accepted; Karaoke, Goods and near misses are refused by ck_entry_tickets_order_purpose; it has no default", async () => {
    await withSeed(async (seed) => {
      await expectAccepted(
        ENTRY_TICKETS,
        seed.ticket(await seed.entryLine({ purpose: "ENTRY_TICKET_PURCHASE" })),
        "ENTRY_TICKET_PURCHASE",
      );
      await expectAccepted(
        ENTRY_TICKETS,
        seed.ticket((await seed.compositeLine()).entry),
        "ENTRY_GOODS_PURCHASE",
      );
      const line = await seed.entryLine();
      // The CHECK is evaluated on the row before the foreign keys, so a purpose that differs from the item's is
      // reported by the allowlist when it is not one of the two Entry purposes.
      for (const purpose of [
        "KARAOKE_PURCHASE",
        "GOODS_PURCHASE",
        ...ENTRY_TICKET_ORDER_PURPOSES.flatMap(nearMisses),
      ])
        await expectRejected(
          ENTRY_TICKETS,
          seed.ticket(line, { order_purpose: purpose }),
          "23514",
          "ck_entry_tickets_order_purpose",
          `order_purpose ${JSON.stringify(purpose)}`,
        );
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(line, { order_purpose: undefined }),
        "23502",
        "order_purpose",
        "order_purpose omitted",
      );
    });
  });

  it("TC-DB-STA-002-006 QR Token: format r39x1, the 2 purposes and the 2 lifecycle states are accepted; near misses are refused by name; none of them has a default", async () => {
    await withSeed(async (seed) => {
      const entryTicket = await seed.newTicket();
      const karaokeTicket = await seed.newKaraokeTicket();
      await expectAccepted(QR_TOKENS, seed.entryQr(entryTicket), "ENTRY ACTIVE");
      await expectAccepted(QR_TOKENS, seed.karaokeQr(karaokeTicket), "KARAOKE ACTIVE");
      await expectAccepted(QR_TOKENS, seed.entryQr(entryTicket, REVOKED), "ENTRY REVOKED");
      expect(QR_TOKEN_PURPOSES).toEqual(["ENTRY", "KARAOKE"]);
      expect(QR_TOKEN_LIFECYCLE_STATES).toEqual(["ACTIVE", "REVOKED"]);
      // The version is already lower case, so its lower-cased near miss is the value itself and is left out.
      const versions = nearMisses(QR_FORMAT_VERSION).filter((v) => v !== QR_FORMAT_VERSION);
      expect(versions).toHaveLength(3);
      for (const version of [...versions, "R39X1", "r39x2", "r39x0", ""])
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(entryTicket, { format_version: version }),
          "23514",
          "ck_qr_tokens_format_version",
          `format_version ${JSON.stringify(version)}`,
        );
      // A purpose outside the allowlist also breaks ck_qr_tokens_purpose_target; CHECKs are tested in name order,
      // so ck_qr_tokens_purpose reports first.
      for (const purpose of [
        ...QR_TOKEN_PURPOSES.flatMap(nearMisses),
        "ent",
        "krk",
        "ENTRY_TICKET",
      ])
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(entryTicket, { purpose }),
          "23514",
          "ck_qr_tokens_purpose",
          `purpose ${JSON.stringify(purpose)}`,
        );
      for (const state of [...QR_TOKEN_LIFECYCLE_STATES.flatMap(nearMisses), "VALID", "USED"])
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(entryTicket, { lifecycle_state: state }),
          "23514",
          "ck_qr_tokens_lifecycle_state",
          `lifecycle_state ${JSON.stringify(state)}`,
        );
      for (const column of ["format_version", "purpose", "lifecycle_state"])
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(entryTicket, { [column]: undefined }),
          "23502",
          column,
          `${column} omitted`,
        );
    });
  });
});

// ---- TC-DB-TQR-001-001 --------------------------------------------------------------------------

describe("TC-DB-TQR-001-001 one Entry Ticket per Order Item and issuance ordinal, issued only from an allocated Entry item of the owner's Order (real PostgreSQL 17)", () => {
  it("TC-DB-TQR-001-001 a second Ticket of the same item and ordinal is refused by uq_entry_tickets_order_item_id_issuance_ordinal in any state; other ordinals and items are accepted", async () => {
    await withSeed(async (seed) => {
      const line = await seed.entryLine({ quantity: 2 });
      await insertRow(ENTRY_TICKETS, seed.ticket(line, { issuance_ordinal: 1 }));
      for (const state of ENTRY_TICKET_STATES)
        await expectRejected(
          ENTRY_TICKETS,
          seed.ticket(line, { issuance_ordinal: 1, state }),
          "23505",
          "uq_entry_tickets_order_item_id_issuance_ordinal",
          `ordinal 1 again as ${state}`,
        );
      await expectAccepted(ENTRY_TICKETS, seed.ticket(line, { issuance_ordinal: 2 }), "ordinal 2");
      await expectAccepted(
        ENTRY_TICKETS,
        seed.ticket(await seed.entryLine(), { issuance_ordinal: 1 }),
        "ordinal 1 of another item",
      );
      // Only the confirmation transaction checks ordinal <= quantity and that N Tickets exist (DB-TQR-001).
      expect(await countRows(ENTRY_TICKETS, "order_item_id = $1", [line.item])).toBe(1);
    });
  });

  it("TC-DB-TQR-001-001 the ordinal must be positive, and the required columns are NOT NULL", async () => {
    await withSeed(async (seed) => {
      const line = await seed.entryLine();
      for (const ordinal of [0, -1, -2147483648])
        await expectRejected(
          ENTRY_TICKETS,
          seed.ticket(line, { issuance_ordinal: ordinal }),
          "23514",
          "ck_entry_tickets_issuance_ordinal",
          `ordinal ${ordinal}`,
        );
      for (const column of ["order_id", "order_item_id", "owner_profile_id", "issuance_ordinal"])
        await expectRejected(
          ENTRY_TICKETS,
          seed.ticket(line, { [column]: undefined }),
          "23502",
          column,
          `${column} omitted`,
        );
      for (const column of ["issued_at", "state_changed_at"])
        await expectRejected(
          ENTRY_TICKETS,
          seed.ticket(line, { [column]: null }),
          "23502",
          column,
          `${column} NULL`,
        );
    });
  });

  it("TC-DB-TQR-001-001 the Ticket's Order and Purpose must be its item's (fk_entry_tickets_order_item)", async () => {
    await withSeed(async (seed) => {
      const line = await seed.entryLine();
      const otherOrder = await seed.entryLine();
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(line, { order_id: otherOrder.order }),
        "23503",
        "fk_entry_tickets_order_item",
        "another Order of the same customer",
      );
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(line, { order_purpose: "ENTRY_GOODS_PURCHASE" }),
        "23503",
        "fk_entry_tickets_order_item",
        "the other Entry purpose",
      );
    });
  });

  it("TC-DB-TQR-001-001 the owner must be the Order's Customer (fk_entry_tickets_order)", async () => {
    await withSeed(async (seed) => {
      const line = await seed.entryLine();
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(line, { owner_profile_id: seed.otherProfile }),
        "23503",
        "fk_entry_tickets_order",
        "owner is not the Order's Customer",
      );
      const othersOrder = await seed.entryLine({ customer: seed.otherProfile });
      await expectAccepted(
        ENTRY_TICKETS,
        seed.ticket(othersOrder),
        "the other Customer's own Order",
      );
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(othersOrder, { owner_profile_id: seed.profile }),
        "23503",
        "fk_entry_tickets_order",
        "owner of the other Customer's Order",
      );
    });
  });

  it("TC-DB-TQR-001-001 an item without an Entry Allocation, including the Goods line of a composite Order, is refused by fk_entry_tickets_entry_sales_allocation", async () => {
    await withSeed(async (seed) => {
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket(await seed.entryLine({ allocation: false })),
        "23503",
        "fk_entry_tickets_entry_sales_allocation",
        "Entry item without an Allocation",
      );
      const composite = await seed.compositeLine();
      await expectRejected(
        ENTRY_TICKETS,
        seed.ticket({ ...composite.entry, item: composite.goodsItem }),
        "23503",
        "fk_entry_tickets_entry_sales_allocation",
        "Goods line of an ENTRY_GOODS_PURCHASE Order",
      );
      // An absent item breaks both the item and the Allocation foreign keys.
      const line = await seed.entryLine();
      expectEitherViolation(
        await tryInsert(ENTRY_TICKETS, seed.ticket(line, { order_item_id: ABSENT_ID })),
        ["fk_entry_tickets_order_item", "fk_entry_tickets_entry_sales_allocation"],
        "absent Order Item",
      );
    });
  });

  it("TC-DB-TQR-001-001 valid_from must be before valid_until when both are set; either may be NULL", async () => {
    await withSeed(async (seed) => {
      const line = await seed.entryLine({ quantity: 4 });
      const cases: [Row, boolean][] = [
        [{ valid_from: VALID_FROM, valid_until: VALID_UNTIL }, true],
        [{ valid_from: VALID_FROM }, true],
        [{ valid_until: VALID_UNTIL }, true],
        [{}, true],
        [{ valid_from: VALID_FROM, valid_until: VALID_FROM }, false],
        [{ valid_from: VALID_UNTIL, valid_until: VALID_FROM }, false],
      ];
      for (const [times, accepted] of cases) {
        const label = `valid period ${JSON.stringify(times)}`;
        if (accepted) await expectAccepted(ENTRY_TICKETS, seed.ticket(line, times), label);
        else
          await expectRejected(
            ENTRY_TICKETS,
            seed.ticket(line, times),
            "23514",
            "ck_entry_tickets_valid_period",
            label,
          );
      }
    });
  });
});

// ---- TC-DB-TQR-002-001 --------------------------------------------------------------------------

describe("TC-DB-TQR-002-001 the QR Token keeps no plaintext: only a 32-byte unique lookup digest and an encrypted envelope (real PostgreSQL 17)", () => {
  it("TC-DB-TQR-002-001 no column of the three tables can hold a token as text: the only text columns are allowlisted, and the token columns are bytea", async () => {
    const columns = (
      await admin.query(
        `SELECT c.relname AS table_name, a.attname, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY 1, 2`,
        [[...ENTRY_TICKET_QR_TABLES]],
      )
    ).rows;
    const ofType = (pattern: RegExp) =>
      columns.filter((c) => pattern.test(c.type)).map((c) => `${c.table_name}.${c.attname}`);
    expect(ofType(/^(text|character|json|xml)/)).toEqual([
      "entry_tickets.order_purpose",
      "entry_tickets.state",
      "qr_tokens.format_version",
      "qr_tokens.lifecycle_state",
      "qr_tokens.purpose",
    ]);
    expect(ofType(/^bytea$/)).toEqual([
      "qr_tokens.lookup_digest",
      "qr_tokens.protected_token_material",
    ]);
    // Each text column is closed by an equality or allowlist CHECK.
    const checks = (
      await admin.query(
        `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid = ANY($1::regclass[]) ORDER BY 1`,
        [ENTRY_TICKET_QR_TABLES.map((t) => `app.${t}`)],
      )
    ).rows.map((r) => r.conname);
    for (const name of [
      "ck_entry_tickets_order_purpose",
      "ck_entry_tickets_state",
      "ck_qr_tokens_format_version",
      "ck_qr_tokens_lifecycle_state",
      "ck_qr_tokens_purpose",
    ])
      expect(checks).toContain(name);
    expect(columns.map((c) => c.attname)).not.toContain("token");
  });

  it("TC-DB-TQR-002-001 the digest is exactly 32 bytes and unique across all Tokens and states; the key version is positive; the token columns are NOT NULL", async () => {
    await withSeed(async (seed) => {
      const ticket = await seed.newTicket();
      for (const size of [0, 1, 31, 33, 64])
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(ticket, { lookup_digest: Buffer.alloc(size, 7) }),
          "23514",
          "ck_qr_tokens_lookup_digest_length",
          `digest of ${size} bytes`,
        );
      const digest = bytes32("shared");
      await insertRow(QR_TOKENS, seed.entryQr(ticket, { ...REVOKED, lookup_digest: digest }));
      await expectRejected(
        QR_TOKENS,
        seed.entryQr(await seed.newTicket(), { lookup_digest: digest }),
        "23505",
        "uq_qr_tokens_lookup_digest",
        "the digest of a REVOKED Token on another Entry Ticket",
      );
      await expectRejected(
        QR_TOKENS,
        seed.karaokeQr(await seed.newKaraokeTicket(), { lookup_digest: digest }),
        "23505",
        "uq_qr_tokens_lookup_digest",
        "the same digest on a Karaoke Ticket",
      );
      for (const version of [0, -1])
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(ticket, { protection_key_version: version }),
          "23514",
          "ck_qr_tokens_protection_key_version",
          `key version ${version}`,
        );
      await expectAccepted(
        QR_TOKENS,
        seed.entryQr(ticket, { protection_key_version: 2 }),
        "key version 2",
      );
      for (const column of ["lookup_digest", "protected_token_material", "protection_key_version"])
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(ticket, { [column]: undefined }),
          "23502",
          column,
          `${column} omitted`,
        );
    });
  });
});

// ---- TC-TQR-TOK-006-001 -------------------------------------------------------------------------

describe("TC-TQR-TOK-006-001 an Entry QR refers to an Entry Ticket only and a Karaoke QR to a Karaoke Ticket only (ck_qr_tokens_purpose_target, real PostgreSQL 17)", () => {
  it("TC-TQR-TOK-006-001 each purpose takes exactly its own Ticket reference; the other, both or none are refused by name", async () => {
    await withSeed(async (seed) => {
      const entry = await seed.newTicket();
      const karaoke = await seed.newKaraokeTicket();
      await expectAccepted(QR_TOKENS, seed.entryQr(entry), "ENTRY -> Entry Ticket");
      await expectAccepted(QR_TOKENS, seed.karaokeQr(karaoke), "KARAOKE -> Karaoke Ticket");
      const refused: [string, Row][] = [
        [
          "ENTRY -> Karaoke Ticket",
          { purpose: "ENTRY", entry_ticket_id: null, karaoke_ticket_id: karaoke },
        ],
        ["ENTRY -> both", { purpose: "ENTRY", entry_ticket_id: entry, karaoke_ticket_id: karaoke }],
        ["ENTRY -> none", { purpose: "ENTRY", entry_ticket_id: null, karaoke_ticket_id: null }],
        [
          "KARAOKE -> Entry Ticket",
          { purpose: "KARAOKE", entry_ticket_id: entry, karaoke_ticket_id: null },
        ],
        [
          "KARAOKE -> both",
          { purpose: "KARAOKE", entry_ticket_id: entry, karaoke_ticket_id: karaoke },
        ],
        ["KARAOKE -> none", { purpose: "KARAOKE", entry_ticket_id: null, karaoke_ticket_id: null }],
      ];
      for (const [label, target] of refused)
        await expectRejected(
          QR_TOKENS,
          seed.entryQr(entry, target),
          "23514",
          "ck_qr_tokens_purpose_target",
          label,
        );
    });
  });

  it("TC-TQR-TOK-006-001 the referenced Ticket must exist (fk_qr_tokens_entry_ticket, fk_qr_tokens_karaoke_ticket)", async () => {
    await withSeed(async (seed) => {
      await expectRejected(
        QR_TOKENS,
        seed.entryQr(ABSENT_ID),
        "23503",
        "fk_qr_tokens_entry_ticket",
        "absent Entry Ticket",
      );
      await expectRejected(
        QR_TOKENS,
        seed.karaokeQr(ABSENT_ID),
        "23503",
        "fk_qr_tokens_karaoke_ticket",
        "absent Karaoke Ticket",
      );
    });
  });
});

// ---- TC-TQR-TOK-013-001 -------------------------------------------------------------------------

describe("TC-TQR-TOK-013-001 at most one ACTIVE QR Token per Entry Ticket and per Karaoke Ticket (ux_qr_tokens_entry_active, ux_qr_tokens_karaoke_active, real PostgreSQL 17)", () => {
  it("TC-TQR-TOK-013-001 a second ACTIVE Token of the same Ticket is refused by name; REVOKED Tokens are not limited; other Tickets are independent", async () => {
    await withSeed(async (seed) => {
      const cases = [
        [
          "Entry",
          await seed.newTicket(),
          await seed.newTicket(),
          seed.entryQr,
          ENTRY_ACTIVE_QR_INDEX,
          "entry_ticket_id",
        ],
        [
          "Karaoke",
          await seed.newKaraokeTicket(0),
          await seed.newKaraokeTicket(1),
          seed.karaokeQr,
          KARAOKE_ACTIVE_QR_INDEX,
          "karaoke_ticket_id",
        ],
      ] as const;
      for (const [kind, ticket, other, qr, index, column] of cases) {
        await insertRow(QR_TOKENS, qr(ticket));
        await expectRejected(QR_TOKENS, qr(ticket), "23505", index, `${kind}: second ACTIVE`);
        // The REVOKED rows stay in the scenario's transaction (tryInsert keeps an accepted row), so they coexist
        // with each other and with the ACTIVE Token of the same Ticket.
        for (let i = 0; i < 3; i++)
          expect(
            await tryInsert(QR_TOKENS, qr(ticket, REVOKED)),
            `${kind}: REVOKED #${i + 1} must be accepted beside the others`,
          ).toBeUndefined();
        await expectRejected(
          QR_TOKENS,
          qr(ticket),
          "23505",
          index,
          `${kind}: second ACTIVE beside the REVOKED Tokens`,
        );
        expect(
          (
            await admin.query(
              `SELECT lifecycle_state, count(*)::int AS count FROM app.qr_tokens WHERE ${column} = $1
                GROUP BY lifecycle_state ORDER BY lifecycle_state`,
              [ticket],
            )
          ).rows.map((r) => [r.lifecycle_state, r.count]),
          `${kind}: Tokens of the Ticket`,
        ).toEqual([
          ["ACTIVE", 1],
          ["REVOKED", 3],
        ]);
        await expectAccepted(QR_TOKENS, qr(other), `${kind}: ACTIVE of another Ticket`);
      }
    });
  });

  it("TC-TQR-TOK-013-001 rotation revokes the old Token before the new one; turning a REVOKED Token back to ACTIVE beside another ACTIVE is refused", async () => {
    await withSeed(async (seed) => {
      const ticket = await seed.newTicket();
      const oldToken = await insertRow(QR_TOKENS, seed.entryQr(ticket));
      expect(
        await attempt(
          "UPDATE app.qr_tokens SET lifecycle_state = 'REVOKED', revoked_at = $2 WHERE id = $1",
          [oldToken, AT],
        ),
      ).toBeUndefined();
      const newToken = await insertRow(QR_TOKENS, seed.entryQr(ticket));
      expectViolation(
        await attempt(
          "UPDATE app.qr_tokens SET lifecycle_state = 'ACTIVE', revoked_at = NULL WHERE id = $1",
          [oldToken],
        ),
        "23505",
        ENTRY_ACTIVE_QR_INDEX,
        "the old Token back to ACTIVE",
      );
      expect(
        (
          await admin.query(
            "SELECT id, lifecycle_state FROM app.qr_tokens WHERE entry_ticket_id = $1 ORDER BY id",
            [ticket],
          )
        ).rows.map((r) => [r.id, r.lifecycle_state]),
      ).toEqual([
        [oldToken, "REVOKED"],
        [newToken, "ACTIVE"],
      ]);
    });
  });
});

// ---- TC-DB-TQR-003-001 --------------------------------------------------------------------------

describe("TC-DB-TQR-003-001 a REVOKED Token keeps its revoked_at and its Ticket correlation, and Tokens survive any Ticket state (real PostgreSQL 17)", () => {
  it("TC-DB-TQR-003-001 ACTIVE forbids revoked_at and REVOKED requires it (ck_qr_tokens_revoked_at)", async () => {
    await withSeed(async (seed) => {
      const ticket = await seed.newTicket();
      await expectRejected(
        QR_TOKENS,
        seed.entryQr(ticket, { revoked_at: AT }),
        "23514",
        "ck_qr_tokens_revoked_at",
        "ACTIVE with revoked_at",
      );
      await expectRejected(
        QR_TOKENS,
        seed.entryQr(ticket, { lifecycle_state: "REVOKED" }),
        "23514",
        "ck_qr_tokens_revoked_at",
        "REVOKED without revoked_at",
      );
      const token = await insertRow(QR_TOKENS, seed.entryQr(ticket));
      expectViolation(
        await attempt("UPDATE app.qr_tokens SET lifecycle_state = 'REVOKED' WHERE id = $1", [
          token,
        ]),
        "23514",
        "ck_qr_tokens_revoked_at",
        "revoking without revoked_at",
      );
    });
  });

  it("TC-DB-TQR-003-001 the Ticket of REVOKED Tokens cannot be deleted, and USED, CANCELED and EXPIRED Tickets keep their Tokens (DB-TQR-004)", async () => {
    await withSeed(async (seed) => {
      const ticket = await seed.newTicket();
      await insertRow(QR_TOKENS, seed.entryQr(ticket, REVOKED));
      await insertRow(QR_TOKENS, seed.entryQr(ticket, REVOKED));
      expectViolation(
        await attempt("DELETE FROM app.entry_tickets WHERE id = $1", [ticket]),
        "23503",
        "fk_qr_tokens_entry_ticket",
        "Ticket with REVOKED Tokens",
      );
      for (const state of ["USED", "CANCELED", "EXPIRED"]) {
        const other = await seed.newTicket();
        await insertRow(QR_TOKENS, seed.entryQr(other));
        expect(
          await attempt(
            "UPDATE app.entry_tickets SET state = $2, state_changed_at = $3 WHERE id = $1",
            [other, state, AT],
          ),
          state,
        ).toBeUndefined();
        expect(await countRows(QR_TOKENS, "entry_ticket_id = $1", [other]), state).toBe(1);
      }
    });
  });
});

// ---- TC-INV-010-05-002 --------------------------------------------------------------------------

describe("TC-INV-010-05-002 at most one Entry Check-in per Ticket, by a Staff Profile and Role Assignment that exist (real PostgreSQL 17)", () => {
  it("TC-INV-010-05-002 a second Check-in of the same Ticket is refused with 23505 uq_entry_checkins_entry_ticket_id; another Ticket's Check-in is accepted", async () => {
    await withSeed(async (seed) => {
      const ticket = await seed.newTicket();
      await insertRow(ENTRY_CHECKINS, seed.checkin(ticket));
      await expectRejected(
        ENTRY_CHECKINS,
        seed.checkin(ticket),
        "23505",
        "uq_entry_checkins_entry_ticket_id",
        "second Check-in, same Staff",
      );
      const otherStaff = await insertRow("business_profiles", { auth_subject: uuid() });
      const otherRole = await insertRow("role_assignments", {
        profile_id: otherStaff,
        role: "STAFF",
        state: "ACTIVE",
      });
      await expectRejected(
        ENTRY_CHECKINS,
        seed.checkin(ticket, { staff_profile_id: otherStaff, staff_role_assignment_id: otherRole }),
        "23505",
        "uq_entry_checkins_entry_ticket_id",
        "second Check-in, another Staff",
      );
      await expectAccepted(ENTRY_CHECKINS, seed.checkin(await seed.newTicket()), "another Ticket");
      expect(await countRows(ENTRY_CHECKINS, "entry_ticket_id = $1", [ticket])).toBe(1);
    });
  });

  it("TC-INV-010-05-002 an absent Ticket, Staff Profile or Role Assignment is refused with 23503 by name; the references are NOT NULL", async () => {
    await withSeed(async (seed) => {
      const ticket = await seed.newTicket();
      await expectRejected(
        ENTRY_CHECKINS,
        seed.checkin(ABSENT_ID),
        "23503",
        "fk_entry_checkins_entry_ticket",
        "absent Ticket",
      );
      await expectRejected(
        ENTRY_CHECKINS,
        seed.checkin(ticket, { staff_profile_id: ABSENT_ID }),
        "23503",
        "fk_entry_checkins_staff_profile",
        "absent Staff Profile",
      );
      await expectRejected(
        ENTRY_CHECKINS,
        seed.checkin(ticket, { staff_role_assignment_id: ABSENT_ID }),
        "23503",
        "fk_entry_checkins_staff_role_assignment",
        "absent Role Assignment",
      );
      for (const column of ["entry_ticket_id", "staff_profile_id", "staff_role_assignment_id"])
        await expectRejected(
          ENTRY_CHECKINS,
          seed.checkin(ticket, { [column]: undefined }),
          "23502",
          column,
          `${column} omitted`,
        );
    });
  });
});

// ---- TC-CON-001-005 -----------------------------------------------------------------------------

describe("TC-CON-001-005 two connections cannot both check in one Entry Ticket or both hold an ACTIVE QR of it (real PostgreSQL 17)", () => {
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
    try {
      // Inside try, so a failed connect of Y still closes X (end() of an unconnected client resolves at once).
      await x.connect();
      await y.connect();
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
  async function withCommittedTicket<T>(run: (seed: Seed, ticket: string) => Promise<T>) {
    const seed = factories(await insertParents());
    try {
      return await run(seed, await seed.newTicket());
    } finally {
      for (const table of [
        ENTRY_CHECKINS,
        QR_TOKENS,
        ENTRY_TICKETS,
        "entry_sales_allocations",
        "order_items",
        "orders",
        "karaoke_slots",
        "karaoke_exclusive_scopes",
        "karaoke_sales_configurations",
        "goods",
        "entry_ticket_offerings",
        "events",
        "role_assignments",
        "business_profiles",
      ])
        await admin.query(`DELETE FROM app.${table}`);
    }
  }

  const scenarios = [
    [
      "Entry Check-in",
      ENTRY_CHECKINS,
      "uq_entry_checkins_entry_ticket_id",
      (seed: Seed, ticket: string) => seed.checkin(ticket),
    ],
    [
      "ACTIVE Entry QR Token",
      QR_TOKENS,
      ENTRY_ACTIVE_QR_INDEX,
      (seed: Seed, ticket: string) => seed.entryQr(ticket),
    ],
  ] as const;

  for (const [label, table, name, row] of scenarios) {
    for (const outcome of ["COMMIT", "ROLLBACK"] as const) {
      it(
        `TC-CON-001-005 ${label}: Y waits for X and is ${outcome === "COMMIT" ? `refused with 23505 ${name}` : "accepted"} after X ${outcome}`,
        async () => {
          await withCommittedTicket(async (seed, ticket) => {
            const failure = await race(outcome, table, row(seed, ticket), row(seed, ticket));
            if (outcome === "COMMIT") {
              expectViolation(failure, "23505", name, "Y after X COMMIT");
              expect(await countRows(table, "entry_ticket_id = $1", [ticket])).toBe(1);
            } else {
              expect(failure, "Y after X ROLLBACK").toBeUndefined();
              expect(await countRows(table, "entry_ticket_id = $1", [ticket])).toBe(0);
            }
          });
          await expectNothingCommitted();
        },
        RACE_CASE_TIMEOUT_MS,
      );
    }
  }
});

// ---- TC-DB-FK-002-006 ---------------------------------------------------------------------------

describe("TC-DB-FK-002-006 the Entry Ticket / QR / Check-in foreign keys restrict deletes and never cascade (real PostgreSQL 17)", () => {
  it("TC-DB-FK-002-006 all eight foreign keys are ON DELETE RESTRICT and ON UPDATE NO ACTION", async () => {
    const rows = (
      await admin.query(
        `SELECT conname, confdeltype, confupdtype FROM pg_constraint
          WHERE contype = 'f' AND conrelid = ANY($1::regclass[]) ORDER BY conname`,
        [ENTRY_TICKET_QR_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    const expected = GOLDEN_TABLES.flatMap((g) => g.foreignKeys.map((f) => f.name)).sort();
    expect(expected).toHaveLength(8);
    expect(rows.map((r) => [r.conname, r.confdeltype, r.confupdtype])).toEqual(
      expected.map((name) => [name, "r", "a"]),
    );
  });

  it("TC-DB-FK-002-006 deleting a parent that has Ticket, Token or Check-in history is refused with 23503 by name, and nothing is lost", async () => {
    await withSeed(async (seed) => {
      const withToken = await seed.newTicket();
      await insertRow(QR_TOKENS, seed.entryQr(withToken, REVOKED));
      const withCheckin = await seed.newTicket({ state: "USED" });
      await insertRow(ENTRY_CHECKINS, seed.checkin(withCheckin));
      const karaoke = await seed.newKaraokeTicket();
      await insertRow(QR_TOKENS, seed.karaokeQr(karaoke));
      const counts = () => Promise.all(ENTRY_TICKET_QR_TABLES.map((t) => countRows(t)));
      const before = await counts();

      const singles: [string, string, string, string][] = [
        [
          "Entry Ticket with a Token",
          "DELETE FROM app.entry_tickets WHERE id = $1",
          withToken,
          "fk_qr_tokens_entry_ticket",
        ],
        [
          "Entry Ticket with a Check-in",
          "DELETE FROM app.entry_tickets WHERE id = $1",
          withCheckin,
          "fk_entry_checkins_entry_ticket",
        ],
        [
          "Karaoke Ticket with a Token",
          "DELETE FROM app.karaoke_tickets WHERE id = $1",
          karaoke,
          "fk_qr_tokens_karaoke_ticket",
        ],
        [
          "Entry Allocation of an issued item",
          "DELETE FROM app.entry_sales_allocations WHERE order_item_id = (SELECT order_item_id FROM app.entry_tickets WHERE id = $1)",
          withToken,
          "fk_entry_tickets_entry_sales_allocation",
        ],
        [
          "Role Assignment that checked in",
          "DELETE FROM app.role_assignments WHERE id = $1",
          seed.staffRole,
          "fk_entry_checkins_staff_role_assignment",
        ],
      ];
      for (const [label, statement, id, name] of singles)
        expectViolation(await attempt(statement, [id]), "23503", name, label);
      const doubles: [string, string, string, string[]][] = [
        [
          "Order Item with a Ticket",
          "DELETE FROM app.order_items WHERE id = (SELECT order_item_id FROM app.entry_tickets WHERE id = $1)",
          withToken,
          [
            "fk_entry_tickets_order_item",
            "fk_entry_sales_allocations_order_item",
            "fk_entry_sales_allocations_offering",
          ],
        ],
        [
          "Order with a Ticket",
          "DELETE FROM app.orders WHERE id = (SELECT order_id FROM app.entry_tickets WHERE id = $1)",
          withToken,
          ["fk_entry_tickets_order", "fk_order_items_order"],
        ],
        [
          "Staff Profile that checked in",
          "DELETE FROM app.business_profiles WHERE id = $1",
          seed.staff,
          ["fk_entry_checkins_staff_profile", "fk_role_assignments_profile"],
        ],
      ];
      for (const [label, statement, id, names] of doubles)
        expectEitherViolation(await attempt(statement, [id]), names, label);
      expect(await counts()).toEqual(before);
    });
  });
});

// ---- TC-SEC-DB-001-006 --------------------------------------------------------------------------

describe("TC-SEC-DB-001-006 no runtime role has any privilege on the three Entry Ticket / QR / Check-in tables (plan U-5, real PostgreSQL 17)", () => {
  const PRIVILEGES = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ] as const;
  const ROLES = [
    "app_api_runtime",
    "app_email_runtime",
    "app_reconciliation_runtime",
    "app_runtime",
  ] as const;

  it("TC-SEC-DB-001-006 has_table_privilege is false for every privilege of the four runtime roles and PUBLIC on all three tables", async () => {
    for (const table of ENTRY_TICKET_QR_TABLES) {
      for (const role of [...ROLES, "public"]) {
        for (const privilege of PRIVILEGES) {
          expect(
            (
              await admin.query("SELECT has_table_privilege($1, $2, $3) AS allowed", [
                role,
                `app.${table}`,
                privilege,
              ])
            ).rows[0].allowed,
            `${role} ${privilege} ${table}`,
          ).toBe(false);
        }
      }
    }
  });

  it("TC-SEC-DB-001-006 the table ACLs name only app_migrator, no column has an ACL, and no role may use the three identity sequences", async () => {
    const withAcl = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS column_name
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL`,
        [[...ENTRY_TICKET_QR_TABLES]],
      )
    ).rows;
    expect(withAcl).toEqual([]);
    for (const table of ENTRY_TICKET_QR_TABLES) {
      const grantees = (
        await admin.query(
          `SELECT DISTINCT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee
             FROM pg_class c, aclexplode(c.relacl) e WHERE c.oid = $1::regclass`,
          [`app.${table}`],
        )
      ).rows.map((r) => r.grantee);
      expect(grantees, table).toEqual(["app_migrator"]);
    }
    for (const sequence of ENTRY_TICKET_QR_SEQUENCES)
      for (const role of ROLES)
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

  it("TC-SEC-DB-001-006 the three runtime pools are refused SELECT, INSERT, UPDATE, DELETE and TRUNCATE on all three tables with 42501", async () => {
    for (const [role] of RUNTIME_SERVICES) {
      const pool = poolOf(role);
      for (const golden of GOLDEN_TABLES) {
        const column = golden.columns[1]?.[0] as string;
        for (const statement of [
          `SELECT 1 FROM app.${golden.table}`,
          `INSERT INTO app.${golden.table} DEFAULT VALUES`,
          `UPDATE app.${golden.table} SET ${column} = ${column} WHERE false`,
          `DELETE FROM app.${golden.table} WHERE false`,
          `TRUNCATE app.${golden.table}`,
        ]) {
          await expect(pool.query(statement), `${role}: ${statement}`).rejects.toMatchObject({
            code: "42501",
          });
        }
      }
    }
  });
});
