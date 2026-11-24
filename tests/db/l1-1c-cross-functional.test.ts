import { readFile } from "node:fs/promises";
import {
  type NotificationEnqueueInput,
  notificationBusinessCauseKey,
} from "@off-r39x/application/notification";
import type { ReviewCaseOpenInput } from "@off-r39x/application/review-case";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../../packages/db/src/index.ts";
import { migrationIdentities } from "../../packages/db/src/migrations.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import {
  AUTH_REASON,
  CONSISTENCY_REVIEW_CASES,
  CROSS_FUNCTIONAL_SEQUENCES,
  CROSS_FUNCTIONAL_TABLES,
  GOLDEN_TABLES,
  NOTIFICATION_PENDING_INDEX,
  NOTIFICATION_REQUEST_STATES,
  NOTIFICATION_REQUESTS,
  REVIEW_TARGETS,
  REVIEW_UNRESOLVED_INDEX,
  SEPARATE_INDEX_NAMES,
  SPEC_COLUMN_COUNTS,
  SPEC_CONSTRAINT_COUNTS,
  SPEC_INDEX_COUNTS,
} from "../harness/db/cross-functional-golden.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";

// PR-L1-1c C1: the two cross-functional tables of migration 0010 (app.notification_requests and
// app.consistency_review_cases) and the two repository functions that write them on the caller's transaction
// (enqueueNotificationRequest, openConsistencyReviewCase) on a real PostgreSQL 17 (SPEC-100 §42, §43, §45.6, §11,
// §12, §46-§48; SPEC-120 §8.1-§8.3; SPEC-150 §43, §44, REL-AUTH-009, REL-REC-016; UCR-100-004; SPEC-170 §22-§24,
// TST-DB-001, TST-DB-004, TST-CON-001). Constraints, identity, foreign keys, concurrency and privileges are never
// proven by a fake (TST-GEN-004, DEV-TST-003). The catalog goldens come from tests/harness/db/cross-functional-
// golden.ts, written by hand from SPEC-100 and the approved plan (U-3, U-6), never derived from schema-contract.json
// or from the migration. Every violating row breaks exactly one constraint unless the case says otherwise, and every
// assertion checks the SQLSTATE and the constraint (or column) name together. The functions are read through a
// string-keyed record so that this file type-checks before they exist (C1 is committed as a failing test). All data
// is synthetic: no real Email address, person or Auth Subject.

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const L1C_VERSION = "0010_cross_functional";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// An id no identity sequence of this test database reaches.
const ABSENT_ID = "9223372036854775807";
const SALES_START = "2030-01-01T00:00:00Z";
const SALES_END = "2030-01-02T00:00:00Z";
const AT = "2030-01-01T03:00:00Z";
const USAGE_START = "2030-01-01T05:00:00Z";
const USAGE_END = "2030-01-01T05:15:00Z";
const TSTZ = "timestamp with time zone";
/** The existing tables 0010 refers to (REFERENCES targets only). */
const PARENT_TABLES = ["business_profiles", ...REVIEW_TARGETS.map(([, parent]) => parent)].sort();

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

type Enqueue = (tx: unknown, input: NotificationEnqueueInput) => Promise<Record<string, unknown>>;
type Open = (tx: unknown, input: ReviewCaseOpenInput) => Promise<Record<string, unknown>>;
let enqueue: Enqueue;
let openCase: Open;

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
  const db = (await import("../../packages/db/src/index.ts")) as unknown as Record<string, unknown>;
  enqueue = db.enqueueNotificationRequest as Enqueue;
  openCase = db.openConsistencyReviewCase as Open;
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

// Like attempt, but a successful statement is undone too, so one-per-key UNIQUEs never interfere with the next
// probe.
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

// Table and column names come from fixed test literals; every value is a bind parameter. An undefined value omits
// the column so that its DEFAULT or NOT NULL behaviour is exercised.
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

// Several foreign keys refer to the same deleted row in these cases. Which one reports first follows the order of
// their RI triggers and is not a contract, so any of the names is accepted; the statement is refused either way.
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
  for (const table of [...CROSS_FUNCTIONAL_TABLES, "orders", "business_profiles"]) {
    expect(await countRows(table), `${table} rows`).toBe(0);
  }
}

// ---- synthetic row factories (valid by default; overrides break one rule at a time) --------------

let counter = 0;
const next = () => ++counter;
const uuid = () => `00000000-0000-4000-8000-${(0xc10000 + next()).toString(16).padStart(12, "0")}`;
/** A synthetic Auth Subject of another UUID version, as Neon Auth may issue (canonical lowercase). */
const authSubject = () =>
  `0190a5f2-7c3e-7000-8000-${(0xc1a000 + next()).toString(16).padStart(12, "0")}`;

/** The target rows of a Case and the sources of a Notification Request, one of each kind. */
interface Seed {
  profile: string;
  otherProfile: string;
  order: string;
  orderRef: string;
  otherOrder: string;
  checkoutAttempt: string;
  paymentBinding: string;
  refundRecord: string;
  karaokeSlot: string;
  karaokeHold: string;
  karaokeReservation: string;
  reservationRef: string;
  otherReservation: string;
  entryTicket: string;
  karaokeTicket: string;
  goodsOrderItem: string;
  /** Target column -> the id of an existing parent row. */
  targets: Record<string, string>;
}

