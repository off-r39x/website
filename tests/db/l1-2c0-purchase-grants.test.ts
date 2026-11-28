import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src/index.ts";
import { catalogSatisfies } from "../../packages/db/src/readiness.ts";
import { catalogQuery, requiredCatalog } from "../../packages/db/src/schema-contract.ts";
import { installSyntheticDirectory, prepareFoundationDatabase } from "../harness/db/foundation.ts";
import {
  ALL_RUNTIME_ROLES,
  columnAclEntries,
  KARAOKE_PROBE_COLUMNS,
  PURCHASE_API_INSERT_COLUMNS,
  PURCHASE_API_SELECT_TABLES,
  PURCHASE_API_UNGRANTED_INSERT_COLUMNS,
  PURCHASE_API_UNGRANTED_TABLES,
  privilegeMismatches,
  tableAcl,
  ungrantedInsertStatement,
} from "../harness/db/purchase-runtime-grants.ts";

// PR-L1-2c0: migration 0011 gives app_api_runtime, and only it, the privileges the purchase eligibility check
// (API-PUR-ELG-001) and the purchase start (Entry now, Goods later) need: table-level SELECT on seven Order / Entry /
// Goods / Karaoke tables and column-level INSERT on five (SEC-DB-001..003, DB-FK-004, DB-TIM-002, SPEC-100 §7.2,
// §43.1, §53, SPEC-140 §38-§39, SPEC-180 §22.2). Real PostgreSQL 17 (TST-GEN-004, TST-DB-001, DEV-TST-003). The
// expected sets are the hand-written constants of tests/harness/db/purchase-runtime-grants.ts, never read from the
// live database. All data is synthetic. A role guards which columns may be written, not their values: the states
// written below are the repository's decision, so no case here claims that the role protects a state.
//
// Naming an identity column (`id`) or a generated column (`line_total_amount`) in an INSERT fails with 428C9 before
// any privilege check, so those two are not privilege cases and are left out of the ungranted-column case.

const url = process.env.TEST_DATABASE_URL;
const caPath = process.env.TEST_DATABASE_CA;
if (!url || !caPath) throw new Error("Real PG17 requires TEST_DATABASE_URL and TEST_DATABASE_CA");

const REPO_MIGRATIONS = resolve(process.cwd(), "../packages/db/migrations");
const PREVIOUS_VERSION = "0010_cross_functional";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SALES = {
  currency: "JPY",
  sales_starts_at: "2030-01-01T00:00:00Z",
  sales_ends_at: "2030-01-02T00:00:00Z",
};

const RUNTIME_SERVICES = [
  ["app_api_runtime", "api"],
  ["app_email_runtime", "email-worker"],
  ["app_reconciliation_runtime", "reconciliation-worker"],
] as const;

let admin: Client;
const runtimes = new Map<string, ReturnType<typeof createDatabase>>();
const poolOf = (role: string): Pool => {
  const runtime = runtimes.get(role);
  if (!runtime) throw new Error(`runtime pool ${role} is not open`);
  return runtime.pool;
};

const TABLE_NAMES = [...PURCHASE_API_SELECT_TABLES];
let appTables: string[] = [];

