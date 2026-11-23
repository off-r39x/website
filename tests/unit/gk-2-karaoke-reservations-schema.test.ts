import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as domain from "@off-r39x/domain";
import { describe, expect, it } from "vitest";
import {
  GOLDEN_TABLES,
  type GoldenTable,
  HOLD_EXPIRY_DECLARED,
  KARAOKE_HOLD_STATES,
  KARAOKE_RESERVATION_SEQUENCES,
  KARAOKE_RESERVATION_STATES,
  KARAOKE_TICKET_STATES,
  SPEC_COLUMN_COUNTS,
  SPEC_CONSTRAINT_COUNTS,
  SPEC_INDEX_COUNTS,
} from "../harness/db/karaoke-reservations-golden.ts";

// PR-GK-2 C1: pins the Drizzle declaration of the four Karaoke reservation tables of migration 0007
// (packages/db/src/schema/karaoke.ts; SPEC-100 §30, §33, §34, §37, §45, §55-§57) against the reviewed
// schema-contract.json and against the hand-written goldens of tests/harness/db/karaoke-reservations-golden.ts.
// Static only: no database. DB enforcement of the same tables is tests/db/gk-2-karaoke-reservations.test.ts on real
// PostgreSQL 17 (TST-UNT-001, TST-GEN-004). The serialisation approach mirrors l1-1a-orders-payments-schema.test.ts;
// helpers are intentionally copied, not shared. The schema module is read through a string-keyed record so that this file
// type-checks before the tables exist (C1 is committed as a failing test).

const dbPackageJson = new URL("../../packages/db/package.json", import.meta.url);
const contractUrl = new URL("../../packages/db/src/schema-contract.json", import.meta.url);
const dbRequire = createRequire(dbPackageJson);

interface DrizzleColumn {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  default?: unknown;
  columnType: string;
  generated?: { as: unknown; type: string; mode?: string };
  generatedIdentity?: { type: string };
  getSQLType(): string;
}
interface DrizzleForeignKey {
  getName(): string;
  onDelete?: string;
  onUpdate?: string;
  reference(): {
    columns: DrizzleColumn[];
    foreignColumns: DrizzleColumn[];
    foreignTable: unknown;
  };
}
interface DrizzleNamedColumns {
  name?: string;
  getName?: () => string;
  columns: DrizzleColumn[];
}
interface DrizzleIndex {
  config: {
    name: string;
    unique: boolean;
    method: string;
    columns: { name: string; indexConfig?: { order?: string } }[];
    where?: unknown;
  };
}
interface DrizzleTableConfig {
  name: string;
  schema?: string;
  columns: DrizzleColumn[];
  indexes: DrizzleIndex[];
  foreignKeys: DrizzleForeignKey[];
  checks: { name: string; value: unknown }[];
  primaryKeys: DrizzleNamedColumns[];
  uniqueConstraints: DrizzleNamedColumns[];
}
const { getTableConfig, PgDialect } = dbRequire("drizzle-orm/pg-core") as {
  getTableConfig(table: unknown): DrizzleTableConfig;
  PgDialect: new () => { sqlToQuery(query: unknown): { sql: string; params: unknown[] } };
};

type ContractColumn = [string, string, string, boolean, string, string, string | null];
type ContractIndex = [table: string, definition: string, ...flags: boolean[]];
type ContractConstraint = [string, string, string, string, ...boolean[]];
interface SchemaContract {
  tables: [string, ...unknown[]][];
  columns: ContractColumn[];
  indexes: ContractIndex[];
  constraints: ContractConstraint[];
  sequences: [string, ...unknown[]][];
}
const contract = JSON.parse(readFileSync(contractUrl, "utf8")) as SchemaContract;

const loadSchema = async () =>
  (await import("@off-r39x/db/schema")) as unknown as Record<string, unknown>;

// ---- expression helpers (same method as gk-1-karaoke-schema.test.ts) -------------------------------

const dialect = new PgDialect();

function serialize(expression: unknown, what: string): string {
  expect(expression, `${what} is declared`).toBeDefined();
  const query = dialect.sqlToQuery(expression);
  expect(query.params, `${what} must not carry bind parameters`).toEqual([]);
  return query.sql;
}

