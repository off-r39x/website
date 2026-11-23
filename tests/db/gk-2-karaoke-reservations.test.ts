import { readFile } from "node:fs/promises";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../../packages/db/src/index.ts";
import { migrationIdentities } from "../../packages/db/src/migrations.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  ACTIVE_HOLD_INDEX,
  GOLDEN_TABLES,
  HOLD_RESERVATION_TARGET,
  KARAOKE_CHECKINS,
  KARAOKE_HOLD_STATES,
  KARAOKE_HOLDS,
  KARAOKE_RESERVATION_SEQUENCES,
  KARAOKE_RESERVATION_STATES,
  KARAOKE_RESERVATION_TABLES,
  KARAOKE_RESERVATIONS,
  KARAOKE_TICKET_STATES,
  KARAOKE_TICKETS,
  SEPARATE_INDEX_NAMES,
  SPEC_COLUMN_COUNTS,
  SPEC_CONSTRAINT_COUNTS,
  SPEC_INDEX_COUNTS,
} from "../harness/db/karaoke-reservations-golden.ts";

// PR-GK-2 C1: the four Karaoke reservation tables of migration 0007 (app.karaoke_holds,
// app.karaoke_reservations, app.karaoke_tickets and app.karaoke_checkins) on a real PostgreSQL 17 (SPEC-100 §30,
// §33, §34, §37, §45.1, §45.4, §45.5, §67 items 18, 22, 23, 26-28; SPEC-170 §22-§24, TST-DB-001, TST-DB-004,
// TST-CON-001). Constraints, the generated expiry, identity, foreign keys, concurrency and privileges are never
// proven by a fake (TST-GEN-004, DEV-TST-003). The catalog goldens come from
// tests/harness/db/karaoke-reservations-golden.ts, written by hand from SPEC-100 and the plan, never derived from
// schema-contract.json or from the migration. Every violating row breaks exactly one constraint unless the case says
// otherwise, and every assertion checks the SQLSTATE and the constraint (or column) name together. The Hold
// acquire, Business Confirmation, cancellation and check-in transactions (SPEC-100 §31, §35-§37) are not part of
// this PR; only the rows they will write are constrained here. All data is synthetic.

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// An id no identity sequence of this test database reaches.
const ABSENT_ID = "9223372036854775807";
const SALES_START = "2030-01-01T00:00:00Z";
const SALES_END = "2030-01-02T00:00:00Z";
const AT = "2030-01-01T03:00:00Z";
const USAGE_START = "2030-01-01T05:00:00Z";
const USAGE_END = "2030-01-01T05:15:00Z";
const TSTZ = "timestamp with time zone";
/** The parents 0007 refers to (REFERENCES targets only). */
const PARENT_TABLES = ["business_profiles", "order_items", "orders", "role_assignments"];

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

// A failed statement never poisons the next one: it is undone to its own savepoint. A successful one is kept.
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
  for (const table of [...KARAOKE_RESERVATION_TABLES, "order_items", "orders"]) {
    expect(await countRows(table), `${table} rows`).toBe(0);
  }
}

// ---- synthetic row factories (valid by default; overrides break one rule at a time) --------------

let counter = 0;
const next = () => ++counter;
const uuid = () => `00000000-0000-4000-8000-${(0xb20000 + next()).toString(16).padStart(12, "0")}`;

/** The timestamps a Hold state needs to satisfy ck_karaoke_holds_state_times (SPEC-100 §30). */
function holdTimes(state: string): Row {
  return {
    committed_at: state === "COMMITTED" ? AT : undefined,
    released_at: state === "RELEASED" ? AT : undefined,
    expired_at: state === "EXPIRED" ? AT : undefined,
  };
}

/** A Karaoke Order and its one Karaoke Order Item; the Hold and Reservation of the item copy these ids. */
interface Chain {
  order: string;
  item: string;
  customer: string;
  slot: string;
}

