import {
  type NotificationEnqueueInput,
  notificationBusinessCauseKey,
  notificationEnqueueInputSchema,
} from "@off-r39x/application/notification";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { notificationRequests } from "./schema/cross-functional.ts";

// Notification Request enqueue (SPEC-100 §42, SPEC-120 §8.1-§8.3; DB-XFN-001, EML-GEN-001..004, EML-DB-001..003).
// The adapter of the PR-S0-5 port (packages/application/src/notification.ts).
//
// It works on the caller's Business transaction, as `insertAuditEvent` and `claimTransportIdempotency` do: it never
// opens a connection or a transaction, never retries and never logs, and makes no Resend, Neon Auth or Stripe call
// (EML-GEN-002). Both statements are built from the Drizzle table declaration (DEV-DB-004); only the comparison of
// the reselect is an SQL fragment, with every value bound. A failure from PostgreSQL is rethrown as the driver's own
// error so that `transaction()` can classify it by SQLSTATE and retry the whole callback. The input is checked
// before anything reaches the database, and a rejection names no value. The Email delivery Job of SPEC-120 §8.1
// step 6 is not written here: app.email_delivery_jobs comes with PR-L3-1, which adds it to the same transaction by
// this function's Business Cause key.

/**
 * `created`: a new PENDING row. `existing`: a row of the same Business Cause with the same type, recipient, source
 * Order / Reservation and render context already exists, whatever its state (no resend, no source re-run).
 * `conflict`: a row of the same Business Cause holds different content; it is left unchanged (EML-GEN-004) and the
 * caller tracks the Consistency Failure (SPEC-120 §8.3; the Case is opened once UCR-150-004 defines its dedupe key,
 * plan U-4). The Business Cause key is the UUIDv5 of SPEC-120 §8.2, not an Internal ID.
 */
export type NotificationEnqueueResult = {
  readonly status: "created" | "existing" | "conflict";
  readonly businessCauseKey: string;
};

// drizzle-orm wraps driver errors in DrizzleQueryError (SQL text and bound values in its message, SQLSTATE on
// `cause`). Rethrow the driver's own error, as insertAuditEvent and the Profile repository do.
function driverError(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause !== undefined ? error.cause : error;
}

/**
 * Inserts the PENDING Notification Request of `input` on the caller's transaction, or converges on the row of the
 * same Business Cause (DB-XFN-001). The INSERT ... ON CONFLICT DO NOTHING waits for a concurrent transaction that
 * holds the same key; the reselect is a separate statement, so under READ COMMITTED it sees that transaction's
 * committed row (the reason of SPEC-100 `DB-AUTH-003`). A reselect that finds nothing is an error, never a second
 * INSERT.
 */
export async function enqueueNotificationRequest(
  tx: PoolClient,
  input: NotificationEnqueueInput,
): Promise<NotificationEnqueueResult> {
  const parsed = notificationEnqueueInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid notification request input");
  const checked = parsed.data;
  const businessCauseKey = notificationBusinessCauseKey(checked);
  const t = notificationRequests;
  const db = drizzle(tx);
  try {
    const inserted = await db
      .insert(t)
      .values({
        businessCauseKey,
        notificationType: checked.notificationType,
        recipientProfileId: checked.recipientProfileId,
        sourceOrderId: checked.sourceOrderId,
        sourceReservationId: checked.sourceReservationId,
        state: "PENDING",
        renderContext: checked.renderContext,
      })
      .onConflictDoNothing({ target: t.businessCauseKey })
      .returning({ businessCauseKey: t.businessCauseKey });
    if (inserted.length === 1) return { status: "created", businessCauseKey };
    // SPEC-120 §8.3: the existing row is compared on the type, the recipient, the source relation and the render
    // context. jsonb equality compares JSON values, independent of key order and whitespace, so it is the
    // deterministic context comparison of §8.3. The template version is pinned on the delivery Job (SPEC-120 §39),
    // not on this row.
    const existing = await db
      .select({
        same: sql<boolean>`(${t.notificationType} = ${checked.notificationType} AND ${t.recipientProfileId} = ${checked.recipientProfileId} AND ${t.sourceOrderId} IS NOT DISTINCT FROM ${checked.sourceOrderId}::bigint AND ${t.sourceReservationId} IS NOT DISTINCT FROM ${checked.sourceReservationId}::bigint AND ${t.renderContext} = ${JSON.stringify(checked.renderContext)}::jsonb)`,
      })
      .from(t)
      .where(eq(t.businessCauseKey, businessCauseKey));
    const row = existing[0];
    if (existing.length !== 1 || row === undefined)
      throw new Error("Notification request reselect cardinality violation");
    return { status: row.same ? "existing" : "conflict", businessCauseKey };
  } catch (error) {
    throw driverError(error);
  }
}
