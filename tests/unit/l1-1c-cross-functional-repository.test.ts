import {
  type NotificationEnqueueInput,
  notificationBusinessCauseKey,
} from "@off-r39x/application/notification";
import type { ReviewCaseOpenInput } from "@off-r39x/application/review-case";
import { describe, expect, it } from "vitest";

// PR-L1-1c C1: what the two repository functions send and return, on a recording stand-in for the caller's
// transaction client. It proves the SQL parameters, the result shapes and what never leaves the functions
// (DB-XFN-004, DEV-TS-005); it is NOT evidence of PostgreSQL behaviour (TST-DB-001): the UNIQUE convergence, the
// constraint checks and the two-connection races are tests/db/l1-1c-cross-functional.test.ts on real PostgreSQL 17.
// The module is read through a string-keyed record so that this file type-checks before the functions exist (C1 is
// committed as a failing test). All values are synthetic.

type Call = { text: string; values: unknown[] };
type Reply = { rows: Record<string, unknown>[] } | Error;

interface Recorder {
  client: { query(text: string, values?: unknown[]): Promise<unknown> };
  calls: Call[];
}

/** A stand-in that answers each query with the next reply, in order. */
function recorder(replies: Reply[]): Recorder {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        const reply = replies.shift();
        if (reply === undefined) throw new Error("unexpected extra query");
        if (reply instanceof Error) throw reply;
        return { rows: reply.rows, rowCount: reply.rows.length };
      },
    },
  };
}

type Enqueue = (tx: unknown, input: unknown) => Promise<Record<string, unknown>>;
type Open = (tx: unknown, input: unknown) => Promise<Record<string, unknown>>;

async function load(): Promise<{ enqueue: Enqueue; open: Open }> {
  const db = (await import("../../packages/db/src/index.ts")) as unknown as Record<string, unknown>;
  expect(typeof db.enqueueNotificationRequest, "enqueueNotificationRequest is exported").toBe(
    "function",
  );
  expect(typeof db.openConsistencyReviewCase, "openConsistencyReviewCase is exported").toBe(
    "function",
  );
  return {
    enqueue: db.enqueueNotificationRequest as Enqueue,
    open: db.openConsistencyReviewCase as Open,
  };
}

const ORDER_REF = "00000000-0000-4000-8000-00000000c101";
const AUTH_SUBJECT = "0190a5f2-7c3e-7000-8000-00000000c102";
const CASE_REF = "00000000-0000-4000-8000-00000000c103";
const AUTH_REASON = "AUTH_PROFILE_RELATION_INCONSISTENT";

const entryInput = (overrides: Record<string, unknown> = {}) =>
  ({
    notificationType: "ENTRY_PURCHASE_CONFIRMED",
    recipientProfileId: 11n,
    sourceOrderId: 12n,
    sourceReservationId: null,
    renderContext: {
      event_name: "合成イベント",
      order_ref: ORDER_REF,
      confirmed_at: "2030-01-01T03:00:00.000Z",
      total: { amount: "2000", currency: "JPY" },
      entry_items: [{ offering_name: "合成入場券", quantity: 2 }],
    },
    ...overrides,
  }) as unknown as NotificationEnqueueInput;

const authInput = (epoch = 1) =>
  ({ reasonCode: AUTH_REASON, authSubject: AUTH_SUBJECT, epoch }) as unknown as ReviewCaseOpenInput;