interface Seed {
  profile: string;
  otherProfile: string;
  staff: string;
  staffRole: string;
  slot: string;
  otherSlot: string;
  entryOffering: string;
  /** A new Karaoke Order (PREPARED) with one item for the slot (default: seed.slot, seed.profile). */
  chain: (o?: { slot?: string; customer?: string }) => Promise<Chain>;
  hold: (c: Chain, o?: Row) => Row;
  newHold: (c: Chain, o?: Row) => Promise<string>;
  reservation: (c: Chain, holdId: string, o?: Row) => Row;
  /** chain + COMMITTED Hold + CONFIRMED Reservation. */
  newReservation: (o?: {
    slot?: string;
    customer?: string;
  }) => Promise<Chain & { hold: string; reservation: string }>;
  ticket: (reservationId: string, ownerId: string, o?: Row) => Row;
  /** newReservation + VALID Ticket. */
  newTicket: () => Promise<Chain & { hold: string; reservation: string; ticket: string }>;
  checkin: (ticketId: string, o?: Row) => Row;
}

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
  const entryOffering = await insertRow("entry_ticket_offerings", {
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
  const slotRow = (start: string, end: string, cycleEnd: string, candidate: number): Row => ({
    exclusive_scope_id: scope,
    sales_configuration_id: config,
    state: "AVAILABLE",
    usage_start: start,
    usage_end: end,
    cycle_end: cycleEnd,
    generation_cause_key: uuid(),
    generation_candidate_no: candidate,
  });
  const slot = await insertRow(
    "karaoke_slots",
    slotRow(USAGE_START, USAGE_END, "2030-01-01T05:20:00Z", 0),
  );
  const otherSlot = await insertRow(
    "karaoke_slots",
    slotRow("2030-01-01T05:20:00Z", "2030-01-01T05:35:00Z", "2030-01-01T05:40:00Z", 1),
  );
  return { profile, otherProfile, staff, staffRole, slot, otherSlot, entryOffering };
}

function factories(parents: Awaited<ReturnType<typeof insertParents>>): Seed {
  const chain = async (o: { slot?: string; customer?: string } = {}): Promise<Chain> => {
    const customer = o.customer ?? parents.profile;
    const slot = o.slot ?? parents.slot;
    const order = await insertRow("orders", {
      purchase_cause_key: uuid(),
      customer_profile_id: customer,
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
    return { order, item, customer, slot };
  };
  const hold = (c: Chain, o: Row = {}): Row => {
    const state = (o.state as string | undefined) ?? "ACTIVE";
    return {
      order_id: c.order,
      order_item_id: c.item,
      customer_profile_id: c.customer,
      slot_id: c.slot,
      state,
      ...holdTimes(state),
      ...o,
    };
  };
  const reservation = (c: Chain, holdId: string, o: Row = {}): Row => ({
    order_id: c.order,
    order_item_id: c.item,
    hold_id: holdId,
    customer_profile_id: c.customer,
    slot_id: c.slot,
    state: "CONFIRMED",
    usage_start_snapshot: USAGE_START,
    usage_end_snapshot: USAGE_END,
    ...o,
  });
  const newReservation = async (o: { slot?: string; customer?: string } = {}) => {
    const c = await chain(o);
    const holdId = await insertRow(KARAOKE_HOLDS, hold(c, { state: "COMMITTED" }));
    const reservationId = await insertRow(KARAOKE_RESERVATIONS, reservation(c, holdId));
    return { ...c, hold: holdId, reservation: reservationId };
  };
  const ticket = (reservationId: string, ownerId: string, o: Row = {}): Row => ({
    reservation_id: reservationId,
    owner_profile_id: ownerId,
    state: "VALID",
    expires_at: USAGE_END,
    ...o,
  });
  return {
    ...parents,
    chain,
    hold,
    newHold: (c, o) => insertRow(KARAOKE_HOLDS, hold(c, o)),
    reservation,
    newReservation,
    ticket,
    newTicket: async () => {
      const r = await newReservation();
      const ticketId = await insertRow(KARAOKE_TICKETS, ticket(r.reservation, r.customer));
      return { ...r, ticket: ticketId };
    },
    checkin: (ticketId, o = {}) => ({
      karaoke_ticket_id: ticketId,
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

// ---- TC-DB-ARC-007-009 --------------------------------------------------------------------------

describe("TC-DB-ARC-007-009 migration 0007 and the catalog of the four Karaoke reservation tables (real PostgreSQL 17)", () => {
  it("TC-DB-ARC-007-009 the journal lists 0001 to 0007 exactly once each with the source hashes, and a second run changes nothing", async () => {
    const identities = await migrationIdentities();
    const read = async () =>
      (await admin.query("SELECT version, source_hash FROM app.schema_migrations ORDER BY version"))
        .rows;
    const before = await read();
    expect(before.map((row) => row.version).slice(0, 7)).toEqual([
      "0001_foundation",
      "0002_audit_events",
      "0003_public_content_sales",
      "0004_karaoke_scopes_slots",
      "0005_idempotency_records",
      "0006_orders_payments",
      "0007_karaoke_reservations",
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

  it("TC-DB-ARC-007-009 0007 only creates the four tables and the four section 45 indexes and revokes; it alters, grants and drops nothing", async () => {
    const identities = await migrationIdentities();
    const seventh = identities.find((i) => i.name === "0007_karaoke_reservations.sql");
    expect(seventh, "0007_karaoke_reservations.sql exists").toBeDefined();
    const sqlText = (seventh?.sql ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const referenced = [...new Set([...sqlText.matchAll(/\bapp\.([a-z_]+)/g)].map((m) => m[1]))];
    expect(referenced.sort()).toEqual([...KARAOKE_RESERVATION_TABLES, ...PARENT_TABLES].sort());
    // The four existing tables appear only as foreign key targets: no existing object changes.
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
      /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION|EXTENSION|ROLE|SCHEMA|VIEW)\b/i,
      /\bOWNER\s+TO\b/i,
      /\bROW\s+LEVEL\s+SECURITY\b/i,
    ]) {
      expect(sqlText, `0007 must not contain ${forbidden}`).not.toMatch(forbidden);
    }
    expect([...sqlText.matchAll(/\bCREATE\s+TABLE\s+app\.([a-z_]+)/gi)].map((m) => m[1])).toEqual([
      ...KARAOKE_RESERVATION_TABLES,
    ]);
    expect(
      [...sqlText.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+([a-z_]+)/gi)].map((m) => m[1]).sort(),
    ).toEqual(SEPARATE_INDEX_NAMES);
    // The two predicates are those of ux_karaoke_holds_slot_active and ix_karaoke_holds_customer_active.
    expect([...sqlText.matchAll(/\bWHERE\b/gi)]).toHaveLength(2);
    expect([...sqlText.matchAll(/\bREVOKE\s+ALL\b/gi)]).toHaveLength(1);
  });

  it("TC-DB-ARC-007-009 the hand-written goldens have the SPEC-100 sizes (43 columns, 29 constraints, 19 indexes)", () => {
    expect(GOLDEN_TABLES.map((g) => g.table)).toEqual([...KARAOKE_RESERVATION_TABLES]);
    expect(GOLDEN_TABLES.map((g) => g.columns.length)).toEqual(SPEC_COLUMN_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.constraints.length)).toEqual(SPEC_CONSTRAINT_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.indexes.length)).toEqual(SPEC_INDEX_COUNTS);
    // PostgreSQL truncates identifiers beyond 63 bytes silently; every golden name fits (plan U-1).
    for (const g of GOLDEN_TABLES)
      for (const name of [...g.constraints, ...g.indexes].map((c) => c.name))
        expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
  });

  it("TC-DB-ARC-007-009 columns of the four tables equal the goldens in attnum order, including the generated hold_expires_at", async () => {
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

  it("TC-DB-ARC-007-009 constraints equal the goldens by name, kind and definition, all validated and not deferrable", async () => {
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
    expect(total).toBe(29);
  });

  it("TC-DB-ARC-007-009 exactly 19 valid indexes equal the goldens, with only the four section 45 indexes besides PK and UNIQUE", async () => {
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
    expect(total).toBe(19);
  });

  it("TC-DB-ARC-007-009 owner is app_migrator, row level security is off, there are four bigint identity sequences and every time column is timestamptz", async () => {
    const tables = (
      await admin.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) ORDER BY c.relname`,
        [[...KARAOKE_RESERVATION_TABLES]],
      )
    ).rows;
    expect(tables.map((t) => t.relname)).toEqual([...KARAOKE_RESERVATION_TABLES].sort());
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
        [KARAOKE_RESERVATION_SEQUENCES],
      )
    ).rows;
    expect(sequences.map((s) => [s.relname, s.type, s.owner])).toEqual(
      [...KARAOKE_RESERVATION_SEQUENCES].sort().map((name) => [name, "bigint", "app_migrator"]),
    );
    // DB-TIM-001: no timestamp without time zone, and every *_at / *_snapshot time column is timestamptz.
    const timeColumns = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname LIKE '%\\_at' OR a.attname LIKE '%\\_snapshot'
                 OR format_type(a.atttypid, a.atttypmod) LIKE 'timestamp%')`,
        [[...KARAOKE_RESERVATION_TABLES]],
      )
    ).rows;
    // 7 + 6 + 3 + 2 time columns (SPEC-100 §30, §33, §34, §37).
    expect(timeColumns.length).toBe(18);
    for (const column of timeColumns) expect(column.type, column.name).toBe(TSTZ);
  });

  it("TC-DB-ARC-007-009 the live catalog equals requiredCatalog, checked directly and not through readiness", async () => {
    const live = (await admin.query(catalogQuery)).rows[0].catalog;
    expect(live).toEqual(requiredCatalog);
    const liveTables = live.tables.map((row: unknown[]) => row[0]);
    for (const table of KARAOKE_RESERVATION_TABLES) expect(liveTables).toContain(table);
    const liveConstraints = live.constraints.map((row: unknown[]) => row[1]);
    for (const golden of GOLDEN_TABLES)
      for (const c of golden.constraints) expect(liveConstraints).toContain(c.name);
  });

  it("TC-DB-ARC-007-009 public_ref of Holds, Reservations and Tickets is a database generated v4 UUID unique by name; ids are GENERATED ALWAYS on all four tables", async () => {
    await withSeed(async (seed) => {
      const r = await seed.newTicket();
      const refs = (
        await admin.query(
          `SELECT (SELECT public_ref FROM app.karaoke_holds WHERE id = $1) AS hold,
                  (SELECT public_ref FROM app.karaoke_reservations WHERE id = $2) AS reservation,
                  (SELECT public_ref FROM app.karaoke_tickets WHERE id = $3) AS ticket`,
          [r.hold, r.reservation, r.ticket],
        )
      ).rows[0];
      for (const ref of [refs.hold, refs.reservation, refs.ticket]) expect(ref).toMatch(UUID_V4);
      // A fresh chain on the other Slot, so each duplicate breaks only its public_ref UNIQUE.
      const d = await seed.chain({ slot: seed.otherSlot });
      expectViolation(
        await tryInsert(KARAOKE_HOLDS, seed.hold(d, { state: "COMMITTED", public_ref: refs.hold })),
        "23505",
        "uq_karaoke_holds_public_ref",
        "duplicate Hold public_ref",
      );
      const holdId = await seed.newHold(d, { state: "COMMITTED" });
      expectViolation(
        await tryInsert(
          KARAOKE_RESERVATIONS,
          seed.reservation(d, holdId, { public_ref: refs.reservation }),
        ),
        "23505",
        "uq_karaoke_reservations_public_ref",
        "duplicate Reservation public_ref",
      );
      const reservationId = await insertRow(KARAOKE_RESERVATIONS, seed.reservation(d, holdId));
      expectViolation(
        await tryInsert(
          KARAOKE_TICKETS,
          seed.ticket(reservationId, d.customer, { public_ref: refs.ticket }),
        ),
        "23505",
        "uq_karaoke_tickets_public_ref",
        "duplicate Ticket public_ref",
      );
      // GENERATED ALWAYS: an explicit id without OVERRIDING SYSTEM VALUE is refused (428C9).
      for (const table of KARAOKE_RESERVATION_TABLES) {
        expect(
          (await attempt(`INSERT INTO app.${table}(id) VALUES ($1)`, [ABSENT_ID]))?.code,
          `${table} explicit id`,
        ).toBe("428C9");
      }
    });
  });
});

// ---- TC-DB-STA-002-004 --------------------------------------------------------------------------

describe("TC-DB-STA-002-004 Hold, Reservation and Karaoke Ticket allowlist CHECK constraints keep the SPEC-030 / SPEC-090 names exactly (real PostgreSQL 17)", () => {
  it("TC-DB-STA-002-004 Hold: the 4 states are accepted; near misses are refused by name; state has no default; order_purpose defaults to and only takes KARAOKE_PURCHASE", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      for (const state of KARAOKE_HOLD_STATES)
        await expectAccepted(KARAOKE_HOLDS, seed.hold(c, { state }), `Hold ${state}`);
      // An unknown state matches no branch of ck_karaoke_holds_state_times either. PostgreSQL tests CHECK
      // constraints in alphabetical order by name (CREATE TABLE, Notes), so the allowlist reports it.
      for (const state of KARAOKE_HOLD_STATES.flatMap(nearMisses))
        await expectRejected(
          KARAOKE_HOLDS,
          seed.hold(c, { state, committed_at: AT, released_at: AT, expired_at: AT }),
          "23514",
          "ck_karaoke_holds_state",
          `Hold state ${JSON.stringify(state)}`,
        );
      await expectRejected(
        KARAOKE_HOLDS,
        { ...seed.hold(c), state: undefined },
        "23502",
        "state",
        "Hold without state",
      );
      const id = await seed.newHold(c);
      expect(
        (await admin.query("SELECT order_purpose FROM app.karaoke_holds WHERE id = $1", [id]))
          .rows[0].order_purpose,
      ).toBe("KARAOKE_PURCHASE");
      // Another purpose cannot match the item either; the CHECK is evaluated before the foreign keys and reports.
      for (const purpose of ["ENTRY_TICKET_PURCHASE", "GOODS_PURCHASE", "karaoke_purchase"])
        await expectRejected(
          KARAOKE_HOLDS,
          seed.hold(await seed.chain(), { order_purpose: purpose }),
          "23514",
          "ck_karaoke_holds_order_purpose",
          `Hold order_purpose ${purpose}`,
        );
    });
  });

  it("TC-DB-STA-002-004 Hold state timestamps follow SPEC-100 section 30 as written: ACTIVE forbids all three, each other state requires its own (plan U-2)", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      for (const column of ["committed_at", "released_at", "expired_at"])
        await expectRejected(
          KARAOKE_HOLDS,
          seed.hold(c, { state: "ACTIVE", [column]: AT }),
          "23514",
          "ck_karaoke_holds_state_times",
          `ACTIVE with ${column}`,
        );
      for (const [state, column] of [
        ["COMMITTED", "committed_at"],
        ["RELEASED", "released_at"],
        ["EXPIRED", "expired_at"],
      ] as const) {
        await expectRejected(
          KARAOKE_HOLDS,
          seed.hold(c, { state, [column]: undefined }),
          "23514",
          "ck_karaoke_holds_state_times",
          `${state} without ${column}`,
        );
        // Plan U-2: §30 constrains only the state's own timestamp; the other two are not constrained.
        await expectAccepted(
          KARAOKE_HOLDS,
          seed.hold(c, { state, committed_at: AT, released_at: AT, expired_at: AT }),
          `${state} with all three timestamps`,
        );
      }
      // A state UPDATE must set the matching timestamp in the same statement.
      const id = await seed.newHold(c);
      expectViolation(
        await attempt("UPDATE app.karaoke_holds SET state = 'COMMITTED' WHERE id = $1", [id]),
        "23514",
        "ck_karaoke_holds_state_times",
        "ACTIVE -> COMMITTED without committed_at",
      );
      expect(
        await attempt(
          "UPDATE app.karaoke_holds SET state = 'COMMITTED', committed_at = $2 WHERE id = $1",
          [id, AT],
        ),
      ).toBeUndefined();
    });
  });

  it("TC-DB-STA-002-004 Reservation: CONFIRMED and CANCELED are accepted, near misses are refused by name and state has no default", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      const holdId = await seed.newHold(c, { state: "COMMITTED" });
      await expectAccepted(KARAOKE_RESERVATIONS, seed.reservation(c, holdId), "CONFIRMED");
      await expectAccepted(
        KARAOKE_RESERVATIONS,
        seed.reservation(c, holdId, { state: "CANCELED", canceled_at: AT }),
        "CANCELED",
      );
      // Without canceled_at, a near miss satisfies ck_karaoke_reservations_canceled_at and breaks only the allowlist.
      for (const state of KARAOKE_RESERVATION_STATES.flatMap(nearMisses))
        await expectRejected(
          KARAOKE_RESERVATIONS,
          seed.reservation(c, holdId, { state }),
          "23514",
          "ck_karaoke_reservations_state",
          `Reservation state ${JSON.stringify(state)}`,
        );
      await expectRejected(
        KARAOKE_RESERVATIONS,
        { ...seed.reservation(c, holdId), state: undefined },
        "23502",
        "state",
        "Reservation without state",
      );
    });
  });

  it("TC-DB-STA-002-004 Karaoke Ticket: the 4 states are accepted, near misses are refused by name and state has no default", async () => {
    await withSeed(async (seed) => {
      const r = await seed.newReservation();
      for (const state of KARAOKE_TICKET_STATES)
        await expectAccepted(
          KARAOKE_TICKETS,
          seed.ticket(r.reservation, r.customer, { state }),
          `Ticket ${state}`,
        );
      for (const state of KARAOKE_TICKET_STATES.flatMap(nearMisses))
        await expectRejected(
          KARAOKE_TICKETS,
          seed.ticket(r.reservation, r.customer, { state }),
          "23514",
          "ck_karaoke_tickets_state",
          `Ticket state ${JSON.stringify(state)}`,
        );
      await expectRejected(
        KARAOKE_TICKETS,
        { ...seed.ticket(r.reservation, r.customer), state: undefined },
        "23502",
        "state",
        "Ticket without state",
      );
    });
  });

  it("TC-DB-STA-002-004 the required columns of the four tables are NOT NULL, and the time defaults are the transaction's transaction_timestamp()", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      for (const column of ["order_id", "order_item_id", "customer_profile_id", "slot_id"])
        await expectRejected(
          KARAOKE_HOLDS,
          { ...seed.hold(c), [column]: undefined },
          "23502",
          column,
          `Hold without ${column}`,
        );
      const holdId = await seed.newHold(c, { state: "COMMITTED" });
      for (const column of [
        "order_id",
        "order_item_id",
        "hold_id",
        "customer_profile_id",
        "slot_id",
        "usage_start_snapshot",
        "usage_end_snapshot",
      ])
        await expectRejected(
          KARAOKE_RESERVATIONS,
          { ...seed.reservation(c, holdId), [column]: undefined },
          "23502",
          column,
          `Reservation without ${column}`,
        );
      const reservationId = await insertRow(KARAOKE_RESERVATIONS, seed.reservation(c, holdId));
      for (const column of ["reservation_id", "owner_profile_id", "expires_at"])
        await expectRejected(
          KARAOKE_TICKETS,
          { ...seed.ticket(reservationId, c.customer), [column]: undefined },
          "23502",
          column,
          `Ticket without ${column}`,
        );
      const ticketId = await insertRow(KARAOKE_TICKETS, seed.ticket(reservationId, c.customer));
      for (const column of ["karaoke_ticket_id", "staff_profile_id", "staff_role_assignment_id"])
        await expectRejected(
          KARAOKE_CHECKINS,
          { ...seed.checkin(ticketId), [column]: undefined },
          "23502",
          column,
          `Check-in without ${column}`,
        );
      const checkinId = await insertRow(KARAOKE_CHECKINS, seed.checkin(ticketId));
      const txNow = (await admin.query("SELECT transaction_timestamp() AS now")).rows[0]
        .now as Date;
      const times = (
        await admin.query(
          `SELECT h.hold_acquired_at, h.created_at AS h_created, h.updated_at AS h_updated,
                  r.confirmed_at, r.created_at AS r_created, r.updated_at AS r_updated,
                  t.issued_at, t.state_changed_at, k.checked_in_at, k.created_at AS k_created
             FROM app.karaoke_holds h, app.karaoke_reservations r, app.karaoke_tickets t, app.karaoke_checkins k
            WHERE h.id = $1 AND r.id = $2 AND t.id = $3 AND k.id = $4`,
          [holdId, reservationId, ticketId, checkinId],
        )
      ).rows[0];
      for (const [column, value] of Object.entries(times))
        expect((value as Date).getTime(), column).toBe(txNow.getTime());
    });
  });
});

