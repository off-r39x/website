import { expect } from "vitest";

// PR-L1-2c0 test harness: the privileges migration 0011 grants to app_api_runtime (plan 20261128-l1-2c0, "列単位の
// INSERT の一覧"; SEC-DB-001..003, SPEC-140 §38-§39, SPEC-180 §22.2, SPEC-100 §7.2, §43.1, DB-TIM-002). Written by
// hand from the plan, never read from the live database or from the migration, so a grant that is too wide or too
// narrow shows up as a difference. No database connection of its own: callers pass a pg client.

export const PURCHASE_API_ROLE = "app_api_runtime";
export const OTHER_RUNTIME_ROLES = [
  "app_email_runtime",
  "app_reconciliation_runtime",
  "app_runtime",
] as const;
export const ALL_RUNTIME_ROLES = [PURCHASE_API_ROLE, ...OTHER_RUNTIME_ROLES] as const;
export const TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const;
export const COLUMN_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const;

/** Table-level SELECT of app_api_runtime: creation order of 0006, 0007, 0008. */
export const PURCHASE_API_SELECT_TABLES = [
  "orders",
  "order_items",
  "entry_sales_allocations",
  "karaoke_holds",
  "karaoke_reservations",
  "goods_order_items",
  "goods_sales_allocations",
] as const;

/** Column-level INSERT of app_api_runtime (five tables). Everything else is a DB default, generated or set later. */
export const PURCHASE_API_INSERT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  orders: [
    "purchase_cause_key",
    "customer_profile_id",
    "purpose",
    "state",
    "currency",
    "total_amount",
  ],
  order_items: [
    "order_id",
    "purpose",
    "line_no",
    "quantity",
    "unit_amount",
    "currency",
    "item_name_snapshot",
    "entry_offering_id",
    "goods_id",
  ],
  entry_sales_allocations: [
    "order_item_id",
    "order_id",
    "purpose",
    "offering_id",
    "quantity",
    "state",
  ],
  goods_order_items: [
    "order_item_id",
    "order_id",
    "order_purpose",
    "customer_profile_id",
    "goods_id",
    "state",
  ],
  goods_sales_allocations: ["goods_order_item_id", "goods_id", "quantity", "state"],
};

/**
 * Columns an INSERT of app_api_runtime must be refused (42501), identity `id` and the generated `line_total_amount`
 * excluded: naming those fails with 428C9 before the privilege check, so they are not a privilege case.
 */
export const PURCHASE_API_UNGRANTED_INSERT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  orders: ["public_ref", "confirmed_at", "terminal_at", "created_at", "updated_at"],
  order_items: ["karaoke_slot_id", "created_at"],
  entry_sales_allocations: ["held_at", "committed_at", "released_at"],
  goods_order_items: ["public_ref", "created_at", "updated_at"],
  goods_sales_allocations: ["held_at", "committed_at", "released_at"],
};

/** One column per Karaoke table that app_api_runtime must not be able to INSERT (a Karaoke purchase is not mounted). */
export const KARAOKE_PROBE_COLUMNS: Readonly<Record<string, string>> = {
  karaoke_holds: "order_id",
  karaoke_reservations: "order_id",
};

/** Tables 0011 leaves without any grant (still closed by 0006-0010). */
export const PURCHASE_API_UNGRANTED_TABLES = [
  "checkout_attempts",
  "payment_bindings",
  "webhook_receipts",
  "refund_records",
  "karaoke_tickets",
  "karaoke_checkins",
  "goods_handoffs",
] as const;

export const hasTableSelect = (table: string): boolean =>
  (PURCHASE_API_SELECT_TABLES as readonly string[]).includes(table);

export const hasColumnInsert = (table: string, column: string): boolean =>
  PURCHASE_API_INSERT_COLUMNS[table]?.includes(column) ?? false;

/** The expected has_table_privilege of a role (or "public") on a table: only app_api_runtime SELECT, nothing else. */
export const expectedTablePrivilege = (role: string, table: string, privilege: string): boolean =>
  role === PURCHASE_API_ROLE && privilege === "SELECT" && hasTableSelect(table);

