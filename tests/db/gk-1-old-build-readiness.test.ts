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

// SPEC-180 INF-HLT-006 (UCR-180-003), PR #73 review: the build released before GK-1 bundles
// 0001-0003 and the required catalog without the two Karaoke tables of 0004. Applying the real 0004
// (expand-only: two new tables, their indexes and grants, nothing changed on an existing table) to
// its database must leave that build Ready. Real PostgreSQL 17 (TST-GEN-004, TST-DB-001).
//
// The old build is reproduced without a production test hook: its migration set is a temporary copy
// of the repository migrations before 0004 (readiness runs with that directory as cwd, as in
// ops-readiness-compat.test.ts), and its required catalog is this repository's contract without the
// 0004 rows (schema-contract.json gained only those rows in GK-1). The first test proves that this
// catalog is exactly what a 0001-0003 database has, i.e. the catalog the old build shipped.

const GK1_VERSION = "0004_karaoke_scopes_slots";
// vi.mock is hoisted above the module body, so the set it uses is hoisted with it.
const { GK1_RELATIONS } = vi.hoisted(() => ({
  GK1_RELATIONS: new Set([
    "karaoke_exclusive_scopes",
    "karaoke_slots",
    "karaoke_exclusive_scopes_id_seq",
    "karaoke_slots_id_seq",
  ]),
}));

vi.mock("../../packages/db/src/schema-contract.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/db/src/schema-contract.ts")>();
  const withoutGk1 = Object.fromEntries(
    Object.entries(actual.requiredCatalog).map(([key, tuples]) => [
      key,
      (tuples as unknown[][]).filter((tuple) => !GK1_RELATIONS.has(String(tuple[0]))),
    ]),
  );
  return { ...actual, requiredCatalog: withoutGk1 };
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

const failClosed = (events: readonly LogEvent[]) =>
  events.filter((event) => event.event_name === "security.fail_closed.triggered");

describe("the build before GK-1 stays Ready after 0004 is applied (real PostgreSQL 17)", () => {
  const name = `r39x_gk1_old_${randomUUID().replaceAll("-", "")}`;
  let admin: Client;
  let setup: Client;
  let url: string;
  let oldRoot: string;
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
    const position = names.indexOf(`${GK1_VERSION}.sql`);
    if (position < 3) throw new Error(`${GK1_VERSION}.sql must follow 0001-0003`);
    const oldNames = names.slice(0, position);
    oldVersions = oldNames.map((file) => file.slice(0, -4));
    oldRoot = await mkdtemp(join(tmpdir(), "r39x-gk1-old-"));
    const dir = join(oldRoot, "packages/db/migrations");
    await mkdir(dir, { recursive: true });
    for (const file of oldNames) await copyFile(join(REPO_MIGRATIONS, file), join(dir, file));
    setup = new Client({ connectionString: url });
    await setup.connect();
    // The database as the old build left it: only the migrations before 0004.
    await inCwd(oldRoot, () => prepareFoundationDatabase(setup));
    await installSyntheticDirectory(setup);
  }, TIMEOUT);

  afterAll(async () => {
    await setup?.end().catch(() => undefined);
    try {
      await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin?.end();
      if (oldRoot) await rm(oldRoot, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it(
    "TC-INF-HLT-006-010 INF-HLT-006 the old build's required catalog is exactly a 0001-0003 database, and that build is Ready on it",
    async () => {
      expect(await journal()).toEqual(oldVersions);
      expect(oldVersions).not.toContain(GK1_VERSION);
      const current = (
        await vi.importActual<typeof import("../../packages/db/src/schema-contract.ts")>(
          "../../packages/db/src/schema-contract.ts",
        )
      ).requiredCatalog as Record<string, unknown[][]>;
      // The derived catalog drops the GK-1 rows of every key and nothing else.
      const dropped = Object.values(current)
        .flat()
        .filter((tuple) => GK1_RELATIONS.has(String(tuple[0])));
      expect(dropped.length).toBeGreaterThan(0);
      expect(
        Object.values(requiredCatalog as Record<string, unknown[][]>).flat().length +
          dropped.length,
      ).toBe(Object.values(current).flat().length);
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
    "TC-INF-HLT-006-010 INF-HLT-006 INF-RBK-002 after the real 0004 is applied the old build stays Ready for the setup, API and Reconciliation identities",
    async () => {
      // The next release (this repository) applies 0004 with the production runner.
      const migrator = new Client({ connectionString: url });
      await migrator.connect();
      try {
        await migrator.query("SET ROLE app_migrator");
        await runMigrations(migrator);
      } finally {
        await migrator.end();
      }
      expect(await journal()).toEqual([...oldVersions, GK1_VERSION]);
      const catalog = await liveCatalog();
      // 0004 really changed the catalog: an exact comparison (the design before INF-HLT-006, as the
      // review pointed out) would make the old build Not Ready; containment holds.
      expect(catalogSatisfies(catalog, requiredCatalog, "exact")).toBe(false);
      expect(catalogSatisfies(catalog, requiredCatalog, "contains")).toBe(true);
      expect(
        (await setup.query("SELECT to_regclass('app.karaoke_slots') AS name")).rows[0].name,
      ).toBe("app.karaoke_slots");

      const pool = new Pool({ connectionString: url, max: 1, options: READINESS_OPTIONS });
      const events: LogEvent[] = [];
      observeDatabase(pool, { log: (event) => events.push(event) });
      try {
        expect(await oldBuildReadiness(pool)).toEqual({ ready: true, failures: [] });
        expect(failClosed(events)).toEqual([]);
      } finally {
        await pool.end();
      }

      // 0004 grants SELECT on the new tables to app_api_runtime; the old build's runtime-privilege
      // checks (no DELETE, no DDL) must still hold for each runtime identity.
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