// ---- TC-DB-KRK-006-001 --------------------------------------------------------------------------

describe("TC-DB-KRK-006-001 the Hold expiry is fixed at acquisition + 45 minutes as a generated column (SPEC-100 section 30, UCR-100-006, real PostgreSQL 17)", () => {
  it("TC-DB-KRK-006-001 hold_expires_at equals hold_acquired_at + 45 minutes to the microsecond under any session TimeZone, including across a DST change", async () => {
    await withSeed(async (seed) => {
      const acquired = [
        "2030-01-01T03:00:00.123456Z",
        // America/New_York moves to daylight saving time at 2030-03-10T07:00:00Z.
        "2030-03-10T06:30:00.000001Z",
        // Europe/Berlin returns to standard time at 2030-10-27T01:00:00Z.
        "2030-10-27T00:59:59.999999Z",
      ];
      for (const zone of ["UTC", "Asia/Tokyo", "America/New_York", "Europe/Berlin"]) {
        await admin.query(`SET LOCAL TimeZone = '${zone}'`);
        for (const at of acquired) {
          // EXPIRED, so the Holds of one Slot never meet ux_karaoke_holds_slot_active.
          const id = await seed.newHold(await seed.chain(), {
            state: "EXPIRED",
            hold_acquired_at: at,
          });
          const row = (
            await admin.query(
              `SELECT extract(epoch FROM hold_expires_at - hold_acquired_at) AS seconds,
                      hold_expires_at = hold_acquired_at + interval '45 minutes' AS exact,
                      to_char(hold_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS utc
                 FROM app.karaoke_holds WHERE id = $1`,
              [id],
            )
          ).rows[0];
          expect([Number(row.seconds), row.exact], `${zone} ${at}`).toEqual([2700, true]);
          const expected = new Date(Date.parse(at) + 45 * 60_000)
            .toISOString()
            .replace(/\.\d+Z$/, "");
          expect(row.utc.startsWith(expected), `${zone} ${at}: ${row.utc}`).toBe(true);
          expect(row.utc.slice(-6), `${zone} ${at} microseconds`).toBe(at.slice(20, 26));
        }
      }
      await admin.query("SET LOCAL TimeZone = 'UTC'");
      // The default acquisition time is the transaction's, so the expiry is transaction_timestamp() + 45 minutes.
      const id = await seed.newHold(await seed.chain());
      const row = (
        await admin.query(
          `SELECT hold_acquired_at = transaction_timestamp() AS acquired_now,
                  hold_expires_at = transaction_timestamp() + interval '45 minutes' AS expires
             FROM app.karaoke_holds WHERE id = $1`,
          [id],
        )
      ).rows[0];
      expect([row.acquired_now, row.expires]).toEqual([true, true]);
    });
  });

  it("TC-DB-KRK-006-001 hold_expires_at cannot be written (428C9) and follows an UPDATE of hold_acquired_at", async () => {
    await withSeed(async (seed) => {
      expect(
        (await tryInsert(KARAOKE_HOLDS, seed.hold(await seed.chain(), { hold_expires_at: AT })))
          ?.code,
        "explicit expiry",
      ).toBe("428C9");
      const id = await seed.newHold(await seed.chain());
      expect(
        (await attempt("UPDATE app.karaoke_holds SET hold_expires_at = $2 WHERE id = $1", [id, AT]))
          ?.code,
        "UPDATE expiry",
      ).toBe("428C9");
      await admin.query(
        "UPDATE app.karaoke_holds SET hold_acquired_at = '2030-02-01T10:00:00Z' WHERE id = $1",
        [id],
      );
      const row = (
        await admin.query("SELECT hold_expires_at FROM app.karaoke_holds WHERE id = $1", [id])
      ).rows[0];
      expect((row.hold_expires_at as Date).toISOString()).toBe("2030-02-01T10:45:00.000Z");
    });
  });
});