async function insertSeed(): Promise<Seed> {
  const profile = await insertRow("business_profiles", { auth_subject: uuid() });
  const otherProfile = await insertRow("business_profiles", { auth_subject: uuid() });
  const staff = await insertRow("business_profiles", { auth_subject: uuid() });
  const event = await insertRow("events", { name: "合成イベント" });
  const sales = {
    event_id: event,
    currency: "JPY",
    sales_starts_at: SALES_START,
    sales_ends_at: SALES_END,
  };
  const offering = await insertRow("entry_ticket_offerings", {
    ...sales,
    name: "合成入場券",
    unit_amount: 1000,
    sale_control_state: "ENABLED",
    sales_capacity: 100,
    purchase_limit: 4,
  });
  const goods = await insertRow("goods", {
    ...sales,
    name: "合成グッズ",
    unit_amount: 2000,
    sale_control_state: "SUSPENDED",
    purchase_limit: 3,
  });
  const karaokeConfig = await insertRow("karaoke_sales_configurations", {
    ...sales,
    name: "合成カラオケ",
    unit_amount: 500,
    sale_control_state: "ENABLED",
    purchase_limit: 2,
  });
  const scope = await insertRow("karaoke_exclusive_scopes", { event_id: event, name: "合成" });
  const slot = (start: string, end: string, cycleEnd: string, candidate: number) =>
    insertRow("karaoke_slots", {
      exclusive_scope_id: scope,
      sales_configuration_id: karaokeConfig,
      state: "AVAILABLE",
      usage_start: start,
      usage_end: end,
      cycle_end: cycleEnd,
      generation_cause_key: uuid(),
      generation_candidate_no: candidate,
    });
  const order = async (purpose: string, total: number) => {
    const id = await insertRow("orders", {
      purchase_cause_key: uuid(),
      customer_profile_id: profile,
      purpose,
      state: "PREPARED",
      currency: "JPY",
      total_amount: total,
    });
    const ref = (await admin.query("SELECT public_ref FROM app.orders WHERE id = $1", [id])).rows[0]
      .public_ref as string;
    return { id, ref };
  };
  const item = (orderId: string, purpose: string, line: number, source: Row) =>
    insertRow("order_items", {
      order_id: orderId,
      purpose,
      line_no: line,
      quantity: 1,
      unit_amount: 1000,
      currency: "JPY",
      item_name_snapshot: "合成明細",
      ...source,
    });

  // An Entry + Goods Order: an Entry Ticket and a Goods Order Item.
  const composite = await order("ENTRY_GOODS_PURCHASE", 3000);
  const entryItem = await item(composite.id, "ENTRY_GOODS_PURCHASE", 1, {
    entry_offering_id: offering,
  });
  await insertRow("entry_sales_allocations", {
    order_item_id: entryItem,
    order_id: composite.id,
    purpose: "ENTRY_GOODS_PURCHASE",
    offering_id: offering,
    quantity: 1,
    state: "COMMITTED",
    committed_at: AT,
  });
  const entryTicket = await insertRow("entry_tickets", {
    order_id: composite.id,
    order_item_id: entryItem,
    order_purpose: "ENTRY_GOODS_PURCHASE",
    owner_profile_id: profile,
    issuance_ordinal: 1,
    state: "VALID",
  });
  const goodsItem = await item(composite.id, "ENTRY_GOODS_PURCHASE", 2, { goods_id: goods });
  const goodsOrderItem = await insertRow(
    "goods_order_items",
    {
      order_item_id: goodsItem,
      order_id: composite.id,
      order_purpose: "ENTRY_GOODS_PURCHASE",
      customer_profile_id: profile,
      goods_id: goods,
      state: "PENDING_PAYMENT",
    },
    "order_item_id",
  );
  const checkoutAttempt = await insertRow("checkout_attempts", {
    order_id: composite.id,
    attempt_no: 1,
    stripe_idempotency_key: `synthetic-idem-l1c-${next()}`,
    creation_result: "SUCCEEDED",
  });
  const paymentBinding = await insertRow("payment_bindings", {
    order_id: composite.id,
    checkout_attempt_id: checkoutAttempt,
    stripe_checkout_session_id: `cs_test_synthetic_l1c_${next()}`,
    checkout_session_created_at: AT,
    amount_total: 3000,
    currency: "JPY",
  });
  const refundRecord = await insertRow("refund_records", {
    order_id: composite.id,
    business_cause_key: uuid(),
    stripe_idempotency_key: `synthetic-refund-l1c-${next()}`,
    state: "REQUESTED",
    requested_amount: 3000,
    currency: "JPY",
    is_full_refund: true,
    requested_by_profile_id: staff,
  });

  // Two Karaoke Orders, each with a committed Hold and a confirmed Reservation; the first has a Ticket.
  const reservation = async (slotId: string) => {
    const karaoke = await order("KARAOKE_PURCHASE", 500);
    const line = await item(karaoke.id, "KARAOKE_PURCHASE", 1, { karaoke_slot_id: slotId });
    const chain = { order_id: karaoke.id, order_item_id: line, customer_profile_id: profile };
    const hold = await insertRow("karaoke_holds", {
      ...chain,
      slot_id: slotId,
      state: "COMMITTED",
      committed_at: AT,
    });
    const id = await insertRow("karaoke_reservations", {
      ...chain,
      hold_id: hold,
      slot_id: slotId,
      state: "CONFIRMED",
      usage_start_snapshot: USAGE_START,
      usage_end_snapshot: USAGE_END,
    });
    const ref = (
      await admin.query("SELECT public_ref FROM app.karaoke_reservations WHERE id = $1", [id])
    ).rows[0].public_ref as string;
    return { hold, id, ref };
  };
  const karaokeSlot = await slot(USAGE_START, USAGE_END, "2030-01-01T05:20:00Z", 0);
  const otherSlot = await slot(
    "2030-01-01T05:20:00Z",
    "2030-01-01T05:35:00Z",
    "2030-01-01T05:40:00Z",
    1,
  );
  const first = await reservation(karaokeSlot);
  const second = await reservation(otherSlot);
  const karaokeTicket = await insertRow("karaoke_tickets", {
    reservation_id: first.id,
    owner_profile_id: profile,
    state: "VALID",
    expires_at: USAGE_END,
  });
  const otherOrder = await order("ENTRY_TICKET_PURCHASE", 1000);

  const targets: Record<string, string> = {
    order_id: composite.id,
    checkout_attempt_id: checkoutAttempt,
    payment_binding_id: paymentBinding,
    refund_record_id: refundRecord,
    karaoke_slot_id: karaokeSlot,
    karaoke_hold_id: first.hold,
    karaoke_reservation_id: first.id,
    entry_ticket_id: entryTicket,
    karaoke_ticket_id: karaokeTicket,
    goods_order_item_id: goodsOrderItem,
  };
  return {
    profile,
    otherProfile,
    order: composite.id,
    orderRef: composite.ref,
    otherOrder: otherOrder.id,
    checkoutAttempt,
    paymentBinding,
    refundRecord,
    karaokeSlot,
    karaokeHold: first.hold,
    karaokeReservation: first.id,
    reservationRef: first.ref,
    otherReservation: second.id,
    entryTicket,
    karaokeTicket,
    goodsOrderItem,
    targets,
  };
}

// The seed and the scenario's rows, inside a transaction that the scenario rolls back.
async function withSeed<T>(run: (seed: Seed) => Promise<T>): Promise<T> {
  const result = await inRolledBackTransaction(async () => run(await insertSeed()));
  await expectNothingCommitted();
  return result;
}

const nearMisses = (value: string) => [value.toLowerCase(), ` ${value}`, `${value} `, `${value}_X`];

/** A raw Notification Request row (valid by default). */
const notificationRow = (seed: Seed, o: Row = {}): Row => ({
  business_cause_key: uuid(),
  notification_type: "ENTRY_PURCHASE_CONFIRMED",
  recipient_profile_id: seed.profile,
  source_order_id: seed.order,
  state: "PENDING",
  ...o,
});

