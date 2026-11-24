import {
  type NotificationEnqueueInput,
  notificationBusinessCauseKey,
  notificationEnqueueInputSchema,
} from "@off-r39x/application/notification";
import type { PoolClient } from "pg";

// Notification Request enqueue (SPEC-100 §42, SPEC-120 §8.1-§8.3; DB-XFN-001, EML-GEN-001..004, EML-DB-001..003).
// The adapter of the PR-S0-5 port (packages/application/src/notification.ts).
//
// It works on the caller's Business transaction, as `insertAuditEvent` and `claimTransportIdempotency` do: it never
// opens a connection or a transaction, never retries and never logs, and makes no Resend, Neon Auth or Stripe call
// (EML-GEN-002). A failure from PostgreSQL is rethrown unchanged so that `transaction()` can classify it by SQLSTATE
// and retry the whole callback. The input is checked before anything reaches the database, and a rejection names no
// value. The Email delivery Job of SPEC-120 §8.1 step 6 is not written here: app.email_delivery_jobs comes with
// PR-L3-1, which adds it to the same transaction by this function's Business Cause key.

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

const INSERT = `INSERT INTO app.notification_requests
    (business_cause_key, notification_type, recipient_profile_id, source_order_id, source_reservation_id, state,
     render_context)
  VALUES ($1, $2, $3, $4, $5, 'PENDING', $6::jsonb)
  ON CONFLICT (business_cause_key) DO NOTHING
  RETURNING business_cause_key`;

// SPEC-120 §8.3: the existing row is compared on the type, the recipient, the source relation and the render context.
// jsonb equality compares JSON values, independent of key order and whitespace, so it is the deterministic context
// comparison of §8.3. The template version is pinned on the delivery Job (SPEC-120 §39), not on this row.
const RESELECT = `SELECT (notification_type = $2
          AND recipient_profile_id = $3::bigint
          AND source_order_id IS NOT DISTINCT FROM $4::bigint
          AND source_reservation_id IS NOT DISTINCT FROM $5::bigint
          AND render_context = $6::jsonb) AS same
     FROM app.notification_requests
    WHERE business_cause_key = $1`;

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
  const values = [
    businessCauseKey,
    checked.notificationType,
    checked.recipientProfileId,
    checked.sourceOrderId,
    checked.sourceReservationId,
    JSON.stringify(checked.renderContext),
  ];
  const inserted = await tx.query(INSERT, values);
  if (inserted.rows.length === 1) return { status: "created", businessCauseKey };
  const existing = await tx.query<{ same: boolean }>(RESELECT, values);
  const row = existing.rows[0];
  if (existing.rows.length !== 1 || row === undefined)
    throw new Error("Notification request reselect cardinality violation");
  return { status: row.same ? "existing" : "conflict", businessCauseKey };
}