// ---- TC-DB-KRK-007-001 / 002 --------------------------------------------------------------------

describe("TC-DB-KRK-007-001 at most one ACTIVE Hold per Slot (ux_karaoke_holds_slot_active, real PostgreSQL 17)", () => {
  it("TC-DB-KRK-007-001 a second ACTIVE Hold of the same Slot is refused by name; Holds in the other three states are not limited", async () => {
    await withSeed(async (seed) => {
      await seed.newHold(await seed.chain());
      expectViolation(
        await tryInsert(KARAOKE_HOLDS, seed.hold(await seed.chain())),
        "23505",
        ACTIVE_HOLD_INDEX,
        "second ACTIVE Hold of the Slot",
      );
      for (const state of ["COMMITTED", "RELEASED", "EXPIRED"] as const)
        for (let i = 0; i < 2; i++)
          expect(
            await tryInsert(KARAOKE_HOLDS, seed.hold(await seed.chain(), { state })),
            `${state} Hold ${i + 1} beside the ACTIVE one`,
          ).toBeUndefined();
      // Another Slot is independent.
      expect(
        await tryInsert(KARAOKE_HOLDS, seed.hold(await seed.chain({ slot: seed.otherSlot }))),
      ).toBeUndefined();
      expect(await countRows(KARAOKE_HOLDS, "slot_id = $1", [seed.slot])).toBe(7);
    });
  });

  it("TC-DB-KRK-007-001 releasing the ACTIVE Hold makes room for a new one; turning a Hold back to ACTIVE beside another is refused", async () => {
    await withSeed(async (seed) => {
      const first = await seed.newHold(await seed.chain());
      await admin.query(
        "UPDATE app.karaoke_holds SET state = 'RELEASED', released_at = $2 WHERE id = $1",
        [first, AT],
      );
      await seed.newHold(await seed.chain());
      expectViolation(
        await attempt(
          "UPDATE app.karaoke_holds SET state = 'ACTIVE', released_at = NULL WHERE id = $1",
          [first],
        ),
        "23505",
        ACTIVE_HOLD_INDEX,
        "RELEASED -> ACTIVE beside an ACTIVE Hold",
      );
      expect(await countRows(KARAOKE_HOLDS, "slot_id = $1 AND state = 'ACTIVE'", [seed.slot])).toBe(
        1,
      );
    });
  });
});

