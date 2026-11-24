import { sql } from "drizzle-orm";
import { bigint, customType, timestamp, uuid } from "drizzle-orm/pg-core";

// Column helpers only (DEV-DB-006, SPEC-100 §7 / DB-ID-003). Each call returns a fresh column builder;
// builders are stateful and must not be shared between tables. Constraints (PK, UNIQUE, FK,
// CHECK) and their explicit names stay in each table definition (DB-ARC-007), and no helper
// hides a Domain State column (DB-STA-001).

/** Internal ID: `id bigint GENERATED ALWAYS AS IDENTITY`, lossless bigint mode. */
export const internalId = () => bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity();

/** Public reference: `public_ref uuid NOT NULL DEFAULT gen_random_uuid()`. UNIQUE is declared per table. */
export const publicRef = () => uuid("public_ref").notNull().defaultRandom();

/** Nullable `timestamptz` column. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/** `timestamptz NOT NULL DEFAULT transaction_timestamp()`. */
export const timestamptzNow = (name: string) =>
  timestamptz(name).notNull().default(sql`transaction_timestamp()`);

/** `bytea`, read and written as a `Uint8Array` (SPEC-100 §56). */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});