/** A raw Case row on one target (valid by default). */
const caseRow = (seed: Seed, o: Row = {}): Row => ({
  dedupe_key: `r150:PAY_BINDING_INCONSISTENT:synthetic:${uuid()}:synthetic`,
  reason_code: "PAY_BINDING_INCONSISTENT",
  payment_binding_id: seed.paymentBinding,
  ...o,
});
const authCaseRow = (o: Row = {}): Row => ({
  dedupe_key: `r150:${AUTH_REASON}:auth_subject:${uuid()}:epoch-1`,
  reason_code: AUTH_REASON,
  auth_subject: authSubject(),
  ...o,
});

/** A valid ENTRY_PURCHASE_CONFIRMED enqueue input for the seed's composite Order (S0-5 port shape). */
function entryInput(
  seed: Seed,
  o: Partial<Record<string, unknown>> = {},
): NotificationEnqueueInput {
  return {
    notificationType: "ENTRY_PURCHASE_CONFIRMED",
    recipientProfileId: BigInt(seed.profile),
    sourceOrderId: BigInt(seed.order),
    sourceReservationId: null,
    renderContext: {
      event_name: "合成イベント",
      order_ref: seed.orderRef,
      confirmed_at: "2030-01-01T03:00:00.000Z",
      total: { amount: "1000", currency: "JPY" },
      entry_items: [{ offering_name: "合成入場券", quantity: 1 }],
    },
    ...o,
  } as NotificationEnqueueInput;
}

/** A valid KARAOKE_RESERVATION_CANCELED input: the Reservation is the source and the Order may be absent. */
function canceledInput(seed: Seed): NotificationEnqueueInput {
  return {
    notificationType: "KARAOKE_RESERVATION_CANCELED",
    recipientProfileId: BigInt(seed.profile),
    sourceOrderId: null,
    sourceReservationId: BigInt(seed.karaokeReservation),
    renderContext: {
      event_name: "合成イベント",
      reservation_ref: seed.reservationRef,
      canceled_at: "2030-01-01T04:00:00.000Z",
      usage_start: "2030-01-01T05:00:00.000Z",
      usage_end: "2030-01-01T05:15:00.000Z",
      cancellation_reason_label: null,
    },
  } as NotificationEnqueueInput;
}

const authInput = (subject: string, epoch = 1) =>
  ({ reasonCode: AUTH_REASON, authSubject: subject, epoch }) as unknown as ReviewCaseOpenInput;
const dedupeOf = (subject: string, epoch = 1) =>
  `r150:${AUTH_REASON}:auth_subject:${subject}:epoch-${epoch}`;

async function notificationRows(key: string): Promise<Row[]> {
  return (
    await admin.query(
      `SELECT notification_type, recipient_profile_id::text, source_order_id::text, source_reservation_id::text,
              state, render_context, created_at, updated_at, sent_at
         FROM app.notification_requests WHERE business_cause_key = $1`,
      [key],
    )
  ).rows;
}

// ---- TC-DB-ARC-007-016 --------------------------------------------------------------------------