describe("TC-DB-KRK-007-002 a Hold belongs to one Karaoke Order Item and repeats its Order, Purpose, Slot and Customer (real PostgreSQL 17)", () => {
  it("TC-DB-KRK-007-002 one Hold per Order Item: a retry of the same item is refused with uq_karaoke_holds_order_item_id in any state", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      await seed.newHold(c, { state: "RELEASED" });
      for (const state of KARAOKE_HOLD_STATES)
        await expectRejected(
          KARAOKE_HOLDS,
          seed.hold(c, { state }),
          "23505",
          "uq_karaoke_holds_order_item_id",
          `second ${state} Hold of the item`,
        );
    });
  });

  it("TC-DB-KRK-007-002 a Hold whose Order, Slot or Purpose differs from its item's is refused with 23503 fk_karaoke_holds_order_item", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      const other = await seed.chain();
      const entryOrder = await insertRow("orders", {
        purchase_cause_key: uuid(),
        customer_profile_id: seed.profile,
        purpose: "ENTRY_TICKET_PURCHASE",
        state: "PREPARED",
        currency: "JPY",
        total_amount: 1000,
      });
      const entryItem = await insertRow("order_items", {
        order_id: entryOrder,
        purpose: "ENTRY_TICKET_PURCHASE",
        line_no: 1,
        quantity: 1,
        unit_amount: 1000,
        currency: "JPY",
        item_name_snapshot: "合成入場券",
        entry_offering_id: seed.entryOffering,
      });
      const cases: [string, Row][] = [
        ["another Slot than the item's", { slot_id: seed.otherSlot }],
        ["another Order of the same Customer", { order_id: other.order }],
        ["an absent item", { order_item_id: ABSENT_ID }],
        ["an Entry Ticket item", { order_id: entryOrder, order_item_id: entryItem }],
      ];
      for (const [label, override] of cases)
        await expectRejected(
          KARAOKE_HOLDS,
          seed.hold(c, override),
          "23503",
          "fk_karaoke_holds_order_item",
          label,
        );
    });
  });

  it("TC-DB-KRK-007-002 a Hold whose Customer is not its Order's is refused with 23503 fk_karaoke_holds_order", async () => {
    await withSeed(async (seed) => {
      await expectRejected(
        KARAOKE_HOLDS,
        seed.hold(await seed.chain(), { customer_profile_id: seed.otherProfile }),
        "23503",
        "fk_karaoke_holds_order",
        "Customer differs from the Order's",
      );
      await expectRejected(
        KARAOKE_HOLDS,
        seed.hold(await seed.chain(), { customer_profile_id: ABSENT_ID }),
        "23503",
        "fk_karaoke_holds_order",
        "absent Customer",
      );
      // The Hold of another Customer's item, with that Customer, is accepted.
      await expectAccepted(
        KARAOKE_HOLDS,
        seed.hold(await seed.chain({ customer: seed.otherProfile, slot: seed.otherSlot })),
        "Hold of the other Customer's own item",
      );
    });
  });
});

