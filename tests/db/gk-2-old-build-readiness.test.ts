import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LogEvent } from "@off-r39x/observability";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INTERVAL_STYLE_OPTION } from "../../packages/db/src/database.ts";
import {
  checkReadiness,
  computeMigrationSetHash,
  createDatabase,
  runMigrations,
} from "../../packages/db/src/index.ts";
import { observeDatabase } from "../../packages/db/src/observability.ts";
import { catalogSatisfies, type ReadinessExpectations } from "../../packages/db/src/readiness.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  KARAOKE_RESERVATION_SEQUENCES,
  KARAOKE_RESERVATION_TABLES,
} from "../harness/db/karaoke-reservations-golden.ts";
import { testSessionOptions } from "../harness/db/session-options.ts";

// SPEC-180 INF-HLT-006 (UCR-180-003), PR-GK-2: the build released before GK-2 bundles 0001-0006 and the
// required catalog without the four Karaoke reservation tables of 0007. Applying the real 0007 (expand-only: four
// new tables, their indexes and a REVOKE, nothing changed on an existing table) to its database must leave that
// build Ready. Real PostgreSQL 17 (TST-GEN-004, TST-DB-001).
//
// The old build is reproduced without a production test hook, as in l1-1a-old-build-readiness.test.ts: its
// migration set is a temporary copy of the repository migrations before 0007 (readiness runs with that
// directory as cwd), and its required catalog is the fixed fixture fixtures/db/required-catalog-0006.json
// (schema-contract.json as the 0006 release shipped it). The next release applies only the migrations up to
// 0007, from its own temporary copy, so later migrations do not change this scenario. The first test proves
// that the fixture is exactly what a 0001-0006 database has.

const GK2_VERSION = "0007_karaoke_reservations";
const GK2_RELATIONS = new Set<string>([
  ...KARAOKE_RESERVATION_TABLES,
  ...KARAOKE_RESERVATION_SEQUENCES,
]);

vi.mock("../../packages/db/src/schema-contract.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/db/src/schema-contract.ts")>();
  const { readFileSync } = await import("node:fs");
  const { resolve: resolvePath } = await import("node:path");
  // cwd is tests/ (the backend runner), as REPO_MIGRATIONS below assumes.
  const fixture = resolvePath(process.cwd(), "fixtures/db/required-catalog-0006.json");
  return { ...actual, requiredCatalog: JSON.parse(readFileSync(fixture, "utf8")) };
});

const sourceUrl = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!sourceUrl || !caPath)
  throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const REPO_MIGRATIONS = resolve(process.cwd(), "../packages/db/migrations");
const READINESS_OPTIONS = testSessionOptions(
  `-c timezone=UTC ${INTERVAL_STYLE_OPTION} -c lock_timeout=1000`,
);
const TIMEOUT = 90_000;

async function inCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(before);
  }
}

function expectations(migrationSetHash: string): ReadinessExpectations {
  return {
    environment: "test",
    environmentMarkerSetting: "r39x.environment",
    migrationSetHash,
    directoryMapping: {
      deploymentConfirmed: true as const,
      providerSchemaVersion: "synthetic-test-v1",
      schema: "synthetic_provider",
      table: "identities",
      subjectColumn: "subject",
      emailColumn: "current_email",
      verifiedColumn: "verified",
    },
  };
}

/** TST-DB-002: setup and migration sessions run in UTC and READ COMMITTED. */
async function expectUtcReadCommitted(client: Client): Promise<void> {
  expect((await client.query("SHOW TimeZone")).rows[0].TimeZone).toBe("UTC");
  expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe(
    "read committed",
  );
}

const failClosed = (events: readonly LogEvent[]) =>
  events.filter((event) => event.event_name === "security.fail_closed.triggered");