describe("TC-DB-ARC-007-016 migration 0010 and the catalog of the two cross-functional tables (real PostgreSQL 17)", () => {
  it("TC-DB-ARC-007-016 the journal lists every migration once with its source hash, 0010 among them, and a second run changes nothing", async () => {
    const identities = await migrationIdentities();
    const read = async () =>
      (await admin.query("SELECT version, source_hash FROM app.schema_migrations ORDER BY version"))
        .rows;
    const before = await read();
    // The pins up to 0008 are those of the earlier PRs; 0009 is the release of PR-L1-1b (#97).
    const pinned09 = [
      "0009_entry_ticket_qr_checkin",
      "3e6e498abfc92f9b538979f90f18ee0d2b3d8365f802bca539254ea103fea00d",
    ];
    expect(before.map((row) => row.version)).toContain(L1C_VERSION);
    expect(new Set(before.map((row) => row.version)).size).toBe(before.length);
    expect(before.map((row) => [row.version, row.source_hash])).toEqual(
      identities.map((identity) => [identity.version, identity.hash]),
    );
    // Pinned from the committed history: an applied migration is never edited (DB-MIG-003).
    expect([before[8]?.version, before[8]?.source_hash]).toEqual(pinned09);
    expect(before[9]?.version).toBe(L1C_VERSION);

    await admin.query("SET ROLE app_migrator");
    try {
      await runMigrations(admin);
    } finally {
      await admin.query("RESET ROLE");
    }
    expect(await read()).toEqual(before);
  });

  it("TC-DB-ARC-007-016 0010 only creates the two tables, the two section 43 / 45.6 indexes and revokes; it alters, grants and drops nothing", async () => {
    const identities = await migrationIdentities();
    const l1c = identities.find((i) => i.name === `${L1C_VERSION}.sql`);
    expect(l1c, `${L1C_VERSION}.sql exists`).toBeDefined();
    const sqlText = (l1c?.sql ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const referenced = [...new Set([...sqlText.matchAll(/\bapp\.([a-z_]+)/g)].map((m) => m[1]))];
    expect(referenced.sort()).toEqual([...CROSS_FUNCTIONAL_TABLES, ...PARENT_TABLES].sort());
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
      expect(sqlText, `0010 must not contain ${forbidden}`).not.toMatch(forbidden);
    }
    expect([...sqlText.matchAll(/\bCREATE\s+TABLE\s+app\.([a-z_]+)/gi)].map((m) => m[1])).toEqual([
      ...CROSS_FUNCTIONAL_TABLES,
    ]);
    expect(
      [...sqlText.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+([a-z_]+)/gi)].map((m) => m[1]).sort(),
    ).toEqual(SEPARATE_INDEX_NAMES);
    // The only predicates are those of the two partial indexes.
    expect([...sqlText.matchAll(/\bWHERE\b/gi)]).toHaveLength(2);
    expect([...sqlText.matchAll(/\bREVOKE\s+ALL\b/gi)]).toHaveLength(1);
  });

  it("TC-DB-ARC-007-016 the hand-written goldens have the SPEC-100 sizes (30 columns, 22 constraints, 7 indexes) and every name fits 63 bytes", () => {
    expect(GOLDEN_TABLES.map((g) => g.table)).toEqual([...CROSS_FUNCTIONAL_TABLES]);
    expect(GOLDEN_TABLES.map((g) => g.columns.length)).toEqual(SPEC_COLUMN_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.constraints.length)).toEqual(SPEC_CONSTRAINT_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.indexes.length)).toEqual(SPEC_INDEX_COUNTS);
    expect(SPEC_COLUMN_COUNTS.reduce((a, b) => a + b)).toBe(30);
    expect(SPEC_CONSTRAINT_COUNTS.reduce((a, b) => a + b)).toBe(22);
    expect(SPEC_INDEX_COUNTS.reduce((a, b) => a + b)).toBe(7);
    for (const golden of GOLDEN_TABLES)
      for (const name of [...golden.constraints, ...golden.indexes].map((x) => x.name))
        expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
  });

  it("TC-DB-ARC-007-016 columns of the two tables equal the goldens in attnum order", async () => {
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

  it("TC-DB-ARC-007-016 constraints equal the goldens by name, kind and definition, all validated and not deferrable", async () => {
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

  it("TC-DB-ARC-007-016 exactly 7 valid indexes equal the goldens; auth_subject has no index (DB-XFN-004)", async () => {
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
    expect(total).toBe(7);
    const onAuthSubject = (
      await admin.query(
        `SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = $1::regclass AND a.attname = 'auth_subject'`,
        [`app.${CONSISTENCY_REVIEW_CASES}`],
      )
    ).rowCount;
    expect(onAuthSubject).toBe(0);
  });

  it("TC-DB-ARC-007-016 owner is app_migrator, row level security is off, there are two bigint identity sequences and every time column is timestamptz", async () => {
    const tables = (
      await admin.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity, c.relforcerowsecurity, c.relkind
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) ORDER BY c.relname`,
        [[...CROSS_FUNCTIONAL_TABLES]],
      )
    ).rows;
    expect(tables.map((t) => t.relname)).toEqual([...CROSS_FUNCTIONAL_TABLES].sort());
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
        [CROSS_FUNCTIONAL_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    expect(sequences.map((s) => [s.relname, s.type, s.owner])).toEqual(
      [...CROSS_FUNCTIONAL_SEQUENCES].sort().map((name) => [name, "bigint", "app_migrator"]),
    );
    const timeColumns = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname LIKE '%\\_at' OR format_type(a.atttypid, a.atttypmod) LIKE 'timestamp%')`,
        [[...CROSS_FUNCTIONAL_TABLES]],
      )
    ).rows;
    // 3 + 2 time columns (SPEC-100 §42, §43).
    expect(timeColumns.length).toBe(5);
    for (const column of timeColumns) expect(column.type, column.name).toBe(TSTZ);
  });

  it("TC-DB-ARC-007-016 the live catalog equals requiredCatalog, checked directly and not through readiness", async () => {
    const live = (await admin.query(catalogQuery)).rows[0].catalog;
    expect(live).toEqual(requiredCatalog);
    const liveTables = live.tables.map((row: unknown[]) => row[0]);
    for (const table of CROSS_FUNCTIONAL_TABLES) expect(liveTables).toContain(table);
    const liveConstraints = live.constraints.map((row: unknown[]) => row[1]);
    for (const golden of GOLDEN_TABLES)
      for (const c of golden.constraints) expect(liveConstraints).toContain(c.name);
  });

  it("TC-DB-ARC-007-016 a duplicate id given with OVERRIDING SYSTEM VALUE is refused with 23505 pk_* on both tables; ids are GENERATED ALWAYS", async () => {
    await withSeed(async (seed) => {
      const notification = await insertRow(NOTIFICATION_REQUESTS, notificationRow(seed));
      const reviewCase = await insertRow(CONSISTENCY_REVIEW_CASES, caseRow(seed));
      expectViolation(
        await tryInsertWithId(NOTIFICATION_REQUESTS, notification, notificationRow(seed)),
        "23505",
        "pk_notification_requests",
        "duplicate Notification Request id",
      );
      expectViolation(
        await tryInsertWithId(CONSISTENCY_REVIEW_CASES, reviewCase, caseRow(seed)),
        "23505",
        "pk_consistency_review_cases",
        "duplicate Case id",
      );
      for (const table of CROSS_FUNCTIONAL_TABLES) {
        expect(
          (await attempt(`INSERT INTO app.${table}(id) VALUES ($1)`, [ABSENT_ID]))?.code,
          `${table} explicit id`,
        ).toBe("428C9");
      }
    });
  });

  it("TC-DB-ARC-007-016 defaults: the Case public_ref is a database generated v4 UUID unique by name, jsonb columns default to {}, and the time columns default to the transaction's transaction_timestamp()", async () => {
    await withSeed(async (seed) => {
      const started = (await admin.query("SELECT transaction_timestamp() AS t")).rows[0].t;
      const notification = (
        await admin.query(
          ...insertStatement(
            NOTIFICATION_REQUESTS,
            notificationRow(seed),
            "render_context, created_at, updated_at, sent_at",
          ),
        )
      ).rows[0];
      expect(notification.render_context).toEqual({});
      expect(notification.sent_at).toBeNull();
      const reviewCase = (
        await admin.query(
          ...insertStatement(
            CONSISTENCY_REVIEW_CASES,
            caseRow(seed),
            "public_ref, details, opened_at, resolved_at, resolution_note",
          ),
        )
      ).rows[0];
      expect(reviewCase.public_ref).toMatch(UUID_V4);
      expect(reviewCase.details).toEqual({});
      expect([reviewCase.resolved_at, reviewCase.resolution_note]).toEqual([null, null]);
      for (const time of [notification.created_at, notification.updated_at, reviewCase.opened_at])
        expect(time).toEqual(started);
      await expectRejected(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { public_ref: reviewCase.public_ref }),
        "23505",
        "uq_consistency_review_cases_public_ref",
        "duplicate Case public_ref",
      );
    });
  });
});

// ---- TC-DB-STA-002-007 --------------------------------------------------------------------------

describe("TC-DB-STA-002-007 the Notification Request state keeps the four SPEC-030 names exactly; the type and reason have no CHECK (plan U-3, real PostgreSQL 17)", () => {
  it("TC-DB-STA-002-007 the 4 states are accepted; near misses and Email processing states are refused by ck_notification_requests_state; state has no default", async () => {
    await withSeed(async (seed) => {
      for (const state of NOTIFICATION_REQUEST_STATES)
        await expectAccepted(NOTIFICATION_REQUESTS, notificationRow(seed, { state }), state);
      // EML-DB-001: no Job processing state (SPEC-120 §39) is a Notification state.
      for (const state of [
        ...NOTIFICATION_REQUEST_STATES.flatMap(nearMisses),
        "READY",
        "CLAIMED",
        "UNKNOWN_RESULT",
        "BLOCKED",
        "CLOSED",
        "FAILED",
        "",
      ])
        await expectRejected(
          NOTIFICATION_REQUESTS,
          notificationRow(seed, { state }),
          "23514",
          "ck_notification_requests_state",
          `state ${JSON.stringify(state)}`,
        );
      await expectRejected(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, { state: undefined }),
        "23502",
        "state",
        "state omitted",
      );
    });
  });

  it("TC-DB-STA-002-007 notification_type and reason_code are NOT NULL text without an allowlist CHECK (plan U-3: the port closes them)", async () => {
    await withSeed(async (seed) => {
      await expectAccepted(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, { notification_type: "SYNTHETIC_FUTURE_TYPE" }),
        "unlisted notification_type",
      );
      await expectAccepted(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { reason_code: "SYNTHETIC_FUTURE_REASON" }),
        "unlisted reason_code",
      );
      await expectRejected(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, { notification_type: undefined }),
        "23502",
        "notification_type",
        "notification_type omitted",
      );
      await expectRejected(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { reason_code: undefined }),
        "23502",
        "reason_code",
        "reason_code omitted",
      );
    });
  });
});