/** The expected has_column_privilege (the table-level SELECT covers every column; INSERT only the listed ones). */
export const expectedColumnPrivilege = (
  role: string,
  table: string,
  column: string,
  privilege: string,
): boolean =>
  role === PURCHASE_API_ROLE &&
  ((privilege === "SELECT" && hasTableSelect(table)) ||
    (privilege === "INSERT" && hasColumnInsert(table, column)));

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TableColumns {
  table: string;
  columns: readonly string[];
}

/**
 * Every difference between the live privileges and the plan, as readable strings (empty = identical): the table
 * privileges of the four runtime roles and PUBLIC on each table, `has_any_column_privilege`, and the column
 * privileges of every column of every table (the table-level SELECT counts for each column).
 */
export async function privilegeMismatches(
  client: Queryable,
  tables: readonly TableColumns[],
): Promise<string[]> {
  const mismatches: string[] = [];
  const roles = [...ALL_RUNTIME_ROLES, "public"];
  const check = async (label: string, sql: string, values: unknown[], expected: boolean) => {
    const actual = (await client.query(sql, values)).rows[0]?.allowed;
    if (actual !== expected) mismatches.push(`${label}: expected ${expected}, got ${actual}`);
  };
  for (const { table, columns } of tables) {
    for (const role of roles) {
      for (const privilege of TABLE_PRIVILEGES)
        await check(
          `${role} ${privilege} on ${table}`,
          "SELECT has_table_privilege($1, $2, $3) AS allowed",
          [role, `app.${table}`, privilege],
          expectedTablePrivilege(role, table, privilege),
        );
      for (const privilege of COLUMN_PRIVILEGES) {
        await check(
          `${role} any-column ${privilege} on ${table}`,
          "SELECT has_any_column_privilege($1, $2, $3) AS allowed",
          [role, `app.${table}`, privilege],
          role === PURCHASE_API_ROLE &&
            ((privilege === "SELECT" && hasTableSelect(table)) ||
              (privilege === "INSERT" && table in PURCHASE_API_INSERT_COLUMNS)),
        );
        for (const column of columns)
          await check(
            `${role} ${privilege} on ${table}.${column}`,
            "SELECT has_column_privilege($1, $2, $3, $4) AS allowed",
            [role, `app.${table}`, column, privilege],
            expectedColumnPrivilege(role, table, column, privilege),
          );
      }
    }
  }
  return mismatches;
}

/** The column ACL entries (`table.column:grantee:PRIVILEGE:grantable`) of the tables, sorted. */
export async function columnAclEntries(
  client: Queryable,
  tables: readonly string[],
): Promise<string[]> {
  return (
    await client.query(
      `SELECT c.relname || '.' || a.attname || ':' ||
              CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END || ':' ||
              e.privilege_type || ':' || e.is_grantable AS entry
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace,
              aclexplode(a.attacl) e
        WHERE n.nspname = 'app' AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped`,
      [[...tables]],
    )
  ).rows
    .map((row) => row.entry as string)
    .sort();
}