beforeAll(async () => {
  admin = new Client({ connectionString: url });
  await admin.connect();
  expect((await admin.query("SHOW TimeZone")).rows[0].TimeZone).toBe("UTC");
  expect((await admin.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe(
    "read committed",
  );
  await prepareFoundationDatabase(admin);
  await installSyntheticDirectory(admin);
  appTables = (
    await admin.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'app' AND tablename <> 'schema_migrations'
        ORDER BY tablename COLLATE "C"`,
    )
  ).rows.map((row) => row.tablename as string);
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

async function insertAdmin(table: string, row: Record<string, unknown>, key = "id") {
  const columns = Object.keys(row);
  const statement = `INSERT INTO app.${table}(${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${key}`;
  return (await admin.query(statement, Object.values(row))).rows[0][key] as string;
}

async function counts(tables: readonly string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of tables)
    result[table] = Number((await admin.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n);
  return result;
}

const subject = (n: number) =>
  `00000000-0000-4000-8000-${(0xc20000 + n).toString(16).padStart(12, "0")}`;

// ---- TC-SEC-DB-001-008 --------------------------------------------------------------------------

describe("TC-SEC-DB-001-008 migration 0011 grants app_api_runtime exactly the purchase read and start privileges (SEC-DB-001..003, real PostgreSQL 17)", () => {
  it("TC-SEC-DB-001-008 the 0011 file is six GRANT statements to app_api_runtime only (the seven-table SELECT and five column-level INSERTs) and follows 0010 in the journal", async () => {
    const files = (await readdir(REPO_MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort();
    const file = files.find((name) => name.startsWith("0011_"));
    expect(file, "migration 0011_*.sql exists").toBeDefined();
    expect(files[files.indexOf(file as string) - 1]).toBe(`${PREVIOUS_VERSION}.sql`);
    const journal = (
      await admin.query('SELECT version FROM app.schema_migrations ORDER BY version COLLATE "C"')
    ).rows.map((row) => row.version as string);
    const position = journal.indexOf((file as string).slice(0, -4));
    expect(position, "0011 is applied").toBeGreaterThan(0);
    expect(journal[position - 1]).toBe(PREVIOUS_VERSION);

    const source = await readFile(resolve(REPO_MIGRATIONS, file as string), "utf8");
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    const statements = body
      .split(";")
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toHaveLength(6);
    for (const statement of statements) {
      expect(statement, statement).toMatch(/^GRANT (SELECT|INSERT) /);
      expect(statement, statement).toMatch(/ TO app_api_runtime$/);
    }
    for (const forbidden of [
      /\bPUBLIC\b/i,
      /app_email_runtime|app_reconciliation_runtime|app_runtime\b|app_migrator/,
      /\bSEQUENCE\b/i,
      /\bALL\b/i,
      /WITH GRANT OPTION/i,
      /\bUPDATE\b/i,
      /\bDELETE\b/i,
      /\bTRUNCATE\b/i,
      /\bCREATE\b/i,
      /\bALTER\b/i,
      /\bDROP\b/i,
      /\bREVOKE\b/i,
    ])
      expect(body, String(forbidden)).not.toMatch(forbidden);

    // The SELECT statement lists exactly the seven tables; each INSERT statement lists exactly the plan's columns.
    const select = statements.find((statement) => statement.startsWith("GRANT SELECT "));
    expect(select, "one table-level SELECT statement").toBeDefined();
    const selectMatch = /^GRANT SELECT ON (.+) TO app_api_runtime$/.exec(select as string);
    expect(
      selectMatch?.[1]
        ?.split(",")
        .map((table) => table.trim().replace(/^app\./, ""))
        .sort(),
    ).toEqual([...PURCHASE_API_SELECT_TABLES].sort());
    const inserts: Record<string, string[]> = {};
    for (const statement of statements.filter((value) => value.startsWith("GRANT INSERT "))) {
      const match = /^GRANT INSERT \(([^)]*)\) ON app\.([a-z_]+) TO app_api_runtime$/.exec(
        statement,
      );
      if (!match) throw new Error(`unexpected INSERT grant: ${statement}`);
      inserts[match[2] as string] = (match[1] as string)
        .split(",")
        .map((column) => column.trim())
        .sort();
    }
    expect(Object.keys(inserts).sort()).toEqual(Object.keys(PURCHASE_API_INSERT_COLUMNS).sort());
    for (const [table, columns] of Object.entries(PURCHASE_API_INSERT_COLUMNS))
      expect(inserts[table], table).toEqual([...columns].sort());
  });

  it("TC-SEC-DB-001-008 the live privileges equal the plan on the seven tables (no difference), the other three roles and PUBLIC hold nothing there, and no sequence of them is usable", async () => {
    const live = (
      await admin.query(
        `SELECT c.relname AS table_name,
                coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped), '{}') AS columns
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname = 'app' AND c.relname = ANY($1) GROUP BY c.relname`,
        [TABLE_NAMES],
      )
    ).rows as { table_name: string; columns: string[] }[];
    expect(live.map((row) => row.table_name).sort()).toEqual([...TABLE_NAMES].sort());
    // Every column the plan names exists in the table (a typo cannot make the comparison vacuous).
    for (const map of [PURCHASE_API_INSERT_COLUMNS, PURCHASE_API_UNGRANTED_INSERT_COLUMNS])
      for (const [table, columns] of Object.entries(map))
        for (const column of columns)
          expect(
            live.find((row) => row.table_name === table)?.columns,
            `${table}.${column}`,
          ).toContain(column);
    expect(
      await privilegeMismatches(
        admin,
        live.map((row) => ({ table: row.table_name, columns: row.columns })),
      ),
    ).toEqual([]);
    expect(await columnAclEntries(admin, TABLE_NAMES)).toEqual(
      Object.entries(PURCHASE_API_INSERT_COLUMNS)
        .flatMap(([table, columns]) =>
          columns.map((column) => `${table}.${column}:app_api_runtime:INSERT:false`),
        )
        .sort(),
    );
    for (const table of TABLE_NAMES) {
      const acl = await tableAcl(admin, table);
      expect(acl.ownerPresent, `${table}: owner`).toBe(true);
      expect(acl.others, table).toEqual(["app_api_runtime:SELECT:false"]);
      // No sequence of the table (identity) is usable by any runtime role or PUBLIC.
      const sequences = (
        await admin.query(
          `SELECT s.relname FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a','i')
             JOIN pg_class t ON t.oid = d.refobjid WHERE s.relkind = 'S' AND t.oid = $1::regclass`,
          [`app.${table}`],
        )
      ).rows.map((row) => row.relname as string);
      for (const sequence of sequences)
        for (const role of [...ALL_RUNTIME_ROLES, "public"])
          expect(
            (
              await admin.query(
                "SELECT has_sequence_privilege($1, $2, 'USAGE,SELECT,UPDATE') AS allowed",
                [role, `app.${sequence}`],
              )
            ).rows[0].allowed,
            `${role} ${sequence}`,
          ).toBe(false);
    }
    // The seven tables 0011 leaves alone (and the 0010 tables) stay closed to every runtime role and PUBLIC.
    const untouched = appTables.filter(
      (table) =>
        (PURCHASE_API_UNGRANTED_TABLES as readonly string[]).includes(table) ||
        ["notification_requests", "consistency_review_cases"].includes(table),
    );
    expect(untouched).toHaveLength(PURCHASE_API_UNGRANTED_TABLES.length + 2);
    for (const table of untouched)
      for (const role of [...ALL_RUNTIME_ROLES, "public"])
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"])
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
  });

  it("TC-SEC-DB-001-008 the live catalog equals schema-contract.json exactly (0011 holds no DDL)", async () => {
    const catalog = (await admin.query(catalogQuery)).rows[0].catalog;
    expect(catalogSatisfies(catalog, requiredCatalog, "exact")).toBe(true);
  });

  // Parent rows (committed by the administrator) the runtime transactions refer to, created once.
  let seeded: Promise<{ profile: string; offering: string; goods: string }> | undefined;
  const parents = () => {
    seeded ??= seedParents();
    return seeded;
  };
  async function seedParents() {
    const profile = await insertAdmin("business_profiles", { auth_subject: subject(1) });
    const event = await insertAdmin("events", { name: "合成イベント" });
    const offering = await insertAdmin("entry_ticket_offerings", {
      ...SALES,
      event_id: event,
      name: "合成入場券",
      unit_amount: 750,
      sale_control_state: "ENABLED",
      sales_capacity: 100,
      purchase_limit: 4,
    });
    const goods = await insertAdmin("goods", {
      ...SALES,
      event_id: event,
      name: "合成グッズ",
      unit_amount: 750,
      sale_control_state: "ENABLED",
      purchase_limit: 3,
    });
    await insertAdmin("goods_inventory", { goods_id: goods, saleable_capacity: 10 }, "goods_id");
    return { profile, offering, goods };
  }

  // Runs `work` on an app_api_runtime connection inside a transaction that is always rolled back.
  async function inRuntimeTransaction<T>(
    work: (
      q: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>,
    ) => Promise<T>,
  ): Promise<T> {
    const client = await poolOf("app_api_runtime").connect();
    try {
      await client.query("BEGIN");
      try {
        return await work(async (text, values) => (await client.query(text, values)).rows);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  }

  async function insertOrder(
    q: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>,
    profile: string,
    purpose: string,
    cause: string,
    total: number,
  ) {
    const [row] = await q(
      `INSERT INTO app.orders (purchase_cause_key, customer_profile_id, purpose, state, currency, total_amount)
       VALUES ($1, $2, $3, 'PREPARED', 'JPY', $4)
       RETURNING id, public_ref, created_at = transaction_timestamp() AS created_now,
                 updated_at = transaction_timestamp() AS updated_now, confirmed_at, terminal_at`,
      [cause, profile, purpose, total],
    );
    expect(String(row?.public_ref)).toMatch(UUID_V4);
    expect(row?.created_now).toBe(true);
    expect(row?.updated_now).toBe(true);
    expect(row?.confirmed_at).toBeNull();
    expect(row?.terminal_at).toBeNull();
    return String(row?.id);
  }

  async function insertItem(
    q: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>,
    order: string,
    purpose: string,
    line: number,
    source: { offering?: string; goods?: string },
  ) {
    const [row] = await q(
      `INSERT INTO app.order_items (order_id, purpose, line_no, quantity, unit_amount, currency, item_name_snapshot,
                                    entry_offering_id, goods_id)
       VALUES ($1, $2, $3, 2, 750, 'JPY', '合成明細', $4, $5)
       RETURNING id, line_total_amount, created_at = transaction_timestamp() AS created_now, karaoke_slot_id`,
      [order, purpose, line, source.offering ?? null, source.goods ?? null],
    );
    expect(String(row?.line_total_amount), "generated 750 x 2").toBe("1500");
    expect(row?.created_now).toBe(true);
    expect(row?.karaoke_slot_id).toBeNull();
    return String(row?.id);
  }

  async function insertEntryAllocation(
    q: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>,
    item: string,
    order: string,
    purpose: string,
    offering: string,
  ) {
    const [row] = await q(
      `INSERT INTO app.entry_sales_allocations (order_item_id, order_id, purpose, offering_id, quantity, state)
       VALUES ($1, $2, $3, $4, 2, 'HELD')
       RETURNING held_at = transaction_timestamp() AS held_now, committed_at, released_at`,
      [item, order, purpose, offering],
    );
    expect(row).toEqual({ held_now: true, committed_at: null, released_at: null });
  }

  async function insertGoodsLine(
    q: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>,
    item: string,
    order: string,
    purpose: string,
    profile: string,
    goods: string,
  ) {
    const [line] = await q(
      `INSERT INTO app.goods_order_items (order_item_id, order_id, order_purpose, customer_profile_id, goods_id, state)
       VALUES ($1, $2, $3, $4, $5, 'PENDING_PAYMENT')
       RETURNING public_ref, created_at = transaction_timestamp() AS created_now,
                 updated_at = transaction_timestamp() AS updated_now`,
      [item, order, purpose, profile, goods],
    );
    expect(String(line?.public_ref)).toMatch(UUID_V4);
    expect(line?.created_now).toBe(true);
    expect(line?.updated_now).toBe(true);
    const [allocation] = await q(
      `INSERT INTO app.goods_sales_allocations (goods_order_item_id, goods_id, quantity, state)
       VALUES ($1, $2, 2, 'HELD')
       RETURNING held_at = transaction_timestamp() AS held_now, committed_at, released_at`,
      [item, goods],
    );
    expect(allocation).toEqual({ held_now: true, committed_at: null, released_at: null });
  }

  async function selectsAllSeven(
    q: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>,
  ) {
    const seen: Record<string, number> = {};
    for (const table of PURCHASE_API_SELECT_TABLES)
      seen[table] = Number((await q(`SELECT count(*) AS n FROM app.${table}`))[0]?.n);
    return seen;
  }

  it("TC-SEC-DB-001-008 an app_api_runtime transaction starts an Entry purchase with the granted columns only: DB defaults fill the rest, all seven tables can be read, and ROLLBACK leaves every table as it was", async () => {
    const { profile, offering } = await parents();
    const before = await counts(appTables);
    await inRuntimeTransaction(async (q) => {
      const order = await insertOrder(q, profile, "ENTRY_TICKET_PURCHASE", subject(11), 1500);
      const item = await insertItem(q, order, "ENTRY_TICKET_PURCHASE", 1, { offering });
      await insertEntryAllocation(q, item, order, "ENTRY_TICKET_PURCHASE", offering);
      const seen = await selectsAllSeven(q);
      expect(seen).toEqual({
        orders: (before.orders ?? 0) + 1,
        order_items: (before.order_items ?? 0) + 1,
        entry_sales_allocations: (before.entry_sales_allocations ?? 0) + 1,
        karaoke_holds: 0,
        karaoke_reservations: 0,
        goods_order_items: 0,
        goods_sales_allocations: 0,
      });
    });
    expect(await counts(appTables)).toEqual(before);
  });

  it("TC-SEC-DB-001-008 an app_api_runtime transaction starts Goods and Entry + Goods purchases with the granted columns only, and ROLLBACK leaves every table as it was", async () => {
    const { profile, offering, goods } = await parents();
    const before = await counts(appTables);
    await inRuntimeTransaction(async (q) => {
      const order = await insertOrder(q, profile, "GOODS_PURCHASE", subject(21), 1500);
      const item = await insertItem(q, order, "GOODS_PURCHASE", 1, { goods });
      await insertGoodsLine(q, item, order, "GOODS_PURCHASE", profile, goods);
      const composite = await insertOrder(q, profile, "ENTRY_GOODS_PURCHASE", subject(22), 3000);
      const entryItem = await insertItem(q, composite, "ENTRY_GOODS_PURCHASE", 1, { offering });
      const goodsItem = await insertItem(q, composite, "ENTRY_GOODS_PURCHASE", 2, { goods });
      await insertEntryAllocation(q, entryItem, composite, "ENTRY_GOODS_PURCHASE", offering);
      await insertGoodsLine(q, goodsItem, composite, "ENTRY_GOODS_PURCHASE", profile, goods);
      const seen = await selectsAllSeven(q);
      expect(seen.orders).toBe((before.orders ?? 0) + 2);
      expect(seen.order_items).toBe((before.order_items ?? 0) + 3);
      expect(seen.entry_sales_allocations).toBe((before.entry_sales_allocations ?? 0) + 1);
      expect(seen.goods_order_items).toBe((before.goods_order_items ?? 0) + 2);
      expect(seen.goods_sales_allocations).toBe((before.goods_sales_allocations ?? 0) + 2);
    });
    expect(await counts(appTables)).toEqual(before);
  });

  it("TC-SEC-DB-001-008 an INSERT that names one ungranted column is refused with 42501 on each of the five tables (and on the two Karaoke tables), while the granted columns alone pass the privilege check", async () => {
    const before = await counts(appTables);
    const pool = poolOf("app_api_runtime");
    for (const [table, columns] of Object.entries(PURCHASE_API_UNGRANTED_INSERT_COLUMNS)) {
      expect(columns.length, table).toBeGreaterThan(0);
      for (const column of columns)
        await expect(
          pool.query(ungrantedInsertStatement(table, column)),
          `${table}.${column}`,
        ).rejects.toMatchObject({ code: "42501" });
    }
    for (const [table, column] of Object.entries(KARAOKE_PROBE_COLUMNS))
      await expect(
        pool.query(ungrantedInsertStatement(table, column)),
        `${table}.${column}`,
      ).rejects.toMatchObject({ code: "42501" });
    // Control: the granted columns alone reach the first NOT NULL check (23502), so a 42501 above is the ungranted column.
    for (const [table, columns] of Object.entries(PURCHASE_API_INSERT_COLUMNS))
      await expect(
        pool.query(
          `INSERT INTO app.${table} (${columns.join(", ")}) VALUES (${columns.map(() => "NULL").join(", ")})`,
        ),
        table,
      ).rejects.toMatchObject({ code: "23502" });
    expect(await counts(appTables)).toEqual(before);
  });

  it("TC-SEC-DB-001-008 the API pool is refused UPDATE, DELETE, TRUNCATE and every row lock on the seven tables, and the Email and Reconciliation pools are refused SELECT, INSERT, UPDATE, DELETE and TRUNCATE", async () => {
    const before = await counts(appTables);
    const api = poolOf("app_api_runtime");
    for (const table of TABLE_NAMES) {
      const column = (
        await admin.query(
          `SELECT a.attname FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 1 AND NOT a.attisdropped
            ORDER BY a.attnum LIMIT 1`,
          [`app.${table}`],
        )
      ).rows[0].attname as string;
      for (const statement of [
        `UPDATE app.${table} SET ${column} = ${column} WHERE false`,
        `DELETE FROM app.${table} WHERE false`,
        `TRUNCATE app.${table}`,
        `SELECT 1 FROM app.${table} FOR UPDATE`,
        `SELECT 1 FROM app.${table} FOR NO KEY UPDATE`,
        `SELECT 1 FROM app.${table} FOR SHARE`,
        `SELECT 1 FROM app.${table} FOR KEY SHARE`,
      ])
        await expect(api.query(statement), `app_api_runtime: ${statement}`).rejects.toMatchObject({
          code: "42501",
        });
      for (const role of ["app_email_runtime", "app_reconciliation_runtime"]) {
        for (const statement of [
          `SELECT 1 FROM app.${table}`,
          `INSERT INTO app.${table} DEFAULT VALUES`,
          `UPDATE app.${table} SET ${column} = ${column} WHERE false`,
          `DELETE FROM app.${table} WHERE false`,
          `TRUNCATE app.${table}`,
        ])
          await expect(
            poolOf(role).query(statement),
            `${role}: ${statement}`,
          ).rejects.toMatchObject({ code: "42501" });
      }
    }
    expect(await counts(appTables)).toEqual(before);
  });

  it("TC-SEC-DB-001-008 the runtime role names stay the ones the plan grants to (no role other than app_api_runtime appears in any ACL of the seven tables)", async () => {
    const grantees = (
      await admin.query(
        `SELECT DISTINCT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                aclexplode(c.relacl) e WHERE n.nspname = 'app' AND c.relname = ANY($1)`,
        [TABLE_NAMES],
      )
    ).rows.map((row) => row.grantee as string);
    expect(grantees.sort()).toEqual(["app_api_runtime", "app_migrator"]);
  });
});
