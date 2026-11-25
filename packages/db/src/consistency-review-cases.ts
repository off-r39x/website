import {
  type ReviewCaseOpenInput,
  reviewCaseOpenInputSchema,
} from "@off-r39x/application/review-case";
import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { consistencyReviewCases } from "./schema/cross-functional.ts";

// Consistency Review Case opening (SPEC-100 §43, SPEC-150 §43-§44; DB-XFN-002..004, REL-REC-007..009, REL-REC-013,
// REL-REC-016, REL-AUTH-009; UCR-100-004). The adapter of the PR-S0-5 port (packages/application/src/review-case.ts).
//
// It works on the caller's transaction, as `insertAuditEvent` and `claimTransportIdempotency` do: it never opens a
// connection or a transaction, never retries and never logs. Both statements are built from the Drizzle table
// declaration (DEV-DB-004). A failure from PostgreSQL is rethrown as the driver's own error so that `transaction()`
// can classify it by SQLSTATE. The input is checked before anything reaches the database, and a rejection names no
// value. The lifecycle event of SPEC-160 OBS-REC-004 is the caller's, after commit: the result says whether the
// Case was opened or already existed.
//
// Plan U-1: SPEC-150 REL-REC-007 fixes only the form of the dedupe key; the primary entity type and the cause
// discriminator of each reason are defined for AUTH_PROFILE_RELATION_INCONSISTENT alone (REL-REC-016). Every other
// reason is refused until UCR-150-004 defines its key, so that no caller invents one.

/**
 * `opened`: a new Case. `existing`: the Case of the same dedupe key, unresolved or resolved (REL-AUTH-009 converges
 * on it either way). `caseRef` is the Case Public Reference (SPEC-160 Consistency Review Reference); the Auth
 * Subject, the dedupe key and the Internal ID never leave this module (DB-XFN-004, DEV-TS-005).
 */
export type ConsistencyReviewCaseOpenResult = {
  readonly status: "opened" | "existing";
  readonly caseRef: string;
  readonly resolved: boolean;
};

const AUTH_PROFILE_REASON = "AUTH_PROFILE_RELATION_INCONSISTENT";

// drizzle-orm wraps driver errors in DrizzleQueryError (SQL text and bound values in its message, SQLSTATE on
// `cause`). Rethrow the driver's own error, as insertAuditEvent and the Profile repository do; the wrapper's message
// would carry the Auth Subject and the dedupe key.
function driverError(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause !== undefined ? error.cause : error;
}

/**
 * Opens the Case of `input` on the caller's transaction, or converges on the Case of the same dedupe key
 * (DB-XFN-002). REL-REC-016: `r150:AUTH_PROFILE_RELATION_INCONSISTENT:auth_subject:<auth_subject>:epoch-<n>`, where
 * the caller counts `<n>` (resolved Cases + 1) in the same statement as the 0-row reselect. REL-AUTH-009: the Case
 * names the Auth Subject only and details keep the column default {}. The INSERT ... ON CONFLICT DO NOTHING waits
 * for a concurrent transaction that holds the same key; the reselect is a separate statement, so under READ
 * COMMITTED it sees that transaction's committed Case. A reselect that finds nothing is an error, never a second
 * INSERT.
 */
export async function openConsistencyReviewCase(
  tx: PoolClient,
  input: ReviewCaseOpenInput,
): Promise<ConsistencyReviewCaseOpenResult> {
  const parsed = reviewCaseOpenInputSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid consistency review case input");
  const checked = parsed.data;
  if (checked.reasonCode !== AUTH_PROFILE_REASON)
    throw new Error("Consistency review dedupe key is not specified for this reason (UCR-150-004)");
  const dedupeKey = `r150:${AUTH_PROFILE_REASON}:auth_subject:${checked.authSubject}:epoch-${checked.epoch}`;
  const t = consistencyReviewCases;
  const db = drizzle(tx);
  try {
    const inserted = await db
      .insert(t)
      .values({ dedupeKey, reasonCode: AUTH_PROFILE_REASON, authSubject: checked.authSubject })
      .onConflictDoNothing({ target: t.dedupeKey })
      .returning({ publicRef: t.publicRef });
    const opened = inserted[0];
    if (opened !== undefined)
      return { status: "opened", caseRef: opened.publicRef, resolved: false };
    const existing = await db
      .select({ publicRef: t.publicRef, resolved: sql<boolean>`${t.resolvedAt} IS NOT NULL` })
      .from(t)
      .where(eq(t.dedupeKey, dedupeKey));
    const row = existing[0];
    if (existing.length !== 1 || row === undefined)
      throw new Error("Consistency review case reselect cardinality violation");
    return { status: "existing", caseRef: row.publicRef, resolved: row.resolved };
  } catch (error) {
    throw driverError(error);
  }
}