/** The column ACL the plan expects for these tables. */
export function expectedColumnAclEntries(tables: readonly string[]): string[] {
  return tables
    .flatMap((table) =>
      (PURCHASE_API_INSERT_COLUMNS[table] ?? []).map(
        (column) => `${table}.${column}:${PURCHASE_API_ROLE}:INSERT:false`,
      ),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The table ACL entries (`grantee:PRIVILEGE:grantable`) other than the owner app_migrator, sorted, and the owner's presence. */
export async function tableAcl(
  client: Queryable,
  table: string,
): Promise<{ ownerPresent: boolean; others: string[] }> {
  const rows = (
    await client.query(
      `SELECT CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(e.grantee) END AS grantee,
              e.privilege_type AS privilege, e.is_grantable AS grantable
         FROM pg_class c, aclexplode(c.relacl) e WHERE c.oid = $1::regclass`,
      [`app.${table}`],
    )
  ).rows;
  return {
    ownerPresent: rows.some((row) => row.grantee === "app_migrator"),
    others: rows
      .filter((row) => row.grantee !== "app_migrator")
      .map((row) => `${row.grantee}:${row.privilege}:${row.grantable}`)
      .sort(),
  };
}

/** The table ACL the plan expects, apart from the owner. */
export const expectedTableAclOthers = (table: string): string[] =>
  hasTableSelect(table) ? [`${PURCHASE_API_ROLE}:SELECT:false`] : [];

/** `INSERT` of the granted columns plus one ungranted column, all NULL: a privilege error is the only possible 42501. */
export function ungrantedInsertStatement(table: string, column: string): string {
  const columns = [...(PURCHASE_API_INSERT_COLUMNS[table] ?? []), column];
  return `INSERT INTO app.${table} (${columns.join(", ")}) VALUES (${columns.map(() => "NULL").join(", ")})`;
}

/** The granted columns only, all NULL: the privilege check passes and the first NOT NULL column fails with 23502. */
export function grantedInsertStatement(table: string): string {
  const columns = PURCHASE_API_INSERT_COLUMNS[table] ?? [];
  return `INSERT INTO app.${table} (${columns.join(", ")}) VALUES (${columns.map(() => "NULL").join(", ")})`;
}

/** A column app_api_runtime has no INSERT privilege on, for tables it can otherwise SELECT (or INSERT some columns of). */
export const ungrantedProbeColumn = (table: string): string | undefined =>
  PURCHASE_API_UNGRANTED_INSERT_COLUMNS[table]?.[0] ?? KARAOKE_PROBE_COLUMNS[table];

/** The three runtime services of the harness: role and the service name createDatabase takes. */
export const RUNTIME_ROLE_SERVICES = [
  ["app_api_runtime", "api"],
  ["app_email_runtime", "email-worker"],
  ["app_reconciliation_runtime", "reconciliation-worker"],
] as const;

type PoolLike = { query(text: string): Promise<unknown> };

/**
 * The refusals a runtime pool must see (SQLSTATE 42501) on each table and the SELECT that must succeed:
 * - a role or table without any privilege: SELECT, INSERT DEFAULT VALUES, UPDATE, DELETE and TRUNCATE are refused;
 * - app_api_runtime on a table it can SELECT: SELECT succeeds; UPDATE, DELETE, TRUNCATE and an INSERT that names an
 *   ungranted column are refused. `INSERT ... DEFAULT VALUES` is not used there: PostgreSQL checks it against "any
 *   column" INSERT privilege, so on a table with column grants it fails with 23502, not 42501.
 */
export async function expectRuntimePoolBehavior(
  poolOf: (role: string) => PoolLike,
  tables: readonly { table: string; updateColumn: string }[],
): Promise<void> {
  for (const [role] of RUNTIME_ROLE_SERVICES) {
    const pool = poolOf(role);
    for (const { table, updateColumn } of tables) {
      const selectable = role === PURCHASE_API_ROLE && hasTableSelect(table);
      const probe = ungrantedProbeColumn(table);
      const refused = [
        `UPDATE app.${table} SET ${updateColumn} = ${updateColumn} WHERE false`,
        `DELETE FROM app.${table} WHERE false`,
        `TRUNCATE app.${table}`,
        ...(selectable
          ? [probe ? ungrantedInsertStatement(table, probe) : ""].filter(Boolean)
          : [`SELECT 1 FROM app.${table}`, `INSERT INTO app.${table} DEFAULT VALUES`]),
      ];
      if (selectable && !probe) throw new Error(`no ungranted INSERT probe column for ${table}`);
      for (const statement of refused)
        await expect(pool.query(statement), `${role}: ${statement}`).rejects.toMatchObject({
          code: "42501",
        });
      if (selectable)
        await expect(
          pool.query(`SELECT 1 FROM app.${table}`),
          `${role}: SELECT ${table}`,
        ).resolves.toBeDefined();
    }
  }
}
