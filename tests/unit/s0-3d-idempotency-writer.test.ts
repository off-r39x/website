import type { PoolClient } from "pg";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  claimTransportIdempotency,
  setTransportIdempotencyResult,
} from "../../packages/db/src/idempotency-records.ts";

// PR-S0-3d C1 (SPEC-100 section 43.1 DB-IDM-001, SPEC-110 section 18.1 API-IDM-005 / 007): the input
// validation of the claim primitive. Every malformed input is refused before a single query is sent, with
// a fixed message that does not contain the value (TST-UNT-003). A fake client records what the primitive
// sends; it proves only the number and shape of the queries, never a DB constraint (TST-UNT-001): the
// constraints and the decisions are TC-DB-IDM-001-001 / TC-API-IDM-006-001 on real PostgreSQL 17. The
// primitive accepts digests and references only: there is no parameter for a raw Idempotency-Key.
// Synthetic values only.

const uuid = (n: number) => `00000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);
const VALID_INPUT = {
  principalProfileRef: uuid(0xa1),
  operationId: "API-ORD-002",
  keyDigest: bytes(32, 1),
  requestDigest: bytes(32, 2),
};
const VALID_RESULT = { type: "SYNTHETIC_EFFECT", refs: [uuid(0xb1)] };

type Sent = { sql: string; params: unknown[] };
function fake() {
  const query = vi.fn(async (_config: unknown, _params?: unknown[]) => ({
    rows: [{ id: "1", xact: "100" }],
    rowCount: 1,
  }));
  const client = { query } as unknown as PoolClient;
  const sent = (): Sent[] =>
    query.mock.calls.map(([config, params]) => ({
      sql: typeof config === "string" ? config : (config as { text: string }).text,
      params:
        typeof config === "string"
          ? (params ?? [])
          : ((config as { values?: unknown[] }).values ?? []),
    }));
  return { client, sent };
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be refused");
}

type Input = typeof VALID_INPUT;
const claim = (client: PoolClient, input: unknown) =>
  claimTransportIdempotency(client, input as Input);
const withField = (field: keyof Input, value: unknown) => ({ ...VALID_INPUT, [field]: value });

describe("TC-DB-IDM-001-003 the claim primitive validates its input before any query", () => {
  const CLAIM_CASES: [field: keyof Input, label: string, value: unknown][] = [
    ["keyDigest", "31 bytes", bytes(31)],
    ["keyDigest", "33 bytes", bytes(33)],
    ["keyDigest", "empty", bytes(0)],
    ["keyDigest", "a hex string of 64 characters", "ab".repeat(32)],
    ["keyDigest", "a plain number array of 32", Array.from({ length: 32 }, () => 1)],
    ["keyDigest", "a Uint16Array of 32", new Uint16Array(32)],
    ["keyDigest", "an ArrayBuffer of 32", new ArrayBuffer(32)],
    ["keyDigest", "null", null],
    ["keyDigest", "undefined", undefined],
    ["requestDigest", "31 bytes", bytes(31)],
    ["requestDigest", "33 bytes", bytes(33)],
    ["requestDigest", "empty", bytes(0)],
    ["requestDigest", "a hex string of 64 characters", "cd".repeat(32)],
    ["requestDigest", "a plain number array of 32", Array.from({ length: 32 }, () => 2)],
    ["requestDigest", "a Float32Array of 32", new Float32Array(32)],
    ["requestDigest", "null", null],
    ["requestDigest", "undefined", undefined],
    ["principalProfileRef", "not a UUID", "synthetic-not-a-uuid"],
    ["principalProfileRef", "empty", ""],
    ["principalProfileRef", "a UUID with a trailing character", `${uuid(0xa1)}0`],
    ["principalProfileRef", "an internal numeric id", "42"],
    ["principalProfileRef", "a number", 42],
    ["principalProfileRef", "undefined", undefined],
    ["operationId", "lower case", "api-ord-002"],
    ["operationId", "underscores", "API_ORD_002"],
    ["operationId", "empty", ""],
    ["operationId", "without an Operation segment", "API-"],
    ["operationId", "without the API prefix", "ORD-002"],
    ["operationId", "with a trailing space", "API-ORD-002 "],
    ["operationId", "with a trailing newline", "API-ORD-002\n"],
    ["operationId", "with an SQL fragment", "API-ORD-002'; --"],
    ["operationId", "a number", 2],
    ["operationId", "undefined", undefined],
  ];

  for (const [field, label, value] of CLAIM_CASES) {
    it(`TC-DB-IDM-001-003 claim: ${field} as ${label} is refused with no query sent`, async () => {
      const { client, sent } = fake();
      await expect(claim(client, withField(field, value))).rejects.toThrow();
      expect(sent(), "queries sent").toHaveLength(0);
    });
  }

  it("TC-DB-IDM-001-003 claim: the refusal message is fixed per field and never contains the offending value", async () => {
    const { client, sent } = fake();
    const probes: Record<string, [unknown, unknown]> = {
      principalProfileRef: ["synthetic-bad-ref-one", "synthetic-bad-ref-two"],
      operationId: ["synthetic-bad-operation-one", "synthetic-bad-operation-two"],
      keyDigest: ["synthetic-bad-key-digest-one", "synthetic-bad-key-digest-two"],
      requestDigest: ["synthetic-bad-request-digest-one", "synthetic-bad-request-digest-two"],
    };
    for (const [field, [one, two]] of Object.entries(probes)) {
      const first = await messageOf(() => claim(client, withField(field as keyof Input, one)));
      const second = await messageOf(() => claim(client, withField(field as keyof Input, two)));
      expect(first, `${field}: the message does not depend on the value`).toBe(second);
      expect(first).not.toContain(String(one));
      expect(second).not.toContain(String(two));
      expect(first.length).toBeGreaterThan(0);
    }
    // Digest bytes never appear in a message either.
    const digestMessage = await messageOf(() =>
      claim(client, withField("keyDigest", bytes(31, 123))),
    );
    expect(digestMessage).not.toMatch(/123/);
    expect(sent()).toHaveLength(0);
  });

  it("TC-DB-IDM-001-003 claim: a valid input sends queries with bound parameters only; the SQL text carries none of the values and no raw key is in the parameters (DEV-DB-004)", async () => {
    const { client, sent } = fake();
    await claim(client, VALID_INPUT).catch(() => undefined);
    const queries = sent();
    expect(queries.length, "the claim sends at least one query").toBeGreaterThan(0);
    const all = queries.map((q) => q.sql).join("\n");
    expect(all).not.toContain(VALID_INPUT.principalProfileRef);
    expect(all).not.toContain(VALID_INPUT.operationId);
    expect(all).not.toContain(Buffer.from(VALID_INPUT.keyDigest).toString("hex"));
    expect(all).toMatch(/app\.idempotency_records/);
    // The first statement binds the Principal reference and the Operation ID as parameters.
    const params = queries[0]?.params ?? [];
    expect(params).toContain(VALID_INPUT.principalProfileRef);
    expect(params).toContain(VALID_INPUT.operationId);
    // The expiry is computed by the database (transaction_timestamp()), never passed in (DB-IDM-003).
    expect(all).toMatch(/transaction_timestamp\(\)/);
    for (const param of params) {
      expect(typeof param === "string" && /^synthetic-idem-key/.test(param)).toBe(false);
    }
    // No statement deletes: DB-IDM-003 (an expired row is updated in place).
    expect(all).not.toMatch(/\bDELETE\b/i);
  });
});

describe("TC-DB-IDM-001-003 setTransportIdempotencyResult validates the result before any query", () => {
  // The handle is opaque and comes from a first claim on the same client: the fake database answers the
  // claim's INSERT with one row, which the primitive reads as `first`. `claimed()` forgets the claim's
  // queries, so `sent()` shows only what setTransportIdempotencyResult sends.
  type Handle = Parameters<typeof setTransportIdempotencyResult>[1];
  async function claimed() {
    const db = fake();
    const claim = await claimTransportIdempotency(db.client, VALID_INPUT);
    if (claim.status !== "first") throw new Error("the fake claim must be first");
    (db.client.query as unknown as ReturnType<typeof vi.fn>).mockClear();
    return { ...db, handle: claim.handle as Handle };
  }
  let handle: Handle;
  let shared: Awaited<ReturnType<typeof claimed>>;
  beforeAll(async () => {
    shared = await claimed();
    handle = shared.handle;
  });
  const set = (client: PoolClient, result: unknown, using: Handle = handle) =>
    setTransportIdempotencyResult(
      client,
      using,
      result as Parameters<typeof setTransportIdempotencyResult>[2],
    );
  /** A fresh fake with its own first claim, so a refusal is about `result`, not about the handle. */
  const fresh = async () => {
    const db = await claimed();
    return {
      client: db.client,
      sent: db.sent,
      run: (result: unknown) => set(db.client, result, db.handle),
    };
  };

  // Arrays with holes: `every` skips a hole, and a hole spreads to undefined, which pg binds as NULL.
  const oneHole = new Array<string>(1);
  const validThenHole = [uuid(0xb1)];
  validThenHole.length = 2;
  // biome-ignore lint/suspicious/noSparseArray: a hole before a valid reference is the case under test
  const holeThenValid = [, uuid(0xb1)];
  const RESULT_CASES: [label: string, value: unknown][] = [
    ["an empty refs array", { type: "SYNTHETIC_EFFECT", refs: [] }],
    ["a non UUID ref", { type: "SYNTHETIC_EFFECT", refs: ["synthetic-not-a-uuid"] }],
    ["an upper case UUID ref", { type: "SYNTHETIC_EFFECT", refs: [uuid(0xb1).toUpperCase()] }],
    ["one bad ref among good ones", { type: "SYNTHETIC_EFFECT", refs: [uuid(0xb1), "bad"] }],
    ["a numeric ref", { type: "SYNTHETIC_EFFECT", refs: [42] }],
    ["refs that is not an array", { type: "SYNTHETIC_EFFECT", refs: uuid(0xb1) }],
    ["a refs array of one hole", { type: "SYNTHETIC_EFFECT", refs: oneHole }],
    ["a valid ref followed by a hole", { type: "SYNTHETIC_EFFECT", refs: validThenHole }],
    ["a hole followed by a valid ref", { type: "SYNTHETIC_EFFECT", refs: holeThenValid }],
    ["an undefined ref", { type: "SYNTHETIC_EFFECT", refs: [uuid(0xb1), undefined] }],
    ["a null ref", { type: "SYNTHETIC_EFFECT", refs: [null] }],
    ["a lower case type", { type: "synthetic_effect", refs: [uuid(0xb1)] }],
    ["an empty type", { type: "", refs: [uuid(0xb1)] }],
    ["a type starting with a digit", { type: "1SYNTHETIC", refs: [uuid(0xb1)] }],
    ["a type of 65 characters", { type: `A${"B".repeat(64)}`, refs: [uuid(0xb1)] }],
    ["a type with a space", { type: "SYNTHETIC EFFECT", refs: [uuid(0xb1)] }],
    ["a type that looks like an Email", { type: "USER@EXAMPLE.TEST", refs: [uuid(0xb1)] }],
    ["a type that looks like a URL", { type: "HTTPS://EXAMPLE.TEST/CHECKOUT", refs: [uuid(0xb1)] }],
    ["a missing type", { refs: [uuid(0xb1)] }],
    ["a null type", { type: null, refs: [uuid(0xb1)] }],
  ];
  for (const [label, value] of RESULT_CASES) {
    it(`TC-DB-IDM-001-003 setResult: ${label} is refused with no query sent`, async () => {
      const db = await fresh();
      await expect(db.run(value)).rejects.toThrow("Invalid transport idempotency field: result");
      expect(db.sent(), "queries sent").toHaveLength(0);
    });
  }

  it("TC-DB-IDM-001-003 setResult: the refs are read once; the copy that was checked is the one bound, so a ref that changes on a second read never reaches the database", async () => {
    const db = await fresh();
    let reads = 0;
    const refs: string[] = [];
    Object.defineProperty(refs, 0, {
      enumerable: true,
      get: () => (reads++ === 0 ? uuid(0xb1) : "synthetic-changed-after-check"),
    });
    await db.run({ type: "SYNTHETIC_EFFECT", refs }).catch(() => undefined);
    const bound = db
      .sent()
      .flatMap((q) => q.params)
      .flat();
    expect(bound, "the checked value is bound").toContain(uuid(0xb1));
    expect(bound).not.toContain("synthetic-changed-after-check");
    expect(bound).not.toContain(undefined);
    expect(reads, "each element is read exactly once").toBe(1);
  });

  it("TC-DB-IDM-001-003 setResult: a valid result binds exactly the checked references, in order, with no undefined or null", async () => {
    const db = await fresh();
    const refs = [uuid(0xb1), uuid(0xb2), uuid(0xb3)];
    await db.run({ type: "SYNTHETIC_EFFECT", refs }).catch(() => undefined);
    const arrays = db
      .sent()
      .flatMap((q) => q.params)
      .filter((p): p is unknown[] => Array.isArray(p));
    expect(arrays).toEqual([refs]);
    expect(arrays[0], "a copy, not the caller's array").not.toBe(refs);
  });

  it("TC-DB-IDM-001-003 setResult: a handle used on another client is refused with no query sent (SPEC-100 section 43.1: the same transaction)", async () => {
    const other = fake();
    await expect(set(other.client, VALID_RESULT, handle)).rejects.toThrow(
      "Invalid transport idempotency field: handle",
    );
    expect(other.sent()).toHaveLength(0);
    expect(shared.sent()).toHaveLength(0);
  });

  it("TC-DB-IDM-001-003 setResult: a handle that did not come from a first claim is refused with no query sent", async () => {
    const db = fake();
    for (const forged of [{}, Object.freeze({}), null, "1", { id: "1" }]) {
      await expect(set(db.client, VALID_RESULT, forged as unknown as Handle)).rejects.toThrow(
        "Invalid transport idempotency field: handle",
      );
    }
    expect(db.sent()).toHaveLength(0);
  });

  it("TC-DB-IDM-001-003 setResult: a type of exactly 64 characters is not refused by validation, and the refusal messages are value independent", async () => {
    const valid = await fresh();
    await valid.run({ type: `A${"B".repeat(63)}`, refs: [uuid(0xb1)] }).catch(() => undefined);
    expect(valid.sent().length, "a valid result reaches the database").toBeGreaterThan(0);

    const refused = await fresh();
    const one = await messageOf(() => refused.run({ type: "bad-one", refs: [uuid(0xb1)] }));
    const two = await messageOf(() => refused.run({ type: "bad-two", refs: [uuid(0xb1)] }));
    expect(one).toBe(two);
    expect(one).not.toContain("bad-one");
    const refOne = await messageOf(() =>
      refused.run({ type: "SYNTHETIC_EFFECT", refs: ["synthetic-bad-ref-one"] }),
    );
    const refTwo = await messageOf(() =>
      refused.run({ type: "SYNTHETIC_EFFECT", refs: ["synthetic-bad-ref-two"] }),
    );
    expect(refOne).toBe(refTwo);
    expect(refOne).not.toContain("synthetic-bad-ref");
    expect(refused.sent()).toHaveLength(0);
  });

  it("TC-DB-IDM-001-003 setResult: refs are bound as parameters, never written into the SQL text", async () => {
    const db = await fresh();
    await db.run(VALID_RESULT).catch(() => undefined);
    const queries = db.sent();
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.map((q) => q.sql).join("\n")).not.toContain(VALID_RESULT.refs[0]);
    expect(queries.flatMap((q) => q.params).flat()).toContain(VALID_RESULT.refs[0]);
    expect(queries.map((q) => q.sql).join("\n")).not.toMatch(/\bDELETE\b/i);
  });
});