function stripSchemaQualifiers(sqlText: string, table: string, what: string): string {
  const bare = sqlText.replace(new RegExp(`"app"\\."${table}"\\."([a-z_0-9]+)"`, "g"), "$1");
  expect(bare, `${what} has an unrecognised quoted identifier`).not.toContain('"');
  return bare;
}

interface ExpressionTokens {
  columns: string[];
  literals: string[];
  numbers: string[];
}
function tokens(expression: string, columnNames: string[]): ExpressionTokens {
  const literals = [...expression.matchAll(/'([^']*)'/g)].map((m) => m[1] as string).sort();
  const rest = expression.replace(/'[^']*'/g, " ");
  return {
    columns: columnNames.filter((name) => new RegExp(`\\b${name}\\b`).test(rest)).sort(),
    literals,
    numbers: [...rest.matchAll(/\b\d+\b/g)].map((m) => m[0]).sort(),
  };
}

function contractCheckExpression(definition: string): string {
  const match = /^CHECK \((.*)\)$/.exec(definition);
  if (!match) throw new Error("Unexpected CHECK definition shape in schema-contract.json");
  return (match[1] as string).replaceAll("::text", "");
}

function constraintName(entry: DrizzleNamedColumns): string {
  const name = entry.getName ? entry.getName() : entry.name;
  if (!name) throw new Error("Unnamed constraint in Drizzle declaration (DB-ARC-007)");
  return name;
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// A Drizzle default is either a plain JS literal or SQL. Both are reduced to PostgreSQL's text without casts.
function defaultText(value: unknown, what: string): string {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return serialize(value, what).replaceAll("::text", "");
}

const contractRows = (table: string) => ({
  columns: contract.columns.filter(([name]) => name === table),
  constraints: contract.constraints.filter(([name]) => name === table),
  indexes: contract.indexes.filter(([name]) => name === table),
});

// ---- tests -------------------------------------------------------------------------------------

describe("TC-DB-ARC-007-010 the contract describes the four Karaoke reservation tables", () => {
  it("TC-DB-ARC-007-010 the hand-written goldens have the SPEC-100 sizes", () => {
    expect(GOLDEN_TABLES.map((g) => g.columns.length)).toEqual(SPEC_COLUMN_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.constraints.length)).toEqual(SPEC_CONSTRAINT_COUNTS);
    expect(GOLDEN_TABLES.map((g) => g.indexes.length)).toEqual(SPEC_INDEX_COUNTS);
  });

  it("TC-DB-ARC-007-010 the contract lists the four tables (owner app_migrator, no row security) and their identity sequences", () => {
    for (const golden of GOLDEN_TABLES) {
      expect(
        contract.tables.find(([name]) => name === golden.table),
        golden.table,
      ).toEqual([golden.table, "r", "app_migrator", false]);
    }
    expect(
      contract.sequences
        .filter(([name]) => KARAOKE_RESERVATION_SEQUENCES.includes(name))
        .map(([name, type, owner]) => [name, type, owner]),
    ).toEqual(
      [...KARAOKE_RESERVATION_SEQUENCES].sort().map((name) => [name, "bigint", "app_migrator"]),
    );
  });

  for (const golden of GOLDEN_TABLES) {
    it(`TC-DB-ARC-007-010 contract rows of ${golden.table} equal the golden columns, constraints and indexes`, () => {
      const rows = contractRows(golden.table);
      expect(rows.columns.map(([, ...rest]) => rest)).toEqual(golden.columns);
      expect(
        rows.constraints.map(([, name, kind, definition]) => [name, kind, definition]),
      ).toEqual([...golden.constraints].sort(byName).map((c) => [c.name, c.kind, c.definition]));
      for (const [, , , , ...flags] of rows.constraints)
        expect(flags).toEqual([true, false, false]);
      expect(rows.indexes.map(([, definition]) => definition)).toEqual(
        [...golden.indexes].sort(byName).map((i) => i.definition),
      );
      for (const [, , ...flags] of rows.indexes) expect(flags).toEqual([true, true, true]);
    });
  }

  it("TC-DB-ARC-007-010 the Hold, Reservation and Karaoke Ticket state names of the goldens equal @off-r39x/domain (SPEC-030)", () => {
    expect([...KARAOKE_HOLD_STATES]).toEqual([...domain.KARAOKE_HOLD_STATES]);
    expect([...KARAOKE_RESERVATION_STATES]).toEqual([...domain.RESERVATION_STATES]);
    expect([...KARAOKE_TICKET_STATES]).toEqual([...domain.KARAOKE_TICKET_STATES]);
  });
});

