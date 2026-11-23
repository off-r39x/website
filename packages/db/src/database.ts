import { checkServerIdentity } from "node:tls";
import { TIMEOUTS } from "@off-r39x/reliability";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { type DatabaseLogger, logDatabase, observeDatabase } from "./observability.ts";
import * as schema from "./schema/index.ts";

/**
 * pg_get_expr and pg_get_constraintdef write interval literals in the session IntervalStyle
 * ('00:30:00'::interval under postgres, 'PT30M'::interval under iso_8601). The required catalog
 * (schema-contract.json, INF-HLT-006) records the postgres style, so every connection that reads
 * the catalog fixes it. A startup option overrides database and role settings.
 */
export const INTERVAL_STYLE_OPTION = "-c intervalstyle=postgres";

export type DatabaseOptions = {
  connectionString: string;
  environment: "production" | "staging" | "development" | "test";
  service: "api" | "email-worker" | "reconciliation-worker";
  ca?: string;
  logger?: DatabaseLogger;
};
export function createDatabase(options: DatabaseOptions) {
  const url = new URL(options.connectionString);
  if (
    !/^postgres(ql)?:$/.test(url.protocol) ||
    (url.port && url.port !== "5432") ||
    url.hostname.includes("-pooler") ||
    url.search
  )
    throw new Error("Direct PostgreSQL URL without TLS query overrides required");
  const api = options.service === "api";
  const expectedUser = {
    api: "app_api_runtime",
    "email-worker": "app_email_runtime",
    "reconciliation-worker": "app_reconciliation_runtime",
  }[options.service];
  if (decodeURIComponent(url.username) !== expectedUser)
    throw new Error("Database runtime role mismatch");
  const max =
    options.environment === "production"
      ? api
        ? 8
        : 4
      : options.environment === "staging"
        ? api
          ? 4
          : 2
        : api
          ? 2
          : 1;
  const pool = new Pool({
    connectionString: options.connectionString,
    max,
    min: 0,
    connectionTimeoutMillis: TIMEOUTS.poolAcquireMs,
    idleTimeoutMillis: 30000,
    ssl: {
      rejectUnauthorized: true,
      servername: url.hostname,
      checkServerIdentity,
      ...(options.ca ? { ca: options.ca } : {}),
    },
    application_name: `r39x/${options.environment}/${options.service}`,
    options: `-c timezone=UTC ${INTERVAL_STYLE_OPTION} -c statement_timeout=${TIMEOUTS.statementMs} -c lock_timeout=${TIMEOUTS.lockMs} -c idle_in_transaction_session_timeout=${TIMEOUTS.transactionMs}`,
  });
  // Pool errors must not leak connection strings through an unhandled event.
  if (options.logger) observeDatabase(pool, options.logger);
  pool.on("error", () =>
    logDatabase(options.logger, {
      event_name: "db.availability.failed",
      level: "ERROR",
      result: "FAILED",
      is_retry: false,
      provider: "NEON_DB",
      failure_class: "TEMPORARY_FAILURE",
    }),
  );
  return { pool, db: drizzle(pool, { schema }), close: () => pool.end() };
}