// ---- TC-CON-001-004 -----------------------------------------------------------------------------

describe("TC-CON-001-004 two connections cannot both hold one Slot ACTIVE (ux_karaoke_holds_slot_active, real PostgreSQL 17)", () => {
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

  async function race(outcomeOfX: "COMMIT" | "ROLLBACK", rowX: Row, rowY: Row) {
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
      await x.query(...insertStatement(KARAOKE_HOLDS, rowX));
      await y.query("SET statement_timeout = '10s'");
      await y.query("BEGIN");
      const yPid = (await y.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const second = y.query(...insertStatement(KARAOKE_HOLDS, rowY)).then(
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
  async function withCommittedItems<T>(run: (seed: Seed, a: Chain, b: Chain) => Promise<T>) {
    const seed = factories(await insertParents());
    try {
      return await run(seed, await seed.chain(), await seed.chain());
    } finally {
      for (const table of [
        KARAOKE_HOLDS,
        "order_items",
        "orders",
        "karaoke_slots",
        "karaoke_exclusive_scopes",
        "karaoke_sales_configurations",
        "entry_ticket_offerings",
        "events",
        "role_assignments",
        "business_profiles",
      ])
        await admin.query(`DELETE FROM app.${table}`);
    }
  }

  for (const outcome of ["COMMIT", "ROLLBACK"] as const) {
    it(
      `TC-CON-001-004 ACTIVE Hold: Y waits for X and is ${outcome === "COMMIT" ? "refused with 23505 ux_karaoke_holds_slot_active" : "accepted"} after X ${outcome}`,
      async () => {
        await withCommittedItems(async (seed, a, b) => {
          const failure = await race(outcome, seed.hold(a), seed.hold(b));
          if (outcome === "COMMIT") {
            expectViolation(failure, "23505", ACTIVE_HOLD_INDEX, "Y after X COMMIT");
            expect(await countRows(KARAOKE_HOLDS, "slot_id = $1", [seed.slot])).toBe(1);
          } else {
            expect(failure, "Y after X ROLLBACK").toBeUndefined();
            expect(await countRows(KARAOKE_HOLDS, "slot_id = $1", [seed.slot])).toBe(0);
          }
        });
        await expectNothingCommitted();
      },
      RACE_CASE_TIMEOUT_MS,
    );
  }
});

// ---- TC-DB-KRK-011-001 ... 015-001 --------------------------------------------------------------

describe("TC-DB-KRK-011-001 at most one Reservation per Order Item, Slot and Hold, correlated with its Hold by a composite foreign key (real PostgreSQL 17)", () => {
  it("TC-DB-KRK-011-001 each composite foreign key is backed by the composite UNIQUE named for it (plan U-1)", async () => {
    const rows = (
      await admin.query(
        `SELECT c.conname, x.relname AS target
           FROM pg_constraint c JOIN pg_class x ON x.oid = c.conindid
          WHERE c.contype = 'f' AND c.conname = ANY($1) ORDER BY c.conname`,
        [
          [
            "fk_karaoke_holds_order",
            "fk_karaoke_holds_order_item",
            "fk_karaoke_reservations_hold",
            "fk_karaoke_tickets_reservation",
          ],
        ],
      )
    ).rows;
    expect(rows.map((r) => [r.conname, r.target])).toEqual([
      ["fk_karaoke_holds_order", "uq_orders_id_customer_profile_id"],
      ["fk_karaoke_holds_order_item", "uq_order_items_id_order_id_purpose_karaoke_slot_id"],
      ["fk_karaoke_reservations_hold", HOLD_RESERVATION_TARGET],
      ["fk_karaoke_tickets_reservation", "uq_karaoke_reservations_id_customer_profile_id"],
    ]);
  });

  it("TC-DB-KRK-011-001 a second Reservation of the same item, Slot or Hold is refused by the matching UNIQUE", async () => {
    await withSeed(async (seed) => {
      const r = await seed.newReservation();
      const again = (o: Row) => seed.reservation(r, r.hold, o);
      // Same Hold, item and Slot: the three UNIQUEs all apply; one of them reports first.
      const error = await tryInsert(KARAOKE_RESERVATIONS, again({}));
      expect(error?.code, "duplicate of the whole correlation").toBe("23505");
      expect([
        "uq_karaoke_reservations_order_item_id",
        "uq_karaoke_reservations_slot_id",
        "uq_karaoke_reservations_hold_id",
      ]).toContain(error?.constraint);
      // A second chain on the same Slot isolates uq_karaoke_reservations_slot_id.
      const c = await seed.chain();
      const holdId = await seed.newHold(c, { state: "COMMITTED" });
      await expectRejected(
        KARAOKE_RESERVATIONS,
        seed.reservation(c, holdId),
        "23505",
        "uq_karaoke_reservations_slot_id",
        "second Reservation of the Slot",
      );
      // On another Slot, the same chain is accepted (one Reservation per Slot, not per Scope).
      const d = await seed.chain({ slot: seed.otherSlot });
      await expectAccepted(
        KARAOKE_RESERVATIONS,
        seed.reservation(d, await seed.newHold(d, { state: "COMMITTED" })),
        "Reservation of another Slot",
      );
    });
  });

  it("TC-DB-KRK-011-001 the Reservation's Order, item, Customer and Slot must be its Hold's: any difference is refused with 23503 fk_karaoke_reservations_hold", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      const holdId = await seed.newHold(c, { state: "COMMITTED" });
      const other = await seed.chain({ slot: seed.otherSlot });
      const cases: [string, Row][] = [
        [
          "another Customer (SPEC-100 section 67 item 28)",
          { customer_profile_id: seed.otherProfile },
        ],
        ["another Slot", { slot_id: seed.otherSlot }],
        ["another Order", { order_id: other.order }],
        ["another item", { order_item_id: other.item }],
        ["an absent Hold", { hold_id: ABSENT_ID }],
      ];
      for (const [label, override] of cases)
        await expectRejected(
          KARAOKE_RESERVATIONS,
          seed.reservation(c, holdId, override),
          "23503",
          "fk_karaoke_reservations_hold",
          label,
        );
      await expectAccepted(
        KARAOKE_RESERVATIONS,
        seed.reservation(c, holdId),
        "the Hold's own chain",
      );
    });
  });
});

