import type { Client } from "pg";
import { sqlState } from "./errors.ts";

// Migration lock (SPEC-180 section 24, INF-DB-008, INF-SEED-003): one session-level advisory lock,
// `hashtext('r39x:schema-migration')`, held on a dedicated app_migrator connection. `runMigrations`
// takes the same lock; a session advisory lock is re-entrant, so a caller that already holds it (this
// handle) can run `runMigrations` on the same client without changing that function.

export class MigrationPrincipalError extends Error {
  constructor() {
    super("Dedicated app_migrator connection required");
    this.name = "MigrationPrincipalError";
  }
}

export class MigrationLockTimeoutError extends Error {
  constructor() {
    super("Migration lock was not acquired in time");
    this.name = "MigrationLockTimeoutError";
  }
}

/** Proof that `client` holds the migration lock. Only `acquireMigrationLock` issues one. */
export type MigrationLock = {
  readonly client: Client;
  /** Releases the lock once. Returns false when it was already released or the connection is gone. */
  release(): Promise<boolean>;
};

// Issued and not yet released handles. A forged object, or a handle that was released, is not here
// (the same registry approach as the Audit change specs; `pg_locks` is never read, INF-SEED-003).
const active = new WeakSet<object>();

/** Marks a handle as no longer usable (its connection was abandoned); `release()` then sends nothing. */
export function invalidateMigrationLock(lock: MigrationLock): void {
  active.delete(lock);
}

export function isActiveMigrationLock(lock: unknown): lock is MigrationLock {
  return typeof lock === "object" && lock !== null && active.has(lock);
}

/** SPEC-180 section 24: the migration lock is acquired within 60 seconds, or the deployment fails. */
export const MIGRATION_LOCK_ACQUIRE_MS = 60_000;

/**
 * Takes the migration lock on `client` (a dedicated, connected app_migrator connection). Waits up to
 * 60 seconds (SPEC-180 section 24). Another role is refused before any lock statement is sent.
 *
 * The server-side `lock_timeout` cannot end a wait for an answer that never arrives (the network stops
 * answering), so the whole acquisition, the statements before the lock included, is also bounded on
 * the client by `deadlineMs` (60 seconds; overridable for tests). When it passes, the client is ended:
 * pg destroys the socket of a client with a query in flight, so the backend ends, and a lock it may
 * already have granted goes with it. The result is `MigrationLockTimeoutError`; do not use the client
 * afterwards.
 */
export async function acquireMigrationLock(
  client: Client,
  options: { readonly deadlineMs?: number } = {},
): Promise<MigrationLock> {
  let abandoned = false;
  const timer = setTimeout(
    () => {
      abandoned = true;
      void client.end().catch(() => {});
    },
    Math.max(options.deadlineMs ?? MIGRATION_LOCK_ACQUIRE_MS, 0),
  );
  timer.unref();
  try {
    const role = (await client.query("SELECT current_user AS role")).rows[0]?.role;
    if (role !== "app_migrator") throw new MigrationPrincipalError();
    await client.query("SET lock_timeout = '60s'");
    await client.query("SET statement_timeout = '65s'");
    await client.query("SET timezone = 'UTC'");
    await client.query("SELECT pg_advisory_lock(hashtext('r39x:schema-migration'))");
    if (abandoned) throw new MigrationLockTimeoutError();
  } catch (error) {
    if (abandoned || sqlState(error) === "55P03") throw new MigrationLockTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const lock: MigrationLock = {
    client,
    async release() {
      if (!active.delete(lock)) return false;
      try {
        const result = await client.query(
          "SELECT pg_advisory_unlock(hashtext('r39x:schema-migration')) AS released",
        );
        return result.rows[0]?.released === true;
      } catch {
        return false;
      }
    },
  };
  active.add(lock);
  return lock;
}