// ---- TC-DB-XFN-001-001 --------------------------------------------------------------------------

describe("TC-DB-XFN-001-001 one Notification Request per Business Cause, from an existing recipient and source (SPEC-100 §42, real PostgreSQL 17)", () => {
  it("TC-DB-XFN-001-001 a second row of the same business_cause_key is refused by uq_notification_requests_business_cause_key in any state", async () => {
    await withSeed(async (seed) => {
      const key = uuid();
      await insertRow(NOTIFICATION_REQUESTS, notificationRow(seed, { business_cause_key: key }));
      for (const state of NOTIFICATION_REQUEST_STATES)
        await expectRejected(
          NOTIFICATION_REQUESTS,
          notificationRow(seed, {
            business_cause_key: key,
            state,
            recipient_profile_id: seed.otherProfile,
          }),
          "23505",
          "uq_notification_requests_business_cause_key",
          `same key, ${state}`,
        );
    });
  });

  it("TC-DB-XFN-001-001 a source Order or Reservation is required (ck_notification_requests_source); either or both are accepted", async () => {
    await withSeed(async (seed) => {
      await expectAccepted(NOTIFICATION_REQUESTS, notificationRow(seed), "Order only");
      await expectAccepted(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, {
          source_order_id: undefined,
          source_reservation_id: seed.karaokeReservation,
        }),
        "Reservation only",
      );
      await expectAccepted(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, { source_reservation_id: seed.karaokeReservation }),
        "both",
      );
      await expectRejected(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, { source_order_id: undefined }),
        "23514",
        "ck_notification_requests_source",
        "neither",
      );
    });
  });

  it("TC-DB-XFN-001-001 the recipient and the sources must exist; the key, the recipient and render_context are NOT NULL", async () => {
    await withSeed(async (seed) => {
      for (const [column, name] of [
        ["recipient_profile_id", "fk_notification_requests_recipient_profile"],
        ["source_order_id", "fk_notification_requests_source_order"],
        ["source_reservation_id", "fk_notification_requests_source_reservation"],
      ] as const)
        await expectRejected(
          NOTIFICATION_REQUESTS,
          notificationRow(seed, { [column]: ABSENT_ID }),
          "23503",
          name,
          `absent ${column}`,
        );
      for (const column of ["business_cause_key", "recipient_profile_id"])
        await expectRejected(
          NOTIFICATION_REQUESTS,
          notificationRow(seed, { [column]: undefined }),
          "23502",
          column,
          `${column} omitted`,
        );
      await expectRejected(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, { render_context: null }),
        "23502",
        "render_context",
        "render_context NULL",
      );
    });
  });
});

// ---- TC-DB-XFN-001-002 --------------------------------------------------------------------------

describe("TC-DB-XFN-001-002 enqueueNotificationRequest converges on the Business Cause row and never re-runs the source (DB-XFN-001, EML-GEN-003, real PostgreSQL 17)", () => {
  it("TC-DB-XFN-001-002 a new cause is created PENDING with the derived key; the same input again is existing and leaves the row, its times and the Order as they were", async () => {
    await withSeed(async (seed) => {
      const input = entryInput(seed);
      const key = notificationBusinessCauseKey(input);
      expect(await enqueue(admin, input)).toEqual({ status: "created", businessCauseKey: key });
      const [row] = await notificationRows(key);
      expect(row).toMatchObject({
        notification_type: "ENTRY_PURCHASE_CONFIRMED",
        recipient_profile_id: seed.profile,
        source_order_id: seed.order,
        source_reservation_id: null,
        state: "PENDING",
        render_context: input.renderContext,
        sent_at: null,
      });
      const order = async () =>
        (
          await admin.query("SELECT to_jsonb(o) AS row FROM app.orders o WHERE id = $1", [
            seed.order,
          ])
        ).rows[0].row;
      const orderBefore = await order();
      const before = await notificationRows(key);
      expect(await enqueue(admin, input)).toEqual({ status: "existing", businessCauseKey: key });
      expect(await notificationRows(key)).toEqual(before);
      expect(await order()).toEqual(orderBefore);
      expect(await countRows(NOTIFICATION_REQUESTS)).toBe(1);
    });
  });

  it("TC-DB-XFN-001-002 a SENT, FAILED_RETRYABLE or CANCELED row is existing and keeps its state (no resend, SPEC-120 §8.3)", async () => {
    await withSeed(async (seed) => {
      const input = entryInput(seed);
      const key = notificationBusinessCauseKey(input);
      await enqueue(admin, input);
      for (const state of ["SENT", "FAILED_RETRYABLE", "CANCELED"]) {
        await admin.query(
          "UPDATE app.notification_requests SET state = $2, sent_at = CASE WHEN $2 = 'SENT' THEN $3::timestamptz END WHERE business_cause_key = $1",
          [key, state, AT],
        );
        expect(await enqueue(admin, input), state).toEqual({
          status: "existing",
          businessCauseKey: key,
        });
        expect((await notificationRows(key))[0]?.state, state).toBe(state);
      }
    });
  });

  it("TC-DB-XFN-001-002 a Reservation cause without an Order is created with source_order_id NULL", async () => {
    await withSeed(async (seed) => {
      const input = canceledInput(seed);
      const key = notificationBusinessCauseKey(input);
      expect(await enqueue(admin, input)).toEqual({ status: "created", businessCauseKey: key });
      expect((await notificationRows(key))[0]).toMatchObject({
        source_order_id: null,
        source_reservation_id: seed.karaokeReservation,
        notification_type: "KARAOKE_RESERVATION_CANCELED",
      });
    });
  });

  it("TC-DB-XFN-001-002 a recipient or source that does not exist is refused by the foreign key, and the caller's transaction sees the error", async () => {
    await withSeed(async (seed) => {
      await admin.query("SAVEPOINT absent");
      const error = await enqueue(
        admin,
        entryInput(seed, { recipientProfileId: BigInt(ABSENT_ID) }),
      ).then(
        () => undefined,
        (e: unknown) => e as PgError,
      );
      await admin.query("ROLLBACK TO SAVEPOINT absent");
      expectViolation(
        error,
        "23503",
        "fk_notification_requests_recipient_profile",
        "absent recipient",
      );
      expect(await countRows(NOTIFICATION_REQUESTS)).toBe(0);
    });
  });
});