function describeTable(golden: GoldenTable) {
  const { table } = golden;
  const load = async () => {
    const schemaModule = await loadSchema();
    const declared = schemaModule[golden.exportName];
    expect(declared, `@off-r39x/db/schema exports ${golden.exportName}`).toBeDefined();
    return { schemaModule, config: getTableConfig(declared) };
  };

  describe(`TC-DB-ARC-007-010 Drizzle declaration of app.${table} matches the contract and the SPEC-100 goldens`, () => {
    it(`TC-DB-ARC-007-010 ${table}: table name, schema, columns in order with SQL type and NOT NULL`, async () => {
      const { config } = await load();
      expect([config.name, config.schema]).toEqual([table, "app"]);
      expect(config.columns.map((c) => [c.name, c.getSQLType(), c.notNull])).toEqual(
        golden.columns.map(([name, type, notNull]) => [name, type, notNull]),
      );
    });

    it(`TC-DB-ARC-007-010 ${table}: identity always on id only, and generated columns carry the golden expression`, async () => {
      const { config } = await load();
      expect(config.columns.filter((c) => c.generatedIdentity).map((c) => c.name)).toEqual(["id"]);
      expect(config.columns.find((c) => c.name === "id")?.generatedIdentity?.type).toBe("always");
      const expected = golden.columns.filter(([, , , , generated]) => generated === "s");
      expect(config.columns.filter((c) => c.generated).map((c) => c.name)).toEqual(
        expected.map(([name]) => name),
      );
      for (const [name] of expected) {
        const column = config.columns.find((c) => c.name === name);
        expect(column?.generated?.type, `${name} GENERATED ALWAYS`).toBe("always");
        const text = stripSchemaQualifiers(serialize(column?.generated?.as, name), table, name);
        expect([name, text]).toEqual(["hold_expires_at", HOLD_EXPIRY_DECLARED]);
      }
    });

    it(`TC-DB-ARC-007-010 ${table}: defaults are exactly the golden ones (state columns have none)`, async () => {
      const { config } = await load();
      const expected = golden.columns.filter(
        ([, , , identity, generated, d]) => identity === "" && generated === "" && d !== null,
      );
      expect(
        config.columns
          .filter((c) => !c.generatedIdentity && !c.generated && c.hasDefault)
          .map((c) => c.name),
      ).toEqual(expected.map(([name]) => name));
      for (const [name, , , , , defaultExpr] of expected) {
        const column = config.columns.find((c) => c.name === name);
        expect(defaultText(column?.default, `default of ${name}`), `default of ${name}`).toBe(
          defaultExpr as string,
        );
      }
    });

    it(`TC-DB-ARC-007-010 ${table}: every bigint column is a lossless bigint (PgBigInt64) and nothing else is (DEV-DB-006)`, async () => {
      const { config } = await load();
      for (const [name, type] of golden.columns) {
        const column = config.columns.find((c) => c.name === name);
        if (type === "bigint") expect(column?.columnType, name).toBe("PgBigInt64");
        else expect(column?.columnType, name).not.toMatch(/^PgBigInt/);
      }
    });

    it(`TC-DB-ARC-007-010 ${table}: constraint names, kinds and column lists equal the golden and the contract`, async () => {
      const { config } = await load();
      const declared = new Map<string, string>();
      const add = (name: string, kind: string) => {
        expect(declared.has(name), `duplicate constraint name ${name}`).toBe(false);
        declared.set(name, kind);
      };
      for (const entry of config.primaryKeys) add(constraintName(entry), "p");
      for (const entry of config.uniqueConstraints) add(constraintName(entry), "u");
      for (const entry of config.foreignKeys) add(entry.getName(), "f");
      for (const entry of config.checks) add(entry.name, "c");
      const goldenKinds = golden.constraints
        .map((c) => [c.name, c.kind] as [string, string])
        .sort();
      expect([...declared.entries()].sort()).toEqual(goldenKinds);
      expect([...declared.entries()].sort()).toEqual(
        contractRows(table)
          .constraints.map(([, name, kind]) => [name, kind] as [string, string])
          .sort(),
      );
      expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(["id"]);
      for (const entry of config.uniqueConstraints) {
        const name = constraintName(entry);
        expect(`UNIQUE (${entry.columns.map((c) => c.name).join(", ")})`, name).toBe(
          golden.constraints.find((c) => c.name === name)?.definition,
        );
      }
    });

    it(`TC-DB-ARC-007-010 ${table}: CHECK expressions equal the golden exactly and match the contract by column, literals and numbers`, async () => {
      const { config } = await load();
      const columnNames = config.columns.map((c) => c.name);
      const actual: Record<string, string> = {};
      for (const entry of config.checks) {
        actual[entry.name] = stripSchemaQualifiers(
          serialize(entry.value, `CHECK ${entry.name}`),
          table,
          `CHECK ${entry.name}`,
        );
      }
      expect(actual).toEqual(
        Object.fromEntries(
          golden.constraints.filter((c) => c.kind === "c").map((c) => [c.name, c.declared]),
        ),
      );
      for (const [, name, kind, definition] of contractRows(table).constraints) {
        if (kind !== "c") continue;
        const expression = contractCheckExpression(definition);
        expect(tokens(actual[name] as string, columnNames), `tokens of ${name}`).toEqual(
          tokens(expression, columnNames),
        );
      }
    });

    it(`TC-DB-ARC-007-010 ${table}: foreign keys reference the golden parents and columns with ON DELETE RESTRICT`, async () => {
      const { schemaModule, config } = await load();
      expect(config.foreignKeys.map((e) => e.getName()).sort()).toEqual(
        golden.foreignKeys.map((f) => f.name).sort(),
      );
      for (const expected of golden.foreignKeys) {
        const entry = config.foreignKeys.find((e) => e.getName() === expected.name);
        const reference = entry?.reference();
        expect(
          reference?.columns.map((c) => c.name),
          expected.name,
        ).toEqual(expected.columns);
        expect(
          reference?.foreignColumns.map((c) => c.name),
          expected.name,
        ).toEqual(expected.parentColumns);
        expect(reference?.foreignTable, expected.name).toBe(schemaModule[expected.parentExport]);
        expect(entry?.onDelete, expected.name).toBe("restrict");
        expect(entry?.onUpdate ?? "no action", `${expected.name} ON UPDATE`).toBe("no action");
      }
    });

    it(`TC-DB-ARC-007-010 ${table}: declared indexes carry the golden columns, order, uniqueness and predicate`, async () => {
      const { config } = await load();
      const goldenDeclared = golden.indexes.filter((i) => i.declared);
      expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
        goldenDeclared.map((i) => i.name).sort(),
      );
      for (const expected of goldenDeclared) {
        const index = config.indexes.find((i) => i.config.name === expected.name);
        expect(index?.config.unique, `${expected.name} uniqueness`).toBe(expected.declared?.unique);
        expect(index?.config.method, `${expected.name} method`).toBe("btree");
        expect(
          index?.config.columns.map((c) => [c.name, c.indexConfig?.order ?? "asc"]),
          `${expected.name} columns`,
        ).toEqual(expected.declared?.columns);
        if (expected.declared?.where === undefined) {
          expect(index?.config.where, `${expected.name} has no predicate`).toBeUndefined();
        } else {
          expect(
            stripSchemaQualifiers(
              serialize(index?.config.where, expected.name),
              table,
              expected.name,
            ),
            `${expected.name} predicate`,
          ).toBe(expected.declared.where);
        }
      }
    });
  });
}

for (const golden of GOLDEN_TABLES) describeTable(golden);

describe("TC-DB-ARC-007-010 the schema barrel exposes the four tables by name", () => {
  it("TC-DB-ARC-007-010 each golden export is a table in the app schema and no two exports are the same table", async () => {
    const schemaModule = await loadSchema();
    const names = new Set<string>();
    for (const golden of GOLDEN_TABLES) {
      const config = getTableConfig(schemaModule[golden.exportName]);
      expect(config.schema, golden.exportName).toBe("app");
      names.add(config.name);
    }
    expect([...names].sort()).toEqual(GOLDEN_TABLES.map((g) => g.table).sort());
  });
});
