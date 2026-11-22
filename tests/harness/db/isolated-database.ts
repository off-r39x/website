import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll } from "vitest";
import { INTERVAL_STYLE_OPTION } from "../../../packages/db/src/database.ts";
import { installBaselineRoles } from "../../../packages/db/src/migrations.ts";

// The catalog goldens (orders-payments-golden.ts, idempotency-golden.ts) and the required catalog
// hold interval literals in the postgres IntervalStyle. node-postgres sends PGOPTIONS as the startup
// options of every connection that sets no options of its own, so a database or role default of
// another IntervalStyle does not change what pg_get_expr returns to the harness. Connections with
// explicit options (createDatabase, READINESS_OPTIONS) carry INTERVAL_STYLE_OPTION themselves.
process.env.PGOPTIONS = [process.env.PGOPTIONS, INTERVAL_STYLE_OPTION].filter(Boolean).join(" ");

// Vitest project.fileParallelism is not a scheduler control in v3. Use a fresh
// database per file so DDL/COMMIT faults cannot affect another worker's schema.
const source = process.env.TEST_DATABASE_URL;
if (!source || !process.env.TEST_DATABASE_CA) throw new Error("Real PG17 test settings required");
const admin = new Client({ connectionString: source });
await admin.connect();
const name = `r39x_test_${randomUUID().replaceAll("-", "")}`;
try {
  const version = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
  if (Math.floor(version / 10000) !== 17) throw new Error("Real PostgreSQL17 required");
  // Roles are cluster-wide; serialize their installation in the common setup DB.
  await admin.query("SELECT pg_advisory_lock(hashtext('r39x:test-role-setup'))");
  try {
    await installBaselineRoles(admin);
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtext('r39x:test-role-setup'))");
  }
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
} finally {
  await admin.end();
}
const isolated = new URL(source);
isolated.pathname = `/${name}`;
process.env.TEST_DATABASE_URL = isolated.href;
afterAll(async () => {
  process.env.TEST_DATABASE_URL = source;
  const cleanup = new Client({ connectionString: source });
  await cleanup.connect();
  try {
    await cleanup.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  } finally {
    await cleanup.end();
  }
});