// ---- TC-EML-GEN-004-001 -------------------------------------------------------------------------

describe("TC-EML-GEN-004-001 the same Business Cause with different content is conflict, never a second row or an overwrite (SPEC-120 §8.3, plan U-4, real PostgreSQL 17)", () => {
  it("TC-EML-GEN-004-001 a different recipient, source Order, source Reservation or render context is conflict and the existing row is unchanged", async () => {
    await withSeed(async (seed) => {
      const input = entryInput(seed);
      const key = notificationBusinessCauseKey(input);
      await enqueue(admin, input);
      const before = await notificationRows(key);
      const context = input.renderContext as Record<string, unknown>;
      for (const [label, changed] of [
        ["recipient", entryInput(seed, { recipientProfileId: BigInt(seed.otherProfile) })],
        ["source Order", entryInput(seed, { sourceOrderId: BigInt(seed.otherOrder) })],
        [
          "render context total",
          entryInput(seed, {
            renderContext: { ...context, total: { amount: "1001", currency: "JPY" } },
          }),
        ],
        [
          "render context quantity",
          entryInput(seed, {
            renderContext: {
              ...context,
              entry_items: [{ offering_name: "合成入場券", quantity: 2 }],
            },
          }),
        ],
        [
          "render context event name",
          entryInput(seed, { renderContext: { ...context, event_name: "別の合成イベント" } }),
        ],
      ] as const) {
        expect(notificationBusinessCauseKey(changed), label).toBe(key);
        expect(await enqueue(admin, changed), label).toEqual({
          status: "conflict",
          businessCauseKey: key,
        });
        expect(await notificationRows(key), label).toEqual(before);
      }
      expect(await countRows(NOTIFICATION_REQUESTS)).toBe(1);
    });
  });

  it("TC-EML-GEN-004-001 a different source Reservation, and a row of another type under the same key, are conflict", async () => {
    await withSeed(async (seed) => {
      const input = canceledInput(seed);
      const key = notificationBusinessCauseKey(input);
      await enqueue(admin, input);
      const moved = {
        ...input,
        sourceReservationId: BigInt(seed.otherReservation),
      } as NotificationEnqueueInput;
      expect(await enqueue(admin, moved)).toEqual({ status: "conflict", businessCauseKey: key });
      // A row already holding the key with another type (not reachable through the derivation, which includes the
      // type in the name, but the comparison of §8.3 still covers it).
      const entry = entryInput(seed);
      const entryKey = notificationBusinessCauseKey(entry);
      await insertRow(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, {
          business_cause_key: entryKey,
          notification_type: "GOODS_PURCHASE_CONFIRMED",
          render_context: JSON.stringify(entry.renderContext),
        }),
      );
      expect(await enqueue(admin, entry)).toEqual({
        status: "conflict",
        businessCauseKey: entryKey,
      });
      expect(await countRows(NOTIFICATION_REQUESTS)).toBe(2);
    });
  });

  it("TC-EML-GEN-004-001 the comparison is by JSON value, so the same context with its keys in another order is existing", async () => {
    await withSeed(async (seed) => {
      const input = entryInput(seed);
      const key = notificationBusinessCauseKey(input);
      await enqueue(admin, input);
      const context = input.renderContext as Record<string, unknown>;
      const reordered = Object.fromEntries(Object.entries(context).reverse());
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(context));
      expect(await enqueue(admin, entryInput(seed, { renderContext: reordered }))).toEqual({
        status: "existing",
        businessCauseKey: key,
      });
    });
  });
});

// ---- TC-DB-XFN-002-001 --------------------------------------------------------------------------

describe("TC-DB-XFN-002-001 one Case per dedupe key, on a target or an Auth Subject (SPEC-100 §43, UCR-100-004, real PostgreSQL 17)", () => {
  it("TC-DB-XFN-002-001 a second Case of the same dedupe_key is refused by uq_consistency_review_cases_dedupe_key, resolved or not", async () => {
    await withSeed(async (seed) => {
      const dedupe = `r150:PAY_BINDING_INCONSISTENT:synthetic:${uuid()}:synthetic`;
      await insertRow(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { dedupe_key: dedupe, resolved_at: AT }),
      );
      await expectRejected(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { dedupe_key: dedupe }),
        "23505",
        "uq_consistency_review_cases_dedupe_key",
        "same dedupe key after resolve",
      );
      for (const column of ["dedupe_key", "reason_code"])
        await expectRejected(
          CONSISTENCY_REVIEW_CASES,
          caseRow(seed, { [column]: undefined }),
          "23502",
          column,
          `${column} omitted`,
        );
    });
  });

  it("TC-DB-XFN-002-001 each of the ten targets alone is accepted, several together are accepted, and none is refused by ck_consistency_review_cases_target", async () => {
    await withSeed(async (seed) => {
      const none: Row = { payment_binding_id: undefined };
      for (const [column] of REVIEW_TARGETS)
        await expectAccepted(
          CONSISTENCY_REVIEW_CASES,
          caseRow(seed, { ...none, [column]: seed.targets[column] }),
          `only ${column}`,
        );
      await expectAccepted(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { ...seed.targets }),
        "all ten targets",
      );
      await expectRejected(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, none),
        "23514",
        "ck_consistency_review_cases_target",
        "no target",
      );
    });
  });

  it("TC-DB-XFN-002-001 auth_subject is set exactly for AUTH_PROFILE_RELATION_INCONSISTENT (ck_consistency_review_cases_auth_subject) and alone satisfies the target CHECK", async () => {
    await withSeed(async (seed) => {
      await expectAccepted(CONSISTENCY_REVIEW_CASES, authCaseRow(), "AUTH with auth_subject only");
      // An AUTH Case without auth_subject (with or without a target) is refused.
      await expectRejected(
        CONSISTENCY_REVIEW_CASES,
        authCaseRow({ auth_subject: undefined, order_id: seed.order }),
        "23514",
        "ck_consistency_review_cases_auth_subject",
        "AUTH without auth_subject",
      );
      // Another reason with auth_subject is refused, with or without a target.
      await expectRejected(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { auth_subject: authSubject() }),
        "23514",
        "ck_consistency_review_cases_auth_subject",
        "PAY reason with auth_subject",
      );
      await expectRejected(
        CONSISTENCY_REVIEW_CASES,
        authCaseRow({ reason_code: "EML_RECIPIENT_RELATION_INCONSISTENT" }),
        "23514",
        "ck_consistency_review_cases_auth_subject",
        "EML reason with auth_subject only",
      );
      // An auth_subject is not a foreign key: any UUID is stored.
      await expectAccepted(
        CONSISTENCY_REVIEW_CASES,
        authCaseRow({ auth_subject: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
        "unknown auth_subject",
      );
    });
  });

  it("TC-DB-XFN-002-001 the unresolved partial index keeps exactly the Cases with resolved_at NULL (REL-REC-009)", async () => {
    await withSeed(async (seed) => {
      await insertRow(CONSISTENCY_REVIEW_CASES, caseRow(seed));
      await insertRow(
        CONSISTENCY_REVIEW_CASES,
        caseRow(seed, { resolved_at: AT, resolution_note: "合成" }),
      );
      const predicate = (
        await admin.query(
          "SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate FROM pg_index i WHERE i.indexrelid = $1::regclass",
          [`app.${REVIEW_UNRESOLVED_INDEX}`],
        )
      ).rows[0].predicate;
      expect(predicate).toBe("(resolved_at IS NULL)");
      expect(await countRows(CONSISTENCY_REVIEW_CASES, `(${predicate})`)).toBe(1);
      const pending = (
        await admin.query(
          "SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate FROM pg_index i WHERE i.indexrelid = $1::regclass",
          [`app.${NOTIFICATION_PENDING_INDEX}`],
        )
      ).rows[0].predicate;
      expect(pending).toBe("(state = ANY (ARRAY['PENDING'::text, 'FAILED_RETRYABLE'::text]))");
    });
  });
});