describe("TC-DB-KRK-012-001 a Reservation is CONFIRMED or CANCELED only, never USED, with canceled_at following the state (real PostgreSQL 17)", () => {
  it("TC-DB-KRK-012-001 USED and other states are refused; CONFIRMED forbids canceled_at, CANCELED requires it; the snapshot interval is ordered", async () => {
    await withSeed(async (seed) => {
      const c = await seed.chain();
      const holdId = await seed.newHold(c, { state: "COMMITTED" });
      for (const state of ["USED", "EXPIRED", "VALID"])
        await expectRejected(
          KARAOKE_RESERVATIONS,
          seed.reservation(c, holdId, { state }),
          "23514",
          "ck_karaoke_reservations_state",
          `Reservation ${state}`,
        );
      await expectRejected(
        KARAOKE_RESERVATIONS,
        seed.reservation(c, holdId, { canceled_at: AT }),
        "23514",
        "ck_karaoke_reservations_canceled_at",
        "CONFIRMED with canceled_at",
      );
      await expectRejected(
        KARAOKE_RESERVATIONS,
        seed.reservation(c, holdId, { state: "CANCELED" }),
        "23514",
        "ck_karaoke_reservations_canceled_at",
        "CANCELED without canceled_at",
      );
      for (const [label, end] of [
        ["equal", USAGE_START],
        ["reversed", "2030-01-01T04:59:59Z"],
      ])
        await expectRejected(
          KARAOKE_RESERVATIONS,
          seed.reservation(c, holdId, { usage_end_snapshot: end }),
          "23514",
          "ck_karaoke_reservations_usage_snapshot",
          `${label} snapshot interval`,
        );
      // CONFIRMED -> CANCELED must set canceled_at in the same statement.
      const id = await insertRow(KARAOKE_RESERVATIONS, seed.reservation(c, holdId));
      expectViolation(
        await attempt("UPDATE app.karaoke_reservations SET state = 'CANCELED' WHERE id = $1", [id]),
        "23514",
        "ck_karaoke_reservations_canceled_at",
        "CONFIRMED -> CANCELED without canceled_at",
      );
      expect(
        await attempt(
          "UPDATE app.karaoke_reservations SET state = 'CANCELED', canceled_at = $2 WHERE id = $1",
          [id, AT],
        ),
      ).toBeUndefined();
    });
  });
});

describe("TC-DB-KRK-013-001 a canceled Reservation keeps its row, and its Slot, Hold and item are not reused or removed (real PostgreSQL 17)", () => {
  it("TC-DB-KRK-013-001 after cancellation no new Reservation of the same item, Slot or Hold is accepted, and the history cannot be deleted", async () => {
    await withSeed(async (seed) => {
      const r = await seed.newReservation();
      await admin.query(
        "UPDATE app.karaoke_reservations SET state = 'CANCELED', canceled_at = $2 WHERE id = $1",
        [r.reservation, AT],
      );
      // The UNIQUEs have no predicate: a CANCELED Reservation still occupies its Slot, Hold and item.
      const c = await seed.chain();
      await expectRejected(
        KARAOKE_RESERVATIONS,
        seed.reservation(c, await seed.newHold(c, { state: "COMMITTED" })),
        "23505",
        "uq_karaoke_reservations_slot_id",
        "new Reservation of the canceled Reservation's Slot",
      );
      const error = await tryInsert(KARAOKE_RESERVATIONS, seed.reservation(r, r.hold));
      expect(error?.code, "new Reservation of the canceled Hold").toBe("23505");
      const before = await Promise.all(
        [...KARAOKE_RESERVATION_TABLES, "order_items", "karaoke_slots"].map((t) => countRows(t)),
      );
      const cases: [string, string, string, string][] = [
        [
          "Hold with a Reservation",
          "DELETE FROM app.karaoke_holds WHERE id = $1",
          r.hold,
          "fk_karaoke_reservations_hold",
        ],
        [
          "item with a Hold",
          "DELETE FROM app.order_items WHERE id = $1",
          r.item,
          "fk_karaoke_holds_order_item",
        ],
        [
          "Slot with an item",
          "DELETE FROM app.karaoke_slots WHERE id = $1",
          seed.slot,
          "fk_order_items_karaoke_slot",
        ],
      ];
      for (const [label, statement, id, name] of cases)
        expectViolation(await attempt(statement, [id]), "23503", name, label);
      expect(
        await Promise.all(
          [...KARAOKE_RESERVATION_TABLES, "order_items", "karaoke_slots"].map((t) => countRows(t)),
        ),
      ).toEqual(before);
      expect(
        (
          await admin.query("SELECT state FROM app.karaoke_reservations WHERE id = $1", [
            r.reservation,
          ])
        ).rows[0].state,
      ).toBe("CANCELED");
    });
  });
});

describe("TC-DB-KRK-014-001 at most one Karaoke Ticket per Reservation (uq_karaoke_tickets_reservation_id, real PostgreSQL 17)", () => {
  it("TC-DB-KRK-014-001 a second Ticket of the same Reservation is refused by name in any state; another Reservation's Ticket is accepted", async () => {
    await withSeed(async (seed) => {
      const t = await seed.newTicket();
      for (const state of KARAOKE_TICKET_STATES)
        await expectRejected(
          KARAOKE_TICKETS,
          seed.ticket(t.reservation, t.customer, { state }),
          "23505",
          "uq_karaoke_tickets_reservation_id",
          `second ${state} Ticket`,
        );
      const other = await seed.newReservation({ slot: seed.otherSlot });
      await expectAccepted(
        KARAOKE_TICKETS,
        seed.ticket(other.reservation, other.customer),
        "Ticket of another Reservation",
      );
    });
  });
});

describe("TC-DB-KRK-015-001 the Karaoke Ticket owner is the Reservation's Customer (composite foreign key, real PostgreSQL 17)", () => {
  it("TC-DB-KRK-015-001 a Ticket owned by another Profile, or of an absent Reservation, is refused with 23503 fk_karaoke_tickets_reservation", async () => {
    await withSeed(async (seed) => {
      const r = await seed.newReservation();
      for (const [label, row] of [
        ["another Profile", seed.ticket(r.reservation, seed.otherProfile)],
        ["the staff Profile", seed.ticket(r.reservation, seed.staff)],
        ["an absent Reservation", seed.ticket(ABSENT_ID, r.customer)],
      ] as const)
        await expectRejected(
          KARAOKE_TICKETS,
          row,
          "23503",
          "fk_karaoke_tickets_reservation",
          label,
        );
      const ticketId = await insertRow(KARAOKE_TICKETS, seed.ticket(r.reservation, r.customer));
      expectViolation(
        await attempt("UPDATE app.karaoke_tickets SET owner_profile_id = $2 WHERE id = $1", [
          ticketId,
          seed.otherProfile,
        ]),
        "23503",
        "fk_karaoke_tickets_reservation",
        "owner changed to another Profile",
      );
    });
  });
});