describe("the build before GK-2 stays Ready after 0007 is applied (real PostgreSQL 17)", () => {
  const name = `r39x_gk2_old_${randomUUID().replaceAll("-", "")}`;
  let admin: Client;
  let setup: Client;
  let url: string;
  let oldRoot: string;
  let nextRoot: string;
  let oldVersions: string[];

  async function oldBuildReadiness(pool: Pool) {
    const hash = await computeMigrationSetHash(oldRoot);
    return inCwd(oldRoot, () => checkReadiness(pool, expectations(hash)));
  }

  async function liveCatalog(): Promise<unknown> {
    return (await setup.query(catalogQuery)).rows[0].catalog;
  }

  // SPEC-170 §22 item 8: historical rows written under the 0006 schema must survive the forward migration. The
  // rows are synthetic and cover the 0006 business tables a 0007 row will refer to (Order, Karaoke Order Item, the
  // Profiles and the Role Assignment) and the rest of the Order / payment history.
  async function insert(table: string, row: Record<string, unknown>): Promise<string> {
    const columns = Object.keys(row);
    const statement = `INSERT INTO app.${table}(${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`;
    return (await setup.query(statement, Object.values(row))).rows[0].id as string;
  }

  async function writeHistory(): Promise<void> {
    const subject = (n: number) =>
      `00000000-0000-4000-8000-${(0xc20000 + n).toString(16).padStart(12, "0")}`;
    const profile = await insert("business_profiles", { auth_subject: subject(1) });
    const staff = await insert("business_profiles", { auth_subject: subject(2) });
    await insert("role_assignments", { profile_id: staff, role: "STAFF", state: "ACTIVE" });
    const event = await insert("events", { name: "合成イベント" });
    const sales = {
      event_id: event,
      currency: "JPY",
      sales_starts_at: "2030-01-01T00:00:00Z",
      sales_ends_at: "2030-01-02T00:00:00Z",
      sale_control_state: "ENABLED",
    };
    const offering = await insert("entry_ticket_offerings", {
      ...sales,
      name: "合成入場券",
      unit_amount: 1000,
      sales_capacity: 100,
      purchase_limit: 4,
    });
    const config = await insert("karaoke_sales_configurations", {
      ...sales,
      name: "合成カラオケ",
      unit_amount: 500,
      purchase_limit: 2,
    });
    const scope = await insert("karaoke_exclusive_scopes", {
      event_id: event,
      name: "合成スコープ",
    });
    const slot = await insert("karaoke_slots", {
      exclusive_scope_id: scope,
      sales_configuration_id: config,
      state: "HELD",
      usage_start: "2030-01-01T05:00:00Z",
      usage_end: "2030-01-01T05:15:00Z",
      cycle_end: "2030-01-01T05:20:00Z",
      generation_cause_key: subject(3),
      generation_candidate_no: 0,
    });
    const order = (purpose: string, n: number) =>
      insert("orders", {
        purchase_cause_key: subject(n),
        customer_profile_id: profile,
        purpose,
        state: "AWAITING_PAYMENT",
        currency: "JPY",
        total_amount: 500,
      });
    const item = (orderId: string, purpose: string, source: Record<string, unknown>) =>
      insert("order_items", {
        order_id: orderId,
        purpose,
        line_no: 1,
        quantity: 1,
        unit_amount: 500,
        currency: "JPY",
        item_name_snapshot: "合成明細",
        ...source,
      });
    const karaokeOrder = await order("KARAOKE_PURCHASE", 4);
    await item(karaokeOrder, "KARAOKE_PURCHASE", { karaoke_slot_id: slot });
    const entryOrder = await order("ENTRY_TICKET_PURCHASE", 5);
    const entryItem = await item(entryOrder, "ENTRY_TICKET_PURCHASE", {
      entry_offering_id: offering,
    });
    await insert("entry_sales_allocations", {
      order_item_id: entryItem,
      order_id: entryOrder,
      purpose: "ENTRY_TICKET_PURCHASE",
      offering_id: offering,
      quantity: 1,
      state: "HELD",
    });
    const attempt = await insert("checkout_attempts", {
      order_id: karaokeOrder,
      attempt_no: 1,
      stripe_idempotency_key: "synthetic-idem-gk2-old-1",
      creation_result: "SUCCEEDED",
    });
    await insert("payment_bindings", {
      order_id: karaokeOrder,
      checkout_attempt_id: attempt,
      stripe_checkout_session_id: "cs_test_synthetic_gk2_old_1",
      checkout_session_created_at: "2030-01-01T03:00:00.123456Z",
      amount_total: 500,
      currency: "JPY",
    });
    await insert("webhook_receipts", {
      stripe_event_id: "evt_test_synthetic_gk2_old_1",
      event_type: "checkout.session.completed",
      livemode: false,
      processing_state: "PROCESSED",
      payload_sha256: Buffer.alloc(32, 7),
      canonical_snapshot: JSON.stringify({ synthetic: true }),
    });
    await insert("refund_records", {
      order_id: entryOrder,
      business_cause_key: subject(6),
      stripe_idempotency_key: "synthetic-refund-gk2-old-1",
      state: "REQUESTED",
      requested_amount: 500,
      currency: "JPY",
      is_full_refund: true,
      requested_by_profile_id: staff,
    });
  }

  /** Every row of every app table except the journal, as jsonb, in a stable order. */
  async function history(tables: readonly string[]): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    for (const table of tables) {
      result[table] = (
        await setup.query(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM app.${table} t`,
        )
      ).rows[0].rows;
    }
    return result;
  }

  async function appTables(): Promise<string[]> {
    return (
      await setup.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'app' AND tablename <> 'schema_migrations'
          ORDER BY tablename COLLATE "C"`,
      )
    ).rows.map((row) => row.tablename as string);
  }

  async function journal(): Promise<string[]> {
    return (
      await setup.query('SELECT version FROM app.schema_migrations ORDER BY version COLLATE "C"')
    ).rows.map((row) => row.version);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: sourceUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    await admin.query(`ALTER DATABASE "${name}" SET r39x.environment TO 'test'`);
    const scenarioUrl = new URL(sourceUrl as string);
    scenarioUrl.pathname = `/${name}`;
    url = scenarioUrl.href;
    const names = (await readdir(REPO_MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort();
    const position = names.indexOf(`${GK2_VERSION}.sql`);
    if (position < 6) throw new Error(`${GK2_VERSION}.sql must follow 0001-0006`);
    const oldNames = names.slice(0, position);
    oldVersions = oldNames.map((file) => file.slice(0, -4));
    const copySet = async (prefix: string, files: readonly string[]) => {
      const root = await mkdtemp(join(tmpdir(), prefix));
      const dir = join(root, "packages/db/migrations");
      await mkdir(dir, { recursive: true });
      for (const file of files) await copyFile(join(REPO_MIGRATIONS, file), join(dir, file));
      return root;
    };
    oldRoot = await copySet("r39x-gk2-old-", oldNames);
    // The next release is the one that brings 0007; nothing after it.
    nextRoot = await copySet("r39x-gk2-next-", names.slice(0, position + 1));
    setup = new Client({ connectionString: url });
    await setup.connect();
    await expectUtcReadCommitted(setup);
    // The database as the old build left it: only the migrations before 0007.
    await inCwd(oldRoot, () => prepareFoundationDatabase(setup));
    await installSyntheticDirectory(setup);
  }, TIMEOUT);

  afterAll(async () => {
    await setup?.end().catch(() => undefined);
    try {
      await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin?.end();
      for (const root of [oldRoot, nextRoot])
        if (root) await rm(root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it(
    "TC-INF-HLT-006-013 INF-HLT-006 the old build's required catalog is exactly a 0001-0006 database, and that build is Ready on it",
    async () => {
      expect(await journal()).toEqual(oldVersions);
      expect(oldVersions).not.toContain(GK2_VERSION);
      // The fixture has none of the 0007 relations, and the 0001-0006 database matches it exactly.
      const fixtureTuples = Object.values(requiredCatalog as Record<string, unknown[][]>).flat();
      expect(fixtureTuples.length).toBeGreaterThan(0);
      expect(fixtureTuples.filter((tuple) => GK2_RELATIONS.has(String(tuple[0])))).toEqual([]);
      expect(catalogSatisfies(await liveCatalog(), requiredCatalog, "exact")).toBe(true);

      const pool = new Pool({ connectionString: url, max: 1, options: READINESS_OPTIONS });
      const events: LogEvent[] = [];
      observeDatabase(pool, { log: (event) => events.push(event) });
      try {
        expect(await oldBuildReadiness(pool)).toEqual({ ready: true, failures: [] });
        expect(failClosed(events)).toEqual([]);
      } finally {
        await pool.end();
      }
    },
    TIMEOUT,
  );

  it(
    "TC-INF-HLT-006-013 INF-HLT-006 INF-RBK-002 after the real 0007 is applied the 0006 history is kept row for row and the old build stays Ready for the setup, API and Reconciliation identities",
    async () => {
      // SPEC-170 §22 item 8: history written under 0006 (committed before the migration runs).
      await writeHistory();
      const oldTables = await appTables();
      const before = await history(oldTables);
      for (const table of [
        "business_profiles",
        "role_assignments",
        "karaoke_slots",
        "orders",
        "order_items",
        "entry_sales_allocations",
        "checkout_attempts",
        "payment_bindings",
        "webhook_receipts",
        "refund_records",
      ])
        expect(before[table]?.length, `${table} history rows`).toBeGreaterThan(0);

      // The next release applies 0007 (and nothing after it) with the production runner.
      const migrator = new Client({ connectionString: url });
      await migrator.connect();
      try {
        await migrator.query("SET ROLE app_migrator");
        await expectUtcReadCommitted(migrator);
        await inCwd(nextRoot, () => runMigrations(migrator));
      } finally {
        await migrator.end();
      }
      expect(await journal()).toEqual([...oldVersions, GK2_VERSION]);
      // Every pre-existing table keeps exactly its rows, ids and values (generated columns included); the only new
      // tables are the four of 0007, and they are empty (0007 inserts nothing).
      expect(await history(oldTables)).toEqual(before);
      const newTables = (await appTables()).filter((table) => !oldTables.includes(table));
      expect(newTables).toEqual([...KARAOKE_RESERVATION_TABLES].sort());
      for (const rows of Object.values(await history(newTables))) expect(rows).toEqual([]);
      const catalog = await liveCatalog();
      // 0007 really changed the catalog: an exact comparison would make the old build Not Ready;
      // containment holds.
      expect(catalogSatisfies(catalog, requiredCatalog, "exact")).toBe(false);
      expect(catalogSatisfies(catalog, requiredCatalog, "contains")).toBe(true);
      expect(
        (await setup.query("SELECT to_regclass('app.karaoke_tickets') AS name")).rows[0].name,
      ).toBe("app.karaoke_tickets");

      const pool = new Pool({ connectionString: url, max: 1, options: READINESS_OPTIONS });
      const events: LogEvent[] = [];
      observeDatabase(pool, { log: (event) => events.push(event) });
      try {
        expect(await oldBuildReadiness(pool)).toEqual({ ready: true, failures: [] });
        expect(failClosed(events)).toEqual([]);
      } finally {
        await pool.end();
      }

      // 0007 grants nothing on the new tables (plan U-4); the old build's runtime-privilege checks
      // (no DELETE, no DDL) must still hold for each runtime identity.
      const ca = await readFile(caPath as string, "utf8");
      for (const [service, role] of [
        ["api", "app_api_runtime"],
        ["reconciliation-worker", "app_reconciliation_runtime"],
      ] as const) {
        const runtimeUrl = new URL(url);
        runtimeUrl.username = role;
        runtimeUrl.password = "";
        runtimeUrl.search = "";
        const runtimeEvents: LogEvent[] = [];
        const runtime = createDatabase({
          connectionString: runtimeUrl.href,
          environment: "test",
          service,
          ca,
          logger: { log: (event) => runtimeEvents.push(event) },
        });
        try {
          expect(await oldBuildReadiness(runtime.pool), service).toEqual({
            ready: true,
            failures: [],
          });
          expect(failClosed(runtimeEvents), service).toEqual([]);
        } finally {
          await runtime.close();
        }
      }
    },
    TIMEOUT,
  );
});