// ---- TC-DB-XFN-002-002 --------------------------------------------------------------------------

describe("TC-DB-XFN-002-002 openConsistencyReviewCase converges on the dedupe key of REL-REC-016 (REL-AUTH-009, real PostgreSQL 17)", () => {
  it("TC-DB-XFN-002-002 a new incident is opened with the REL-REC-016 key, the Auth Subject, empty details and no target; the same incident is existing", async () => {
    await withSeed(async () => {
      const subject = authSubject();
      const opened = await openCase(admin, authInput(subject));
      expect(opened).toMatchObject({ status: "opened", resolved: false });
      expect(opened.caseRef).toMatch(UUID_V4);
      const rows = (
        await admin.query(
          "SELECT to_jsonb(c) - 'id' - 'opened_at' AS row FROM app.consistency_review_cases c",
        )
      ).rows.map((r) => r.row);
      expect(rows).toEqual([
        {
          public_ref: opened.caseRef,
          dedupe_key: dedupeOf(subject),
          reason_code: AUTH_REASON,
          ...Object.fromEntries(REVIEW_TARGETS.map(([column]) => [column, null])),
          auth_subject: subject,
          details: {},
          resolved_at: null,
          resolution_note: null,
        },
      ]);
      expect(await openCase(admin, authInput(subject))).toEqual({
        status: "existing",
        caseRef: opened.caseRef,
        resolved: false,
      });
      expect(await countRows(CONSISTENCY_REVIEW_CASES)).toBe(1);
    });
  });

  it("TC-DB-XFN-002-002 a resolved Case of the same epoch is existing with resolved true; the next epoch opens a new Case (REL-REC-013)", async () => {
    await withSeed(async () => {
      const subject = authSubject();
      const first = await openCase(admin, authInput(subject, 1));
      await admin.query(
        "UPDATE app.consistency_review_cases SET resolved_at = $2, resolution_note = '合成' WHERE public_ref = $1",
        [first.caseRef, AT],
      );
      expect(await openCase(admin, authInput(subject, 1))).toEqual({
        status: "existing",
        caseRef: first.caseRef,
        resolved: true,
      });
      const second = await openCase(admin, authInput(subject, 2));
      expect(second).toMatchObject({ status: "opened", resolved: false });
      expect(second.caseRef).not.toBe(first.caseRef);
      expect(
        (
          await admin.query("SELECT dedupe_key FROM app.consistency_review_cases ORDER BY id")
        ).rows.map((r) => r.dedupe_key),
      ).toEqual([dedupeOf(subject, 1), dedupeOf(subject, 2)]);
      // Another Auth Subject is another incident.
      expect(await openCase(admin, authInput(authSubject(), 1))).toMatchObject({
        status: "opened",
      });
    });
  });
});

// ---- concurrency: TC-DB-XFN-001-003 / TC-DB-XFN-002-003 -------------------------------------------