describe("TC-INV-010-05-001 at most one Karaoke Check-in per Ticket, by a Staff Profile and Role Assignment that exist (real PostgreSQL 17)", () => {
  it("TC-INV-010-05-001 a second Check-in of the same Ticket is refused with 23505 uq_karaoke_checkins_karaoke_ticket_id", async () => {
    await withSeed(async (seed) => {
      const t = await seed.newTicket();
      await insertRow(KARAOKE_CHECKINS, seed.checkin(t.ticket));
      const secondStaff = await insertRow("business_profiles", { auth_subject: uuid() });
      const secondRole = await insertRow("role_assignments", {
        profile_id: secondStaff,
        role: "STAFF",
        state: "ACTIVE",
      });
      for (const [label, row] of [
        ["same Staff", seed.checkin(t.ticket)],
        [
          "another Staff",
          seed.checkin(t.ticket, {
            staff_profile_id: secondStaff,
            staff_role_assignment_id: secondRole,
          }),
        ],
      ] as const)
        await expectRejected(
          KARAOKE_CHECKINS,
          row,
          "23505",
          "uq_karaoke_checkins_karaoke_ticket_id",
          label,
        );
      expect(await countRows(KARAOKE_CHECKINS, "karaoke_ticket_id = $1", [t.ticket])).toBe(1);
    });
  });

  it("TC-INV-010-05-001 an absent Ticket, Staff Profile or Role Assignment is refused with 23503 by name", async () => {
    await withSeed(async (seed) => {
      const t = await seed.newTicket();
      for (const [label, override, name] of [
        ["absent Ticket", { karaoke_ticket_id: ABSENT_ID }, "fk_karaoke_checkins_karaoke_ticket"],
        ["absent Staff", { staff_profile_id: ABSENT_ID }, "fk_karaoke_checkins_staff_profile"],
        [
          "absent Role Assignment",
          { staff_role_assignment_id: ABSENT_ID },
          "fk_karaoke_checkins_staff_role_assignment",
        ],
      ] as const)
        await expectRejected(
          KARAOKE_CHECKINS,
          seed.checkin(t.ticket, override),
          "23503",
          name,
          label,
        );
    });
  });
});

// ---- TC-DB-FK-002-004 ---------------------------------------------------------------------------

describe("TC-DB-FK-002-004 the Karaoke reservation foreign keys restrict deletes and never cascade (real PostgreSQL 17)", () => {
  it("TC-DB-FK-002-004 all seven foreign keys are ON DELETE RESTRICT and ON UPDATE NO ACTION", async () => {
    const rows = (
      await admin.query(
        `SELECT conname, confdeltype, confupdtype FROM pg_constraint
          WHERE contype = 'f' AND conrelid = ANY($1::regclass[]) ORDER BY conname`,
        [KARAOKE_RESERVATION_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    const expected = GOLDEN_TABLES.flatMap((g) => g.foreignKeys.map((f) => f.name)).sort();
    expect(expected).toHaveLength(7);
    expect(rows.map((r) => [r.conname, r.confdeltype, r.confupdtype])).toEqual(
      expected.map((name) => [name, "r", "a"]),
    );
  });

  it("TC-DB-FK-002-004 deleting a parent that has Hold, Reservation, Ticket or Check-in history is refused with 23503 by name, and nothing is lost", async () => {
    await withSeed(async (seed) => {
      const t = await seed.newTicket();
      await insertRow(KARAOKE_CHECKINS, seed.checkin(t.ticket));
      const lonely = await seed.chain({ slot: seed.otherSlot });
      await seed.newHold(lonely);
      const before = await Promise.all(KARAOKE_RESERVATION_TABLES.map((tb) => countRows(tb)));
      const cases: [string, string, string, string][] = [
        [
          "Ticket with a Check-in",
          "DELETE FROM app.karaoke_tickets WHERE id = $1",
          t.ticket,
          "fk_karaoke_checkins_karaoke_ticket",
        ],
        [
          "Reservation with a Ticket",
          "DELETE FROM app.karaoke_reservations WHERE id = $1",
          t.reservation,
          "fk_karaoke_tickets_reservation",
        ],
        [
          "Hold with a Reservation",
          "DELETE FROM app.karaoke_holds WHERE id = $1",
          t.hold,
          "fk_karaoke_reservations_hold",
        ],
        [
          "item with only a Hold",
          "DELETE FROM app.order_items WHERE id = $1",
          lonely.item,
          "fk_karaoke_holds_order_item",
        ],
        [
          "Role Assignment of a Check-in",
          "DELETE FROM app.role_assignments WHERE id = $1",
          seed.staffRole,
          "fk_karaoke_checkins_staff_role_assignment",
        ],
      ];
      for (const [label, statement, id, name] of cases)
        expectViolation(await attempt(statement, [id]), "23503", name, label);
      // Several foreign keys refer to the deleted row in these cases. Which one reports first follows the order
      // of their RI triggers and is not a contract, so any of the names is accepted; the delete is refused.
      const doubles: [string, string, string, string[]][] = [
        [
          "Order with an item and a Hold",
          "DELETE FROM app.orders WHERE id = $1",
          lonely.order,
          ["fk_order_items_order", "fk_karaoke_holds_order"],
        ],
        [
          "Staff Profile with a Role Assignment and a Check-in",
          "DELETE FROM app.business_profiles WHERE id = $1",
          seed.staff,
          ["fk_role_assignments_profile", "fk_karaoke_checkins_staff_profile"],
        ],
      ];
      for (const [label, statement, id, names] of doubles) {
        const error = await attempt(statement, [id]);
        expect(error?.code, `${label}: SQLSTATE`).toBe("23503");
        expect(names, `${label}: ${error?.constraint}`).toContain(error?.constraint);
      }
      expect(await Promise.all(KARAOKE_RESERVATION_TABLES.map((tb) => countRows(tb)))).toEqual(
        before,
      );
    });
  });
});

// ---- TC-SEC-DB-001-004 --------------------------------------------------------------------------

describe("TC-SEC-DB-001-004 no runtime role has any privilege on the four Karaoke reservation tables yet (plan U-4, real PostgreSQL 17)", () => {
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

  it("TC-SEC-DB-001-004 has_table_privilege is false for every privilege of the four runtime roles and PUBLIC on all four tables", async () => {
    for (const table of KARAOKE_RESERVATION_TABLES) {
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

  it("TC-SEC-DB-001-004 the table ACLs name only app_migrator, no column has an ACL, and no role may use the four identity sequences", async () => {
    const withAcl = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS column_name
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL`,
        [[...KARAOKE_RESERVATION_TABLES]],
      )
    ).rows;
    expect(withAcl).toEqual([]);
    for (const table of KARAOKE_RESERVATION_TABLES) {
      const grantees = (
        await admin.query(
          `SELECT DISTINCT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee
             FROM pg_class c, aclexplode(c.relacl) e WHERE c.oid = $1::regclass`,
          [`app.${table}`],
        )
      ).rows.map((r) => r.grantee);
      expect(grantees, table).toEqual(["app_migrator"]);
    }
    for (const sequence of KARAOKE_RESERVATION_SEQUENCES)
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

  it("TC-SEC-DB-001-004 the three runtime pools are refused SELECT, INSERT, UPDATE, DELETE and TRUNCATE on all four tables with 42501", async () => {
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
