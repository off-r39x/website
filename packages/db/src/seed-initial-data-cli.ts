import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { checkServerIdentity } from "node:tls";
import { createLogger, type LogEvent } from "@off-r39x/observability";
import { TIMEOUTS } from "@off-r39x/reliability";
import { Client } from "pg";
import {
  endConnection,
  failedOutcome,
  openSeedConnection,
  outcomeExitCode,
  outcomeLogFields,
  SEED_OPERATION_ID,
  type SeedFailureClass,
  type SeedOutcome,
  seedInitialData,
} from "./initial-data/seed.ts";
import {
  acquireMigrationLock,
  type MigrationLock,
  MigrationLockTimeoutError,
  MigrationPrincipalError,
} from "./migration-lock.ts";

// Initial data seeding command (SPEC-180 section 45.3, INF-SEED-001..006). It runs as app_migrator on a
// direct TLS connection under the migration lock. stdout carries exactly one JSON line (the business
// specific result); stderr carries the common log lines. No exception message or stack, no input value,
// no connection string and no SQLSTATE is ever written (INF-SEED-005, INF-SEC-001, OBS-LOG-005).
// Exit codes: 0 CREATED / NOOP, 2 FAILED, 3 UNKNOWN_RESULT. Node itself exits 1 on a crash, which is
// treated like UNKNOWN_RESULT: run the command again.

const APP_ENVIRONMENTS = ["production", "staging", "development", "test"] as const;
type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];
const SAFE_REF = /^[A-Za-z0-9_:-]{1,128}$/;
const CLOSE_WAIT_MS = 3000;
const DIRECT_PORT = 5432;

type Logger = { log(event: LogEvent): void };

// A failure before any seed attempt ran is reported as attempt 1 (is_retry false).
const failedBeforeSeed = (
  operationExecutionId: string,
  failureClass: SeedFailureClass,
  errorCode: string,
): SeedOutcome => failedOutcome(operationExecutionId, 1, failureClass, errorCode);

/** Where the command connects: the checked parts of the URL, handed to pg one by one. */
type MigrationTarget = {
  readonly host: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
};

/**
 * The conditions of migrate-cli.ts, made stricter: a dedicated, direct app_migrator URL. The URL is taken apart
 * here, the way pg would read it (the host and the credentials percent-decoded), and the checks apply
 * to those decoded values: the `-pooler` check ignores case. pg then gets the parts, not the URL, with
 * the port fixed to 5432, so that neither a host spelled another way nor PGPORT / PGHOST can lead it
 * to another endpoint. The database name is required too: without one pg would read PGDATABASE (or
 * fall back to the user name), and the target would depend on the environment, not on the URL. A host
 * with a slash is refused: pg would take it as a Unix socket directory, without TLS.
 */
function migrationTarget(connectionString: string | undefined): MigrationTarget | undefined {
  if (!connectionString) return undefined;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }
  let user: string;
  let password: string;
  let host: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    host = decodeURIComponent(url.hostname.replace(/^\[(.+)\]$/, "$1"));
    database = decodeURI(url.pathname.slice(1));
  } catch {
    return undefined;
  }
  if (
    user !== "app_migrator" ||
    url.search ||
    host === "" ||
    // pg takes a host that starts with "/" as a Unix socket directory and connects to it without
    // TLS; no DNS name or address has a slash either, so any slash is refused.
    host.includes("/") ||
    database === "" ||
    host.toLowerCase().includes("-pooler") ||
    (url.port !== "" && url.port !== String(DIRECT_PORT))
  )
    return undefined;
  return { host, user, password, database };
}