describe("TC-DB-XFN-001-003 / TC-DB-XFN-002-003 two connections converge on one Notification Request and one Case (TST-CON-001, real PostgreSQL 17)", () => {
  const LOCK_WAIT_DEADLINE_MS = 5_000;
  const RACE_CASE_TIMEOUT_MS = 20_000;

  async function waitUntilBlockedOnLock(pid: number, second: Promise<unknown>) {
    // Barrier: Y's INSERT ... ON CONFLICT waits for X's uncommitted index entry (a Lock wait). Polling a database
    // condition, never a fixed sleep (TST-CON-001); if Y finishes first, fail at once.
    let settled = false;
    void second.finally(() => {
      settled = true;
    });
    const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
    for (;;) {
      if (settled) throw new Error("connection Y finished without waiting on X's lock");
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

  /** X runs `call` and holds its transaction open; Y runs the same call, waits, then X ends with `outcomeOfX`. */
  async function race<T>(
    outcomeOfX: "COMMIT" | "ROLLBACK",
    call: (client: Client) => Promise<T>,
  ): Promise<{ x: T; y: T | PgError }> {
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
      const xResult = await call(x);
      await y.query("SET statement_timeout = '10s'");
      await y.query("BEGIN");
      const yPid = (await y.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const second = call(y).then(
        (value) => value,
        (error: PgError) => error,
      );
      await waitUntilBlockedOnLock(yPid, second);
      await x.query(outcomeOfX);
      const yResult = await second;
      await y.query("COMMIT");
      return { x: xResult, y: yResult };
    } finally {
      await x.end();
      await y.end();
    }
  }

  // Committed fixture rows (removed again by the administrator, children first: fixture cleanup).
  async function withCommittedSeed<T>(run: (seed: Seed) => Promise<T>) {
    const seed = await insertSeed();
    try {
      return await run(seed);
    } finally {
      for (const table of [
        NOTIFICATION_REQUESTS,
        CONSISTENCY_REVIEW_CASES,
        "karaoke_tickets",
        "karaoke_reservations",
        "karaoke_holds",
        "refund_records",
        "payment_bindings",
        "checkout_attempts",
        "goods_order_items",
        "entry_tickets",
        "entry_sales_allocations",
        "order_items",
        "orders",
        "karaoke_slots",
        "karaoke_exclusive_scopes",
        "karaoke_sales_configurations",
        "goods",
        "entry_ticket_offerings",
        "events",
        "business_profiles",
      ])
        await admin.query(`DELETE FROM app.${table}`);
    }
  }

  for (const outcome of ["COMMIT", "ROLLBACK"] as const) {
    it(
      `TC-DB-XFN-001-003 enqueue: Y waits for X and is ${outcome === "COMMIT" ? "existing" : "created"} after X ${outcome}; one row remains`,
      async () => {
        await withCommittedSeed(async (seed) => {
          const input = entryInput(seed);
          const key = notificationBusinessCauseKey(input);
          const { x, y } = await race(outcome, (client) => enqueue(client, input));
          expect(x).toEqual({ status: "created", businessCauseKey: key });
          expect(y).toEqual({
            status: outcome === "COMMIT" ? "existing" : "created",
            businessCauseKey: key,
          });
          expect(await countRows(NOTIFICATION_REQUESTS, "business_cause_key = $1", [key])).toBe(1);
        });
        await expectNothingCommitted();
      },
      RACE_CASE_TIMEOUT_MS,
    );

    it(
      `TC-DB-XFN-002-003 open: Y waits for X and is ${outcome === "COMMIT" ? "existing on X's Case" : "opened"} after X ${outcome}; one Case remains`,
      async () => {
        await withCommittedSeed(async () => {
          const subject = authSubject();
          const { x, y } = await race(outcome, (client) => openCase(client, authInput(subject)));
          expect(x).toMatchObject({ status: "opened", resolved: false });
          if (outcome === "COMMIT")
            expect(y).toEqual({ status: "existing", caseRef: x.caseRef, resolved: false });
          else expect(y).toMatchObject({ status: "opened", resolved: false });
          expect(
            await countRows(CONSISTENCY_REVIEW_CASES, "dedupe_key = $1", [dedupeOf(subject)]),
          ).toBe(1);
        });
        await expectNothingCommitted();
      },
      RACE_CASE_TIMEOUT_MS,
    );
  }
});

// ---- TC-DB-FK-002-007 ---------------------------------------------------------------------------

describe("TC-DB-FK-002-007 the cross-functional foreign keys restrict deletes and never cascade, also for a resolved Case (DB-XFN-003, real PostgreSQL 17)", () => {
  it("TC-DB-FK-002-007 all thirteen foreign keys are ON DELETE RESTRICT and ON UPDATE NO ACTION", async () => {
    const rows = (
      await admin.query(
        `SELECT conname, confdeltype, confupdtype FROM pg_constraint
          WHERE contype = 'f' AND conrelid = ANY($1::regclass[]) ORDER BY conname`,
        [CROSS_FUNCTIONAL_TABLES.map((t) => `app.${t}`)],
      )
    ).rows;
    const expected = GOLDEN_TABLES.flatMap((g) => g.foreignKeys.map((f) => f.name)).sort();
    expect(expected).toHaveLength(13);
    expect(rows.map((r) => [r.conname, r.confdeltype, r.confupdtype])).toEqual(
      expected.map((name) => [name, "r", "a"]),
    );
  });

  it("TC-DB-FK-002-007 deleting a parent of a Notification Request or of a resolved Case is refused with 23503, and nothing is lost", async () => {
    await withSeed(async (seed) => {
      await insertRow(
        NOTIFICATION_REQUESTS,
        notificationRow(seed, {
          recipient_profile_id: seed.otherProfile,
          source_order_id: seed.otherOrder,
          source_reservation_id: seed.otherReservation,
        }),
      );
      // One resolved Case per target, so each target row is held by exactly this table's key.
      for (const [column] of REVIEW_TARGETS)
        await insertRow(
          CONSISTENCY_REVIEW_CASES,
          caseRow(seed, {
            payment_binding_id: undefined,
            [column]: seed.targets[column],
            resolved_at: AT,
            resolution_note: "合成",
          }),
        );
      const counts = () => Promise.all(CROSS_FUNCTIONAL_TABLES.map((t) => countRows(t)));
      const before = await counts();
      // In the seed these five target rows have no child row but the Case, so the refusal must name the Case's key.
      // The other five are also held by their own children (an Order by its items, a Hold by its Reservation, ...),
      // whose RI trigger may report first; they must be refused all the same.
      const heldOnlyByTheCase = new Set([
        "payment_binding_id",
        "refund_record_id",
        "entry_ticket_id",
        "karaoke_ticket_id",
        "goods_order_item_id",
      ]);
      for (const [column, parent, key, , stem] of REVIEW_TARGETS) {
        const error = await attempt(`DELETE FROM app.${parent} WHERE ${key} = $1`, [
          seed.targets[column],
        ]);
        if (heldOnlyByTheCase.has(column))
          expectViolation(
            error,
            "23503",
            `fk_consistency_review_cases_${stem}`,
            `delete ${parent}`,
          );
        else expect(error?.code, `delete ${parent}`).toBe("23503");
      }
      for (const [statement, id, names] of [
        [
          "DELETE FROM app.business_profiles WHERE id = $1",
          seed.otherProfile,
          ["fk_notification_requests_recipient_profile"],
        ],
        [
          "DELETE FROM app.orders WHERE id = $1",
          seed.otherOrder,
          ["fk_notification_requests_source_order"],
        ],
        [
          "DELETE FROM app.karaoke_reservations WHERE id = $1",
          seed.otherReservation,
          ["fk_notification_requests_source_reservation", "fk_karaoke_tickets_reservation"],
        ],
      ] as const)
        expectEitherViolation(await attempt(statement, [id]), [...names], statement);
      expect(await counts()).toEqual(before);
    });
  });
});

// ---- TC-SEC-DB-001-007 --------------------------------------------------------------------------

describe("TC-SEC-DB-001-007 no runtime role has any privilege on the two cross-functional tables (plan U-7, real PostgreSQL 17)", () => {
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

  it("TC-SEC-DB-001-007 has_table_privilege is false for every privilege of the four runtime roles and PUBLIC on both tables", async () => {
    for (const table of CROSS_FUNCTIONAL_TABLES) {
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

  it("TC-SEC-DB-001-007 the table ACLs name only app_migrator, no column has an ACL, and no role may use the two identity sequences", async () => {
    const withAcl = (
      await admin.query(
        `SELECT c.relname || '.' || a.attname AS column_name
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL`,
        [[...CROSS_FUNCTIONAL_TABLES]],
      )
    ).rows;
    expect(withAcl).toEqual([]);
    for (const table of CROSS_FUNCTIONAL_TABLES) {
      const grantees = (
        await admin.query(
          `SELECT DISTINCT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee
             FROM pg_class c, aclexplode(c.relacl) e WHERE c.oid = $1::regclass`,
          [`app.${table}`],
        )
      ).rows.map((r) => r.grantee);
      expect(grantees, table).toEqual(["app_migrator"]);
    }
    for (const sequence of CROSS_FUNCTIONAL_SEQUENCES)
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

  it("TC-SEC-DB-001-007 the three runtime pools are refused SELECT, INSERT, UPDATE, DELETE and TRUNCATE on both tables with 42501", async () => {
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