describe("TC-DB-XFN-001-004 enqueueNotificationRequest writes one PENDING row keyed by the Business Cause on the caller's transaction (DB-XFN-001, EML-GEN-003)", () => {
  it("TC-DB-XFN-001-004 a new Business Cause is one INSERT ... ON CONFLICT DO NOTHING with the derived key, PENDING and the context as JSON; the result is created", async () => {
    const { enqueue } = await load();
    const input = entryInput();
    const key = notificationBusinessCauseKey(input);
    const tx = recorder([{ rows: [{ business_cause_key: key }] }]);
    expect(await enqueue(tx.client, input)).toEqual({ status: "created", businessCauseKey: key });
    expect(tx.calls).toHaveLength(1);
    const [insert] = tx.calls;
    expect(insert?.text).toMatch(/^INSERT INTO app\.notification_requests\b/);
    expect(insert?.text).toMatch(/ON CONFLICT \(business_cause_key\) DO NOTHING/);
    expect(insert?.text).toMatch(/'PENDING'/);
    expect(insert?.text).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b/i);
    expect(insert?.values).toContain(key);
    expect(insert?.values).toContain(11n);
    expect(insert?.values).toContain(12n);
    expect(insert?.values).toContain(null);
    expect(insert?.values).toContain("ENTRY_PURCHASE_CONFIRMED");
    const json = insert?.values.find((v) => typeof v === "string" && v.startsWith("{"));
    expect(JSON.parse(json as string)).toEqual(input.renderContext);
  });

  it("TC-DB-XFN-001-004 an existing Business Cause is reselected by a separate statement; the same content is existing and a different one is conflict", async () => {
    const { enqueue } = await load();
    const input = entryInput();
    const key = notificationBusinessCauseKey(input);
    for (const [same, status] of [
      [true, "existing"],
      [false, "conflict"],
    ] as const) {
      const tx = recorder([{ rows: [] }, { rows: [{ same }] }]);
      expect(await enqueue(tx.client, input)).toEqual({ status, businessCauseKey: key });
      expect(tx.calls).toHaveLength(2);
      expect(tx.calls[1]?.text).toMatch(/^SELECT\b/);
      expect(tx.calls[1]?.text).toMatch(/FROM app\.notification_requests\b/);
      expect(tx.calls[1]?.text).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
      expect(tx.calls[1]?.values).toContain(key);
    }
  });

  it("TC-DB-XFN-001-004 a reselect that finds no row is an error, never a second INSERT", async () => {
    const { enqueue } = await load();
    const tx = recorder([{ rows: [] }, { rows: [] }]);
    await expect(enqueue(tx.client, entryInput())).rejects.toThrow(/notification request/i);
    expect(tx.calls).toHaveLength(2);
  });

  it("TC-DB-XFN-001-004 a PostgreSQL error is rethrown unchanged, for transaction() to classify by SQLSTATE", async () => {
    const { enqueue } = await load();
    const failure = Object.assign(new Error("synthetic"), { code: "40P01" });
    const tx = recorder([failure]);
    await expect(enqueue(tx.client, entryInput())).rejects.toBe(failure);
  });
});

describe("TC-DB-XFN-004-001 nothing internal leaves the two functions (DB-XFN-004, DEV-TS-005)", () => {
  it("TC-DB-XFN-004-001 enqueue results carry the status and the Business Cause key only, never an Internal ID", async () => {
    const { enqueue } = await load();
    const tx = recorder([{ rows: [{ business_cause_key: "x", id: 99n }] }]);
    const result = await enqueue(tx.client, entryInput());
    expect(Object.keys(result).sort()).toEqual(["businessCauseKey", "status"]);
  });

  it("TC-DB-XFN-004-001 an invalid enqueue input is refused before any query, and the message names no value", async () => {
    const { enqueue } = await load();
    const secret = "user@example.com";
    for (const input of [
      entryInput({
        renderContext: { ...entryInput().renderContext, recipient_email: secret },
      }),
      entryInput({ recipientProfileId: secret }),
      entryInput({ notificationType: "UNKNOWN" }),
      entryInput({ sourceOrderId: null }),
      null,
    ]) {
      const tx = recorder([]);
      const error = await enqueue(tx.client, input).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error, "refused").toBeInstanceOf(Error);
      expect(error?.message).not.toContain(secret);
      expect(error?.message).not.toContain("UNKNOWN");
      expect(tx.calls).toEqual([]);
    }
  });

  it("TC-DB-XFN-004-001 open results carry the status, the Case Public Reference and resolved only; never the Auth Subject, the dedupe key or an Internal ID", async () => {
    const { open } = await load();
    const cases: [Reply[], Record<string, unknown>][] = [
      [
        [{ rows: [{ public_ref: CASE_REF }] }],
        { status: "opened", caseRef: CASE_REF, resolved: false },
      ],
      [
        [{ rows: [] }, { rows: [{ public_ref: CASE_REF, resolved: true }] }],
        { status: "existing", caseRef: CASE_REF, resolved: true },
      ],
      [
        [{ rows: [] }, { rows: [{ public_ref: CASE_REF, resolved: false }] }],
        { status: "existing", caseRef: CASE_REF, resolved: false },
      ],
    ];
    for (const [replies, expected] of cases) {
      const tx = recorder(replies);
      const result = await open(tx.client, authInput());
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(AUTH_SUBJECT);
      expect(JSON.stringify(result)).not.toContain("r150:");
    }
  });

  it("TC-DB-XFN-004-001 an invalid open input is refused before any query, and the message names neither the Auth Subject nor a dedupe key", async () => {
    const { open } = await load();
    for (const input of [
      { ...authInput(), authSubject: AUTH_SUBJECT.toUpperCase() },
      { ...authInput(), epoch: 0 },
      { ...authInput(), dedupeKey: `r150:${AUTH_REASON}:auth_subject:${AUTH_SUBJECT}:epoch-1` },
      { reasonCode: AUTH_REASON, targets: { orderId: 1n }, details: {} },
      undefined,
    ]) {
      const tx = recorder([]);
      const error = await open(tx.client, input).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error, "refused").toBeInstanceOf(Error);
      expect(error?.message).not.toContain(AUTH_SUBJECT);
      expect(error?.message).not.toContain(AUTH_SUBJECT.toUpperCase());
      expect(error?.message).not.toContain("r150:");
      expect(tx.calls).toEqual([]);
    }
  });
});