/** Waits at most CLOSE_WAIT_MS for `work` (the unlock); the client itself is ended with endConnection. */
async function closeQuietly(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  const startedAt = performance.now();
  const fallbackExecutionId = randomUUID();
  const environment = process.env.APP_ENV;
  const appEnv = (APP_ENVIRONMENTS as readonly string[]).includes(environment ?? "")
    ? (environment as AppEnvironment)
    : undefined;
  const actorRef = SAFE_REF.test(process.env.INITIAL_DATA_SEED_ACTOR_REF ?? "")
    ? (process.env.INITIAL_DATA_SEED_ACTOR_REF as string)
    : undefined;
  let logger: Logger | undefined;
  if (appEnv !== undefined) {
    logger = createLogger(
      {
        service: "RECOVERY",
        environment: appEnv,
        actor_type: "INFRASTRUCTURE_OPERATOR",
        ...(actorRef === undefined ? {} : { actor_ref: actorRef }),
      },
      (line) => {
        process.stderr.write(`${line}\n`);
      },
    );
  }

  const target = migrationTarget(process.env.MIGRATION_DATABASE_URL);
  let outcome: SeedOutcome;
  if (appEnv === undefined || actorRef === undefined || target === undefined) {
    outcome = failedBeforeSeed(fallbackExecutionId, "PERMANENT_FAILURE", "CONFIGURATION_INVALID");
  } else {
    outcome = await execute(target, actorRef, logger, fallbackExecutionId);
  }

  const fields = outcomeLogFields(outcome);
  try {
    logger?.log({
      event_name: "provision.initial_data_seed.completed",
      level: fields.level,
      result: fields.result,
      failure_class: fields.failure_class,
      is_retry: outcome.attemptNumber > 1,
      operation_id: SEED_OPERATION_ID,
      operation_execution_id: outcome.operationExecutionId,
      attempt_number: outcome.attemptNumber,
      error_code: "errorCode" in outcome ? outcome.errorCode : null,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch {
    // Logging is not business authority.
  }

  const created = outcome.outcome === "CREATED" ? outcome.created : undefined;
  const events = [...(created?.events ?? [])];
  const offerings = [...(created?.entry_ticket_offerings ?? [])];
  process.stdout.write(
    `${JSON.stringify({
      schema_version: 1,
      operation_id: SEED_OPERATION_ID,
      operation_execution_id: outcome.operationExecutionId,
      outcome: outcome.outcome,
      actor_ref: actorRef ?? null,
      created: { events, entry_ticket_offerings: offerings },
      counts: { events: events.length, entry_ticket_offerings: offerings.length },
      audit_event_ids: outcome.outcome === "CREATED" ? [...outcome.auditEventIds] : [],
      error_code: "errorCode" in outcome ? outcome.errorCode : null,
    })}\n`,
  );
  process.exitCode = outcomeExitCode(outcome);
}

async function execute(
  target: MigrationTarget,
  actorRef: string,
  logger: Logger | undefined,
  executionId: string,
): Promise<SeedOutcome> {
  // Node warns (to stderr) when the TLS server name is an IP address; the certificate is then matched
  // against the address by checkServerIdentity itself.
  const servername = isIP(target.host) === 0 ? target.host : undefined;
  const newClient = (timeoutMs: number = TIMEOUTS.poolAcquireMs): Client => {
    const client = new Client({
      host: target.host,
      port: DIRECT_PORT,
      user: target.user,
      password: target.password,
      database: target.database,
      ssl: {
        rejectUnauthorized: true,
        ...(servername === undefined ? {} : { servername }),
        checkServerIdentity,
      },
      connectionTimeoutMillis: Math.max(1, Math.min(TIMEOUTS.poolAcquireMs, timeoutMs)),
      application_name: "r39x/deployment/initial-data-seed",
    });
    // A connection error after connect must not become an unhandled event (it would print a stack).
    client.on("error", () => {});
    return client;
  };

  // The client constructor reads the configuration (and the PG* variables it does not get); a
  // throw there is a configuration error, not a temporary failure.
  try {
    newClient();
  } catch {
    return failedBeforeSeed(executionId, "PERMANENT_FAILURE", "CONFIGURATION_INVALID");
  }
  const open = async ({ timeoutMs }: { readonly timeoutMs: number }): Promise<Client> => {
    const next = newClient(timeoutMs);
    try {
      await next.connect();
    } catch (error) {
      await endConnection(next, CLOSE_WAIT_MS);
      throw error;
    }
    return next;
  };

  // SPEC-150 section 11 "temporary DB connection acquisition": the first connection gets the same 3
  // attempts within 3 seconds, backoff included, as the re-check connection. A refused authentication
  // is not retried: FAILED(PERMANENT_FAILURE, DATABASE_AUTHENTICATION_FAILED).
  const opened = await openSeedConnection(open, {
    executionId,
    ...(logger === undefined ? {} : { logger }),
  });
  if (opened.kind === "failed") return opened.outcome;
  const client = opened.client;
  let lock: MigrationLock | undefined;
  try {
    try {
      lock = await acquireMigrationLock(client);
    } catch (error) {
      if (error instanceof MigrationPrincipalError)
        return failedBeforeSeed(executionId, "PERMANENT_FAILURE", "MIGRATION_PRINCIPAL_INVALID");
      if (error instanceof MigrationLockTimeoutError)
        return failedBeforeSeed(executionId, "TEMPORARY_FAILURE", "MIGRATION_LOCK_TIMEOUT");
      return failedBeforeSeed(executionId, "TEMPORARY_FAILURE", "DATABASE_TEMPORARY_FAILURE");
    }
    // No catch here: seedInitialData classifies every error of its own attempts. A throw that still
    // reaches this point is a bug or a pre-flight refusal, and cannot be proven to have happened before
    // COMMIT, so it must not be reported as FAILED (a rolled-back result). It leaves through the outer
    // handler as a crash (exit 1), which the README treats like UNKNOWN_RESULT: run the command again.
    return await seedInitialData({
      lock,
      connect: open,
      readInput: () => process.env.INITIAL_DATA_SEED_JSON,
      actorRef,
      ...(logger === undefined ? {} : { logger }),
    });
  } finally {
    if (lock) await closeQuietly(lock.release());
    // A peer that stops answering after the unlock would leave the socket (and the process) open:
    // endConnection destroys it after the wait.
    await endConnection(client, CLOSE_WAIT_MS);
  }
}

try {
  await run();
} catch {
  // Never print the exception. Whether COMMIT was reached is unknown here, so no FAILED result line
  // is claimed: exit 1 like a crash, and run the command again (it is idempotent).
  process.exitCode = 1;
}
