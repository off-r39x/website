// Test-only clock control for real PostgreSQL tests (fault injection stays in tests/harness): a
// connection pool whose unqualified statement_timestamp() returns a fixed instant, so that a period
// boundary can be placed exactly at, and one microsecond around, the instant the statement judges with.
// It works by name resolution only: a function of the same name in a test schema that the pool's
// search_path lists before pg_catalog. The repository SQL is not changed; a statement that qualified
// pg_catalog.statement_timestamp() would read the real clock instead, which the boundary rows of the
// caller (placed years away from now) would then show.
import { type Client, Pool } from "pg";

const SCHEMA = "r39x_test_clock";

export type FixedStatementClockOptions = {
  /** Superuser connection to the file's own database (creates and drops the test schema). */
  admin: Client;
  /** The runtime role URL without a query (the same as the repository's own pool). */
  runtimeUrl: string;
  ca: string;
  /** The instant statement_timestamp() returns, as a timestamptz literal (microseconds kept). */
  instant: string;
};

/**
 * Runs `fn` with a pool of the runtime role whose statement_timestamp() is `instant`, after checking that
 * the pool really reads that instant. The schema is dropped and the pool closed afterwards.
 */
export async function withFixedStatementClock<T>(
  options: FixedStatementClockOptions,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const { admin, runtimeUrl, ca, instant } = options;
  const role = decodeURIComponent(new URL(runtimeUrl).username);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  const pool = new Pool({
    connectionString: runtimeUrl,
    max: 1,
    ssl: { rejectUnauthorized: true, ca, servername: new URL(runtimeUrl).hostname },
    options: `-c timezone=UTC -c search_path=${SCHEMA},pg_catalog,"$user",public`,
  });
  pool.on("error", () => undefined);
  try {
    await admin.query(
      `CREATE FUNCTION ${SCHEMA}.statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT ${literal(instant)}::timestamptz $$`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${identifier(role)}`);
    const check = await pool.query<{ fixed: boolean }>(
      `SELECT statement_timestamp() = ${literal(instant)}::timestamptz AS fixed`,
    );
    if (check.rows[0]?.fixed !== true)
      throw new Error("the fixed statement clock is not in effect");
    return await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  }
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