describe("TC-REL-REC-016-001 openConsistencyReviewCase opens only the AUTH reason, keyed by REL-REC-016 (plan U-1)", () => {
  it("TC-REL-REC-016-001 the dedupe key is r150:AUTH_PROFILE_RELATION_INCONSISTENT:auth_subject:<subject>:epoch-<n> in decimal without leading zeros", async () => {
    const { open } = await load();
    for (const epoch of [1, 2, 10, 12345]) {
      const tx = recorder([{ rows: [{ public_ref: CASE_REF }] }]);
      await open(tx.client, authInput(epoch));
      expect(tx.calls).toHaveLength(1);
      const [insert] = tx.calls;
      expect(insert?.text).toMatch(/^INSERT INTO app\.consistency_review_cases\b/);
      expect(insert?.text).toMatch(/ON CONFLICT \(dedupe_key\) DO NOTHING/);
      expect(insert?.text).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b/i);
      expect(insert?.values).toContain(
        `r150:AUTH_PROFILE_RELATION_INCONSISTENT:auth_subject:${AUTH_SUBJECT}:epoch-${epoch}`,
      );
      expect(insert?.values).toContain(AUTH_REASON);
      expect(insert?.values).toContain(AUTH_SUBJECT);
      // REL-AUTH-009: details are {} and no target FK is written.
      expect(insert?.text).not.toMatch(/\b(order_id|details)\b/);
    }
  });

  it("TC-REL-REC-016-001 an existing Case is reselected by the dedupe key in a separate statement", async () => {
    const { open } = await load();
    const tx = recorder([{ rows: [] }, { rows: [{ public_ref: CASE_REF, resolved: false }] }]);
    await open(tx.client, authInput(4));
    expect(tx.calls[1]?.text).toMatch(/^SELECT\b/);
    expect(tx.calls[1]?.text).toMatch(/FROM app\.consistency_review_cases\b/);
    expect(tx.calls[1]?.values).toEqual([
      `r150:AUTH_PROFILE_RELATION_INCONSISTENT:auth_subject:${AUTH_SUBJECT}:epoch-4`,
    ]);
  });

  it("TC-REL-REC-016-001 every other reason is refused before any query until UCR-150-004 defines its dedupe key", async () => {
    const { open } = await load();
    const input = {
      reasonCode: "PAY_BINDING_INCONSISTENT",
      targets: { orderId: 1n },
      details: {},
    } as ReviewCaseOpenInput;
    const tx = recorder([]);
    await expect(open(tx.client, input)).rejects.toThrow(/dedupe key/i);
    expect(tx.calls).toEqual([]);
  });

  it("TC-REL-REC-016-001 a PostgreSQL error is rethrown unchanged", async () => {
    const { open } = await load();
    const failure = Object.assign(new Error("synthetic"), { code: "55P03" });
    const tx = recorder([failure]);
    await expect(open(tx.client, authInput())).rejects.toBe(failure);
  });
});
