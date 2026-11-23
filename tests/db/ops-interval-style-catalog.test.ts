import { readFile } from "node:fs/promises";
import type { LogEvent } from "@off-r39x/observability";
import { Client, type QueryResult } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { INTERVAL_STYLE_OPTION } from "../../packages/db/src/database.ts";
import {
  checkReadiness,
  computeMigrationSetHash,
  createDatabase,
} from "../../packages/db/src/index.ts";
import { catalogSatisfies, type ReadinessExpectations } from "../../packages/db/src/readiness.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";
import { GOLDEN_COLUMNS, GOLDEN_CONSTRAINTS } from "../harness/db/idempotency-golden.ts";
import { PAYMENT_DEADLINE_EXPRESSION } from "../harness/db/orders-payments-golden.ts";
import { testSessionOptions } from "../harness/db/session-options.ts";

// SPEC-180 INF-HLT-006 (Common 7): pg_get_expr and pg_get_constraintdef write interval literals in the
// session IntervalStyle, and the required catalog (schema-contract.json) and the harness goldens record
// the postgres style. A database or role default of another style must not make readiness Not Ready or
// the goldens fail. createDatabase and the harness fix the style with a startup option, which overrides
// both defaults. Real PostgreSQL 17 (TST-GEN-004, TST-DB-001).
//
// Each case first proves the default is in effect: a session without the option (explicit options, so
// the harness PGOPTIONS does not apply) sees the other style and a catalog that differs from the
// required one. Then the harness session and the three runtime pools see the postgres style, the
// required catalog exactly and the goldens, and readiness is Ready with no fail-closed event.
// Migrations run in a session that starts in sql_standard (which also changes how signed interval
// input is read) and must still run their DDL in the postgres style.

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const TIMEOUT = 90_000;
/**
 * Startup options of a session that does not fix IntervalStyle (and so bypasses PGOPTIONS). It keeps
 * the options the runner was given for the test database.
 */
const UNFIXED_OPTIONS = testSessionOptions("-c timezone=UTC");

const POSTGRES_DEADLINE = "'00:30:00'::interval";
const POSTGRES_EXPIRY = "'24:00:00'::interval";
/** pg_get_expr output of the two interval literals under each non-default IntervalStyle (PostgreSQL 17). */
const STYLES = [
  { style: "iso_8601", deadline: "'PT30M'::interval", expiry: "'PT24H'::interval" },
  { style: "sql_standard", deadline: "'0:30:00'::interval", expiry: "'24:00:00'::interval" },
  {
    style: "postgres_verbose",
    deadline: "'@ 30 mins'::interval",
    expiry: "'@ 24 hours'::interval",
  },
] as const;
const SCOPES = ["database", "role"] as const;

const RUNTIME_SERVICES = [
  ["app_api_runtime", "api"],
  ["app_email_runtime", "email-worker"],
  ["app_reconciliation_runtime", "reconciliation-worker"],
] as const;

const goldenExpiryDefault = GOLDEN_COLUMNS.find(([name]) => name === "expires_at")?.[4];
const goldenExpiryCheck = GOLDEN_CONSTRAINTS.find(
  ([name]) => name === "ck_idempotency_records_expiry",
)?.[2];

const quoteIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;
const failClosed = (events: readonly LogEvent[]) =>
  events.filter((event) => event.event_name === "security.fail_closed.triggered");

type Queryable = Pick<Client, "query">;

async function catalogExpressions(client: Queryable) {
  const row = (
    await client.query(`SELECT current_setting('IntervalStyle') AS style,
      (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'app.payment_bindings'::regclass AND a.attname = 'payment_deadline_at') AS deadline,
      (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'app.idempotency_records'::regclass AND a.attname = 'expires_at') AS expiry_default,
      (SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k
        WHERE k.conrelid = 'app.idempotency_records'::regclass AND k.conname = 'ck_idempotency_records_expiry') AS expiry_check`)
  ).rows[0];
  const catalog = (await client.query(catalogQuery)).rows[0].catalog;
  return { ...row, catalog } as {
    style: string;
    deadline: string;
    expiry_default: string;
    expiry_check: string;
    catalog: unknown;
  };
}

