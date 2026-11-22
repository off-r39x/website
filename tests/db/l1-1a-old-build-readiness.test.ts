import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LogEvent } from "@off-r39x/observability";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { ORDER_PAYMENT_TABLES } from "../harness/db/orders-payments-golden.ts";

// SPEC-180 INF-HLT-006 (UCR-180-003), PR-L1-1a: the build released before L1-1a bundles 0001-0005 and the
// required catalog without the seven Order / payment tables of 0006. Applying the real 0006 (expand-only: seven
// new tables, their indexes and a REVOKE, nothing changed on an existing table) to its database must leave that
// build Ready. Real PostgreSQL 17 (TST-GEN-004, TST-DB-001).
//
// The old build is reproduced without a production test hook, as in gk-1-old-build-readiness.test.ts: its
// migration set is a temporary copy of the repository migrations before 0006 (readiness runs with that
// directory as cwd), and its required catalog is the fixed fixture fixtures/db/required-catalog-0005.json
// (schema-contract.json as the 0005 release shipped it). The next release applies only the migrations up to
// 0006, from its own temporary copy, so later migrations do not change this scenario. The first test proves
// that the fixture is exactly what a 0001-0005 database has.

const L1A_VERSION = "0006_orders_payments";
const L1A_RELATIONS = new Set<string>([
  ...ORDER_PAYMENT_TABLES,
  ...ORDER_PAYMENT_TABLES.map((table) => `${table}_id_seq`),
]);

vi.mock("../../packages/db/src/schema-contract.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/db/src/schema-contract.ts")>();
  const { readFileSync } = await import("node:fs");
  const { resolve: resolvePath } = await import("node:path");
  // cwd is tests/ (the backend runner), as REPO_MIGRATIONS below assumes.
  const fixture = resolvePath(process.cwd(), "fixtures/db/required-catalog-0005.json");
  return { ...actual, requiredCatalog: JSON.parse(readFileSync(fixture, "utf8")) };
});

const sourceUrl = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!sourceUrl || !caPath)
  throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const REPO_MIGRATIONS = resolve(process.cwd(), "../packages/db/migrations");
const READINESS_OPTIONS = "-c timezone=UTC -c lock_timeout=1000";
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

describe("the build before L1-1a stays Ready after 0006 is applied (real PostgreSQL 17)", () => {
  const name = `r39x_l1a_old_${randomUUID().replaceAll("-", "")}`;
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
    const position = names.indexOf(`${L1A_VERSION}.sql`);
    if (position < 5) throw new Error(`${L1A_VERSION}.sql must follow 0001-0005`);
    const oldNames = names.slice(0, position);
    oldVersions = oldNames.map((file) => file.slice(0, -4));
    const copySet = async (prefix: string, files: readonly string[]) => {
      const root = await mkdtemp(join(tmpdir(), prefix));
      const dir = join(root, "packages/db/migrations");
      await mkdir(dir, { recursive: true });
      for (const file of files) await copyFile(join(REPO_MIGRATIONS, file), join(dir, file));
      return root;
    };
    oldRoot = await copySet("r39x-l1a-old-", oldNames);
    // The next release is the one that brings 0006; nothing after it.
    nextRoot = await copySet("r39x-l1a-next-", names.slice(0, position + 1));
    setup = new Client({ connectionString: url });
    await setup.connect();
    await expectUtcReadCommitted(setup);
    // The database as the old build left it: only the migrations before 0006.
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
    "TC-INF-HLT-006-011 INF-HLT-006 the old build's required catalog is exactly a 0001-0005 database, and that build is Ready on it",
    async () => {
      expect(await journal()).toEqual(oldVersions);
      expect(oldVersions).not.toContain(L1A_VERSION);
      // The fixture has none of the 0006 relations, and the 0001-0005 database matches it exactly.
      const fixtureTuples = Object.values(requiredCatalog as Record<string, unknown[][]>).flat();
      expect(fixtureTuples.length).toBeGreaterThan(0);
      expect(fixtureTuples.filter((tuple) => L1A_RELATIONS.has(String(tuple[0])))).toEqual([]);
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
    "TC-INF-HLT-006-011 INF-HLT-006 INF-RBK-002 after the real 0006 is applied the old build stays Ready for the setup, API and Reconciliation identities",
    async () => {
      // The next release applies 0006 (and nothing after it) with the production runner.
      const migrator = new Client({ connectionString: url });
      await migrator.connect();
      try {
        await migrator.query("SET ROLE app_migrator");
        await expectUtcReadCommitted(migrator);
        await inCwd(nextRoot, () => runMigrations(migrator));
      } finally {
        await migrator.end();
      }
      expect(await journal()).toEqual([...oldVersions, L1A_VERSION]);
      const catalog = await liveCatalog();
      // 0006 really changed the catalog: an exact comparison would make the old build Not Ready;
      // containment holds.
      expect(catalogSatisfies(catalog, requiredCatalog, "exact")).toBe(false);
      expect(catalogSatisfies(catalog, requiredCatalog, "contains")).toBe(true);
      expect(
        (await setup.query("SELECT to_regclass('app.payment_bindings') AS name")).rows[0].name,
      ).toBe("app.payment_bindings");

      const pool = new Pool({ connectionString: url, max: 1, options: READINESS_OPTIONS });
      const events: LogEvent[] = [];
      observeDatabase(pool, { log: (event) => events.push(event) });
      try {
        expect(await oldBuildReadiness(pool)).toEqual({ ready: true, failures: [] });
        expect(failClosed(events)).toEqual([]);
      } finally {
        await pool.end();
      }

      // 0006 grants nothing on the new tables (plan U-4); the old build's runtime-privilege checks
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