async function withClient<T>(
  config: { connectionString: string; options?: string },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(config);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function roleUrl(role: string): string {
  const runtimeUrl = new URL(url as string);
  runtimeUrl.username = role;
  runtimeUrl.password = "";
  runtimeUrl.search = "";
  return runtimeUrl.href;
}

describe("readiness and the catalog goldens under a non-default IntervalStyle (real PostgreSQL 17)", () => {
  let admin: Client;
  let database: string;
  let adminRole: string;
  let ca: string;
  let expected: ReadinessExpectations;

  const loginRoles = () => [adminRole, ...RUNTIME_SERVICES.map(([role]) => role)];

  async function setDefault(scope: (typeof SCOPES)[number], style: string | null) {
    const value = style === null ? "RESET intervalstyle" : `SET intervalstyle = '${style}'`;
    if (scope === "database") await admin.query(`ALTER DATABASE ${quoteIdent(database)} ${value}`);
    else
      for (const role of loginRoles())
        await admin.query(
          `ALTER ROLE ${quoteIdent(role)} IN DATABASE ${quoteIdent(database)} ${value}`,
        );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: url });
    await admin.connect();
    const identity = (
      await admin.query("SELECT current_database() AS database, current_user AS role")
    ).rows[0];
    database = identity.database;
    adminRole = identity.role;
    await prepareFoundationDatabase(admin);
    await installSyntheticDirectory(admin);
    await admin.query(`ALTER DATABASE ${quoteIdent(database)} SET r39x.environment TO 'test'`);
    ca = await readFile(caPath as string, "utf8");
    expected = {
      environment: "test",
      environmentMarkerSetting: "r39x.environment",
      migrationSetHash: await computeMigrationSetHash(),
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
  }, TIMEOUT);

  afterEach(async () => {
    for (const scope of SCOPES) await setDefault(scope, null);
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("TC-INF-HLT-006-012 the goldens and the required catalog hold the postgres IntervalStyle literals", async () => {
    expect(INTERVAL_STYLE_OPTION).toBe("-c intervalstyle=postgres");
    // Options in the connection string would override PGOPTIONS, so the isolated URL has none and
    // PGOPTIONS ends with the IntervalStyle option.
    expect(new URL(url as string).searchParams.has("options")).toBe(false);
    expect(process.env.PGOPTIONS?.endsWith(INTERVAL_STYLE_OPTION)).toBe(true);
    expect(PAYMENT_DEADLINE_EXPRESSION).toContain(POSTGRES_DEADLINE);
    expect(goldenExpiryDefault).toContain(POSTGRES_EXPIRY);
    expect(goldenExpiryCheck).toContain(POSTGRES_EXPIRY);
    const live = await catalogExpressions(admin);
    expect(live).toMatchObject({
      style: "postgres",
      deadline: PAYMENT_DEADLINE_EXPRESSION,
      expiry_default: goldenExpiryDefault,
      expiry_check: goldenExpiryCheck,
    });
    expect(catalogSatisfies(live.catalog, requiredCatalog, "exact")).toBe(true);
  });

  it(
    "TC-INF-HLT-006-012 INF-HLT-006 migrations started in a sql_standard session run their DDL in the postgres IntervalStyle and create the required catalog",
    async () => {
      const target = `${database}_ivs`;
      const targetUrl = new URL(url as string);
      targetUrl.pathname = `/${target}`;
      await admin.query(`CREATE DATABASE ${quoteIdent(target)} TEMPLATE template0`);
      try {
        // The IntervalStyle in effect when each CREATE TABLE statement of the migrations runs.
        const ddlStyles: string[] = [];
        await withClient(
          {
            connectionString: targetUrl.href,
            options: testSessionOptions("-c timezone=UTC -c intervalstyle=sql_standard"),
          },
          async (client) => {
            expect(
              (await client.query("SELECT current_setting('IntervalStyle') AS style")).rows[0]
                .style,
            ).toBe("sql_standard");
            const query = client.query.bind(client) as (...args: unknown[]) => Promise<QueryResult>;
            client.query = (async (...args: unknown[]) => {
              const [text] = args;
              const sql =
                typeof text === "string" ? text : ((text as { text?: string } | null)?.text ?? "");
              if (/\bCREATE\s+TABLE\b/i.test(sql))
                ddlStyles.push(
                  (await query("SELECT current_setting('IntervalStyle') AS style")).rows[0].style,
                );
              return query(...args);
            }) as unknown as Client["query"];
            await prepareFoundationDatabase(client);
          },
        );
        expect(ddlStyles.length).toBeGreaterThan(0);
        expect(new Set(ddlStyles)).toEqual(new Set(["postgres"]));

        // The required catalog also covers the identity directory, which beforeAll installs in the
        // first database.
        const migrated = await withClient({ connectionString: targetUrl.href }, async (client) => {
          await installSyntheticDirectory(client);
          return catalogExpressions(client);
        });
        expect(migrated).toMatchObject({
          style: "postgres",
          deadline: PAYMENT_DEADLINE_EXPRESSION,
          expiry_default: goldenExpiryDefault,
          expiry_check: goldenExpiryCheck,
        });
        expect(catalogSatisfies(migrated.catalog, requiredCatalog, "exact")).toBe(true);
      } finally {
        await admin.query(`DROP DATABASE ${quoteIdent(target)} WITH (FORCE)`);
      }
    },
    TIMEOUT,
  );

  for (const scope of SCOPES)
    for (const { style, deadline, expiry } of STYLES)
      it(
        `TC-INF-HLT-006-012 INF-HLT-006 with the ${scope} default IntervalStyle ${style}, the harness and the three runtime pools read the required catalog and readiness is Ready`,
        async () => {
          await setDefault(scope, style);

          // The default is in effect: sessions without the option, as the admin and as each runtime
          // role, see the other style, and the catalog they read differs from the required one.
          for (const connectionString of [url, ...RUNTIME_SERVICES.map(([role]) => roleUrl(role))])
            expect(
              (
                await withClient({ connectionString, options: UNFIXED_OPTIONS }, (client) =>
                  client.query("SELECT current_setting('IntervalStyle') AS style"),
                )
              ).rows[0].style,
            ).toBe(style);
          const unfixed = await withClient(
            { connectionString: url, options: UNFIXED_OPTIONS },
            catalogExpressions,
          );
          expect(unfixed).toMatchObject({
            style,
            deadline: PAYMENT_DEADLINE_EXPRESSION.replace(POSTGRES_DEADLINE, deadline),
            expiry_default: goldenExpiryDefault?.replace(POSTGRES_EXPIRY, expiry),
            expiry_check: goldenExpiryCheck?.replace(POSTGRES_EXPIRY, expiry),
          });
          expect(catalogSatisfies(unfixed.catalog, requiredCatalog, "exact")).toBe(false);

          // A harness session (PGOPTIONS from isolated-database.ts) reads the goldens and the
          // required catalog.
          const harness = await withClient({ connectionString: url }, catalogExpressions);
          expect(harness).toMatchObject({
            style: "postgres",
            deadline: PAYMENT_DEADLINE_EXPRESSION,
            expiry_default: goldenExpiryDefault,
            expiry_check: goldenExpiryCheck,
          });
          expect(catalogSatisfies(harness.catalog, requiredCatalog, "exact")).toBe(true);

          // The production pools fix the style themselves and are Ready.
          for (const [role, service] of RUNTIME_SERVICES) {
            const events: LogEvent[] = [];
            const runtime = createDatabase({
              connectionString: roleUrl(role),
              environment: "test",
              service,
              ca,
              logger: { log: (event) => events.push(event) },
            });
            try {
              const client = await runtime.pool.connect();
              try {
                expect(
                  (await client.query("SELECT current_setting('IntervalStyle') AS style")).rows[0]
                    .style,
                  service,
                ).toBe("postgres");
                expect(
                  catalogSatisfies(
                    (await client.query(catalogQuery)).rows[0].catalog,
                    requiredCatalog,
                    "exact",
                  ),
                  service,
                ).toBe(true);
              } finally {
                client.release();
              }
              expect(await checkReadiness(runtime.pool, expected), service).toEqual({
                ready: true,
                failures: [],
              });
              expect(failClosed(events), service).toEqual([]);
            } finally {
              await runtime.close();
            }
          }
        },
        TIMEOUT,
      );
});
